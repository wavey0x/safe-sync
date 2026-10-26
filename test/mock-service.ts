// Stand-in for the Safe Transaction Service, for tests and the sandbox. It follows the real service's
// source for the endpoints Safe Sync uses (safe-transaction-service v6.13.0 @ 83316729, safe-eth-py 7.27.0):
// same paths, field validation, status codes, error texts and response shapes. Proposals live in memory;
// owners, versions, nonces, approvals and executions are read from the chain, as the real service does.
import { createPublicClient, getAddress, hashMessage, http, keccak256, parseAbi, recoverAddress, size, slice, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { CHAINS } from '../src/chains'
import { SAFE_ABI } from '../src/safe'

const ABI = [...SAFE_ABI, ...parseAbi(['function approvedHashes(address owner, bytes32 hash) view returns (uint256)'])]
const EXECUTION_SUCCESS = keccak256(toHex('ExecutionSuccess(bytes32,uint256)'))
// Contracts the service trusts as DELEGATECALL targets: the canonical MultiSend / MultiSendCallOnly deployments.
const TRUSTED_DELEGATECALL = new Set([
  '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761', '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', '0x998739BFdAAdde7C933B942a68053933098f9EDa',
  '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B', '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526', '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  '0x218543288004CD07832472D464648173c77D7eB7', '0xA83c336B20401Af773B6219BA5027174338D1836',
].map(a => a.toLowerCase()))

type Confirmation = { owner: Address; submissionDate: string; transactionHash: null; signature: Hex; signatureType: string }
type Stored = {
  chainId: number; safe: Address; to: Address; value: bigint; data: Hex | null; operation: number; gasToken: Address; safeTxGas: bigint
  baseGas: bigint; gasPrice: bigint; refundReceiver: Address; nonce: bigint; safeTxHash: Hex; proposer: Address; proposedByDelegate: Address | null; origin: string
  submissionDate: string; modified: string; trusted: boolean; confirmations: Confirmation[]
  executed?: { transactionHash: Hex; blockNumber: number; executor: Address; executionDate: string }
}
type Errors = Record<string, string[]>
/** A SafeContractDelegate row: `delegator` (an owner) lets `delegate` propose, for `safe` or (null) all of the delegator's Safes. */
export type Delegation = { chainId: number; safe: Address | null; delegate: Address; delegator: Address; label: string; expiryDate: string | null }

export type MockOptions = { port?: number; rpc: Record<number, string>; rps?: number; log?: boolean }

const isChecksummed = (a: unknown): a is Address => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a
const pyList = (xs: string[]) => `[${xs.map(x => `'${x}'`).join(', ')}]`
const pySet = (xs: Iterable<string>) => { const l = [...xs]; return l.length ? `{${l.map(x => `'${x}'`).join(', ')}}` : 'set()' }
const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const now = () => new Date().toISOString()

/** Field validation as DRF + safe-eth-py do it; returns errors keyed by camelCase field names. */
function validateFields(body: any, spec: Record<string, { kind: 'address' | 'int' | 'hex' | 'string'; required?: boolean; nullable?: boolean; zero?: boolean; sentinel?: boolean; blank?: boolean; min?: number; max?: number }>) {
  const errors: Errors = {}, out: Record<string, any> = {}
  const src: Record<string, any> = {}
  for (const [k, v] of Object.entries(body ?? {})) src[snake(k)] = v
  for (const [k, f] of Object.entries(spec)) {
    const fail = (m: string) => (errors[camel(k)] ??= []).push(m)
    const x = src[k]
    if (x === undefined) { if (f.required) fail('This field is required.'); else out[k] = null; continue }
    if (x === null) { if (f.nullable) out[k] = null; else fail('This field may not be null.'); continue }
    if (f.kind === 'address') {
      if (!isChecksummed(x)) fail(`Address ${x} is not checksumed`)
      else if (BigInt(x) === 0n && !f.zero) fail('0x0 address is not allowed')
      else if (BigInt(x) === 1n && !f.sentinel) fail('0x1 address is not allowed')
      else out[k] = x
    } else if (f.kind === 'int') {
      if (!(Number.isInteger(x) || (typeof x === 'string' && /^\s*-?\d+\s*$/.test(x)))) fail('A valid integer is required.')
      else if (BigInt(String(x).trim()) < 0n) fail('Ensure this value is greater than or equal to 0.')
      else out[k] = BigInt(String(x).trim())
    } else if (f.kind === 'hex') {
      const h = typeof x === 'string' ? x.trim().replace(/^0x/, '') : null
      if (h === null) fail(`${x} is not a hexadecimal value.`)
      else if (!h) { if (f.blank) out[k] = null; else fail('This field may not be blank.') }
      else if (!/^[0-9a-fA-F]*$/.test(h)) fail(`${x} is not a hexadecimal value.`)
      else {
        const bytes = Math.ceil(h.length / 2)
        if (f.min && bytes < f.min) fail(`Ensure this field has at least ${f.min} hexadecimal chars (not counting 0x).`)
        else if (f.max && bytes > f.max) fail(`Ensure this field has no more than ${f.max} hexadecimal chars (not counting 0x).`)
        else out[k] = `0x${h.length % 2 ? '0' : ''}${h.toLowerCase()}` as Hex
      }
    } else {
      if (typeof x !== 'string') fail('Not a valid string.')
      else if (f.max && x.length > f.max) fail(`Ensure this field has no more than ${f.max} characters.`)
      else out[k] = x
    }
  }
  return { errors, out }
}

export function startMockService(opts: MockOptions) {
  const txs = new Map<string, Stored>()
  const delegates: Delegation[] = [] // seeded by the sandbox and tests; the real service adds them through a signed POST
  /** SafeContractDelegateManager.get_for_safe: for this Safe or every Safe, named by a current owner, not expired. */
  const delegationsFor = (chainId: number, safe: Address, owners: Address[]) => delegates.filter(d =>
    d.chainId === chainId && (d.safe === null || d.safe === safe) && owners.includes(d.delegator) && (d.expiryDate === null || Date.parse(d.expiryDate) > Date.now()))
  const clients = new Map<number, PublicClient>()
  const client = (chainId: number) => {
    if (!clients.has(chainId)) clients.set(chainId, createPublicClient({ transport: http(opts.rpc[chainId]) }) as PublicClient)
    return clients.get(chainId)!
  }
  const read = (chainId: number, safe: Address, functionName: any, args: any[] = []) => client(chainId).readContract({ address: safe, abi: ABI, functionName, args } as any) as Promise<any>
  const shortToChain = (short: string) => CHAINS.find(c => c.short === short && opts.rpc[c.id])?.id ?? (opts.rpc[Number(short)] ? Number(short) : undefined)

  /** Marks proposals as executed once the chain has an ExecutionSuccess for their hash (the real service indexes the same event). */
  async function index(chainId: number, safe: Address) {
    const pending = [...txs.values()].filter(t => t.chainId === chainId && t.safe === safe && !t.executed)
    if (!pending.length) return
    const nonce = BigInt(await read(chainId, safe, 'nonce'))
    if (!pending.some(t => t.nonce < nonce)) return
    const logs = await client(chainId).request({ method: 'eth_getLogs', params: [{ address: safe, topics: [EXECUTION_SUCCESS], fromBlock: '0x0', toBlock: 'latest' }] }) as any[]
    for (const log of logs) {
      // txHash is indexed from Safe 1.4.1 on, in the data before that
      const hash = (log.topics[1] ?? slice(log.data, 0, 32)).toLowerCase()
      const t = txs.get(hash)
      if (!t || t.executed) continue
      const [tx, block] = await Promise.all([client(chainId).getTransaction({ hash: log.transactionHash }), client(chainId).getBlock({ blockHash: log.blockHash })])
      t.executed = { transactionHash: log.transactionHash, blockNumber: Number(log.blockNumber), executor: getAddress(tx.from), executionDate: new Date(Number(block.timestamp) * 1000).toISOString() }
      t.modified = now()
    }
  }

  /** SafeSignature.parse_signature + is_valid, for EOA, eth_sign and approved-hash signatures. */
  async function parseSignatures(chainId: number, safe: Address, hash: Hex, signature: Hex | null) {
    const out: { owner?: Address; signature: Hex; type: string; valid: boolean }[] = []
    if (!signature) return out
    for (let i = 0; i + 65 <= size(signature); i += 65) {
      const sig = slice(signature, i, i + 65), v = parseInt(sig.slice(-2), 16)
      try {
        if (v === 0 || v === 2) { out.push({ owner: getAddress(slice(sig, 12, 32)), signature: sig, type: v ? 'SECP256R1' : 'CONTRACT_SIGNATURE', valid: false }); continue }
        if (v === 1) {
          const owner = getAddress(slice(sig, 12, 32))
          out.push({ owner, signature: sig, type: 'APPROVED_HASH', valid: BigInt(await read(chainId, safe, 'approvedHashes', [owner, hash])) !== 0n })
        } else if (v > 30) {
          const owner = await recoverAddress({ hash: hashMessage({ raw: hash }), signature: (sig.slice(0, -2) + (v - 4).toString(16)) as Hex })
          out.push({ owner, signature: sig, type: 'ETH_SIGN', valid: true })
        } else {
          out.push({ owner: await recoverAddress({ hash, signature: sig }), signature: sig, type: 'EOA', valid: v === 27 || v === 28 })
        }
      } catch { out.push({ signature: sig, type: 'EOA', valid: false }) }
    }
    return out
  }

  const view = (t: Stored, threshold: number) => ({
    safe: t.safe, to: t.to, value: String(t.value), data: t.data, operation: t.operation, gasToken: t.gasToken,
    safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice), refundReceiver: t.refundReceiver,
    nonce: String(t.nonce), executionDate: t.executed?.executionDate ?? null, submissionDate: t.submissionDate, modified: t.modified,
    blockNumber: t.executed?.blockNumber ?? null, transactionHash: t.executed?.transactionHash ?? null, safeTxHash: t.safeTxHash,
    proposer: t.proposer, proposedByDelegate: t.proposedByDelegate, executor: t.executed?.executor ?? null, isExecuted: !!t.executed,
    isSuccessful: t.executed ? true : null, ethGasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null, gasUsed: null,
    fee: null, payment: null, origin: t.origin, dataDecoded: null, confirmationsRequired: threshold, confirmations: t.confirmations,
    trusted: t.trusted, signatures: null,
  })

  async function propose(chainId: number, safe: Address, body: any): Promise<[number, unknown]> {
    const { errors, out: a } = validateFields(body, {
      to: { kind: 'address', required: true, zero: true, sentinel: true }, value: { kind: 'int', required: true },
      data: { kind: 'hex', nullable: true, blank: true }, operation: { kind: 'int', required: true },
      gas_token: { kind: 'address', nullable: true, zero: true }, safe_tx_gas: { kind: 'int', required: true },
      base_gas: { kind: 'int', required: true }, gas_price: { kind: 'int', required: true },
      refund_receiver: { kind: 'address', nullable: true, zero: true }, nonce: { kind: 'int', required: true },
      contract_transaction_hash: { kind: 'hex', required: true, min: 32, max: 32 }, sender: { kind: 'address', required: true },
      signature: { kind: 'hex', nullable: true, min: 65 }, origin: { kind: 'string', nullable: true, max: 200 },
    })
    if (a.operation !== undefined && ![0n, 1n, 2n].includes(a.operation)) (errors.operation ??= []).push('Unknown operation')
    if (Object.keys(errors).length) return [422, errors]
    const fail = (m: string): [number, unknown] => [422, { nonFieldErrors: [m] }]
    if (a.operation === 2n) return fail('Operation CREATE not supported. Please use Safe CreateLib')
    if (a.operation === 1n && !TRUSTED_DELEGATECALL.has(a.to.toLowerCase())) return fail('Operation DELEGATE_CALL is not allowed')
    let owners: Address[]
    try { owners = await read(chainId, safe, 'getOwners') } catch {
      return fail(`Could not get Safe ${safe} owners from blockchain, check contract exists on network ${chainId}`)
    }
    const gasToken = a.gas_token ?? '0x0000000000000000000000000000000000000000', refundReceiver = a.refund_receiver ?? '0x0000000000000000000000000000000000000000'
    const hash: Hex = (await read(chainId, safe, 'getTransactionHash', [a.to, a.value, a.data ?? '0x', Number(a.operation), a.safe_tx_gas, a.base_gas, a.gas_price, gasToken, refundReceiver, a.nonce])).toLowerCase()
    if (hash !== a.contract_transaction_hash) return fail(`Contract-transaction-hash=${hash} does not match provided contract-tx-hash=${a.contract_transaction_hash}`)
    await index(chainId, safe)
    const executed = [...txs.values()].filter(t => t.chainId === chainId && t.safe === safe && t.nonce === a.nonce && t.executed)
    if (executed.length) {
      const same = executed.find(t => t.safeTxHash === hash)
      if (same) return fail(`Tx with safe-tx-hash=${hash} for safe=${safe} was already executed in tx-hash=${same.executed!.transactionHash}`)
      return fail(`Tx with nonce=${a.nonce} for safe=${safe} already executed in tx-hash=${executed[0].executed!.transactionHash}`)
    }
    const delegations = delegationsFor(chainId, safe, owners), named = new Set(delegations.map(d => d.delegate))
    const allowed = (x: Address) => owners.includes(x) || named.has(x)
    if (!allowed(a.sender)) return fail(`Sender=${a.sender} is not an owner or delegate. Current owners=${pyList(owners)}. Delegates=${pySet(named)}`)
    const sigs = await parseSignatures(chainId, safe, hash, a.signature)
    const signers: Address[] = []
    for (const s of sigs) {
      if (!s.valid || !s.owner) return fail(`Signature=${s.signature} for owner=${s.owner} is not valid`)
      // An address that is both owner and delegate is treated as owner
      if (named.has(s.owner) && !owners.includes(s.owner) && sigs.length > 1) return fail('Just one signature is expected if using delegates')
      if (!allowed(s.owner)) return fail(`Signer=${s.owner} is not an owner or delegate. Current owners=${pyList(owners)}. Delegates=${pySet(named)}`)
      if (signers.includes(s.owner)) return fail(`Signature for owner=${s.owner} is duplicated`)
      signers.push(s.owner)
    }
    if (signers.length && !signers.includes(a.sender)) return fail(`Signature does not match sender=${a.sender}. Calculated owners=${pyList(signers)}`)
    // A delegate proposes in its delegator's name; its signature makes the proposal trusted but is no confirmation.
    const byDelegate = owners.includes(a.sender) ? null : a.sender
    // get_or_create: re-proposing an existing, unexecuted transaction just adds confirmations
    let t = txs.get(hash)
    if (!t) {
      t = { chainId, safe, to: a.to, value: a.value, data: a.data, operation: Number(a.operation), gasToken, safeTxGas: a.safe_tx_gas, baseGas: a.base_gas,
        gasPrice: a.gas_price, refundReceiver, nonce: a.nonce, safeTxHash: hash, proposer: byDelegate ? delegations.find(d => d.delegate === byDelegate)!.delegator : a.sender,
        proposedByDelegate: byDelegate, origin: a.origin ?? '{}', submissionDate: now(), modified: now(), trusted: signers.length > 0, confirmations: [] }
      txs.set(hash, t)
    } else if (signers.length && !t.trusted) t.trusted = true
    for (const s of sigs) if (owners.includes(s.owner!) && !t.confirmations.some(c => c.owner === s.owner)) t.confirmations.push({ owner: s.owner!, submissionDate: now(), transactionHash: null, signature: s.signature, signatureType: s.type })
    return [201, null]
  }

  async function confirm(hash: string, body: any): Promise<[number, unknown]> {
    const { errors, out } = validateFields(body, { signature: { kind: 'hex', required: true, min: 65 } })
    if (Object.keys(errors).length) return [400, errors]
    const t = txs.get(hash.toLowerCase())
    if (!t) return [404, { detail: `Multisig transaction with safe-tx-hash=${hash} was not found` }]
    await index(t.chainId, t.safe)
    const fail = (m: string): [number, unknown] => [400, { signature: [m] }]
    if (t.executed) return fail(`Transaction with safe-tx-hash=${hash} was already executed`)
    const owners: Address[] = await read(t.chainId, t.safe, 'getOwners')
    const sigs = await parseSignatures(t.chainId, t.safe, t.safeTxHash, out.signature)
    const seen: Address[] = []
    for (const s of sigs) {
      if (!s.owner || !owners.includes(s.owner)) return fail(`Signer=${s.owner} is not an owner. Current owners=${pyList(owners)}`)
      if (!s.valid) return fail(`Signature=${s.signature} for owner=${s.owner} is not valid`)
      if (seen.includes(s.owner)) return fail(`Signature for owner=${s.owner} is duplicated`)
      seen.push(s.owner)
    }
    for (const s of sigs) if (!t.confirmations.some(c => c.owner === s.owner)) t.confirmations.push({ owner: s.owner!, submissionDate: now(), transactionHash: null, signature: s.signature, signatureType: s.type })
    t.trusted = true; t.modified = now()
    return [201, { signature: out.signature }]
  }

  async function list(chainId: number, safe: Address, q: URLSearchParams, base: string): Promise<[number, unknown]> {
    await index(chainId, safe)
    const threshold = Number(await read(chainId, safe, 'getThreshold').catch(() => 0))
    let rows = [...txs.values()].filter(t => t.chainId === chainId && t.safe === safe)
    if (q.get('trusted') !== 'false') rows = rows.filter(t => t.trusted)
    if (q.has('executed')) rows = rows.filter(t => !!t.executed === (q.get('executed') === 'true'))
    for (const [k, cmp] of [['nonce__gte', (a: bigint, b: bigint) => a >= b], ['nonce__lte', (a: bigint, b: bigint) => a <= b], ['nonce', (a: bigint, b: bigint) => a === b]] as const)
      if (q.has(k)) rows = rows.filter(t => cmp(t.nonce, BigInt(q.get(k)!)))
    rows.sort((a, b) => Number(b.nonce - a.nonce) || b.submissionDate.localeCompare(a.submissionDate))
    const limit = Math.min(Number(q.get('limit') ?? 20), 200), offset = Number(q.get('offset') ?? 0)
    const page = rows.slice(offset, offset + limit)
    const link = (o: number) => { const u = new URL(base); u.searchParams.set('limit', String(limit)); u.searchParams.set('offset', String(o)); return u.toString() }
    return [200, {
      count: rows.length, next: offset + limit < rows.length ? link(offset + limit) : null, previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
      results: page.map(t => view(t, threshold)), countUniqueNonce: new Set(rows.map(t => t.nonce)).size,
    }]
  }

  // DRF-style throttling per client IP: 2 req/s without a key, 5 with one (the public API's limits).
  const hits = new Map<string, number[]>()
  const throttled = (ip: string, keyed: boolean) => {
    const limit = (opts.rps ?? 2) * (keyed ? 2.5 : 1), t = Date.now()
    const recent = (hits.get(ip) ?? []).filter(x => t - x < 1000)
    hits.set(ip, recent)
    if (recent.length >= limit) return true
    recent.push(t)
    return false
  }

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'etag' }
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...cors, ...(body === null ? {} : { 'content-type': 'application/json' }), ...extra } })

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req, srv) {
      if (req.method === 'OPTIONS') return reply(200, null)
      const url = new URL(req.url)
      const res = await (async () => {
        const m = url.pathname.match(/^\/tx-service\/([a-z0-9-]+)\/api(\/.*)$/)
        const chainId = m ? shortToChain(m[1]) : undefined
        if (!m || chainId === undefined) return reply(404, { detail: 'Not found.' })
        if (throttled(srv.requestIP(req)?.address ?? 'local', !!req.headers.get('authorization'))) return reply(429, { detail: 'Request was throttled. Expected available in 1 second.' }, { 'retry-after': '1' })
        const path = m[2], body = req.method === 'POST' ? await req.json().catch(() => ({})) : undefined
        let r: RegExpMatchArray | null
        if ((r = path.match(/^\/v2\/safes\/([^/]+)\/multisig-transactions\/$/))) {
          if (!isChecksummed(r[1])) return reply(422, { code: 1, message: 'Checksum address validation failed', arguments: [r[1]] })
          const [status, data] = req.method === 'POST' ? await propose(chainId, r[1], body) : await list(chainId, r[1], url.searchParams, req.url)
          return reply(status, data)
        }
        if (req.method === 'GET' && (r = path.match(/^\/v2\/multisig-transactions\/([^/]+)\/$/))) {
          const t = txs.get(r[1].toLowerCase())
          if (!t || t.chainId !== chainId) return reply(404, { detail: 'No MultisigTransaction matches the given query.' })
          await index(chainId, t.safe)
          return reply(200, view(t, Number(await read(chainId, t.safe, 'getThreshold'))))
        }
        if (req.method === 'POST' && (r = path.match(/^\/v1\/multisig-transactions\/([^/]+)\/confirmations\/$/))) {
          const [status, data] = await confirm(r[1], body)
          return reply(status, data)
        }
        if (req.method === 'GET' && path === '/v2/delegates/') {
          // DelegateListFilter: needs at least one filter; expired delegations are listed too.
          const q = url.searchParams, filters = (['safe', 'delegate', 'delegator', 'label'] as const).filter(k => q.get(k))
          if (!filters.length) return reply(400, ['At least one query param must be provided'])
          const rows = delegates.filter(d => d.chainId === chainId && filters.every(k => String(d[k]) === q.get(k)))
          return reply(200, { count: rows.length, next: null, previous: null, results: rows.map(({ chainId: _, ...d }) => d) })
        }
        return reply(404, { detail: 'Not found.' })
      })().catch(e => reply(500, { detail: String(e?.shortMessage ?? e?.message ?? e) }))
      if (opts.log) console.log(`${req.method} ${url.pathname}${url.search} → ${res.status}`)
      return res
    },
  })
  return {
    port: server.port,
    /** Base URL for a chain, in the same shape as https://api.safe.global/tx-service/<short>. */
    url: (chainId: number) => `http://127.0.0.1:${server.port}/tx-service/${CHAINS.find(c => c.id === chainId)?.short ?? chainId}`,
    txs, delegates,
    stop: () => server.stop(true),
  }
}
