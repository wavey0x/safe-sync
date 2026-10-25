// Read-only check of the plan's rotation example against live chains.
// Usage: bun scripts/validate-example.ts   (uses <CHAIN>_RPC_URL env vars when present)
import { CHAINS } from '../src/chains'
import { config, client, parseActions, parseTargets, payloadKey, prepareTarget, resolveNames, describe, encodeBatch, batchId, short } from '../src/safe'
import { getTx } from '../src/service'

const ENV: Record<number, string | undefined> = {
  1: process.env.ETHEREUM_RPC_URL, 10: process.env.OPTIMISM_RPC_URL, 100: process.env.GNOSIS_RPC_URL, 137: process.env.POLYGON_RPC_URL,
  146: process.env.SONIC_RPC_URL, 42161: process.env.ARBITRUM_RPC_URL, 43114: process.env.AVALANCHE_RPC_URL, 167000: process.env.TAIKO_RPC_URL,
  747474: process.env.KATANA_RPC_URL, 5042: process.env.ARC_RPC_URL,
}
for (const [id, url] of Object.entries(ENV)) if (url) config.rpc[Number(id)] = url

const SAFE = '0x6d447e544D01a59cb0774763bf15526574CffFeD'
const found = (await Promise.all(CHAINS.filter(c => !c.name.toLowerCase().includes('sepolia')).map(async c => {
  try { const code = await client(c.id).getCode({ address: SAFE }); return code && code !== '0x' ? c : null } catch { return null }
}))).filter(Boolean)
console.log(`${SAFE} deployed on ${found.length} chains: ${found.map(c => c!.short).join(' ')}`)

const targets = parseTargets(`${SAFE} ${found.map(c => c!.id).join(' ')}\neth:0x467947EE34aF926cF1DCac093870f613C96B1E0c`)
const actions = parseActions(`swap 0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3 winthorpe.eth\nswap 0xe9A65fe8190fA5A4b5E277b84f0aAce686FDc174 0x4046B37Ffc36B0C723d7Fc64e0C763B698D81934`)
if (targets.errors.length || actions.errors.length) throw new Error([...targets.errors, ...actions.errors].join('\n'))
const names = await resolveNames(actions.actions)
console.log('names', names)

const t0 = Date.now()
const prepared = await Promise.all(targets.targets.map(t => prepareTarget(t, actions.actions, names)))
console.log(`prepared ${prepared.length} in ${Date.now() - t0}ms`)
for (const p of prepared) {
  const c = CHAINS.find(c => c.id === p.chainId)
  console.log([c?.short.padEnd(14), short(p.safe), `v${p.state?.version}`, `nonce ${p.tx?.nonce ?? p.state?.nonce}`, `${p.state?.threshold}/${p.state?.owners.length}→${p.threshold}/${p.owners?.length}`,
    p.sim?.ok ? `sim ok gas ${p.sim.gas}` : `sim ${p.sim?.ok === false ? p.sim.error : '-'}`, p.hash ?? '', p.error ?? p.skip ?? ''].join('  '))
}
const ok = prepared.filter(p => p.tx && !p.error)
const groups = new Map<string, number>(), exact = new Map<string, number>()
for (const p of ok) groups.set(payloadKey(p.tx!), (groups.get(payloadKey(p.tx!)) ?? 0) + 1), exact.set(p.tx!.data, (exact.get(p.tx!.data) ?? 0) + 1)
console.log(`groups (up to self address): ${[...groups.values()]}; exact calldata groups: ${[...exact.values()]}`)
const nonces = new Map<number, string[]>()
for (const p of ok) nonces.set(p.tx!.nonce, [...(nonces.get(p.tx!.nonce) ?? []), CHAINS.find(c => c.id === p.chainId)!.short])
console.log('nonces', Object.fromEntries([...nonces].map(([n, cs]) => [n, `${cs.length}: ${cs.join(' ')}`])))
console.log('steps', JSON.stringify(describe(ok[0].tx!), (_, v) => typeof v === 'bigint' ? v.toString() : v))

const orig = ok.find(p => p.safe === '0x467947EE34aF926cF1DCac093870f613C96B1E0c')!
const svc = await getTx(1, orig.hash!)
console.log(`original Safe hash ${orig.hash} ${svc ? `MATCHES existing Transaction Builder proposal (nonce ${svc.nonce}, ${svc.confirmations.length} confirmations)` : 'not in service'}`)

const b = { title: 'Rotate 2 signers', created: Date.now(), txs: ok.map(p => p.tx!), labels: { [names['winthorpe.eth'].toLowerCase()]: 'winthorpe.eth' }, src: { targets: '', actions: '' } }
const link = await encodeBatch(b)
console.log(`link payload ${link.length} chars, batch id ${batchId(b)}`)
