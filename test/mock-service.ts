// In-memory stand-in for the Safe Transaction Service endpoints Fanout uses, one per chain
// under /<chainId>. Validates hashes and signatures like the real one. Used by tests and the
// browser end-to-end run:  bun test/mock-service.ts [port]
import type { Address, Hex } from 'viem'
import { safeTxHash, sigOwner, type Tx } from '../src/safe'

type Stored = Tx & { safeTxHash: Hex; isExecuted: boolean; confirmations: { owner: Address; signature: Hex }[] }

export function startMockService(port = 0) {
  const txs = new Map<string, Stored>()
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
  const json = (body: unknown, status = 200) => {
    if (status >= 400 && status !== 404) console.error(status, JSON.stringify(body))
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } })
  }
  const server = Bun.serve({
    port,
    async fetch(req) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
      const url = new URL(req.url)
      const m = url.pathname.match(/^\/(\d+)\/api(\/.*)$/)
      if (!m) return json({ detail: 'not found' }, 404)
      const chainId = Number(m[1]), path = m[2]
      let r: RegExpMatchArray | null
      if (req.method === 'GET' && (r = path.match(/^\/v2\/multisig-transactions\/(0x[0-9a-f]{64})\/$/i))) {
        const t = txs.get(r[1].toLowerCase())
        return t ? json(t) : json({ detail: 'Not found.' }, 404)
      }
      if (req.method === 'GET' && (r = path.match(/^\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/))) {
        const gte = Number(url.searchParams.get('nonce__gte') ?? 0)
        return json({ results: [...txs.values()].filter(t => t.chainId === chainId && t.safe.toLowerCase() === r![1].toLowerCase() && t.nonce >= gte && !t.isExecuted) })
      }
      if (req.method === 'POST' && (r = path.match(/^\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/))) {
        const b = await req.json()
        const tx: Tx = { chainId, safe: r[1] as Address, nonce: Number(b.nonce), to: b.to, value: String(b.value), data: b.data ?? '0x', operation: b.operation }
        const hash = safeTxHash(tx)
        if (hash !== b.contractTransactionHash) return json({ nonFieldErrors: ['Contract-transaction-hash does not match'] }, 422)
        if (txs.has(hash)) return json({ nonFieldErrors: ['Tx with safe-tx-hash already exists'] }, 422)
        if ((await sigOwner(hash, b.signature))?.toLowerCase() !== b.sender.toLowerCase()) return json({ nonFieldErrors: ['Signature does not match sender'] }, 422)
        txs.set(hash, { ...tx, nonce: tx.nonce, safeTxHash: hash, isExecuted: false, confirmations: [{ owner: b.sender, signature: b.signature }] })
        return json({}, 201)
      }
      if (req.method === 'POST' && (r = path.match(/^\/v1\/multisig-transactions\/(0x[0-9a-f]{64})\/confirmations\/$/i))) {
        const t = txs.get(r[1].toLowerCase())
        if (!t) return json({ detail: 'Not found.' }, 404)
        const { signature } = await req.json()
        const owner = await sigOwner(t.safeTxHash, signature)
        if (!owner) return json({ signature: ['bad signature'] }, 400)
        if (!t.confirmations.some(c => c.owner === owner)) t.confirmations.push({ owner, signature })
        return json({}, 201)
      }
      return json({ detail: 'not found' }, 404)
    },
  })
  return { url: (chainId: number) => `http://127.0.0.1:${server.port}/${chainId}`, txs, stop: () => server.stop(true), port: server.port }
}

if (import.meta.main) {
  const s = startMockService(Number(process.argv[2] ?? 8655))
  console.log(`mock Safe Transaction Service on http://127.0.0.1:${s.port}/<chainId>`)
}
