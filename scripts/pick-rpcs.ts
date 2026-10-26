// Regenerates src/chains.ts: for each chain, picks the fastest public RPC from
// chainlist.org that answers browser (CORS) JSON-RPC batch requests correctly.
// Usage: bun scripts/pick-rpcs.ts

// Chains with an official Safe Transaction Service, keyed by its EIP-3770 short name.
const SERVICE: Record<number, string> = {
  1: 'eth', 10: 'oeth', 50: 'xdc', 56: 'bnb', 100: 'gno', 130: 'unichain', 137: 'pol', 143: 'monad',
  146: 'sonic', 196: 'okb', 204: 'opbnb', 324: 'zksync', 480: 'wc', 677: 'bot', 988: 'stable',
  999: 'hyper', 1672: 'pharos', 2818: 'morph', 3338: 'peaq', 4217: 'tempo', 4326: 'mega',
  4663: 'robinhood', 5000: 'mantle', 5042: 'arc', 8217: 'kaia', 8453: 'base', 9745: 'plasma',
  16661: '0g', 25363: 'fluent', 36900: 'adi', 42161: 'arb1', 42220: 'celo', 43111: 'hemi',
  43114: 'avax', 57073: 'ink', 59144: 'linea', 80094: 'berachain', 102030: 'ctc', 534352: 'scr',
  747474: 'katana', 1313161554: 'aurora', 11155111: 'sep', 84532: 'basesep',
}
// Services someone else runs with the same API (found through each app's gateway /v1/chains/<id>):
// [service, Safe{Wallet} app, the app's chain prefix in links].
const COMMUNITY: Record<number, [string, string, string]> = {
  252: ['https://safe.mainnet.frax.com/txs', 'https://safe.mainnet.frax.com', 'fraxtal'], // Frax
  167000: ['https://transaction-taiko.safe.protofire.io', 'https://app.safe.protofire.io', 'tko-mainnet'], // Protofire
}
// Popular chains without an official service (a community one above, or signatures travel as a pasted bundle).
const EXTRA = [252, 167000, 42793, 2222, 239, 81457, 34443, 7777777, 250, 1088, 1284, 1329, 1868, 1923, 1135, 1101, 42170, 60808, 25, 33139, 98866]

type Rec = { chainId: number; name: string; shortName: string; nativeCurrency: { symbol: string }; rpc: { url: string; tracking?: string }[]; explorers?: { url: string }[] }
const list: Rec[] = await (await fetch('https://chainlist.org/rpcs.json')).json()
const byId = new Map(list.map(r => [r.chainId, r]))
// Lower is better. drpc/1rpc free tiers cap batches and drop calls under load, so they go last.
const rank = (t: string | undefined, url: string) => (({ none: 0, limited: 1 } as Record<string, number>)[t ?? ''] ?? (t === 'yes' ? 3 : 2)) + (/drpc\.org|1rpc\.io/.test(url) ? 4 : 0)

async function probe(url: string, id: number): Promise<{ ms: number; revert: boolean }> {
  const t0 = performance.now()
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.headers.get('access-control-allow-origin')) throw new Error('no cors')
    return res.json()
  }
  // A reverting eth_call too: simulation needs the revert data back.
  const [chain, block, revert] = await Promise.all([call('eth_chainId', []), call('eth_blockNumber', []), call('eth_call', [{ data: '0x60016000526001601ffd' }, 'latest'])])
  if (Number(chain.result) !== id || !block.result) throw new Error('bad')
  // Non-EVM-equivalent chains (zkSync) cannot run init code in eth_call; accept them, but rank lower.
  return { ms: performance.now() - t0, revert: JSON.stringify(revert.error ?? '').includes('"0x01"') }
}

const rows: string[] = []
for (const id of [...Object.keys(SERVICE).map(Number), ...EXTRA]) {
  const r = byId.get(id)
  if (!r) { console.error('missing', id); continue }
  const urls = r.rpc.filter(x => x.url.startsWith('https://') && !/[${}]|api[_-]?key/i.test(x.url)).sort((a, b) => rank(a.tracking, a.url) - rank(b.tracking, b.url)).slice(0, 10)
  const timed = await Promise.all(urls.map(async x => ({ url: x.url, rank: rank(x.tracking, x.url), ...(await probe(x.url, id).catch(() => ({ ms: Infinity, revert: false }))) })))
  // Prefer endpoints that return revert data, then privacy-friendly ones unless they are much slower.
  const ok = timed.filter(x => x.ms < Infinity), withRevert = ok.filter(x => x.revert)
  const best = (withRevert.length ? withRevert : ok).sort((a, b) => a.rank - b.rank || a.ms - b.ms)
  const pick = best.find(x => x.ms < (best[0]?.ms ?? 0) * 3 + 400) ?? best[0]
  if (!pick) { console.error('no rpc', id, r.name); continue }
  // A second endpoint from a different provider, used when the first fails.
  const host = (u: string) => new URL(u).hostname.split('.').slice(-2).join('.')
  const backup = [...best, ...ok.sort((a, b) => a.ms - b.ms)].find(x => host(x.url) !== host(pick.url))
  const rpcs = backup ? [pick.url, backup.url] : [pick.url]
  // Service chains must use Safe's short name; others get a readable one when EIP-3770's is long (tko-mainnet → taiko).
  const short = SERVICE[id] ?? (r.shortName.length <= 8 ? r.shortName : r.name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, ''))
  const explorer = r.explorers?.[0]?.url ?? ''
  rows.push(`  [${id}, ${JSON.stringify(r.name)}, ${JSON.stringify(short)}, ${JSON.stringify(r.nativeCurrency.symbol)}, ${JSON.stringify(rpcs)}, ${JSON.stringify(explorer)}, ${id in SERVICE || JSON.stringify(COMMUNITY[id] ?? false)}],`)
  console.error(id, short, pick.url, Math.round(pick.ms) + 'ms')
}

await Bun.write(new URL('../src/chains.ts', import.meta.url), `// Generated by scripts/pick-rpcs.ts. RPCs are public defaults; override them in Settings.
/** A chain's Safe Transaction Service, the Safe{Wallet} app that shows it, and the chain prefix that app uses in links. */
export type SafeService = { url: string; app: string; prefix: string }
export type Chain = { id: number; name: string; short: string; symbol: string; rpcs: string[]; explorer: string; service?: SafeService }

// [id, name, EIP-3770 short name, native symbol, public RPCs (primary, fallback), explorer,
//  Safe service: true for Safe's own, [service, app, app prefix] for one someone else runs, false for none]
const rows: [number, string, string, string, string[], string, boolean | [string, string, string]][] = [
${rows.join('\n')}
]

const service = (short: string, s: boolean | [string, string, string]): SafeService | undefined =>
  s === true ? { url: \`https://api.safe.global/tx-service/\${short}\`, app: 'https://app.safe.global', prefix: short } : s ? { url: s[0], app: s[1], prefix: s[2] } : undefined
export const CHAINS: Chain[] = rows.map(([id, name, short, symbol, rpcs, explorer, s]) => ({ id, name, short, symbol, rpcs, explorer, service: service(short, s) }))
`)
