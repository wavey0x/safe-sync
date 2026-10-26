// Core logic: parse the proposer's input, build one Safe transaction per target,
// hash/simulate/sign/execute it. No UI and no network state beyond RPC reads.
import {
  concat, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeFunctionData, encodePacked,
  getAddress, hashDomain, hashMessage, hashStruct, hashTypedData, fallback, hexToBigInt, http, isAddress, keccak256,
  parseAbi, parseAbiItem, parseEther, recoverAddress, size, slice, toHex,
  type AbiFunction, type Address, type Hex, type PublicClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { CHAINS, type Chain } from './chains'

export type Call = { to: Address; value: bigint; data: Hex }
export type Tx = { chainId: number; safe: Address; nonce: number; to: Address; value: string; data: Hex; operation: 0 | 1 }
export type Target = { chainId: number; safe: Address }
export type Batch = { title: string; created: number; txs: Tx[]; labels: Record<string, string>; src: unknown }

export const ZERO = '0x0000000000000000000000000000000000000000' as Address
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address
export const VERSIONS = ['1.3.0', '1.4.1', '1.5.0']

export const SAFE_ABI = parseAbi([
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function simulateAndRevert(address targetContract, bytes calldataPayload)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function changeThreshold(uint256 _threshold)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
])
const MULTISEND_ABI = parseAbi(['function multiSend(bytes transactions) payable'])
const ACCESSOR_ABI = parseAbi(['function simulate(address to, uint256 value, bytes data, uint8 operation) returns (uint256 estimate, bool success, bytes returnData)'])
// Shown decoded in the review; anything else is shown as selector + raw bytes.
const KNOWN_ABI = [...SAFE_ABI, ...MULTISEND_ABI, ...parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
])]

// Canonical, eip155 and zkSync deployments (1.3.0, 1.4.1, 1.5.0). Any version works with any Safe >= 1.3.0;
// the first one deployed on the chain is used. 1.3.0 canonical first, as Safe{Wallet}'s Transaction Builder does.
const MULTISEND_CALL_ONLY = [
  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B', '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  '0xA83c336B20401Af773B6219BA5027174338D1836', '0xf220D3b4DFb23C4ade8C88E526C1353AbAcbC38F', '0x0408EF011960d02349d50286D20531229BCef773',
] as Address[]
const SIMULATE_TX_ACCESSOR = [
  '0x59AD6735bCd8152B84860Cb256dD9e96b85F69Da', '0x727a77a074D1E6c4530e814F89E618a3298FC044', '0x3d4BA2E0884aa488718476ca2FB8Efc291A46199',
  '0x07EfA797c55B5DdE3698d876b277aBb6B893654C', '0x4191E2e12E8BC5002424CE0c51f9947b02675a44', '0xdd35026932273768A3e31F4efF7313B5B7A7199d',
] as Address[]
const MULTISEND_SET = new Set([...MULTISEND_CALL_ONLY, '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761', '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526', '0x998739BFdAAdde7C933B942a68053933098f9EDa'].map(a => a.toLowerCase()))

// ---------------------------------------------------------------- chains & RPC

export const config = { rpc: {} as Record<number, string> }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
export function chainOf(key: string | number): Chain | undefined {
  const k = String(key).toLowerCase()
  const c = CHAINS.find(c => String(c.id) === k || c.short.toLowerCase() === k || slug(c.name) === slug(k) || slug(c.name.split(' ')[0]) === slug(k))
  const id = c?.id ?? (/^\d+$/.test(k) ? Number(k) : undefined)
  if (id === undefined) return undefined
  const rpcs = config.rpc[id] ? [config.rpc[id]] : c?.rpcs
  if (!rpcs?.length) return undefined
  return { ...(c ?? { id, name: `Chain ${id}`, short: String(id), symbol: 'ETH', explorer: '' }), rpcs }
}
export const chainName = (id: number) => chainOf(id)?.name ?? `Chain ${id}`

const clients = new Map<string, PublicClient>()
export function client(chainId: number): PublicClient {
  const c = chainOf(chainId)
  if (!c) throw new Error(`No RPC for chain ${chainId}; add one in Settings`)
  const key = `${chainId}|${c.rpcs}`
  // No JSON-RPC batching: free RPCs cap or mangle batches, and HTTP/2 makes single calls cheap.
  const transports = c.rpcs.map(u => http(u, { retryCount: 1, timeout: 15_000 }))
  if (!clients.has(key)) clients.set(key, createPublicClient({ chain: chainId === 1 ? mainnet : undefined, transport: fallback(transports) }) as PublicClient)
  return clients.get(key)!
}

// ---------------------------------------------------------------- parsing

const ADDR = /0x[0-9a-fA-F]{40}/
const isName = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(s)

/** Targets: `eth:0xSafe`, `42161:0xSafe`, Safe{Wallet} URLs, or `0xSafe eth arb1 base 252` (one address, many chains). */
export function parseTargets(text: string): { targets: Target[]; errors: string[] } {
  const targets: Target[] = [], errors: string[] = [], seen = new Set<string>()
  const add = (chain: string, addr: string, line: string) => {
    const c = chainOf(chain)
    if (!c) return errors.push(`Unknown chain "${chain}" in: ${line}`)
    const key = `${c.id}:${addr.toLowerCase()}`
    if (!seen.has(key)) seen.add(key), targets.push({ chainId: c.id, safe: getAddress(addr) })
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    const pairs = [...line.matchAll(/([a-z0-9-]+):(0x[0-9a-fA-F]{40})/gi)]
    if (pairs.length) { for (const m of pairs) add(m[1], m[2], line); continue }
    const tokens = line.split(/[\s,]+/).filter(Boolean)
    const addrs = tokens.filter(t => ADDR.test(t) && t.length === 42)
    const chains = tokens.filter(t => !addrs.includes(t))
    if (addrs.length !== 1 || !chains.length) { errors.push(`Expected "chain:0xSafe" or "0xSafe chain1 chain2…" in: ${line}`); continue }
    for (const c of chains) add(c, addrs[0], line)
  }
  return { targets, errors }
}

export type Action =
  | { kind: 'swap'; old: string; new: string }
  | { kind: 'add'; owner: string }
  | { kind: 'remove'; owner: string }
  | { kind: 'threshold'; n: number }
  | { kind: 'call'; to: string; value: bigint; data?: string; fn?: AbiFunction; args?: string[] }
  // Make the Safe have exactly these owners and this threshold; `replace` says which removal pairs with which addition.
  | { kind: 'sync'; owners: string[]; threshold: number; replace: [string, string][] }

/** Splits on whitespace, keeping [..] / (..) groups and "quoted strings" together. */
function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = '', depth = 0, quote = false
  for (const ch of line) {
    if (ch === '"') quote = !quote
    if (!quote && (ch === '[' || ch === '(')) depth++
    if (!quote && (ch === ']' || ch === ')')) depth--
    if (/\s/.test(ch) && !depth && !quote) { if (cur) out.push(cur); cur = '' } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * One action per line:
 *   swap OLD NEW   (or OLD -> NEW)   add OWNER   remove OWNER   threshold N
 *   TO [value=WEI|1.5ether] 0xCALLDATA      TO [value=…] fn(type,…) arg …
 * TO / addresses may be 0x…, name.eth, or `self` (the target Safe). Raw calldata may contain {self}.
 * A Safe Transaction Builder JSON file can be pasted instead.
 */
export function parseActions(text: string): { actions: Action[]; errors: string[] } {
  const actions: Action[] = [], errors: string[] = []
  if (text.trim().startsWith('{')) {
    try { return parseActions(linesFromTxBuilder(JSON.parse(text))) } catch (e) { return { actions, errors: [`Transaction Builder JSON: ${msg(e)}`] } }
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) continue
    try {
      const arrow = line.match(/^(\S+)\s*->\s*(\S+)$/)
      const t = tokenize(line), kw = t[0].toLowerCase()
      if (arrow) actions.push({ kind: 'swap', old: arrow[1], new: arrow[2] })
      else if (kw === 'swap' && t.length === 3) actions.push({ kind: 'swap', old: t[1], new: t[2] })
      else if (kw === 'add' && t.length === 2) actions.push({ kind: 'add', owner: t[1] })
      else if (kw === 'remove' && t.length === 2) actions.push({ kind: 'remove', owner: t[1] })
      else if (kw === 'threshold' && t.length === 2 && /^\d+$/.test(t[1])) actions.push({ kind: 'threshold', n: Number(t[1]) })
      else {
        let [to, ...rest] = t, value = 0n
        if (rest[0]?.startsWith('value=')) {
          const v = rest.shift()!.slice(6)
          value = /ether$|eth$/i.test(v) ? parseEther(v.replace(/ether$|eth$/i, '')) : BigInt(v)
        }
        if (!(to === 'self' || isAddress(to) || isName(to))) throw new Error(`"${to}" is not an address, name.eth or self`)
        if (!rest.length) actions.push({ kind: 'call', to, value, data: '0x' })
        else if (rest[0].startsWith('0x') && rest.length === 1) {
          if (!/^0x([0-9a-fA-F]|\{self\})*$/.test(rest[0])) throw new Error('calldata must be hex (may contain {self})')
          actions.push({ kind: 'call', to, value, data: rest[0] })
        } else {
          const fn = parseAbiItem(`function ${rest[0]}`) as AbiFunction
          if (fn.inputs.length !== rest.length - 1) throw new Error(`${fn.name} takes ${fn.inputs.length} arguments, got ${rest.length - 1}`)
          actions.push({ kind: 'call', to, value, fn, args: rest.slice(1) })
        }
      }
    } catch (e) { errors.push(`${msg(e)} — in: ${line}`) }
  }
  return { actions, errors }
}

/** Transaction Builder JSON → action lines, through the same conversion as a queued Safe transaction. */
export function linesFromTxBuilder(j: any): string {
  if (!Array.isArray(j.transactions)) throw new Error('missing transactions[]')
  const src: string | undefined = j.meta?.createdFromSafeAddress
  return j.transactions.map((t: any) => {
    let data: string = t.data && t.data !== '0x' ? t.data : '0x'
    if (data === '0x' && t.contractMethod) {
      const fn = { type: 'function', name: t.contractMethod.name, inputs: t.contractMethod.inputs, outputs: [], stateMutability: 'nonpayable' } as AbiFunction
      data = encodeFunctionData({ abi: [fn], args: fn.inputs.map(i => coerce(i.type, t.contractInputsValues?.[i.name!] ?? '', getAddress)) })
    }
    return replicateLine({ to: t.to, value: String(t.value || 0), data, operation: 0 }, src)
  }).join('\n')
}

/** Replace a Safe's own address inside hex calldata with {self} so the payload can be replicated. */
export const withSelf = (data: string, safe?: string) => safe ? data.replace(new RegExp(safe.replace(/^0x/i, ''), 'ig'), '{self}') : data

/**
 * One call made by `source` → an action line any Safe can run. Owner changes on the source itself become
 * swap/add/remove/threshold, so prevOwner is rebuilt per target; the source's own address becomes self.
 * A DELEGATECALL can't be carried by a plain call line, so it is refused.
 */
function replicateLine(c: { to: string; value: bigint | string; data: string; operation: number }, source?: string): string {
  if (c.operation !== 0) throw new Error('Source contains a DELEGATECALL; it cannot be replicated safely, so build it manually')
  if (source && same(c.to, source) && !BigInt(c.value) && c.data && c.data !== '0x') {
    try {
      const { functionName, args } = decodeFunctionData({ abi: SAFE_ABI, data: c.data as Hex }) as { functionName: string; args: readonly any[] }
      if (functionName === 'swapOwner') return `swap ${args[1]} ${args[2]}`
      if (functionName === 'addOwnerWithThreshold') return `add ${args[0]}\nthreshold ${args[1]}`
      if (functionName === 'removeOwner') return `remove ${args[1]}\nthreshold ${args[2]}`
      if (functionName === 'changeThreshold') return `threshold ${args[0]}`
    } catch {}
  }
  const to = source && same(c.to, source) ? 'self' : c.to
  return [to, BigInt(c.value) ? `value=${c.value}` : '', c.data && c.data !== '0x' ? withSelf(c.data, source) : ''].filter(Boolean).join(' ')
}

/** A queued Safe transaction (as returned by the Transaction Service) → action lines. */
export function linesFromTx(t: { safe: string; to: string; value: string; data: string | null; operation: number }): string {
  const data = (t.data ?? '0x') as Hex
  if (t.operation === 1 && MULTISEND_SET.has(t.to.toLowerCase())) return unpackMultiSend(data).map(c => replicateLine(c, t.safe)).join('\n')
  return replicateLine({ to: t.to, value: t.value, data, operation: t.operation }, t.safe)
}

/** ENS names are resolved once, on Ethereum, when preparing; the batch stores addresses only. */
export async function resolveNames(actions: Action[]): Promise<Record<string, Address>> {
  const names = new Set<string>()
  for (const a of actions) {
    for (const v of a.kind === 'swap' ? [a.old, a.new] : a.kind === 'add' || a.kind === 'remove' ? [a.owner] : a.kind === 'call' ? [a.to, ...(a.args ?? [])] : a.kind === 'sync' ? [...a.owners, ...a.replace.flat()] : [])
      if (isName(v)) names.add(v.toLowerCase())
  }
  const out: Record<string, Address> = {}
  await Promise.all([...names].map(async n => {
    const a = await client(1).getEnsAddress({ name: normalize(n) })
    if (!a) throw new Error(`${n} does not resolve`)
    out[n] = a
  }))
  return out
}

// ---------------------------------------------------------------- building

export type SafeState = { version: string; owners: Address[]; threshold: number; nonce: number }

export async function readSafe(chainId: number, safe: Address): Promise<SafeState> {
  const c = client(chainId)
  const read = (functionName: any) => c.readContract({ address: safe, abi: SAFE_ABI, functionName }) as Promise<any>
  const code = await c.getCode({ address: safe })
  if (!code || code === '0x') throw new Error('No contract at this address')
  const [version, owners, threshold, nonce] = await Promise.all([read('VERSION'), read('getOwners'), read('getThreshold'), read('nonce')])
  return { version, owners, threshold: Number(threshold), nonce: Number(nonce) }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

export type Found = { chainId: number; safe: Address; state?: SafeState; error?: string }

/** Looks for a Safe at `safe` on every chain with an RPC. Chains without it are left out; unreachable ones come back with an error. */
export async function findSafe(safe: Address, timeoutMs = 8000, chainIds?: number[]): Promise<Found[]> {
  const ids = chainIds ?? [...new Set([...CHAINS.map(c => c.id), ...Object.keys(config.rpc).map(Number)])]
  const found = await Promise.all(ids.map(async (chainId): Promise<Found | null> => {
    try { return { chainId, safe, state: await withTimeout(readSafe(chainId, safe), timeoutMs) } } catch (e) { return notHere(e) ? null : { chainId, safe, error: msg(e) } }
  }))
  return found.filter((f): f is Found => !!f)
}
const notHere = (e: unknown) => /No contract|returned no data|reverted|is not a valid|out of gas/i.test(msg(e))

/** Turns actions into calls for one Safe, tracking the owner list as it changes (prevOwner depends on order). */
export function buildCalls(actions: Action[], safe: Address, state: SafeState, names: Record<string, Address>) {
  const addr = (s: string): Address => s === 'self' ? safe : isName(s) ? names[s.toLowerCase()] : getAddress(s)
  let owners = [...state.owners], threshold = state.threshold
  const calls: Call[] = [], notes: string[] = []
  const self = (data: Hex) => calls.push({ to: safe, value: 0n, data })
  const prev = (i: number) => (i === 0 ? SENTINEL : owners[i - 1])
  const idx = (a: Address) => owners.findIndex(o => same(o, a))
  const apply = (a: Action): void => {
    if (a.kind === 'swap') {
      const o = addr(a.old), n = addr(a.new), i = idx(o)
      if (i < 0 && idx(n) >= 0) return void notes.push(`${short(o)} → ${short(n)} already done`)
      if (i < 0) throw new Error(`${short(o)} is not an owner`)
      if (idx(n) >= 0) throw new Error(`${short(n)} is already an owner`)
      self(encodeFunctionData({ abi: SAFE_ABI, functionName: 'swapOwner', args: [prev(i), o, n] }))
      owners[i] = n
    } else if (a.kind === 'add') {
      const n = addr(a.owner)
      if (idx(n) >= 0) return void notes.push(`${short(n)} already an owner`)
      self(encodeFunctionData({ abi: SAFE_ABI, functionName: 'addOwnerWithThreshold', args: [n, BigInt(threshold)] }))
      owners = [n, ...owners]
    } else if (a.kind === 'remove') {
      const o = addr(a.owner), i = idx(o)
      if (i < 0) return void notes.push(`${short(o)} already not an owner`)
      if (owners.length === 1) throw new Error('Cannot remove the last owner')
      threshold = Math.min(threshold, owners.length - 1)
      self(encodeFunctionData({ abi: SAFE_ABI, functionName: 'removeOwner', args: [prev(i), o, BigInt(threshold)] }))
      owners.splice(i, 1)
    } else if (a.kind === 'threshold') {
      if (a.n < 1 || a.n > owners.length) throw new Error(`Threshold ${a.n} is invalid for ${owners.length} owners`)
      if (a.n === threshold) return
      self(encodeFunctionData({ abi: SAFE_ABI, functionName: 'changeThreshold', args: [BigInt(a.n)] }))
      threshold = a.n
    } else if (a.kind === 'sync') {
      // Compare this Safe with the target: drift is fixed and a Safe already in sync gets nothing.
      const want = a.owners.map(addr)
      if (!want.length) throw new Error('Keep at least one owner')
      if (new Set(want.map(w => w.toLowerCase())).size !== want.length) throw new Error('The owner list has a duplicate')
      const remove = owners.filter(o => !want.some(w => same(w, o))), add = want.filter(w => idx(w) < 0)
      const pairs: [Address, Address][] = []
      for (const [o, n] of a.replace.map(([o, n]) => [addr(o), addr(n)])) {
        const i = remove.findIndex(r => same(r, o)), j = add.findIndex(x => same(x, n))
        if (i >= 0 && j >= 0) pairs.push([remove.splice(i, 1)[0], add.splice(j, 1)[0]])
      }
      while (remove.length && add.length) pairs.push([remove.shift()!, add.shift()!])
      for (const [o, n] of pairs) apply({ kind: 'swap', old: o, new: n })
      for (const n of add) apply({ kind: 'add', owner: n }) // adds first, so removals never push the threshold above the owner count
      for (const o of remove) apply({ kind: 'remove', owner: o })
      apply({ kind: 'threshold', n: a.threshold })
    } else {
      const to = addr(a.to)
      let data: Hex
      if (a.fn) data = encodeFunctionData({ abi: [a.fn], args: a.fn.inputs.map((inp, i) => coerce(inp.type, a.args![i], addr)) })
      else data = a.data!.replaceAll('{self}', safe.slice(2).toLowerCase()) as Hex
      calls.push({ to, value: a.value, data })
    }
  }
  actions.forEach(apply)
  return { calls, owners, threshold, notes }
}

function coerce(type: string, v: any, addr: (s: string) => Address): any {
  if (type.endsWith(']')) {
    const arr = typeof v === 'string' ? JSON.parse(v.replace(/(?<=[[,\s])(self|0x[0-9a-fA-F]+|[a-z0-9-]+\.eth)(?=[\],\s])/gi, '"$1"')) : v
    return arr.map((x: any) => coerce(type.slice(0, type.lastIndexOf('[')), x, addr))
  }
  const s = typeof v === 'string' ? v.replace(/^"|"$/g, '') : String(v)
  if (type === 'address') return addr(s)
  if (/^u?int/.test(type)) return BigInt(s)
  if (type === 'bool') return s === 'true'
  return s
}

export function packMultiSend(calls: Call[]): Hex {
  const packed = concat(calls.map(c => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, c.to, c.value, BigInt(size(c.data)), c.data])))
  return encodeFunctionData({ abi: MULTISEND_ABI, functionName: 'multiSend', args: [packed] })
}

export function unpackMultiSend(data: Hex): (Call & { operation: number })[] {
  const [packed] = decodeFunctionData({ abi: MULTISEND_ABI, data }).args as [Hex]
  const out: (Call & { operation: number })[] = []
  for (let i = 0; i < size(packed);) {
    const len = Number(hexToBigInt(slice(packed, i + 53, i + 85)))
    out.push({ operation: Number(hexToBigInt(slice(packed, i, i + 1))), to: getAddress(slice(packed, i + 1, i + 21)), value: hexToBigInt(slice(packed, i + 21, i + 53)), data: len ? slice(packed, i + 85, i + 85 + len) : '0x' })
    i += 85 + len
  }
  return out
}

const deployed = new Map<string, Promise<Address>>()
/** First candidate with code on the chain, probed in order and cached per chain. */
function firstDeployed(chainId: number, candidates: Address[]): Promise<Address> {
  const key = `${chainId}|${candidates[0]}`
  if (!deployed.has(key)) deployed.set(key, (async () => {
    for (const a of candidates) {
      const code = await client(chainId).getCode({ address: a })
      if (code && code !== '0x') return a
    }
    throw new Error('No canonical Safe library deployed on this chain')
  })().catch(e => { deployed.delete(key); throw e }))
  return deployed.get(key)!
}

export type Prepared = Target & { state?: SafeState; tx?: Tx; hash?: Hex; owners?: Address[]; threshold?: number; notes: string[]; sim?: Sim; error?: string; skip?: string }
export type Sim = { ok: true; gas: bigint } | { ok: false; error: string; definite: boolean }

/**
 * Reads one Safe, builds its transaction, simulates it and cross-checks the hash on-chain. Never throws.
 * `nonceFor` gets the transaction at the Safe's on-chain nonce and returns the nonce to use (see pickNonce).
 */
export async function prepareTarget(t: Target, actions: Action[], names: Record<string, Address>, nonceFor?: (tx: Tx) => Promise<number>): Promise<Prepared> {
  const p: Prepared = { ...t, notes: [] }
  try {
    const state = p.state = await readSafe(t.chainId, t.safe)
    if (!VERSIONS.includes(state.version)) throw new Error(`Safe ${state.version} is not supported (1.3.0, 1.4.1, 1.5.0)`)
    const b = buildCalls(actions, t.safe, state, names)
    p.notes.push(...b.notes); p.owners = b.owners; p.threshold = b.threshold
    if (!b.calls.length) { p.skip = 'Already in sync'; return p }
    const missing = (await Promise.all(b.calls.filter(c => !same(c.to, t.safe) && c.data !== '0x').map(async c => ((await client(t.chainId).getCode({ address: c.to })) ?? '0x') === '0x' ? c.to : null))).filter(Boolean)
    if (missing.length) throw new Error(`No contract at ${missing.map(a => short(a!)).join(', ')} on this chain`)
    const env = b.calls.length === 1
      ? { to: b.calls[0].to, value: b.calls[0].value, data: b.calls[0].data, operation: 0 as const }
      : { to: await firstDeployed(t.chainId, MULTISEND_CALL_ONLY), value: 0n, data: packMultiSend(b.calls), operation: 1 as const }
    const tx: Tx = { chainId: t.chainId, safe: t.safe, nonce: state.nonce, to: env.to, value: env.value.toString(), data: env.data, operation: env.operation }
    if (nonceFor) tx.nonce = await nonceFor(tx)
    const [onchain, sim] = await Promise.all([onchainHash(tx), simulate(tx)])
    p.tx = tx; p.hash = safeTxHash(tx); p.sim = sim
    if (onchain !== p.hash) throw new Error(`Hash mismatch: local ${p.hash}, on-chain ${onchain}`)
    if (!sim.ok && sim.definite) throw new Error(`Simulation reverted: ${sim.error}`)
  } catch (e) { p.error = msg(e) }
  return p
}

export async function onchainHash(tx: Tx): Promise<Hex> {
  return client(tx.chainId).readContract({ address: tx.safe, abi: SAFE_ABI, functionName: 'getTransactionHash', args: [tx.to, BigInt(tx.value), tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, BigInt(tx.nonce)] })
}

/** Runs the payload from the Safe's own context via simulateAndRevert (no signatures, no state overrides). */
export async function simulate(tx: Tx): Promise<Sim> {
  const c = client(tx.chainId)
  try {
    const accessor = await firstDeployed(tx.chainId, SIMULATE_TX_ACCESSOR)
    const inner = encodeFunctionData({ abi: ACCESSOR_ABI, functionName: 'simulate', args: [tx.to, BigInt(tx.value), tx.data, tx.operation] })
    await c.call({ to: tx.safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'simulateAndRevert', args: [accessor, inner] }) })
    return { ok: false, error: 'simulateAndRevert did not revert', definite: false }
  } catch (e) {
    const d = revertData(e)
    if (!d || size(d) < 64 + 96) return { ok: false, error: `Could not simulate (${short(msg(e), 80)})`, definite: false }
    const [estimate, success, ret] = decodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }], slice(d, 64))
    return success ? { ok: true, gas: estimate } : { ok: false, error: revertReason(ret), definite: true }
  }
}

export function revertData(e: any): Hex | undefined {
  for (let x = e; x; x = x.cause) {
    for (const d of [x.data, x.data?.data, x.error?.data]) if (typeof d === 'string' && /^0x[0-9a-f]*$/i.test(d) && d.length > 2) return d as Hex
  }
  return msg(e).match(/0x[0-9a-f]{8,}/i)?.[0] as Hex | undefined
}

export function revertReason(ret: Hex): string {
  if (ret.startsWith('0x08c379a0')) return decodeAbiParameters([{ type: 'string' }], slice(ret, 4))[0] as string
  return ret === '0x' ? 'reverted without reason' : `reverted: ${short(ret, 74)}`
}

// ---------------------------------------------------------------- hashing & signatures

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

// Gas/refund fields are always zero: the executor pays gas, nobody gets refunded.
const message = (tx: Tx) => ({ to: tx.to, value: BigInt(tx.value), data: tx.data, operation: tx.operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: BigInt(tx.nonce) })
const domain = (tx: Tx) => ({ chainId: tx.chainId, verifyingContract: tx.safe })

export const safeTxHash = (tx: Tx): Hex => hashTypedData({ domain: domain(tx), types: SAFE_TX_TYPES, primaryType: 'SafeTx', message: message(tx) })
/** What a Ledger shows when it cannot clear-sign: compare these with the device screen. */
export const domainHash = (tx: Tx): Hex => hashDomain({ domain: domain(tx), types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } })
export const messageHash = (tx: Tx): Hex => hashStruct({ data: message(tx), primaryType: 'SafeTx', types: SAFE_TX_TYPES })

/** eth_signTypedData_v4 payload (EIP712Domain included; numbers as strings for wallet compatibility). */
export function walletTypedData(tx: Tx): string {
  return JSON.stringify({
    types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...SAFE_TX_TYPES },
    domain: domain(tx), primaryType: 'SafeTx',
    message: { ...message(tx), value: tx.value, safeTxGas: '0', baseGas: '0', gasPrice: '0', nonce: String(tx.nonce) },
  })
}

/** Some wallets/hardware return v as 0/1; Safe needs 27/28 for ECDSA signatures. */
export function normalizeSig(sig: Hex): Hex {
  if (size(sig) !== 65) throw new Error(`Unexpected signature length ${size(sig)}`)
  const v = parseInt(sig.slice(-2), 16)
  return v < 27 ? (sig.slice(0, -2) + (v + 27).toString(16)) as Hex : sig
}

/**
 * Recovers who produced a Safe signature: ECDSA (v 27/28) or eth_sign (v 31/32).
 * Pre-approved hashes (v 1) and contract signatures (v 0) prove nothing by themselves, so they don't count.
 */
export async function sigOwner(hash: Hex, sig: Hex): Promise<Address | undefined> {
  const v = parseInt(sig.slice(-2), 16)
  if (v === 27 || v === 28) return recoverAddress({ hash, signature: sig })
  if (v === 31 || v === 32) return recoverAddress({ hash: hashMessage({ raw: hash }), signature: (sig.slice(0, -2) + (v - 4).toString(16)) as Hex })
  return undefined
}

/** Safe requires signatures sorted by owner address, ascending. Uses exactly `threshold` of them. */
export function packSigs(sigs: { owner: Address; sig: Hex }[], threshold: number): Hex {
  const sorted = [...sigs].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1)).slice(0, threshold)
  return concat(sorted.map(s => s.sig))
}

export function execData(tx: Tx, sigs: { owner: Address; sig: Hex }[], threshold: number): Hex {
  return encodeFunctionData({ abi: SAFE_ABI, functionName: 'execTransaction', args: [tx.to, BigInt(tx.value), tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, packSigs(sigs, threshold)] })
}

// ---------------------------------------------------------------- batch link

// The link stores each distinct payload once, with the Safe's own address as {self},
// so the same change on 30 Safes costs barely more than on one.
type Packed = { v: 1; title: string; created: number; labels: Record<string, string>; src: unknown; p: [string, string, string, number][]; t: [number, string, number, number][] }

export async function encodeBatch(b: Batch): Promise<string> {
  const p: Packed['p'] = [], keys: string[] = []
  const t = b.txs.map(tx => {
    const s = tx.safe.slice(2)
    const row: [string, string, string, number] = [same(tx.to, tx.safe) ? 'self' : tx.to, tx.value, withSelf(tx.data, s), tx.operation]
    const k = JSON.stringify(row)
    let i = keys.indexOf(k)
    if (i < 0) i = keys.push(k) - 1, p.push(row)
    return [tx.chainId, tx.safe, tx.nonce, i] as [number, string, number, number]
  })
  const json = JSON.stringify({ v: 1, title: b.title, created: b.created, labels: b.labels, src: b.src, p, t } satisfies Packed)
  const buf = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function decodeBatch(s: string): Promise<Batch> {
  const bin = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const j: Packed = JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text())
  if (j.v !== 1) throw new Error('Unsupported batch version')
  const txs = j.t.map(([chainId, safe, nonce, i]): Tx => {
    const [to, value, data, operation] = j.p[i], sa = getAddress(safe)
    if (operation !== 0 && operation !== 1) throw new Error('Bad operation')
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(nonce) || !Number.isSafeInteger(chainId)) throw new Error('Bad number')
    const d = data.replaceAll('{self}', sa.slice(2).toLowerCase())
    if (!/^0x([0-9a-f]{2})*$/i.test(d)) throw new Error('Bad calldata')
    return { chainId, safe: sa, nonce, to: to === 'self' ? sa : getAddress(to), value, data: d as Hex, operation }
  })
  return { title: String(j.title ?? ''), created: Number(j.created), labels: j.labels ?? {}, src: j.src ?? null, txs }
}

/** Short fingerprint of exactly what will be signed — compare it out of band. */
export const batchId = (b: Batch) => keccak256(toHex(b.txs.map(safeTxHash).join(''))).slice(2, 10).replace(/(.{4})/, '$1-')

// ---------------------------------------------------------------- review

export type Step = { target: Address | 'self'; op: number; value: bigint; fn: string; args: [string, string][]; raw?: Hex }

/** Human-readable steps for one transaction (MultiSend is unpacked). */
export function describe(tx: Pick<Tx, 'to' | 'value' | 'data' | 'operation' | 'safe'>): Step[] {
  const step = (to: Address, value: bigint, data: Hex, op: number): Step => {
    const target = same(to, tx.safe) ? 'self' : to
    if (data === '0x') return { target, op, value, fn: value ? 'send native' : '(empty call)', args: [] }
    try {
      const d = decodeFunctionData({ abi: KNOWN_ABI, data })
      const fn = KNOWN_ABI.find(f => f.type === 'function' && f.name === d.functionName) as AbiFunction
      const args = (d.args ?? []).map((v, i): [string, string] =>
        [fn.inputs[i].name ?? `arg${i}`, typeof v === 'string' && isAddress(v) && same(v, tx.safe) ? 'this Safe' : String(v)])
      return { target, op, value, fn: d.functionName, args }
    } catch {
      return { target, op, value, fn: `unknown ${data.slice(0, 10)}`, args: [], raw: data }
    }
  }
  if (tx.operation === 1 && MULTISEND_SET.has(tx.to.toLowerCase())) {
    try { return unpackMultiSend(tx.data).map(c => step(c.to, c.value, c.data, c.operation)) } catch {}
  }
  return [step(tx.to, BigInt(tx.value), tx.data, tx.operation)]
}

export type OwnerOp =
  | { kind: 'swap'; old: string; new: string }
  | { kind: 'add'; owner: string; threshold: number }
  | { kind: 'remove'; owner: string; threshold: number }
  | { kind: 'threshold'; n: number }

/** The owner operations a transaction makes on its own Safe, in order, read from the calldata; null if it does anything else. */
export function ownerOps(tx: Pick<Tx, 'to' | 'value' | 'data' | 'operation' | 'safe'>): OwnerOp[] | null {
  const ops: OwnerOp[] = []
  for (const st of describe(tx)) {
    if (st.target !== 'self' || st.op !== 0) return null
    const a = Object.fromEntries(st.args)
    if (st.fn === 'swapOwner') ops.push({ kind: 'swap', old: a.oldOwner, new: a.newOwner })
    else if (st.fn === 'addOwnerWithThreshold') ops.push({ kind: 'add', owner: a.owner, threshold: Number(a._threshold) })
    else if (st.fn === 'removeOwner') ops.push({ kind: 'remove', owner: a.owner, threshold: Number(a._threshold) })
    else if (st.fn === 'changeThreshold') ops.push({ kind: 'threshold', n: Number(a._threshold) })
    else return null
  }
  return ops
}

/** Owners (lowercase, in Safe order) and threshold after the operations, applied in order exactly as the Safe applies them. */
export function applyOps(owners: string[], threshold: number, ops: OwnerOp[]) {
  let o = owners.map(x => x.toLowerCase()), t = threshold
  for (const op of ops) {
    if (op.kind === 'swap') o = o.map(x => (x === op.old.toLowerCase() ? op.new.toLowerCase() : x))
    else if (op.kind === 'add') o = [op.owner.toLowerCase(), ...o], t = op.threshold
    else if (op.kind === 'remove') o = o.filter(x => x !== op.owner.toLowerCase()), t = op.threshold
    else t = op.n
  }
  return { owners: o, threshold: t }
}

export type Queued = { nonce: number; safeTxHash: Hex }
export type NonceChoice = 'after' | 'replace'
/**
 * The nonce for `tx` (built at the Safe's on-chain nonce), given what's already queued for the Safe. The same transaction
 * already queued keeps its nonce, so its signatures count. Otherwise nothing is replaced unless chosen: 'after' goes after
 * the last queued transaction, 'replace' takes the on-chain nonce and competes with whatever is queued there.
 */
export function pickNonce(tx: Tx, queue: Queued[], choice: NonceChoice): { nonce: number; same?: true } {
  const pending = queue.filter(q => q.nonce >= tx.nonce)
  const same = pending.find(q => q.safeTxHash.toLowerCase() === safeTxHash({ ...tx, nonce: q.nonce }))
  if (same) return { nonce: same.nonce, same: true }
  return { nonce: pending.length && choice === 'after' ? Math.max(...pending.map(q => q.nonce)) + 1 : tx.nonce }
}

/** Grouping key: identical payloads up to the Safe's own address. */
export const payloadKey = (tx: Tx) => JSON.stringify([same(tx.to, tx.safe) ? 'self' : tx.to.toLowerCase(), tx.value, withSelf(tx.data, tx.safe).toLowerCase(), tx.operation])

export const short = (s: string, n = 12) => (s.length > n ? `${s.slice(0, Math.ceil(n / 2))}…${s.slice(-(Math.floor(n / 2) - 2))}` : s)
export const msg = (e: any): string => e?.shortMessage ?? e?.details ?? e?.message ?? String(e)
