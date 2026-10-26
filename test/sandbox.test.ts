// End to end on the sandbox (14 local chains + mock Safe service): prepare, five owners sign through the
// service, execute everywhere. Plus the Safe service rules the client depends on. Needs anvil.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createWalletClient, encodeFunctionData, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import {
  config, execData, findSafe, normalizeSig, parseActions, parseTargets, payloadKey, prepareTarget, readSafe, safeTxHash, sigOwner,
  walletTypedData, type Prepared, type Tx,
} from '../src/safe'
import * as svc from '../src/service'
import { startMockService } from './mock-service'
import { ACCOUNTS, CHAIN_IDS, INCOMING, OWNERS, PROPOSER, startSandbox, type Sandbox } from './sandbox'

const enabled = !!Bun.which('anvil')
let sb: Sandbox
// Every test can run alone: whichever needs the prepared batch first prepares it.
let preparing: Promise<Prepared[]> | undefined
const prepareAll = () => (preparing ??= (async () => {
  const t = parseTargets(sb.targets), a = parseActions(sb.actions)
  return Promise.all(t.targets.map(x => prepareTarget(x, a.actions, {})))
})())

beforeAll(async () => {
  if (!enabled) return
  // The client's 1 req/s pacing is a production setting; tests run the mock unthrottled to stay fast.
  sb = await startSandbox({ rps: 1000 })
  for (const id of sb.serviceChains) svc.config.service[id] = sb.service.url(id)
  svc.config.gapMs = 0
}, 120_000)
afterAll(() => sb?.stop())

const sign = async (tx: Tx, signer: (typeof OWNERS)[number]) => {
  const p = JSON.parse(walletTypedData(tx)); delete p.types.EIP712Domain
  return normalizeSig(await signer.signTypedData(p))
}
const post = (chainId: number, path: string, body: unknown) =>
  fetch(`${sb.service.url(chainId)}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const proposal = async (tx: Tx, sender: string, signature: Hex | null, over: Record<string, unknown> = {}) => ({
  to: tx.to, value: tx.value, data: tx.data, operation: tx.operation, safeTxGas: '0', baseGas: '0', gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000', refundReceiver: '0x0000000000000000000000000000000000000000',
  nonce: String(tx.nonce), contractTransactionHash: safeTxHash(tx), sender, signature, ...over,
})

test.skipIf(!enabled)('prepare sorts the 16 Safes into ready and already applied, and spots queued transactions', async () => {
  const t = parseTargets(sb.targets), a = parseActions(sb.actions)
  expect([...t.errors, ...a.errors]).toEqual([])
  expect(t.targets).toHaveLength(16)
  const prepared = await prepareAll()
  const linea = prepared.find(p => p.chainId === 59144)!
  expect(linea.skip).toBe('Already in sync')
  const ready = prepared.filter(p => p.tx && !p.error && !p.skip)
  expect(ready).toHaveLength(15)
  for (const p of ready) {
    expect(p.sim?.ok).toBe(true)
    expect(p.owners).toContain(INCOMING[0].address)
    expect(p.threshold).toBe(5)
  }
  // Nonces as set up: Optimism and Sonic at 1, Arbitrum at 2, the original Safe at 3.
  const nonce = (id: number, safe = sb.team) => ready.find(p => p.chainId === id && p.safe === safe)!.tx!.nonce
  expect([nonce(10), nonce(146), nonce(42161), nonce(1, sb.original), nonce(8453)]).toEqual([1, 1, 2, 3, 0])
  // Owner order differs on the original Safe, so its prevOwner differs: two encodings of one change.
  // (Scroll's Safe has its own address but the same owner order, so its payload matches up to that address.)
  expect(new Set(ready.map(p => payloadKey(p.tx!))).size).toBe(2)
  const orig = (await svc.getTx(1, ready.find(p => p.safe === sb.original)!.hash!))!
  expect(orig.confirmations.map(c => c.owner)).toEqual([OWNERS[1].address])
  const queued = await svc.queued(100, sb.team, 0)
  expect(queued.some(q => q.safeTxHash !== ready.find(p => p.chainId === 100)!.hash)).toBe(true)
}, 60_000)

test.skipIf(!enabled)('five owners sign everything through the service, then one executor runs it on every chain', async () => {
  const ready = (await prepareAll()).filter(p => p.tx && !p.error && !p.skip)
  for (const owner of OWNERS.slice(0, 5)) {
    for (const p of ready) {
      const tx = p.tx!, hash = p.hash!
      const existing = await svc.getTx(tx.chainId, hash)
      if (existing?.confirmations.some(c => c.owner === owner.address)) continue
      if (existing && existing.confirmations.length >= 5) continue
      await svc.submit(tx, hash, owner.address, await sign(tx, owner), !!existing)
    }
  }
  const executor = ACCOUNTS[0]
  for (const p of ready) {
    const tx = p.tx!, hash = p.hash!
    const s = (await svc.getTx(tx.chainId, hash))!
    expect(s.confirmations.length).toBeGreaterThanOrEqual(5)
    const sigs = s.confirmations.map(c => ({ owner: c.owner, sig: c.signature }))
    for (const s of sigs) expect(await sigOwner(hash, s.sig)).toBe(s.owner)
    const w = createWalletClient({ account: executor, transport: http(config.rpc[tx.chainId]) }).extend(publicActions)
    const rc = await w.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: tx.safe, data: execData(tx, sigs, 5), chain: null }) })
    expect(rc.status).toBe('success')
    const after = await readSafe(tx.chainId, tx.safe)
    expect(after.owners).toContain(INCOMING[1].address)
    expect(after.owners).not.toContain(OWNERS[0].address)
    expect(after.nonce).toBe(tx.nonce + 1)
    expect((await svc.getTx(tx.chainId, hash))!.isExecuted).toBe(true)
  }
  expect(new Set(ready.map(p => p.chainId)).size).toBe(CHAIN_IDS.length - 1) // every chain except Linea, already done
}, 180_000)

test.skipIf(!enabled)('Safe service rules the client depends on', async () => {
  const owner = OWNERS[5], other = OWNERS[6]
  const tx: Tx = { chainId: 8453, safe: sb.team, nonce: 1, to: sb.team, value: '0', data: encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [4n] }), operation: 0 }
  const sig = await sign(tx, owner), path = `/v2/safes/${tx.safe}/multisig-transactions/`
  const expect422 = async (body: unknown, text: string, p = path) => {
    const res = await post(8453, p, body)
    expect(res.status).toBe(422)
    expect(await res.text()).toContain(text)
  }
  // Addresses must be checksummed: wallets often return lowercase accounts.
  await expect422(await proposal(tx, owner.address.toLowerCase(), sig), 'is not checksumed')
  await expect422(await proposal(tx, owner.address, sig), 'Checksum address validation failed', `/v2/safes/${tx.safe.toLowerCase()}/multisig-transactions/`)
  await expect422(await proposal(tx, owner.address, sig, { contractTransactionHash: `0x${'ab'.repeat(32)}` }), 'does not match provided contract-tx-hash')
  await expect422(await proposal(tx, ACCOUNTS[0].address, sig), 'is not an owner or delegate')
  await expect422(await proposal(tx, other.address, sig), 'Signature does not match sender')
  // v = 0/1 from some wallets means "contract signature" / "approved hash" to Safe: normalising matters.
  await expect422(await proposal(tx, owner.address, (sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')) as Hex), 'is not valid')
  // DELEGATECALL only to trusted libraries.
  await expect422(await proposal({ ...tx, operation: 1, to: ACCOUNTS[0].address }, owner.address, null), 'Operation DELEGATE_CALL is not allowed')

  // Proposing is get-or-create: proposing an existing transaction with another owner's signature adds a confirmation.
  expect((await post(8453, path, await proposal(tx, owner.address, sig))).status).toBe(201)
  expect((await post(8453, path, await proposal(tx, other.address, await sign(tx, other)))).status).toBe(201)
  expect((await svc.getTx(8453, safeTxHash(tx)))!.confirmations.map(c => c.owner)).toEqual([owner.address, other.address])
  // Confirmations: unknown hash is 404, a non-owner is 400.
  expect((await post(8453, `/v1/multisig-transactions/0x${'12'.repeat(32)}/confirmations/`, { signature: sig })).status).toBe(404)
  const res = await post(8453, `/v1/multisig-transactions/${safeTxHash(tx)}/confirmations/`, { signature: await sign(tx, ACCOUNTS[0]) })
  expect(res.status).toBe(400)
  expect(await res.text()).toContain('is not an owner')
  // Numbers come back as strings.
  const got = (await svc.getTx(8453, safeTxHash(tx)))!
  expect([typeof got.nonce, typeof got.value]).toEqual(['string', 'string'])

  // Throttling, on a mock with the public API's 2 req/s: bursts get 429 with Retry-After,
  // and the client (even unpaced) retries through them.
  const slow = startMockService({ rps: 2, rpc: sb.rpc })
  try {
    const url = `${slow.url(8453)}/api/v2/multisig-transactions/${safeTxHash(tx)}/`
    const burst = await Promise.all(Array.from({ length: 6 }, () => fetch(url)))
    expect(burst.find(r => r.status === 429)?.headers.get('retry-after')).toBe('1')
    svc.config.service[8453] = slow.url(8453)
    expect(await Promise.all(Array.from({ length: 6 }, () => svc.getTx(8453, safeTxHash(tx))))).toEqual(Array(6).fill(null))
  } finally { svc.config.service[8453] = sb.service.url(8453); slow.stop() }
}, 60_000)

test.skipIf(!enabled)('a proposer (delegate) proposes in its delegator\'s name, and its signature is no confirmation', async () => {
  const tx: Tx = { chainId: 8453, safe: sb.team, nonce: 1000, to: sb.team, value: '0', data: encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [3n] }), operation: 0 }
  const hash = safeTxHash(tx), path = `/v2/safes/${tx.safe}/multisig-transactions/`
  // The sandbox has owner 2 name the proposer for all of its Safes.
  expect((await svc.delegations(8453, PROPOSER.address)).map(d => [d.safe, d.delegator, d.expiryDate])).toEqual([[null, OWNERS[1].address, null]])
  expect(await svc.delegations(8453, ACCOUNTS[0].address)).toEqual([])
  // A delegate sends its own signature and nothing else.
  const both = `${await sign(tx, OWNERS[5])}${(await sign(tx, PROPOSER)).slice(2)}` as Hex
  const res = await post(8453, path, await proposal(tx, PROPOSER.address, both))
  expect([res.status, await res.text()]).toEqual([422, JSON.stringify({ nonFieldErrors: ['Just one signature is expected if using delegates'] })])

  await svc.propose(tx, hash, PROPOSER.address, await sign(tx, PROPOSER), OWNERS[0].address)
  const t = (await svc.getTx(8453, hash))!
  expect([t.proposedByDelegate, t.confirmations]).toEqual([PROPOSER.address, []])
  // Signed, so trusted: Safe{Wallet}'s queue (and ours) lists it.
  expect((await svc.atNonce(8453, sb.team, 1000)).map(x => x.safeTxHash)).toEqual([hash])
  // Owners confirm as usual; the proposer can't.
  await svc.submit(tx, hash, OWNERS[5].address, await sign(tx, OWNERS[5]), true)
  expect((await svc.getTx(8453, hash))!.confirmations.map(c => c.owner)).toEqual([OWNERS[5].address])
  expect((await post(8453, `/v1/multisig-transactions/${hash}/confirmations/`, { signature: await sign(tx, PROPOSER) })).status).toBe(400)

  // Named for another Safe, expired, or by someone who isn't an owner: no proposing.
  const other = { ...tx, nonce: 1001 }, outsider = ACCOUNTS[0].address
  const rows = [
    { chainId: 8453, safe: sb.original!, delegate: outsider, delegator: OWNERS[1].address, label: '', expiryDate: null },
    { chainId: 8453, safe: null, delegate: outsider, delegator: OWNERS[1].address, label: '', expiryDate: new Date(Date.now() - 60_000).toISOString() },
    { chainId: 8453, safe: null, delegate: outsider, delegator: PROPOSER.address, label: '', expiryDate: null },
  ]
  sb.service.delegates.push(...rows)
  try {
    const r = await post(8453, path, await proposal(other, outsider, await sign(other, ACCOUNTS[0])))
    expect([r.status, await r.text()]).toEqual([422, expect.stringContaining(`Sender=${outsider} is not an owner or delegate`)])
    expect(await svc.delegations(8453, outsider)).toHaveLength(3) // listed all the same: the client checks
  } finally { sb.service.delegates.splice(-rows.length) }
}, 60_000)

test.skipIf(!enabled)('anyone else proposes unsigned, naming an owner: untrusted until an owner confirms', async () => {
  const tx: Tx = { chainId: 252, safe: sb.team, nonce: 1000, to: sb.team, value: '0', data: encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [3n] }), operation: 0 }
  const hash = safeTxHash(tx), outsider = ACCOUNTS[0].address
  // The service still takes a proposal without a signature, but only from an owner (or delegate) as sender.
  const res = await post(252, `/v2/safes/${tx.safe}/multisig-transactions/`, await proposal(tx, outsider, null))
  expect([res.status, await res.text()]).toEqual([422, expect.stringContaining(`Sender=${outsider} is not an owner or delegate`)])

  await svc.propose(tx, hash, outsider, null, OWNERS[1].address)
  const t = (await svc.getTx(252, hash))!
  expect([t.trusted, t.confirmations, t.proposedByDelegate]).toEqual([false, [], null])
  expect(JSON.parse((t as any).origin)).toEqual({ name: 'Safe Sync', note: `unsigned, sent by ${outsider}` })
  // Out of the default (trusted) listing, which is what Safe{Wallet}'s queue shows; ours asks for untrusted too.
  expect(await svc.queued(252, sb.team, 1000)).toEqual([])
  expect((await svc.atNonce(252, sb.team, 1000)).map(x => [x.safeTxHash, x.trusted])).toEqual([[hash, false]])
  // The first owner's signature confirms it and makes it trusted.
  await svc.submit(tx, hash, OWNERS[5].address, await sign(tx, OWNERS[5]), true)
  const after = (await svc.getTx(252, hash))!
  expect([after.trusted, after.confirmations.map(c => c.owner)]).toEqual([true, [OWNERS[5].address]])
  expect((await svc.queued(252, sb.team, 1000)).map(x => x.safeTxHash)).toEqual([hash])
}, 60_000)

test.skipIf(!enabled)('simple mode: the two well-known test wallets run a 2-of-2 Safe on three local chains', async () => {
  const simple = await startSandbox({ simple: true, rps: 1000 })
  try {
    for (const id of simple.serviceChains) svc.config.service[id] = simple.service.url(id)
    const [a0, a1] = ACCOUNTS
    expect(simple.owners).toEqual([a0.address, a1.address])
    const t = parseTargets(simple.targets), a = parseActions(simple.actions)
    const ready = await Promise.all(t.targets.map(x => prepareTarget(x, a.actions, {})))
    expect(ready.map(p => [p.chainId, p.error, p.sim?.ok, p.threshold, p.owners?.length])).toEqual([[31338, undefined, true, 2, 4], [31339, undefined, true, 2, 4], [31340, undefined, true, 2, 4]])
    for (const p of ready) {
      for (const owner of [a0, a1]) await svc.submit(p.tx!, p.hash!, owner.address, await sign(p.tx!, owner), !!(await svc.getTx(p.chainId, p.hash!)))
      const s = (await svc.getTx(p.chainId, p.hash!))!
      const w = createWalletClient({ account: a1, transport: http(config.rpc[p.chainId]) }).extend(publicActions)
      const rc = await w.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: p.safe, data: execData(p.tx!, s.confirmations.map(c => ({ owner: c.owner, sig: c.signature })), 2), chain: null }) })
      expect(rc.status).toBe('success')
      expect((await readSafe(p.chainId, p.safe)).owners).toHaveLength(4)
    }
  } finally { simple.stop() }
}, 60_000)

test.skipIf(!enabled)('finding the team Safe by address turns up every chain it is on', async () => {
  const found = await findSafe(sb.team, 8000, CHAIN_IDS)
  expect(found.filter(f => f.state).map(f => f.chainId).sort((a, b) => a - b)).toEqual([...CHAIN_IDS].sort((a, b) => a - b))
  expect(found.some(f => f.error)).toBe(false)
}, 60_000)
