// Safe Transaction Service client. It is the shared state between signers: proposals and
// confirmations land where Safe{Wallet} also sees them. Calls go straight from the browser
// (CORS is open; no key needed) through one throttled queue that stays under the rate limit.
import type { Address, Hex } from 'viem'
import { chainOf, ZERO, type Tx } from './safe'

export const config = { service: {} as Record<number, string>, apiKey: '', gapMs: 1000 }

export function serviceUrl(chainId: number): string | undefined {
  if (config.service[chainId]) return config.service[chainId].replace(/\/+$/, '').replace(/\/api$/, '')
  return chainOf(chainId)?.service?.url
}

// Safe allows 2 req/s per IP without a key, 5 req/s per account with one, but teammates behind one network or
// sharing one key share that budget. So each browser stays at 1 req/s (gapMs), 2.5 with a key, and backs off on 429.
// Each service host has its own pace: a community-run service doesn't wait behind Safe's.
const paces = new Map<string, { last: number; queue: Promise<unknown> }>()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function slot(host: string, gap: number): Promise<void> {
  const p = paces.get(host) ?? { last: 0, queue: Promise.resolve() }
  paces.set(host, p)
  const next = p.queue.then(async () => {
    await sleep(Math.max(0, p.last + gap - Date.now()))
    p.last = Date.now()
  })
  p.queue = next
  return next
}

async function api(chainId: number, path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<Response> {
  const base = serviceUrl(chainId)
  if (!base) throw new Error('No Safe Transaction Service for this chain')
  const host = new URL(base).host, keyed = !!config.apiKey && host === 'api.safe.global'
  for (let attempt = 0; ; attempt++) {
    await slot(host, keyed ? config.gapMs * 0.4 : config.gapMs)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (keyed) headers.authorization = `Bearer ${config.apiKey}`
    const res = await fetch(`${base}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      if ((await res.clone().text()).includes('Monthly quota')) return res
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt)
      continue
    }
    return res
  }
}

async function fail(res: Response): Promise<never> {
  const t = await res.text()
  throw new Error(`Safe service ${res.status}: ${t.slice(0, 300)}`)
}

/** Read every page without trusting a service-supplied URL as a new request destination. */
async function list<T>(chainId: number, path: string): Promise<T[]> {
  const results: T[] = []
  for (let offset = 0; ; ) {
    const res = await api(chainId, `${path}&offset=${offset}`)
    if (!res.ok) await fail(res)
    const page: { results: T[]; next: string | null } = await res.json()
    results.push(...page.results)
    if (!page.next) return results
    if (!page.results.length) throw new Error('Safe service returned an empty page with more results')
    offset += page.results.length
  }
}

export type ServiceTx = { safe: Address; to: Address; value: string; data: Hex | null; operation: number; nonce: string; safeTxHash: Hex; isExecuted: boolean; trusted: boolean; proposedByDelegate: Address | null; confirmations: { owner: Address; signature: Hex }[] }

export async function getTx(chainId: number, hash: Hex): Promise<ServiceTx | null> {
  const res = await api(chainId, `/v2/multisig-transactions/${hash}/`)
  if (res.status === 404) return null
  if (!res.ok) await fail(res)
  return res.json()
}

/** Trusted transactions at one nonce. Look up our own unsigned proposal by hash, keeping unsigned spam out. */
export async function atNonce(chainId: number, safe: Address, nonce: number): Promise<ServiceTx[]> {
  return list<ServiceTx>(chainId, `/v2/safes/${safe}/multisig-transactions/?nonce=${nonce}&limit=20`)
}

/**
 * Other not-yet-executed transactions queued at or after `nonce`: trusted ones only (the service's default), since anyone
 * can post an unsigned proposal. They decide the nonce of a new transaction (pickNonce).
 */
export async function queued(chainId: number, safe: Address, nonce: number): Promise<{ nonce: number; safeTxHash: Hex }[]> {
  return (await list<ServiceTx>(chainId, `/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=${nonce}&limit=50`))
    .map(t => ({ nonce: Number(t.nonce), safeTxHash: t.safeTxHash }))
}

const proposal = (tx: Tx, hash: Hex, sender: Address, signature: Hex) => api(tx.chainId, `/v2/safes/${tx.safe}/multisig-transactions/`, {
  to: tx.to, value: tx.value, data: tx.data === '0x' ? null : tx.data, operation: tx.operation,
  safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: String(tx.nonce),
  contractTransactionHash: hash, sender, signature, origin: JSON.stringify({ name: 'Safe Sync' }),
})

/** Posts one signature: proposes the transaction if nobody has yet, otherwise adds a confirmation. */
export async function submit(tx: Tx, hash: Hex, owner: Address, signature: Hex, proposed: boolean): Promise<void> {
  const confirm = () => api(tx.chainId, `/v1/multisig-transactions/${hash}/confirmations/`, { signature })
  const propose = () => proposal(tx, hash, owner, signature)
  let res = await (proposed ? confirm() : propose())
  // Someone else proposed (or the proposal vanished) in the meantime: try the other route once.
  if (!res.ok && res.status < 500) res = await (proposed ? propose() : confirm())
  if (!res.ok) await fail(res)
}

/** Proposes as a proposer (a Safe{Wallet} delegate): its signature makes the proposal trusted, but isn't a confirmation. */
export async function propose(tx: Tx, hash: Hex, delegate: Address, signature: Hex): Promise<void> {
  const res = await proposal(tx, hash, delegate, signature)
  if (!res.ok) await fail(res)
}

/** One owner naming `delegate` a proposer: for one Safe, or (safe null) every Safe the delegator owns. */
export type Delegation = { safe: Address | null; delegate: Address; delegator: Address; label: string; expiryDate: string | null }

/** Every delegation naming `delegate` on this chain, expired ones included (the service lists those too). */
export async function delegations(chainId: number, delegate: Address): Promise<Delegation[]> {
  return list<Delegation>(chainId, `/v2/delegates/?delegate=${delegate}&limit=100`)
}

/** The proposers named for this one Safe, as Safe{Wallet} lists them: expired ones and a former owner's included. */
export async function proposers(chainId: number, safe: Address): Promise<Delegation[]> {
  return list<Delegation>(chainId, `/v2/delegates/?safe=${safe}&limit=100`)
}

/** `delegator`, an owner, names `delegate` a proposer of `safe` (again with the same delegator: just a new label). */
export async function addProposer(chainId: number, p: { safe: Address; delegate: Address; delegator: Address; label: string; signature: Hex }): Promise<void> {
  const res = await api(chainId, '/v2/delegates/', p)
  if (!res.ok) await fail(res)
}

/** Ends what `delegator` named: signed by that delegator or by the proposer itself. One already gone is fine. */
export async function removeProposer(chainId: number, p: { safe: Address; delegate: Address; delegator: Address; signature: Hex }): Promise<void> {
  const res = await api(chainId, `/v2/delegates/${p.delegate}/`, { safe: p.safe, delegator: p.delegator, signature: p.signature }, 'DELETE')
  if (!res.ok && res.status !== 404) await fail(res)
}
