// A local copy of a team's real situation, for end-to-end tests and for trying the app by hand:
// 14 anvil chains with real chain ids, the canonical Safe contracts at their canonical addresses,
// a 5-of-9 team Safe at the same address everywhere plus two odd ones, the awkward cases that come up
// in practice, and the mock Safe Transaction Service.
//
//   bun run sandbox      serves the app on http://localhost:8600 with a sandbox wallet (pick any signer)
//   startSandbox()       used by test/sandbox.test.ts
import { createWalletClient, encodeFunctionData, getAddress, http, parseAbi, publicActions, type Address, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { CHAINS } from '../src/chains'
import { execData, normalizeSig, parseActions, prepareTarget, readSafe, safeTxHash, walletTypedData, config, type Tx } from '../src/safe'
import { startMockService } from './mock-service'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname)
const MNEMONIC = 'test test test test test test test test test test test junk'
export const ACCOUNTS = Array.from({ length: 12 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }))
const [EXECUTOR, ...REST] = ACCOUNTS
export const OWNERS = REST.slice(0, 9) // 5-of-9, like the Curve emergency Safes
export const INCOMING = REST.slice(9, 11)

// 12 chains with an official Safe service, 2 without (Fraxtal, Taiko).
export const CHAIN_IDS = [1, 10, 56, 100, 137, 146, 8453, 42161, 43114, 59144, 534352, 5000, 252, 167000]
const NO_SERVICE = new Set([252, 167000])

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

export async function startSandbox({ basePort = 8601, servicePort = 0, rps = 2, log = false } = {}) {
  const chains = CHAIN_IDS.map((id, i) => ({
    id, rpc: `http://127.0.0.1:${basePort + i}`,
    proc: Bun.spawn(['anvil', '--chain-id', String(id), '--port', String(basePort + i), '--accounts', '12', '--silent'], { stdout: 'ignore', stderr: 'ignore' }),
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
      for (const [a, bytecode] of Object.entries(code)) await wallet(c.id).request({ method: 'anvil_setCode' as any, params: [a, bytecode] as any })
    }))

    const deploy = async (chainId: number, owners: Address[], salt: bigint, v141 = false) => {
      const w = wallet(chainId)
      const init = encodeFunctionData({ abi: ABI, functionName: 'setup', args: [owners, 5n, ZERO, '0x', v141 ? C.handler_141 : C.handler_130, ZERO, 0n, ZERO] })
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
      const sigs = await Promise.all(OWNERS.slice(0, 5).map(async o => ({ owner: o.address, sig: await sign(tx, o) })))
      const w = wallet(tx.chainId)
      const rc = await w.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: tx.safe, data: execData(tx, sigs, 5), chain: null }) })
      if (rc.status !== 'success') throw new Error('setup execution failed')
    }
    // A harmless transaction, to move a Safe's nonce forward.
    const bump = async (chainId: number, safe: Address) => execute({ chainId, safe, nonce: (await readSafe(chainId, safe)).nonce, to: EXECUTOR.address, value: '0', data: '0x', operation: 0 })

    // The team Safe: same owners, same address on every chain.
    const teams = await Promise.all(CHAIN_IDS.map(id => deploy(id, OWNERS.map(o => o.address), 1n)))
    if (new Set(teams).size !== 1) throw new Error('team Safe addresses differ across chains')
    const team = teams[0]
    // The original Safe on Ethereum: same owners in a different order, so prevOwner differs.
    const original = await deploy(1, [...OWNERS.slice(4), ...OWNERS.slice(0, 4)].map(o => o.address), 2n)
    // A newer Safe (1.4.1) on Scroll at its own address.
    const scroll141 = await deploy(534352, OWNERS.map(o => o.address), 1n, true)

    const targets = [`${team} ${CHAIN_IDS.map(id => CHAINS.find(c => c.id === id)!.short).join(' ')}`, `eth:${original}`, `scr:${scroll141}`].join('\n')
    // Same shape as the Curve rotation: two swaps, one of them the first owner (prevOwner = sentinel).
    const actions = `swap ${OWNERS[2].address} ${INCOMING[0].address}\nswap ${OWNERS[0].address} ${INCOMING[1].address}`

    // Different nonces, as on real chains.
    await bump(10, team); await bump(146, team); await bump(42161, team); await bump(42161, team)
    for (let i = 0; i < 3; i++) await bump(1, original)
    // Already rotated on Linea (someone did it by hand): shows up as "already applied".
    const parsed = parseActions(actions).actions
    const linea = await prepareTarget({ chainId: 59144, safe: team }, parsed, {})
    await execute(linea.tx!)

    const service = startMockService({ port: servicePort, rps, rpc: Object.fromEntries(CHAIN_IDS.filter(id => !NO_SERVICE.has(id)).map(id => [id, rpc[id]])), log })
    const post = (chainId: number, path: string, body: unknown) =>
      fetch(`${service.url(chainId)}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const propose = async (tx: Tx, signer: (typeof OWNERS)[number]) => {
      const res = await post(tx.chainId, `/v2/safes/${tx.safe}/multisig-transactions/`, {
        to: tx.to, value: tx.value, data: tx.data === '0x' ? null : tx.data, operation: tx.operation, safeTxGas: '0', baseGas: '0', gasPrice: '0',
        gasToken: ZERO, refundReceiver: ZERO, nonce: String(tx.nonce), contractTransactionHash: safeTxHash(tx), sender: signer.address,
        signature: await sign(tx, signer), origin: JSON.stringify({ name: 'Sandbox setup' }),
      })
      if (res.status !== 201) throw new Error(`setup proposal failed: ${await res.text()}`)
    }
    // Someone already queued this rotation on the original Safe in Safe{Wallet}, with one signature.
    await propose((await prepareTarget({ chainId: 1, safe: original }, parsed, {})).tx!, OWNERS[1])
    // An unrelated transaction is queued on Gnosis at the same nonce: a conflict to notice.
    await propose({ chainId: 100, safe: team, nonce: 0, to: team, value: '0', data: encodeFunctionData({ abi: ABI, functionName: 'changeThreshold', args: [4n] }), operation: 0 }, OWNERS[3])

    return {
      chains: chains.map(({ id, rpc }) => ({ id, rpc })), rpc, service, team, original, scroll141, targets, actions,
      serviceChains: CHAIN_IDS.filter(id => !NO_SERVICE.has(id)), noServiceChains: [...NO_SERVICE],
      settings: {
        rpc: chains.map(c => `${c.id} ${c.rpc}`).join('\n'),
        service: CHAIN_IDS.filter(id => !NO_SERVICE.has(id)).map(id => `${id} ${service.url(id)}`).join('\n'),
        apiKey: '',
      },
      stop: () => { service.stop(); stopChains() },
    }
  } catch (e) { stopChains(); throw e }
}

if (import.meta.main) {
  const sb = await startSandbox({ servicePort: 8655, log: process.argv.includes('--log') })
  const runId = String(Date.now())
  const labels = ACCOUNTS.map((a, i) => ({ address: a.address, label: i === 0 ? 'Executor (not an owner)' : i <= 9 ? `Owner ${i}` : `Incoming owner ${i - 9}` }))
  const boot = `window.__SANDBOX__=${JSON.stringify({ runId, rpcs: sb.rpc, accounts: labels, settings: sb.settings, draft: { title: 'Rotate 2 signers (sandbox)', targets: sb.targets, actions: sb.actions } })};\n${await Bun.file(`${root}test/sandbox-wallet.js`).text()}`
  const server = Bun.serve({
    port: 8600,
    async fetch() {
      const html = (await Bun.file(`${root}dist/fanout.html`).text()).replace('<head>', () => `<head><script>${boot}</script>`)
      return new Response(html, { headers: { 'content-type': 'text/html' } })
    },
  })
  console.log(`
Fanout sandbox: http://localhost:${server.port}

  ${CHAIN_IDS.length} local chains (${sb.noServiceChains.length} without a Safe service), mock Safe service on :${sb.service.port}
  Team Safe ${sb.team} (5-of-9) on every chain, original Safe ${sb.original} on Ethereum, Safe 1.4.1 ${sb.scroll141} on Scroll
  Set up to include: different nonces, a rotation already applied on Linea, a conflicting queued tx on Gnosis,
  and the same rotation already queued on the original Safe with one signature.

  The draft is filled in: Prepare → Create signing link → Open to sign.
  Choose who signs in the "Sandbox wallet" box at the bottom right. Ctrl-C to stop.
`)
  process.on('SIGINT', () => { sb.stop(); process.exit(0) })
}
