// A local copy of a team's real situation, for end-to-end tests and for trying the app by hand:
// 14 anvil chains with real chain ids, the canonical Safe contracts at their canonical addresses,
// a 5-of-9 team Safe at the same address everywhere plus two odd ones, the awkward cases that come up
// in practice, and the mock Safe Transaction Service.
//
//   bun run sandbox                     serves the app on http://localhost:8600 with a sandbox wallet (pick any signer)
//   bun run sandbox -- --signer 0xA,0xB  also makes your addresses owners (the last ones, never rotated), funded on every chain
//   bun run sandbox -- --port 8700       app on 8700, chains on 8701+, mock service on 8755 (default 8600)
//   bun run sandbox -- --simple          instead: one 2-of-2 Safe owned by the first two test accounts (or your
//                                        --signer addresses) on 3 local-only chain ids, so a browser wallet can
//                                        add them as networks and sign and execute against the local chains
//   startSandbox()                      used by test/sandbox.test.ts
import { createWalletClient, encodeFunctionData, getAddress, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { CHAINS } from '../src/chains'
import { execData, normalizeSig, parseActions, prepareTarget, readSafe, safeTxHash, walletTypedData, config, type Tx } from '../src/safe'
import { startMockService } from './mock-service'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname)
const MNEMONIC = 'test test test test test test test test test test test junk'
export const ACCOUNTS = Array.from({ length: 13 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }))
const [EXECUTOR, ...REST] = ACCOUNTS
export const OWNERS = REST.slice(0, 9) // 5-of-9, like the Curve emergency Safes
export const INCOMING = REST.slice(9, 11)
export const PROPOSER = REST[11] // a Safe{Wallet} proposer (delegate): proposes, never signs, needs no gas

// 12 chains with Safe's own service, 2 (Fraxtal, Taiko) with one someone else runs. The mock stands in for all of
// them: the sandbox must never reach a real service.
export const CHAIN_IDS = [1, 10, 56, 100, 137, 146, 8453, 42161, 43114, 59144, 534352, 5000, 252, 167000]
// Chain ids no real network or wallet default uses, so wallets add them as local networks.
export const SIMPLE_CHAIN_IDS = [31338, 31339, 31340]

const C = {
  safeL2_130: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E', factory_130: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  handler_130: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4', multiSendCallOnly_130: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  simulateTxAccessor_130: '0x59AD6735bCd8152B84860Cb256dD9e96b85F69Da', safeL2_141: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  factory_141: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', handler_141: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
} as const
const ABI = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function changeThreshold(uint256 threshold)',
])
const ZERO = '0x0000000000000000000000000000000000000000'

const inUse = (port: number) => Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, open(s) { s.end() } } }).then(() => true, () => false)
function freePorts(n: number): number[] {
  const listeners = Array.from({ length: n }, () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }))
  const ports = listeners.map(l => l.port)
  listeners.forEach(l => l.stop(true))
  return ports
}

/** Runtime code of the canonical Safe contracts, copied from Ethereum once and kept in test/fixtures. */
async function safeCode(): Promise<Record<string, Hex>> {
  const file = Bun.file(`${root}test/fixtures/safe-contracts.json`)
  if (await file.exists()) return file.json()
  const rpc = process.env.ETHEREUM_RPC_URL ?? CHAINS.find(c => c.id === 1)!.rpcs[0]
  const code: Record<string, Hex> = {}
  for (const a of Object.values(C)) {
    const r = await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [a, 'latest'] }) })).json()
    if (!r.result || r.result === '0x') throw new Error(`no code at ${a}`)
    code[a] = r.result
  }
  await Bun.write(file, JSON.stringify(code, null, 1))
  return code
}

export type Sandbox = Awaited<ReturnType<typeof startSandbox>>

/** `basePort` 0 picks free ports (tests); otherwise chains use basePort, basePort+1, … and must be free. */
export async function startSandbox({ basePort = 0, servicePort = 0, rps = 2, log = false, signers = [], simple = false }: { basePort?: number; servicePort?: number; rps?: number; log?: boolean; signers?: Address[]; simple?: boolean } = {}) {
  // Owners are 9 addresses: local test accounts first, then yours. The rotation swaps owners 1 and 3, never yours.
  const mine = signers.map(a => getAddress(a))
  if (mine.length > 4) throw new Error('At most 4 signers: setup needs 5 local owners to sign')
  if (mine.some(a => INCOMING.some(i => i.address === a))) throw new Error('A signer is one of the incoming owners the rotation adds')
  const pool = ACCOUNTS.slice(1, 10).filter(a => !mine.includes(a.address)).slice(0, 9 - mine.length)
  const owners = [...pool.map(a => a.address), ...mine]
  const ids = simple ? SIMPLE_CHAIN_IDS : CHAIN_IDS
  const ports = basePort ? ids.map((_, i) => basePort + i) : freePorts(ids.length)
  // Never latch onto a chain someone else is running: its state would be modified and the run would fail oddly.
  const busy = (await Promise.all(ports.map(async p => ((await inUse(p)) ? p : 0)))).filter(Boolean)
  if (busy.length) throw new Error(`Port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} already in use; pick another --port`)
  const chains = ids.map((id, i) => ({
    id, rpc: `http://127.0.0.1:${ports[i]}`,
    proc: Bun.spawn(['anvil', '--chain-id', String(id), '--port', String(ports[i]), '--accounts', String(ACCOUNTS.length), '--silent'], { stdout: 'ignore', stderr: 'ignore' }),
  }))
  const stopChains = () => chains.forEach(c => c.proc.kill())
  try {
    const code = await safeCode()
    const rpc = Object.fromEntries(chains.map(c => [c.id, c.rpc]))
    for (const [id, url] of Object.entries(rpc)) config.rpc[Number(id)] = url
    const wallet = (chainId: number) => createWalletClient({ account: EXECUTOR, transport: http(rpc[chainId]) }).extend(publicActions)

    await Promise.all(chains.map(async c => {
      for (let i = 0; ; i++) {
        try { await wallet(c.id).getChainId(); break } catch { if (i > 100) throw new Error(`anvil on ${c.rpc} did not start`); await Bun.sleep(100) }
      }
      if (c.proc.exitCode !== null || (await wallet(c.id).getChainId()) !== c.id) throw new Error(`${c.rpc} is not the chain this sandbox started`)
      for (const [a, bytecode] of Object.entries(code)) await wallet(c.id).request({ method: 'anvil_setCode' as any, params: [a, bytecode] as any })
      for (const a of mine) await wallet(c.id).request({ method: 'anvil_setBalance' as any, params: [a, '0x56bc75e2d63100000'] as any }) // 100 ETH
    }))

    const deploy = async (chainId: number, owners: Address[], salt: bigint, v141 = false, threshold = 5n) => {
      const w = wallet(chainId)
      const init = encodeFunctionData({ abi: ABI, functionName: 'setup', args: [owners, threshold, ZERO, '0x', v141 ? C.handler_141 : C.handler_130, ZERO, 0n, ZERO] })
      const args = [v141 ? C.safeL2_141 : C.safeL2_130, init, salt] as const
      const factory = v141 ? C.factory_141 : C.factory_130
      const { result } = await w.simulateContract({ address: factory, abi: ABI, functionName: 'createProxyWithNonce', args })
      await w.waitForTransactionReceipt({ hash: await w.writeContract({ address: factory, abi: ABI, functionName: 'createProxyWithNonce', args, chain: null }) })
      return getAddress(result)
    }
    const sign = async (tx: Tx, signer: (typeof OWNERS)[number]) => {
      const p = JSON.parse(walletTypedData(tx)); delete p.types.EIP712Domain
      return normalizeSig(await signer.signTypedData(p))
    }
    const execute = async (tx: Tx) => {
      const sigs = await Promise.all(pool.slice(0, 5).map(async o => ({ owner: o.address, sig: await sign(tx, o) })))
      const w = wallet(tx.chainId)
      const rc = await w.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: tx.safe, data: execData(tx, sigs, 5), chain: null }) })
      if (rc.status !== 'success') throw new Error('setup execution failed')
    }
    // `targets`/`actions` are the change in the text format (tests); `draft` is the same change for the app's editor.
    const finish = (service: ReturnType<typeof startMockService>, s: { team: Address; original?: Address; scroll141?: Address; targets: string; actions: string; owners: Address[]; draft: Record<string, unknown> }) => ({
      ...s, chains: chains.map(({ id, rpc }) => ({ id, rpc })), rpc, service,
      serviceChains: ids,
      settings: {
        apiKey: '',
        rpc: Object.fromEntries(chains.map(c => [c.id, c.rpc])),
        service: Object.fromEntries(ids.map(id => [id, service.url(id)])),
      },
      stop: () => { service.stop(); stopChains() },
    })

    if (simple) {
      // One fresh Safe owned by your two wallets, the same address on every chain, and one easy change.
      const safeOwners = mine.length ? mine : [ACCOUNTS[0].address, ACCOUNTS[1].address]
      const safes = await Promise.all(ids.map(id => deploy(id, safeOwners, 11n, false, BigInt(safeOwners.length))))
      if (new Set(safes).size !== 1) throw new Error('Safe addresses differ across chains')
      const service = startMockService({ port: servicePort, rps, rpc, log })
      return finish(service, {
        team: safes[0], targets: `${safes[0]} ${ids.join(' ')}`, actions: `add ${ACCOUNTS[2].address}\nadd ${ACCOUNTS[3].address}`, owners: safeOwners,
        draft: { safes: [safes[0]], owners: [...safeOwners.map(o => ({ from: o, to: o })), { to: ACCOUNTS[2].address }, { to: ACCOUNTS[3].address }], threshold: safeOwners.length, startedFrom: `${ids[0]}:${safes[0]}` },
      })
    }

    // A harmless transaction, to move a Safe's nonce forward.
    const bump = async (chainId: number, safe: Address) => execute({ chainId, safe, nonce: (await readSafe(chainId, safe)).nonce, to: EXECUTOR.address, value: '0', data: '0x', operation: 0 })

    // The team Safe: same owners, same address on every chain.
    const teams = await Promise.all(CHAIN_IDS.map(id => deploy(id, owners, 1n)))
    if (new Set(teams).size !== 1) throw new Error('team Safe addresses differ across chains')
    const team = teams[0]
    // The original Safe on Ethereum: same owners in a different order, so prevOwner differs.
    const original = await deploy(1, [...owners.slice(4), ...owners.slice(0, 4)], 2n)
    // A newer Safe (1.4.1) on Scroll at its own address.
    const scroll141 = await deploy(534352, owners, 1n, true)

    const targets = [`${team} ${CHAIN_IDS.map(id => CHAINS.find(c => c.id === id)!.short).join(' ')}`, `eth:${original}`, `scr:${scroll141}`].join('\n')
    // Same shape as the Curve rotation: two swaps, one of them the first owner (prevOwner = sentinel).
    const actions = `swap ${owners[2]} ${INCOMING[0].address}\nswap ${owners[0]} ${INCOMING[1].address}`

    // Different nonces, as on real chains.
    await bump(10, team); await bump(146, team); await bump(42161, team); await bump(42161, team)
    for (let i = 0; i < 3; i++) await bump(1, original)
    // Already rotated on Linea (someone did it by hand): shows up as "already applied".
    const parsed = parseActions(actions).actions
    const linea = await prepareTarget({ chainId: 59144, safe: team }, parsed, {})
    await execute(linea.tx!)

    const service = startMockService({ port: servicePort, rps, rpc, log })
    // Owner 2 (never rotated out) named the proposer for all of its Safes, on every chain with a service.
    for (const id of CHAIN_IDS) service.delegates.push({ chainId: id, safe: null, delegate: PROPOSER.address, delegator: owners[1], label: 'Sandbox proposer', expiryDate: null })
    const post = (chainId: number, path: string, body: unknown) =>
      fetch(`${service.url(chainId)}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const propose = async (tx: Tx, signer: (typeof OWNERS)[number]) => {
      const body = {
        to: tx.to, value: tx.value, data: tx.data === '0x' ? null : tx.data, operation: tx.operation, safeTxGas: '0', baseGas: '0', gasPrice: '0',
        gasToken: ZERO, refundReceiver: ZERO, nonce: String(tx.nonce), contractTransactionHash: safeTxHash(tx), sender: signer.address,
        signature: await sign(tx, signer), origin: JSON.stringify({ name: 'Sandbox setup' }),
      }
      let res = await post(tx.chainId, `/v2/safes/${tx.safe}/multisig-transactions/`, body)
      // The interactive sandbox's service is throttled like the real one: wait as told.
      while (res.status === 429) {
        await Bun.sleep(Number(res.headers.get('retry-after') || 1) * 1000)
        res = await post(tx.chainId, `/v2/safes/${tx.safe}/multisig-transactions/`, body)
      }
      if (res.status !== 201) throw new Error(`setup proposal failed: ${await res.text()}`)
    }
    // Someone already queued this rotation on the original Safe in Safe{Wallet}, with one signature.
    await propose((await prepareTarget({ chainId: 1, safe: original }, parsed, {})).tx!, pool[1])
    // Something else is already queued: one transaction on Gnosis, two on Polygon. The proposer goes after them or replaces them.
    const threshold4 = (chainId: number, nonce: number): Tx => ({ chainId, safe: team, nonce, to: team, value: '0', data: encodeFunctionData({ abi: ABI, functionName: 'changeThreshold', args: [4n] }), operation: 0 })
    for (const tx of [threshold4(100, 0), threshold4(137, 0), threshold4(137, 1)]) await propose(tx, pool[3])

    return finish(service, {
      team, original, scroll141, targets, actions, owners,
      // Replaced in the same order as the proposal queued on the original Safe, so its signature counts.
      draft: {
        safes: [team, original, scroll141], threshold: 5, startedFrom: `1:${team}`,
        owners: owners.map(o => (o === owners[2] ? { from: o, to: INCOMING[0].address, at: 1 } : o === owners[0] ? { from: o, to: INCOMING[1].address, at: 2 } : { from: o, to: o })),
      },
    })
  } catch (e) { stopChains(); throw e }
}

if (import.meta.main) {
  const signers = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--signer' ? a.split(',') : [])).map(a => getAddress(a.trim()))
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8600
  const simple = process.argv.includes('--simple')
  const sb = await startSandbox({ basePort: port + 1, servicePort: port + 55, log: process.argv.includes('--log'), signers, simple })
  const runId = String(Date.now())
  const labels = ACCOUNTS.map(a => {
    const owner = sb.owners.indexOf(a.address), incoming = INCOMING.findIndex(i => i.address === a.address)
    const proposer = sb.service.delegates.some(d => d.delegate === a.address)
    return { address: a.address, label: owner >= 0 ? `Owner ${owner + 1}${signers.includes(a.address) ? ' (yours)' : ''}` : incoming >= 0 ? `Incoming owner ${incoming + 1}` : proposer ? 'Proposer (not an owner)' : 'Not an owner' }
  })
  const draft = { mode: 'owners', source: '', excluded: [], ...sb.draft }
  const cfg = `window.__SANDBOX__=${JSON.stringify({ runId, rpcs: sb.rpc, accounts: labels, settings: sb.settings, draft, walletOnly: !simple })};`
  const server = Bun.serve({
    port,
    async fetch() {
      // Read on every request, so a rebuild (or a wallet edit) shows on reload.
      const boot = `${cfg}\n${await Bun.file(`${root}test/sandbox-wallet.js`).text()}`
      const html = (await Bun.file(`${root}dist/safe-sync.html`).text()).replace('<head>', () => `<head><script>${boot}</script>`)
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    },
  })
  console.log(simple ? `
Safe Sync simple sandbox: http://localhost:${server.port}

  Safe ${sb.team}, ${sb.owners.length}-of-${sb.owners.length}, owners ${sb.owners.join(', ')}
  on local chains ${SIMPLE_CHAIN_IDS.join(', ')} (RPC ${sb.chains[0].rpc} and up), mock Safe service on :${sb.service.port}
  The draft adds two owners. Sign once with each owner, then execute.

  Your browser wallet adds each local chain the first time (one approval per chain), so signing and
  executing both go to these local chains. Remove those networks from the wallet afterwards.
  Ctrl-C to stop.
` : `
Safe Sync sandbox: http://localhost:${server.port}

  ${CHAIN_IDS.length} local chains, one mock Safe service for all of them on :${sb.service.port}
  Team Safe ${sb.team} (5-of-9) on every chain, original Safe ${sb.original} on Ethereum, Safe 1.4.1 ${sb.scroll141} on Scroll${signers.length ? `\n  Your signers are owners ${signers.map((a, i) => `${9 - signers.length + i + 1} (${a})`).join(', ')} on all of them, with 100 ETH on every local chain` : ''}
  Set up to include: different nonces, a rotation already applied on Linea, transactions already queued on Gnosis and Polygon,
  the same rotation already queued on the original Safe with one signature, and a proposer (Safe{Wallet}
  delegate of owner 2) that proposes signed but never confirms. "Not an owner" only views the link.

  The draft is filled in: Review → Copy signing link → Propose now.
  Choose who signs in the "Sandbox wallet" box at the bottom left. Other wallets are hidden here: these chains
  use real chain ids, so a real wallet would send executions to the real networks (use --simple for that).
  Ctrl-C to stop.
`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { sb.stop(); process.exit(0) })
}
