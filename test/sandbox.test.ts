// End to end on the sandbox (14 local chains + mock Safe service): prepare, five owners sign through the
// service, execute everywhere. Plus the Safe service rules the client depends on. Needs anvil.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createWalletClient, encodeFunctionData, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import {
  config, delegateTypedData, execData, findSafe, normalizeSig, parseActions, parseTargets, payloadKey, pickNonce, prepareTarget, readSafe, safeTxHash, sigOwner,
  totpNow, walletTypedData, type NonceChoice, type Prepared, type Tx,
} from '../src/safe'
import * as svc from '../src/service'
import { startMockService } from './mock-service'
import { ACCOUNTS, CHAIN_IDS, INCOMING, KEEPER, KEEPER_MISSING, OWNERS, PROPOSER, startSandbox, type Sandbox } from './sandbox'

const enabled = !!Bun.which('anvil')
let sb: Sandbox
// Every test can run alone: whichever needs the prepared batch first prepares it.
let preparing: Promise<Prepared[]> | undefined
// The nonce as the app picks it: from what's queued, and the proposer's choice where something else is.
const nonceBy = (choice: NonceChoice) => async (tx: Tx) => pickNonce(tx, svc.serviceUrl(tx.chainId) ? await svc.queued(tx.chainId, tx.safe, tx.nonce) : [], choice).nonce
// This proposer replaces what's queued on Gnosis and Polygon, so every chain can execute.
const prepareAll = () => (preparing ??= (async () => {
  const t = parseTargets(sb.targets), a = parseActions(sb.actions)
  return Promise.all(t.targets.map(x => prepareTarget(x, a.actions, {}, nonceBy('replace'))))
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
  // Something else is queued on Gnosis (one) and Polygon (two): by default the nonce goes after it, replacing takes the on-chain one.
  expect([nonce(100), nonce(137)]).toEqual([0, 0])
  const after = (chainId: number, safe = sb.team) => prepareTarget({ chainId, safe }, a.actions, {}, nonceBy('after')).then(p => p.tx!.nonce)
  expect(await Promise.all([after(100), after(137)])).toEqual([1, 2])
  // The rotation already queued on the original Safe keeps its nonce either way, so its signature counts.
  expect(await after(1, sb.original)).toBe(3)
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
  // Settings recognises a service by its about page.
  expect((await (await fetch(`${sb.service.url(8453)}/api/v1/about/`)).json()).name).toBe('Safe Transaction Service')
  // Numbers come back as strings.
  const got = (await svc.getTx(8453, safeTxHash(tx)))!
  expect([typeof got.nonce, typeof got.value]).toEqual(['string', 'string'])

  // Throttling: past the limit the service answers 429 with Retry-After, and the client (even unpaced) waits and
  // retries. A 1 req/s mock shows both with one wait: the burst uses the second up, so the client's call is refused once.
  const slow = startMockService({ rps: 1, rpc: sb.rpc })
  try {
    const url = `${slow.url(8453)}/api/v2/multisig-transactions/${safeTxHash(tx)}/`
    const burst = await Promise.all(Array.from({ length: 2 }, () => fetch(url)))
    expect(burst.map(r => r.status).sort()).toEqual([404, 429])
    expect(burst.find(r => r.status === 429)?.headers.get('retry-after')).toBe('1')
    svc.config.service[8453] = slow.url(8453)
    expect(await svc.getTx(8453, safeTxHash(tx))).toBeNull()
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

  await svc.propose(tx, hash, PROPOSER.address, await sign(tx, PROPOSER))
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

test.skipIf(!enabled)('one owner signature adds a proposer on every chain, and only its delegator or itself removes it', async () => {
  const chains = [1, 8453, 252], delegate = ACCOUNTS[0].address, safe = sb.team
  const signDelegate = (signer: (typeof OWNERS)[number], who: Address, chainId?: number) => {
    const p = JSON.parse(delegateTypedData(who, totpNow())), { EIP712Domain, ...types } = p.types
    return signer.signTypedData({ domain: { ...p.domain, ...(chainId ? { chainId } : {}) }, types, primaryType: 'Delegate', message: { ...p.message, totp: BigInt(p.message.totp) } })
  }
  // Safe{Wallet}'s list for one Safe: what was named for it, not what an owner named for all of its Safes.
  const listed = async (chainId: number) => (await svc.proposers(chainId, safe)).map(d => [d.delegate, d.delegator, d.label])
  expect(await listed(1)).toEqual([[KEEPER, OWNERS[1].address, 'Keeper bot']])
  expect(await listed(KEEPER_MISSING[0])).toEqual([])

  const signature = await signDelegate(OWNERS[3], delegate)
  for (const chainId of chains) await svc.addProposer(chainId, { safe, delegate, delegator: OWNERS[3].address, label: 'Ops', signature })
  for (const chainId of chains) expect(await listed(chainId)).toContainEqual([delegate, OWNERS[3].address, 'Ops'])
  // The same delegator again only relabels it.
  await svc.addProposer(1, { safe, delegate, delegator: OWNERS[3].address, label: 'Ops desk', signature })
  expect((await listed(1)).filter(d => d[0] === delegate)).toEqual([[delegate, OWNERS[3].address, 'Ops desk']])

  // Only an owner names one, with its own signature. A chain's own id in the message works there only.
  const pr = svc.addProposer(1, { safe, delegate, delegator: PROPOSER.address, label: 'x', signature: await signDelegate(PROPOSER, delegate) })
  await expect(pr).rejects.toThrow(`Provided delegator=${PROPOSER.address} is not an owner of Safe=${safe}`)
  await expect(svc.addProposer(1, { safe, delegate, delegator: OWNERS[4].address, label: 'x', signature })).rejects.toThrow(`Signature does not match provided delegator=${OWNERS[4].address}`)
  const onBase = await signDelegate(OWNERS[4], delegate, 8453)
  await svc.addProposer(8453, { safe, delegate, delegator: OWNERS[4].address, label: 'Ops', signature: onBase })
  await expect(svc.addProposer(1, { safe, delegate, delegator: OWNERS[4].address, label: 'Ops', signature: onBase })).rejects.toThrow('Signature does not match')

  // Another owner can't remove what owner 4 named; owner 4 can, and so can the proposer itself.
  await expect(svc.removeProposer(1, { safe, delegate, delegator: OWNERS[3].address, signature: await signDelegate(OWNERS[5], delegate) })).rejects.toThrow('Signature does not match provided delegate=')
  await svc.removeProposer(1, { safe, delegate, delegator: OWNERS[3].address, signature })
  await svc.removeProposer(8453, { safe, delegate, delegator: OWNERS[3].address, signature: await signDelegate(ACCOUNTS[0], delegate) })
  expect((await listed(1)).filter(d => d[0] === delegate)).toEqual([])
  expect((await listed(8453)).filter(d => d[0] === delegate)).toEqual([[delegate, OWNERS[4].address, 'Ops']])
  // Removing one that's already gone is fine.
  await svc.removeProposer(1, { safe, delegate, delegator: OWNERS[3].address, signature })
  await svc.removeProposer(8453, { safe, delegate, delegator: OWNERS[4].address, signature: onBase })
  await svc.removeProposer(252, { safe, delegate, delegator: OWNERS[3].address, signature })
  for (const chainId of chains) expect((await listed(chainId)).filter(d => d[0] === delegate)).toEqual([])
}, 60_000)

// The app no longer proposes unsigned, but anyone can: the service keeps such proposals untrusted, and so must we.
test.skipIf(!enabled)('unsigned proposals stay untrusted until an owner confirms, and cannot hide a signed transaction', async () => {
  const owner = OWNERS[5], chainId = 252, nonce = 2000, path = `/v2/safes/${sb.team}/multisig-transactions/`
  const threshold = (n: bigint): Tx => ({ chainId, safe: sb.team, nonce, to: sb.team, value: '0', operation: 0,
    data: encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [n] }) })
  // The service takes a proposal without a signature, but only with an owner (or delegate) as sender.
  const res = await post(chainId, path, await proposal(threshold(3n), ACCOUNTS[0].address, null))
  expect([res.status, await res.text()]).toEqual([422, expect.stringContaining(`Sender=${ACCOUNTS[0].address} is not an owner or delegate`)])
  // Unsigned noise at the nonce of a signed transaction: untrusted, and out of the listings, so it can't crowd it out.
  const signed = threshold(3n), hash = safeTxHash(signed)
  await svc.submit(signed, hash, owner.address, await sign(signed, owner), false)
  for (let n = 4n; n < 24n; n++) expect((await post(chainId, path, await proposal(threshold(n), OWNERS[1].address, null))).status).toBe(201)
  const unsigned = threshold(23n), unsignedHash = safeTxHash(unsigned)
  expect([(await svc.getTx(chainId, unsignedHash))!.trusted, (await svc.getTx(chainId, unsignedHash))!.confirmations]).toEqual([false, []])
  expect((await svc.atNonce(chainId, sb.team, nonce)).map(t => t.safeTxHash)).toEqual([hash])
  expect((await svc.queued(chainId, sb.team, nonce)).map(t => t.safeTxHash)).toEqual([hash])
  // An owner's signature confirms an unsigned proposal and makes it trusted, so it shows from then on.
  await svc.submit(unsigned, unsignedHash, owner.address, await sign(unsigned, owner), true)
  expect((await svc.getTx(chainId, unsignedHash))!.trusted).toBe(true)
  expect((await svc.atNonce(chainId, sb.team, nonce)).map(t => t.safeTxHash).sort()).toEqual([hash, unsignedHash].sort())
}, 60_000)

test.skipIf(!enabled)('the complete queue keeps an existing transaction nonce beyond the first page', async () => {
  const owner = OWNERS[5], chainId = 8453, nonce = 5000
  const data = (n: bigint) => encodeFunctionData({ abi: parseAbi(['function changeThreshold(uint256)']), functionName: 'changeThreshold', args: [n] })
  const tx: Tx = { chainId, safe: sb.team, nonce, to: sb.team, value: '0', operation: 0, data: data(3n) }
  for (let i = 0; i <= 50; i++) {
    const next = { ...tx, nonce: nonce + i, data: i ? data(4n) : tx.data }
    await svc.submit(next, safeTxHash(next), owner.address, await sign(next, owner), false)
  }
  const queue = await svc.queued(chainId, sb.team, nonce)
  expect(queue).toHaveLength(51)
  expect(pickNonce(tx, queue, 'after')).toEqual({ nonce, same: true })
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
