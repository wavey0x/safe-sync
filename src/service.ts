// Safe Transaction Service client. It is the shared state between signers: proposals and
// confirmations land where Safe{Wallet} also sees them. Calls go straight from the browser
// (CORS is open; no key needed) through one throttled queue that stays under the rate limit.
import type { Address, Hex } from 'viem'
import { chainOf, ZERO, type Tx } from './safe'

export const config = { service: {} as Record<number, string>, apiKey: '', gapMs: 1000 }

export function serviceUrl(chainId: number): string | undefined {
  if (config.service[chainId]) return config.service[chainId].replace(/\/+$/, '').replace(/\/api$/, '')
  const c = chainOf(chainId)
  return c?.service ? `https://api.safe.global/tx-service/${c.short}` : undefined
}

// Safe allows 2 req/s per IP without a key, 5 req/s per account with one, but teammates behind one
// network or sharing one key share that budget. So each browser stays at 1 req/s (gapMs) and backs off on 429.
let last = 0, queue: Promise<unknown> = Promise.resolve()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function slot(): Promise<void> {
  const next = queue.then(async () => {
    await sleep(Math.max(0, last + config.gapMs - Date.now()))
    last = Date.now()
  })
  queue = next
  return next
}

async function api(chainId: number, path: string, body?: unknown): Promise<Response> {
  const base = serviceUrl(chainId)
  if (!base) throw new Error('No Safe Transaction Service for this chain')
  for (let attempt = 0; ; attempt++) {
    await slot()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.apiKey && base.includes('api.safe.global')) headers.authorization = `Bearer ${config.apiKey}`
    const res = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined })
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

export type ServiceTx = { safe: Address; to: Address; value: string; data: Hex | null; operation: number; nonce: string; safeTxHash: Hex; isExecuted: boolean; confirmations: { owner: Address; signature: Hex }[] }

export async function getTx(chainId: number, hash: Hex): Promise<ServiceTx | null> {
  const res = await api(chainId, `/v2/multisig-transactions/${hash}/`)
  if (res.status === 404) return null
  if (!res.ok) await fail(res)
  return res.json()
}

/** Every transaction at one nonce of a Safe, executed or not: ours (with its confirmations) and any competitor, in one request. */
export async function atNonce(chainId: number, safe: Address, nonce: number): Promise<ServiceTx[]> {
  const res = await api(chainId, `/v2/safes/${safe}/multisig-transactions/?nonce=${nonce}&limit=20`)
  if (!res.ok) await fail(res)
  return (await res.json()).results
}

/** Other not-yet-executed transactions queued at or after `nonce` (potential conflicts). */
export async function queued(chainId: number, safe: Address, nonce: number): Promise<{ nonce: number; safeTxHash: Hex }[]> {
  const res = await api(chainId, `/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=${nonce}&limit=50`)
  if (!res.ok) await fail(res)
  return (await res.json()).results.map((t: any) => ({ nonce: Number(t.nonce), safeTxHash: t.safeTxHash }))
}

/** Posts one signature: proposes the transaction if nobody has yet, otherwise adds a confirmation. */
export async function submit(tx: Tx, hash: Hex, owner: Address, signature: Hex, proposed: boolean): Promise<void> {
  const confirm = () => api(tx.chainId, `/v1/multisig-transactions/${hash}/confirmations/`, { signature })
  const propose = () => api(tx.chainId, `/v2/safes/${tx.safe}/multisig-transactions/`, {
    to: tx.to, value: tx.value, data: tx.data === '0x' ? null : tx.data, operation: tx.operation,
    safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: String(tx.nonce),
    contractTransactionHash: hash, sender: owner, signature, origin: JSON.stringify({ name: 'Safe Sync' }),
  })
  let res = await (proposed ? confirm() : propose())
  // Someone else proposed (or the proposal vanished) in the meantime: try the other route once.
  if (!res.ok && res.status < 500) res = await (proposed ? propose() : confirm())
  if (!res.ok) await fail(res)
}
