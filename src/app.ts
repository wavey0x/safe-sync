// UI. Two screens: compose (proposer) and batch (signers and executors, opened from the link).
// All state lives in the link, the Safe Transaction Service, the chain, and localStorage.
import { html, nothing, render, type TemplateResult } from 'lit-html'
import { live } from 'lit-html/directives/live.js'
import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem'
import { CHAINS } from './chains'
import {
  batchId, chainName, chainOf, client, config, decodeBatch, describe, domainHash, encodeBatch, execData, findSafe, linesFromTx,
  linesFromTxBuilder, messageHash, msg, normalizeSig, onchainHash, parseActions, payloadKey, prepareTarget, readSafe, resolveNames,
  revertData, revertReason, SAFE_ABI, safeTxHash, short, sigOwner, walletTypedData,
  type Action, type Batch, type Found, type Prepared, type Step, type Tx,
} from './safe'
import * as svc from './service'

// ---------------------------------------------------------------- state

type Sig = { owner: Address; sig: Hex; posted: boolean; uploading?: boolean }
type Kind = 'loading' | 'collecting' | 'ready' | 'waiting' | 'executed' | 'blocked' | 'unknown'
type Row = {
  tx: Tx; hash: Hex; sigs: Record<string, Sig>
  owners?: Address[]; threshold?: number; chainNonce?: number
  svc: 'loading' | 'ok' | 'none' | 'error'; proposed: boolean; svcExecuted?: boolean; readAt: number
  others: { safeTxHash: Hex; isExecuted: boolean }[] // other transactions at the same nonce
  phase?: string; error?: string; fatal?: string; execHash?: Hex; execOk?: boolean; open?: boolean
  loaded?: Promise<void>; posting?: Promise<void>
}
type Wallet = { info: { name: string; icon: string; rdns: string }; provider: any }
type Result = { before: [number, number]; after: [number, number] }
/** What the proposer entered. Also stored in the link, so "edit as new batch" can bring it back. */
type Draft = {
  title: string; safes: string; mode: 'owners' | 'replicate'
  edits: Record<string, string | null> // current owner (lowercase) → replacement, or null to remove
  added: string[]; threshold: number | null; source: string; afterQueue: boolean
}
type Pick = Found & { selected: boolean }

let storageOk = true
const store = {
  get: <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { storageOk = false } },
}
const blank = (): Draft => ({ title: '', safes: '', mode: 'owners', edits: {}, added: [], threshold: null, source: '', afterQueue: false })

const S = {
  mode: 'compose' as 'compose' | 'batch',
  d: { ...blank(), ...store.get<Partial<Draft>>('safesync:draft', {}) } as Draft,
  found: [] as Pick[], finding: false, lines: '', sourceNote: '',
  preparing: false, prepared: [] as Prepared[], errors: [] as string[], names: {} as Record<string, Address>, link: '',
  batch: null as Batch | null, id: '', rows: [] as Row[], loadError: '', pasted: '',
  wallets: [] as Wallet[], provider: null as any, account: null as Address | null, choosing: false,
  signing: false, executing: false, waiting: false, current: null as Row | null, notice: '',
  settingsOpen: false, settingsErrors: [] as string[], settings: store.get('safesync:settings', { rpc: '', service: '', apiKey: '' }),
}

let queued = false
const update = () => {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    render(view(), document.body)
    // Keep the transaction being worked on in view, so the list reads as a checklist.
    if (S.signing || S.executing) document.querySelector('tr.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

/** Parses "chain url" lines; returns the problems instead of silently skipping them. */
function applySettings(): string[] {
  const errors: string[] = []
  const map = (text: string, what: string) => Object.fromEntries(text.split('\n').map(l => l.trim()).filter(Boolean).flatMap(l => {
    const [k, url, extra] = l.split(/\s+/)
    const id = /^\d+$/.test(k) ? Number(k) : CHAINS.find(c => c.short === k.toLowerCase())?.id
    if (!id || !/^https?:\/\/\S+$/.test(url ?? '') || extra) return errors.push(`${what}: expected "chain url", got "${l}"`), []
    return [[id, url]]
  }))
  config.rpc = map(S.settings.rpc, 'RPC')
  svc.config.service = map(S.settings.service, 'Service')
  svc.config.apiKey = S.settings.apiKey.trim()
  return errors
}
applySettings()

// ---------------------------------------------------------------- compose: which Safes

// Bumped on every edit: results of an older Prepare are discarded, so a link never carries stale transactions.
let run = 0
function edited() {
  run++
  S.prepared = []; S.link = ''; S.preparing = false
  store.set('safesync:draft', S.d); update()
}

/** Bare addresses are looked for on every chain; chain:0x… and Safe{Wallet} links name one Safe. */
async function find() {
  const tokens = S.d.safes.split(/[\s,]+/).filter(Boolean)
  const exact: { chain: string; safe: string }[] = [], anywhere: string[] = []
  for (const t of tokens) {
    const m = t.match(/(?:safe=)?([a-z0-9-]+):(0x[0-9a-fA-F]{40})/i)
    if (m) exact.push({ chain: m[1], safe: m[2] })
    else if (isAddress(t)) anywhere.push(t)
    else return (S.errors = [`"${t}" isn't a Safe address, chain:0xSafe or Safe{Wallet} link`]), update()
  }
  S.errors = []; S.finding = true; S.found = []; edited()
  const results = await Promise.all([
    ...anywhere.map(a => findSafe(getAddress(a))),
    ...exact.map(async ({ chain, safe }): Promise<Found[]> => {
      const c = chainOf(chain)
      if (!c) { S.errors.push(`Unknown chain "${chain}"`); return [] }
      try { return [{ chainId: c.id, safe: getAddress(safe), state: await readSafe(c.id, getAddress(safe)) }] } catch (e) { return [{ chainId: c.id, safe: getAddress(safe), error: msg(e) }] }
    }),
  ])
  const seen = new Set<string>()
  S.found = results.flat().filter(f => !seen.has(`${f.chainId}:${f.safe}`) && seen.add(`${f.chainId}:${f.safe}`)).map(f => ({ ...f, selected: !!f.state }))
  if (!S.found.length) S.errors.push('No Safe found at that address on any chain.')
  S.finding = false; update()
}

async function retry(p: Pick) {
  p.error = undefined; update()
  try { p.state = await readSafe(p.chainId, p.safe); p.selected = true } catch (e) { p.error = msg(e) }
  edited()
}

const selected = () => S.found.filter(f => f.selected && f.state)

/** The owner list most of the selected Safes share, in the order of the first one that has it. */
function baseOwners() {
  const sel = selected(), key = (o: Address[]) => o.map(a => a.toLowerCase()).sort().join()
  const counts = new Map<string, number>()
  for (const f of sel) counts.set(key(f.state!.owners), (counts.get(key(f.state!.owners)) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const first = sel.find(f => top && key(f.state!.owners) === top[0])
  const thresholds = sel.filter(f => f === first || (top && key(f.state!.owners) === top[0])).map(f => f.state!.threshold)
  return { owners: first?.state!.owners ?? [], threshold: thresholds.sort((a, b) => thresholds.filter(x => x === b).length - thresholds.filter(x => x === a).length)[0] ?? 1, share: top?.[1] ?? 0, total: sel.length }
}

/** The owner list every Safe should end up with, built from the base list and the edits. */
function targetOwners() {
  const base = baseOwners()
  const kept = base.owners.flatMap(o => { const e = S.d.edits[o.toLowerCase()]; return e === null ? [] : [e && e.trim() ? e.trim() : o] })
  const owners = [...kept, ...S.d.added.map(a => a.trim()).filter(Boolean)]
  // In the order the replacements were made, which is also the order someone queuing it by hand would use.
  const replace = Object.entries(S.d.edits).flatMap(([k, e]) => {
    const o = base.owners.find(b => b.toLowerCase() === k)
    return o && e && e.trim() ? [[o, e.trim()] as [string, string]] : []
  })
  return { owners, replace, threshold: S.d.threshold ?? Math.min(base.threshold, owners.length || 1) }
}

const validOwner = (s: string) => isAddress(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(s)

// ---------------------------------------------------------------- compose: replicate a transaction

async function loadSource() {
  const src = S.d.source.trim()
  try {
    if (src.startsWith('{')) {
      const j = JSON.parse(src)
      S.lines = linesFromTxBuilder(j)
      S.sourceNote = `${plural(j.transactions.length, 'call')} from a Transaction Builder file`
    } else {
      const hash = src.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined
      const chain = chainOf(src.match(/safe=([a-z0-9-]+):/i)?.[1] ?? src.match(/^([a-z0-9-]+):0x/i)?.[1] ?? '')
      if (!hash || !chain) throw new Error('Paste a Safe{Wallet} transaction link, or a Transaction Builder JSON file')
      const t = await svc.getTx(chain.id, hash)
      if (!t) throw new Error('That transaction isn\'t in the Safe Transaction Service')
      S.lines = linesFromTx(t)
      S.sourceNote = `From ${chain.name} ${short(t.safe)}, nonce ${t.nonce}`
    }
    S.errors = []
  } catch (e) { S.lines = ''; S.sourceNote = ''; S.errors = [msg(e)] }
  edited()
}

// ---------------------------------------------------------------- compose: prepare and share

function actionsFor(): { actions: Action[]; errors: string[] } {
  if (S.d.mode === 'replicate') return S.lines ? parseActions(S.lines) : { actions: [], errors: ['Load a transaction to replicate first.'] }
  const t = targetOwners(), errors: string[] = []
  for (const o of [...t.owners, ...t.replace.map(r => r[1])]) if (!validOwner(o)) errors.push(`"${o}" isn't an address or name.eth`)
  if (t.threshold < 1 || t.threshold > t.owners.length) errors.push(`Threshold ${t.threshold} doesn't fit ${plural(t.owners.length, 'owner')}`)
  return { actions: [{ kind: 'sync', owners: t.owners, threshold: t.threshold, replace: t.replace }], errors }
}

async function prepare() {
  const my = ++run
  const targets = selected().map(f => ({ chainId: f.chainId, safe: f.safe }))
  const a = actionsFor()
  S.errors = [...a.errors]
  if (!targets.length) S.errors.push('Find and select at least one Safe.')
  S.prepared = []; S.link = ''
  if (S.errors.length) return update()
  S.preparing = true; update()
  try {
    const names = await resolveNames(a.actions)
    if (my !== run) return
    S.names = names
    S.prepared = targets.map(x => ({ ...x, notes: ['checking the queue…'] }))
    update()
    await Promise.all(targets.map(async (x, i) => {
      const p = await prepareTarget(x, a.actions, names, S.d.afterQueue ? queueEnd : undefined)
      if (my !== run) return
      p.notes.unshift('checking the queue…')
      S.prepared[i] = p; update()
      await checkQueue(p, my)
    }))
  } catch (e) { if (my === run) S.errors.push(msg(e)) }
  if (my === run) { S.preparing = false; update() }
}

/** Notes transactions already queued at this nonce: the same one (its signatures count) or a competitor. */
async function checkQueue(p: Prepared, my: number) {
  const drop = () => (p.notes = p.notes.filter(n => n !== 'checking the queue…'))
  if (!p.tx || p.error || !svc.serviceUrl(p.chainId)) return void drop()
  try {
    const q = await svc.queued(p.chainId, p.safe, p.tx.nonce)
    drop()
    if (q.some(o => o.safeTxHash === p.hash)) p.notes.push('already queued in Safe{Wallet}; its signatures count')
    else if (q.some(o => o.nonce === p.tx!.nonce)) p.notes.push(`⚠ another transaction is queued at nonce ${p.tx.nonce}`)
  } catch (e) { drop(); p.notes.push(`queue check failed: ${msg(e)}`) }
  if (my === run) update()
}

async function queueEnd(chainId: number, safe: Address, nonce: number): Promise<number> {
  if (!svc.serviceUrl(chainId)) return nonce
  const q = await svc.queued(chainId, safe, nonce)
  return Math.max(nonce, ...q.map(o => o.nonce + 1))
}

const prepKind = (p: Prepared) => (p.error ? 'attention' : p.skip ? 'synced' : p.tx ? 'ready' : 'loading')

async function createLink() {
  const ready = S.prepared.filter(p => prepKind(p) === 'ready')
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const batch: Batch = { title: S.d.title.trim() || 'Untitled batch', created: Date.now(), txs: ready.map(p => p.tx!), labels, src: S.d }
  S.link = `${location.href.split('#')[0]}#${await encodeBatch(batch)}`
  copy(S.link)
}

// ---------------------------------------------------------------- batch

// Signatures are kept per safeTxHash, so they carry over when a batch is edited into a new link.
const sigKey = (h: Hex) => `safesync:sig:${h}`
const saveSigs = (r: Row) => store.set(sigKey(r.hash), Object.fromEntries(Object.entries(r.sigs).map(([k, s]) => [k, { owner: s.owner, sig: s.sig }])))

async function openBatch(encoded: string) {
  try {
    const batch = await decodeBatch(encoded)
    S.batch = batch; S.id = batchId(batch); S.mode = 'batch'; S.loadError = ''
    S.rows = batch.txs.map(tx => {
      const hash = safeTxHash(tx), saved = store.get<Record<string, { owner: Address; sig: Hex }>>(sigKey(hash), {})
      return { tx, hash, sigs: Object.fromEntries(Object.entries(saved).map(([k, s]) => [k, { ...s, posted: false }])), svc: 'loading', proposed: false, readAt: 0, others: [] }
    })
    S.rows.forEach(r => (r.loaded = loadRow(r)))
  } catch (e) { S.loadError = `This link is not a valid batch: ${msg(e)}`; S.mode = 'batch' }
  update()
}

async function loadRow(r: Row) {
  try {
    const [st, h] = await Promise.all([readSafe(r.tx.chainId, r.tx.safe), onchainHash(r.tx)])
    if (h !== r.hash) r.fatal = `Hash mismatch: the Safe computes ${h}`
    r.owners = st.owners; r.threshold = st.threshold; r.chainNonce = st.nonce
  } catch (e) { r.error = `Couldn't read the chain: ${msg(e)}` }
  update()
  if (svc.serviceUrl(r.tx.chainId)) await readService(r)
  else { r.svc = 'none'; await verify(r) }
  saveSigs(r); update()
  // Outbox: anything signed here that the service doesn't have yet is (re)uploaded.
  if (r.svc === 'ok' && needsWork(r)) for (const s of Object.values(r.sigs)) if (!s.posted) post(r, s)
}

/** One request: this transaction's confirmations and execution, plus anything else at the same nonce. */
async function readService(r: Row) {
  try {
    const all = await svc.atNonce(r.tx.chainId, r.tx.safe, r.tx.nonce)
    const t = all.find(x => x.safeTxHash.toLowerCase() === r.hash.toLowerCase())
    r.others = all.filter(x => x !== t).map(x => ({ safeTxHash: x.safeTxHash, isExecuted: x.isExecuted }))
    r.proposed = !!t; r.svcExecuted = t?.isExecuted; r.readAt = Date.now(); r.svc = 'ok'
    // The service is the truth: a local signature counts as uploaded only if the service has it
    // (a proposal can be deleted in Safe{Wallet}; an upload can fail after the device signed).
    for (const [k, s] of Object.entries(r.sigs)) s.posted = !!t?.confirmations.some(c => c.owner.toLowerCase() === k)
    for (const c of t?.confirmations ?? []) r.sigs[c.owner.toLowerCase()] = { owner: c.owner, sig: c.signature, posted: true }
  } catch (e) { r.svc = 'error'; r.error = `Safe service: ${msg(e)}` }
  await verify(r)
}

/** Keeps only signatures that recover to the owner they claim (drops corrupt, approved-hash and contract signatures). */
async function verify(r: Row) {
  for (const [k, s] of Object.entries(r.sigs)) if ((await sigOwner(r.hash, s.sig).catch(() => undefined))?.toLowerCase() !== k) delete r.sigs[k]
}

function post(r: Row, s: Sig) {
  s.uploading = true
  r.posting = (r.posting ?? Promise.resolve()).then(async () => {
    if (s.posted) return void (s.uploading = false)
    try {
      await svc.submit(r.tx, r.hash, s.owner, s.sig, r.proposed)
      s.posted = true; r.proposed = true; r.error = undefined
    } catch (e) { r.error = `Signed but not uploaded: ${msg(e)}` }
    s.uploading = false; update()
  })
}

const isOwner = (r: Row, a?: Address | null) => !!a && !!r.owners?.some(o => o.toLowerCase() === a.toLowerCase())
const validSigs = (r: Row) => Object.values(r.sigs).filter(s => isOwner(r, s.owner))
function status(r: Row): { kind: Kind; text: string } {
  if (r.fatal) return { kind: 'blocked', text: r.fatal }
  if (r.chainNonce === undefined) return r.error ? { kind: 'unknown', text: r.error } : { kind: 'loading', text: 'loading…' }
  if (r.chainNonce > r.tx.nonce) {
    if (r.svcExecuted || r.execOk) return { kind: 'executed', text: 'executed' }
    if (r.svc === 'loading' || r.execHash) return { kind: 'loading', text: 'checking…' }
    if (r.svc === 'ok') return { kind: 'blocked', text: `nonce ${r.tx.nonce} was used by another transaction` }
    return { kind: 'unknown', text: `nonce ${r.tx.nonce} is used; can't confirm it was this transaction` }
  }
  if (r.execHash) return { kind: 'waiting', text: 'executing…' }
  const n = validSigs(r).length, t = r.threshold!
  if (n >= t) return r.chainNonce === r.tx.nonce ? { kind: 'ready', text: 'ready to execute' } : { kind: 'waiting', text: `signed; nonce ${r.chainNonce} must execute first` }
  return { kind: 'collecting', text: `${n} of ${t} signatures` }
}
const needsWork = (r: Row) => ['collecting', 'ready', 'waiting'].includes(status(r).kind)
const mine = (r: Row) => !!S.account && !!r.sigs[S.account.toLowerCase()]
const canSign = (r: Row) => isOwner(r, S.account) && !mine(r) && status(r).kind === 'collecting'

// ---------------------------------------------------------------- wallet

window.addEventListener('eip6963:announceProvider', (e: any) => { if (!S.wallets.some(w => w.info.rdns === e.detail.info.rdns)) S.wallets.push(e.detail); update() })
window.dispatchEvent(new Event('eip6963:requestProvider'))

async function connect(w?: Wallet) {
  const provider = w?.provider ?? (S.wallets.length === 1 ? S.wallets[0].provider : S.wallets.length ? null : (window as any).ethereum)
  if (!provider) { S.choosing = S.wallets.length > 1; S.notice = S.wallets.length ? '' : 'No browser wallet found.'; return update() }
  S.choosing = false
  try {
    // Wallets may return lowercase addresses; the Safe service rejects anything not checksummed.
    const [account] = await provider.request({ method: 'eth_requestAccounts' })
    S.provider = provider; S.account = getAddress(account)
    provider.on?.('accountsChanged', (a: Address[]) => {
      S.account = a[0] ? getAddress(a[0]) : null
      if (S.signing || S.executing) stop('Wallet account changed, so I stopped.')
      update()
    })
  } catch (e) { S.notice = msg(e) }
  update()
}

async function ensureChain(id: number) {
  const p = S.provider
  if (Number(await p.request({ method: 'eth_chainId' })) === id) return
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(id) }] })
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecogni[sz]ed|not added|unknown chain|not supported/i.test(msg(e))) throw e
    const c = chainOf(id)!
    await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: toHex(id), chainName: c.name, nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 }, rpcUrls: c.rpcs, blockExplorerUrls: c.explorer ? [c.explorer] : undefined }] })
    if (Number(await p.request({ method: 'eth_chainId' })) !== id) await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(id) }] })
  }
}

const rejected = (e: any) => e?.code === 4001 || e?.cause?.code === 4001 || /reject|denied|cancel/i.test(msg(e))

// Each run gets an id; Pause bumps it, so an older run that wakes up after a pending request stops.
let session = 0
function stop(notice = '') { session++; S.signing = S.executing = false; S.notice = notice; update() }
/** One wallet request at a time; while it is pending the start buttons stay disabled, even after Pause. */
async function ask<T>(f: () => Promise<T>): Promise<T> {
  S.waiting = true; update()
  try { return await f() } finally { S.waiting = false; update() }
}

async function signAll() {
  const account = S.account!, my = ++session
  S.signing = true; S.notice = ''; update()
  const stopped = () => my !== session || S.account !== account
  for (const r of S.rows) {
    if (stopped()) break
    await r.loaded
    if (!canSign(r)) continue
    S.current = r
    try {
      // Fresh reads right before involving the wallet: skip anything executed or completed meanwhile.
      r.phase = 'checking'; update()
      const nonce = Number(await client(r.tx.chainId).readContract({ address: r.tx.safe, abi: SAFE_ABI, functionName: 'nonce' }))
      if (nonce > r.tx.nonce) { r.chainNonce = nonce; continue }
      if (r.svc !== 'none' && Date.now() - r.readAt > 30_000) await readService(r)
      if (stopped() || !canSign(r)) continue
      r.phase = 'switching network'; update()
      await ask(() => ensureChain(r.tx.chainId))
      if (stopped()) break
      r.phase = 'confirm in your wallet'; update()
      const sig = normalizeSig(await ask(() => S.provider.request({ method: 'eth_signTypedData_v4', params: [account, walletTypedData(r.tx)] })))
      if ((await sigOwner(r.hash, sig))?.toLowerCase() !== account.toLowerCase()) throw new Error('The wallet returned a signature for a different account or message')
      // Kept even if Pause was pressed while the wallet was open: it is a valid signature.
      const s = (r.sigs[account.toLowerCase()] = { owner: account, sig, posted: false })
      r.error = undefined; saveSigs(r)
      if (svc.serviceUrl(r.tx.chainId)) post(r, s)
    } catch (e) {
      if (rejected(e)) stop('Paused: the request was rejected in your wallet.')
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  if (my === session) { S.signing = false; S.current = null; update() }
}

async function executeAll() {
  const account = S.account!, my = ++session
  S.executing = true; S.notice = ''; update()
  const stopped = () => my !== session || S.account !== account
  for (const r of S.rows) {
    if (stopped()) break
    if (status(r).kind !== 'ready') continue
    S.current = r
    try {
      r.phase = 'switching network'; update()
      await ask(() => ensureChain(r.tx.chainId))
      const c = client(r.tx.chainId)
      const data = execData(r.tx, validSigs(r), r.threshold!)
      r.phase = 'simulating'; update()
      try { await c.call({ account, to: r.tx.safe, data }) } catch (e) {
        const d = revertData(e); throw new Error(`Execution would fail: ${d ? revertReason(d) : msg(e)}`)
      }
      const gas = await c.estimateGas({ account, to: r.tx.safe, data })
      if (stopped()) break
      r.phase = 'confirm in your wallet'; update()
      r.execHash = await ask(() => S.provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: r.tx.safe, data, gas: toHex((gas * 13n) / 10n) }] }))
      // Only a successful receipt counts as executed; a broadcast hash alone doesn't.
      c.waitForTransactionReceipt({ hash: r.execHash! }).then(rc => {
        if (rc.status === 'success') r.execOk = true, r.chainNonce = r.tx.nonce + 1
        else r.error = 'Execution reverted', r.execHash = undefined
        update()
      }, e => { r.error = msg(e); r.execHash = undefined; update() })
    } catch (e) {
      if (rejected(e)) stop('Paused: the request was rejected in your wallet.')
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  if (my === session) { S.executing = false; S.current = null; update() }
}

// Signatures the Safe service doesn't hold (no service on the chain, or upload failed) can be shared as a bundle.
const unshared = (r: Row) => (r.svc === 'loading' || !needsWork(r) ? [] : Object.values(r.sigs).filter(s => r.svc !== 'ok' || !s.posted))
const exportSigs = () => `safesync-sigs:${btoa(JSON.stringify(S.rows.flatMap(r => unshared(r).map(s => [r.hash, s.sig]))))}`

async function importSigs() {
  let added = 0
  try {
    for (const m of S.pasted.matchAll(/safesync-sigs:([A-Za-z0-9+/=]+)/g)) {
      for (const [hash, sig] of JSON.parse(atob(m[1])) as [Hex, Hex][]) {
        const r = S.rows.find(r => r.hash === hash)
        const owner = r && (await sigOwner(hash, sig).catch(() => undefined))
        if (!r || !owner || !isOwner(r, owner) || r.sigs[owner.toLowerCase()]) continue
        const s = (r.sigs[owner.toLowerCase()] = { owner, sig, posted: false })
        saveSigs(r); added++
        if (r.svc === 'ok' && needsWork(r)) post(r, s)
      }
    }
    S.notice = `Added ${plural(added, 'signature')}.`; S.pasted = ''
  } catch (e) { S.notice = `Could not read signatures: ${msg(e)}` }
  update()
}

function refresh() {
  for (const r of S.rows) { r.error = undefined; r.svc = 'loading'; r.loaded = loadRow(r) }
  update()
}

function edit() {
  if (!S.batch) return
  const src = S.batch.src as Partial<Draft> | null
  S.d = { ...blank(), ...(src && typeof src === 'object' ? src : {}), title: S.batch.title }
  history.pushState(null, '', location.pathname + location.search)
  S.mode = 'compose'; edited()
  if (S.d.safes) find()
  if (S.d.mode === 'replicate' && S.d.source) loadSource()
}

// ---------------------------------------------------------------- view helpers

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => { S.notice = 'Copied.'; update(); setTimeout(() => { if (S.notice === 'Copied.') S.notice = '', update() }, 1500) }, () => {})
  update()
}
const addr = (a: string, labels: Record<string, string> = S.batch?.labels ?? {}) =>
  html`<span class="mono" title=${a}>${short(a)}</span>${labels[a.toLowerCase()] ? html` <span class="label">${labels[a.toLowerCase()]}</span>` : nothing}`
const chainChip = (id: number) => html`<span class="chip" title=${chainName(id)}>${chainOf(id)?.short ?? id}</span>`
const safeLink = (tx: { chainId: number; safe: string }, hash?: string) => {
  const c = chainOf(tx.chainId)
  if (c?.service) return `https://app.safe.global/${hash ? `transactions/tx?safe=${c.short}:${tx.safe}&id=multisig_${tx.safe}_${hash}` : `home?safe=${c.short}:${tx.safe}`}`
  return c?.explorer ? `${c.explorer}/address/${tx.safe}` : undefined
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const fmt = ([t, n]: [number, number]) => `${t}-of-${n}`
const argValue = (v: string, labels: Record<string, string>) => (isAddress(v) ? addr(v, labels) : v === 'this Safe' ? html`<b>this Safe</b>` : html`<span class="mono wrap">${v}</span>`)

/** Every decoded field, for the technical view. */
function steps(list: Step[], labels: Record<string, string>) {
  return html`<ol class="steps">${list.map(s => html`<li>
    <b>${s.target === 'self' ? 'this Safe' : addr(s.target, labels)}</b> · <span class="fn">${s.fn}</span>
    ${s.op === 1 ? html`<span class="bad"> DELEGATECALL</span>` : nothing}
    ${s.value ? html` · value ${s.value.toString()} wei` : nothing}
    ${s.args.length ? html`<div class="args">${s.args.map(([k, v]) => html`<div><span class="muted">${k}</span> ${argValue(v, labels)}</div>`)}</div>` : nothing}
    ${s.raw ? html`<div class="mono small wrap">${s.raw}</div>` : nothing}
  </li>`)}</ol>`
}

const OWNER_FNS = ['swapOwner', 'addOwnerWithThreshold', 'removeOwner', 'changeThreshold']

/** One plain-language line per step. Owner changes ignore encoding details such as prevOwner; calls keep their arguments. */
function intent(s: Step, labels: Record<string, string>): { key: string; view: TemplateResult } {
  const a = Object.fromEntries(s.args)
  if (s.target === 'self' && s.op === 0) {
    if (s.fn === 'swapOwner') return { key: `swap ${a.oldOwner} ${a.newOwner}`, view: html`Replace ${addr(a.oldOwner, labels)} → ${addr(a.newOwner, labels)}` }
    if (s.fn === 'addOwnerWithThreshold') return { key: `add ${a.owner}`, view: html`Add owner ${addr(a.owner, labels)}` }
    if (s.fn === 'removeOwner') return { key: `remove ${a.owner}`, view: html`Remove owner ${addr(a.owner, labels)}` }
    if (s.fn === 'changeThreshold') return { key: `threshold ${a._threshold}`, view: html`Set the threshold to ${a._threshold}` }
  }
  const target = s.target === 'self' ? html`this Safe` : addr(s.target, labels)
  return {
    key: JSON.stringify([s.target, s.fn, s.args, String(s.value), s.op, s.raw]),
    view: html`${s.op === 1 ? html`<b class="bad">DELEGATECALL </b>` : nothing}Call <span class="fn">${s.fn}</span>${s.args.length ? html`(${s.args.map(([k, v], i) => html`${i ? ', ' : ''}<span class="muted">${k}</span> ${argValue(v, labels)}`)})` : nothing} on ${target}${s.value ? html` with ${s.value.toString()} wei` : nothing}`,
  }
}

/** The intended change in plain language, grouped across Safes; exact encodings behind a toggle. */
function changeView(txs: Tx[], result: (tx: Tx) => Result | undefined, labels: Record<string, string>) {
  const groups = new Map<string, { txs: Tx[]; lines: TemplateResult[]; owners: boolean }>()
  for (const tx of txs) {
    const list = describe(tx), its = list.map(s => intent(s, labels)), key = its.map(i => i.key).join('\n')
    const g = groups.get(key) ?? { txs: [], lines: its.map(i => i.view), owners: list.some(s => s.target === 'self' && OWNER_FNS.includes(s.fn)) }
    g.txs.push(tx); groups.set(key, g)
  }
  return [...groups.values()].map(g => {
    const known = g.txs.map(result).filter((r): r is Result => !!r)
    const one = known[0], uniform = !!one && known.every(r => fmt(r.before) === fmt(one.before) && fmt(r.after) === fmt(one.after))
    const payloads = new Map<string, Tx[]>()
    for (const tx of g.txs) payloads.set(payloadKey(tx), [...(payloads.get(payloadKey(tx)) ?? []), tx])
    return html`<div class="change">
      <div class="muted small">${groups.size === 1 ? `On all ${plural(g.txs.length, 'Safe')}` : html`On ${plural(g.txs.length, 'Safe')}: ${g.txs.map(t => chainChip(t.chainId))}`}</div>
      <ul>${g.lines.map(l => html`<li>${l}</li>`)}</ul>
      ${g.owners && one ? html`<div class="result">${!uniform ? 'Owner counts differ between Safes' : fmt(one.before) === fmt(one.after) ? `Threshold stays ${fmt(one.after)}` : `${fmt(one.before)} → ${fmt(one.after)}`}</div>` : nothing}
      <details><summary>Technical details</summary>
        ${[...payloads.values()].map(list => html`<div class="payload">
          ${payloads.size > 1 ? html`<div class="muted small">${plural(list.length, 'Safe')}: ${list.map(t => chainChip(t.chainId))}</div>` : nothing}
          ${steps(describe(list[0]), labels)}
          ${list[0].operation === 1 ? html`<div class="muted small">Sent through MultiSendCallOnly ${short(list[0].to)} (delegatecall), so the inner calls run as the Safe.</div>` : nothing}
        </div>`)}
      </details>
    </div>`
  })
}

// ---------------------------------------------------------------- compose view

function safesCard() {
  const byAddress = new Map<string, Pick[]>()
  for (const f of S.found) byAddress.set(f.safe, [...(byAddress.get(f.safe) ?? []), f])
  const toggle = (f: Pick) => { if (f.state) { f.selected = !f.selected; edited() } else retry(f) }
  return html`<section class="card">
    <input class="title" placeholder="Title, like Rotate signers Q4" .value=${live(S.d.title)} @input=${(e: any) => { S.d.title = e.target.value; store.set('safesync:draft', S.d) }}>
    <label><span>Safe</span>
      <div class="row">
        <input class="grow mono" placeholder="0x… (looked for on every chain), eth:0x…, or a Safe{Wallet} link" .value=${live(S.d.safes)}
          @input=${(e: any) => { S.d.safes = e.target.value; store.set('safesync:draft', S.d) }} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && find()}>
        <button class=${S.found.length ? '' : 'primary'} @click=${find} ?disabled=${S.finding || !S.d.safes.trim()}>${S.finding ? 'Looking…' : 'Find'}</button>
      </div>
      <small>A bare address is looked for on every chain. Add Safes at other addresses as <code>chain:0x…</code>, separated by spaces.</small>
    </label>
    ${[...byAddress.entries()].map(([safe, list]) => {
      const ok = list.filter(f => f.state), bad = list.filter(f => !f.state)
      return html`<div class="found">
        <div class="small"><span class="mono" title=${safe}>${short(safe)}</span> · ${ok.length ? `found on ${plural(ok.length, 'chain')}` : 'not reachable'} · <span class="muted">${ok.filter(f => f.selected).length} selected</span></div>
        <div class="chips">${ok.map(f => html`<button class=${`pick ${f.selected ? 'on' : ''}`} aria-pressed=${f.selected} title=${`${chainName(f.chainId)} · ${fmt([f.state!.threshold, f.state!.owners.length])} · nonce ${f.state!.nonce}`} @click=${() => toggle(f)}>${chainOf(f.chainId)?.short ?? f.chainId}</button>`)}</div>
        ${bad.length ? html`<div class="small warn">Couldn't check ${bad.map(f => html`<button class="pick" title=${f.error ?? ''} @click=${() => toggle(f)}>${chainOf(f.chainId)?.short ?? f.chainId} ↻</button>`)}</div>` : nothing}
      </div>`
    })}
  </section>`
}

function ownersEditor() {
  const base = baseOwners(), t = targetOwners()
  if (!base.total) return html`<p class="muted">Find a Safe first; its owners show up here to edit.</p>`
  const drift = selected().filter(f => f.state!.owners.map(a => a.toLowerCase()).sort().join() !== base.owners.map(a => a.toLowerCase()).sort().join())
  const set = (o: string, v: string | null | undefined) => { if (v === undefined) delete S.d.edits[o.toLowerCase()]; else S.d.edits[o.toLowerCase()] = v; edited() }
  return html`
    <p class="muted small">Edit the list into what every Safe should have. ${base.share === base.total ? `All ${plural(base.total, 'selected Safe')} have these owners now.` : `${base.share} of ${base.total} selected Safes have these owners now.`}
      ${drift.length ? html`<span class="warn">Different now: ${drift.map(f => chainChip(f.chainId))}. They'll be brought in line.</span>` : nothing}</p>
    <div class="owners">${base.owners.map(o => {
      const e = S.d.edits[o.toLowerCase()]
      return html`<div class="owner">
        <span class=${e === null ? 'mono gone' : 'mono'} title=${o}>${short(o)}</span>
        ${e === undefined ? html`<span class="muted small">keeps</span><span class="actions"><button class="ghost" @click=${() => set(o, '')}>Replace</button><button class="ghost" @click=${() => set(o, null)}>Remove</button></span>`
        : e === null ? html`<span class="bad small">removed</span><span class="actions"><button class="ghost" @click=${() => set(o, undefined)}>Undo</button></span>`
        : html`<input class="mono" placeholder="New owner: 0x… or name.eth" .value=${live(e)} @input=${(ev: any) => { S.d.edits[o.toLowerCase()] = ev.target.value; edited() }}><span class="actions"><button class="ghost" @click=${() => set(o, undefined)}>Undo</button></span>`}
      </div>`
    })}
    ${S.d.added.map((a, i) => html`<div class="owner">
      <span class="good small">new</span>
      <input class="mono" placeholder="0x… or name.eth" .value=${live(a)} @input=${(ev: any) => { S.d.added[i] = ev.target.value; edited() }}>
      <span class="actions"><button class="ghost" @click=${() => { S.d.added.splice(i, 1); edited() }}>Remove</button></span>
    </div>`)}
    </div>
    <div class="row">
      <button class="ghost" @click=${() => { S.d.added.push(''); edited() }}>+ Add owner</button>
      <span class="grow"></span>
      <label class="check">Threshold <input class="num" type="number" min="1" max=${t.owners.length} .value=${live(String(t.threshold))} @input=${(e: any) => { S.d.threshold = Number(e.target.value) || null; edited() }}> of ${t.owners.length}</label>
    </div>`
}

function replicateEditor() {
  return html`
    <p class="muted small">Build the transaction once in Safe{Wallet}'s Transaction Builder, then paste its link (or the exported JSON) here. Owner changes are redone per Safe; the source Safe's own address becomes each Safe's.</p>
    <textarea rows="3" spellcheck="false" placeholder="https://app.safe.global/transactions/tx?safe=eth:0x…&id=multisig_…   or   { Transaction Builder JSON }"
      .value=${live(S.d.source)} @input=${(e: any) => { S.d.source = e.target.value; S.lines = ''; edited() }}></textarea>
    <div class="row">
      <span class="grow small ${S.lines ? 'good' : 'muted'}">${S.lines ? `✓ Loaded: ${S.sourceNote}` : ''}</span>
      <button @click=${loadSource} ?disabled=${!S.d.source.trim()}>Load</button>
    </div>
    ${S.lines ? html`<details><summary>As it will be replicated</summary><pre class="mono small wrap">${S.lines}</pre></details>` : nothing}`
}

function composeView() {
  const by = (k: string) => S.prepared.filter(p => prepKind(p) === k)
  const ready = by('ready'), synced = by('synced'), attention = by('attention'), loading = by('loading')
  const checking = S.prepared.filter(p => p.notes.includes('checking the queue…')).length
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const prepResult = (tx: Tx) => {
    const p = S.prepared.find(p => p.tx === tx)
    return p?.state && p.owners && p.threshold !== undefined ? { before: [p.state.threshold, p.state.owners.length], after: [p.threshold, p.owners.length] } as Result : undefined
  }
  const mode = (m: Draft['mode'], label: string) => html`<button class=${S.d.mode === m ? 'seg on' : 'seg'} aria-pressed=${S.d.mode === m} @click=${() => { S.d.mode = m; edited() }}>${label}</button>`
  return html`
  ${safesCard()}
  <section class="card">
    <div class="row"><span class="segs">${mode('owners', 'Owners and threshold')}${mode('replicate', 'Replicate a transaction')}</span></div>
    ${S.d.mode === 'owners' ? ownersEditor() : replicateEditor()}
    <div class="row">
      <label class="check"><input type="checkbox" .checked=${S.d.afterQueue} @change=${(e: any) => { S.d.afterQueue = e.target.checked; edited() }}> Queue after transactions already pending</label>
      <span class="grow"></span>
      <button class="primary" @click=${prepare} ?disabled=${S.preparing || !selected().length}>${S.preparing ? 'Preparing…' : `Prepare ${selected().length ? plural(selected().length, 'Safe') : ''}`}</button>
    </div>
    ${S.errors.length ? html`<div class="errors">${S.errors.map(e => html`<div>${e}</div>`)}</div>` : nothing}
  </section>

  ${S.prepared.length ? html`
  <section class="card">
    <div class="summary">
      <span class="good">✓ ${ready.length} ready</span>
      ${synced.length ? html` · <span class="muted">${synced.length} already in sync</span>` : nothing}
      ${attention.length ? html` · <span class="bad">${attention.length} need${attention.length === 1 ? 's' : ''} attention</span>` : nothing}
      ${loading.length ? html` · <span class="muted">${loading.length} reading…</span>` : nothing}
    </div>
    ${Object.keys(S.names).length ? html`<div class="muted small">Resolved on Ethereum: ${Object.entries(S.names).map(([n, a]) => html`${n} → <span class="mono">${a}</span> `)}</div>` : nothing}
    ${ready.length ? changeView(ready.map(p => p.tx!), prepResult, labels) : nothing}
    <div class="scroll"><table>
      <thead><tr><th></th><th>Chain</th><th>Safe</th><th>Nonce</th><th>Owners</th><th>Notes</th></tr></thead>
      <tbody>${S.prepared.map(p => {
        const k = prepKind(p)
        return html`<tr>
          <td class="ico-cell">${k === 'ready' ? html`<span class="ico done">✓</span>` : k === 'synced' ? html`<span class="ico done quiet">✓</span>` : k === 'attention' ? html`<span class="ico warn">!</span>` : html`<span class="ico now"></span>`}</td>
          <td>${chainChip(p.chainId)}</td>
          <td>${addr(p.safe, labels)}</td>
          <td>${p.tx?.nonce ?? p.state?.nonce ?? ''}</td>
          <td class="nowrap">${p.state ? (p.owners && p.threshold !== undefined && (p.owners.length !== p.state.owners.length || p.threshold !== p.state.threshold) ? `${fmt([p.state.threshold, p.state.owners.length])} → ${fmt([p.threshold, p.owners.length])}` : fmt([p.state.threshold, p.state.owners.length])) : ''}</td>
          <td class="small">
            ${p.error ? html`<span class="bad">${p.error}</span>` : p.skip ? html`<span class="muted">${p.skip}</span>` : nothing}
            ${p.sim && !p.sim.ok && !p.sim.definite ? html`<span class="warn">${p.sim.error}</span>` : nothing}
            <span class=${p.notes.some(n => n.startsWith('⚠')) ? 'warn' : 'muted'}>${p.notes.join('; ')}</span>
          </td>
        </tr>`
      })}</tbody>
    </table></div>
    <div class="row">
      <span class="grow muted small">The link covers the ${plural(ready.length, 'ready Safe')}.${checking ? ` Still checking ${plural(checking, 'queue')} for conflicts; signers see conflicts too.` : ''} Whoever executes pays gas.</span>
      <button class="primary" @click=${createLink} ?disabled=${S.preparing || !ready.length}>Create signing link</button>
    </div>
    ${S.link ? html`<div class="linkbox">
      <input readonly .value=${live(S.link)} @focus=${(e: any) => e.target.select()}>
      <button @click=${() => copy(S.link)}>Copy</button>
      <a class="button primary" href=${S.link}>Open to sign</a>
      <div class="muted small">Share it in your team chat. The link holds the whole batch; nothing is stored on a server.</div>
    </div>` : nothing}
  </section>` : nothing}`
}

// ---------------------------------------------------------------- batch view

/** The checklist mark for one Safe, from the connected signer's point of view. */
function icon(r: Row, kind: Kind) {
  if (r === S.current) return html`<span class="ico now"></span>`
  if (kind === 'blocked') return html`<span class="ico warn">!</span>`
  if (kind === 'unknown') return html`<span class="ico todo quiet">?</span>`
  if (mine(r) || kind === 'executed') return html`<span class="ico done">✓</span>`
  if (canSign(r)) return html`<span class="ico todo"></span>`
  if (S.account && (kind === 'ready' || kind === 'waiting')) return html`<span class="ico done quiet" title="Has enough signatures without yours">✓</span>`
  if (S.account && r.owners && !isOwner(r, S.account)) return html`<span class="ico idle" title="You are not an owner">–</span>`
  return html`<span class="ico todo quiet"></span>`
}
const KIND_CLASS: Record<Kind, string> = { loading: 'muted', collecting: '', ready: 'good', waiting: 'muted', executed: 'good', blocked: 'bad', unknown: 'warn' }

function rowResult(tx: Tx): Result | undefined {
  const r = S.rows.find(r => r.tx === tx)
  if (!r?.owners || r.threshold === undefined || !needsWork(r)) return
  let n = r.owners.length, t = r.threshold
  for (const s of describe(tx)) {
    if (s.target !== 'self') continue
    const a = Object.fromEntries(s.args)
    if (s.fn === 'addOwnerWithThreshold') n++, t = Number(a._threshold)
    if (s.fn === 'removeOwner') n--, t = Number(a._threshold)
    if (s.fn === 'changeThreshold') t = Number(a._threshold)
  }
  return { before: [r.threshold, r.owners.length], after: [t, n] }
}

function progressView() {
  const yours = S.account ? S.rows.filter(r => mine(r) || canSign(r)) : []
  const signed = yours.filter(mine).length, remaining = yours.length - signed
  const loading = S.rows.some(r => status(r).kind === 'loading')
  const ready = S.rows.filter(r => status(r).kind === 'ready').length
  const executed = S.rows.filter(r => status(r).kind === 'executed').length
  const busy = S.signing || S.executing || S.waiting
  const pending = (r: Row) => (r.svc === 'ok' ? unshared(r) : [])
  const uploading = S.rows.reduce((n, r) => n + pending(r).filter(s => s.uploading).length, 0)
  const notUploaded = S.rows.reduce((n, r) => n + pending(r).filter(s => !s.uploading).length, 0)
  const manual = S.rows.filter(r => r.svc === 'none' && needsWork(r) && Object.keys(r.sigs).length)
  const bar = html`<div class="bar"><i style=${`width:${yours.length ? Math.round((signed / yours.length) * 100) : 0}%`}></i></div>`
  const cur = S.current
  return html`
  ${!S.account ? html`<div class="row">
      <button class="primary" @click=${() => connect()}>Connect wallet</button>
      ${S.choosing ? S.wallets.map(w => html`<button @click=${() => connect(w)}><img src=${w.info.icon} alt="">${w.info.name}</button>`) : nothing}
      <span class="muted grow">Connect the wallet you sign with to see which Safes need you.</span>
    </div>`
  : S.signing ? html`<div class="row"><b class="grow">Signing ${Math.min(signed + 1, yours.length)} of ${yours.length}</b><button @click=${() => stop()}>Pause</button></div>
      ${bar}
      ${cur ? html`<div class="current">
        <div><b>${chainName(cur.tx.chainId)}</b> · ${addr(cur.tx.safe)} · nonce ${cur.tx.nonce} · <span class="muted">${cur.phase ?? ''}</span></div>
        <div class="hashes"><span class="muted">safeTxHash</span><span class="mono">${cur.hash}</span></div>
        <div class="hashes"><span class="muted">domain hash</span><span class="mono">${domainHash(cur.tx)}</span></div>
        <div class="hashes"><span class="muted">message hash</span><span class="mono">${messageHash(cur.tx)}</span></div>
      </div>` : nothing}`
  : remaining ? html`<div class="row">
      <span class="grow">${addr(S.account)} · you've signed <b>${signed}</b> of ${yours.length}${loading ? html` <span class="muted">(still loading)</span>` : nothing}</span>
      <button class="primary" @click=${signAll} ?disabled=${busy}>${S.waiting ? 'Waiting for your wallet…' : `Sign remaining ${remaining}`}</button>
    </div>${bar}`
  : yours.length ? html`
      ${uploading && !notUploaded && !manual.length ? html`<div class="done-msg">✓ Signing complete. <span class="muted">Uploading ${plural(uploading, 'signature')}…</span></div>`
      : notUploaded || manual.length ? html`<div class="done-msg warn">✓ Signing complete, but ${[
        notUploaded ? `${plural(notUploaded, 'signature')} didn't upload yet` : '',
        manual.length ? html`${manual.map(r => chainChip(r.tx.chainId))} ${manual.length === 1 ? 'needs' : 'need'} signatures shared by hand` : '',
      ].filter(Boolean).map((x, i) => html`${i ? ' and ' : ''}${x}`)}.</div>
      <div class="row">${notUploaded ? html`<button @click=${refresh}>Retry upload</button>` : nothing}<button @click=${() => copy(exportSigs())}>Copy signatures to share</button></div>`
      : html`<div class="done-msg">✓ You've signed all ${yours.length}. Nothing else is needed from you.</div>`}${bar}`
  : html`<div class="muted">${loading ? 'Checking which Safes need your signature…' : html`${addr(S.account)} has nothing to sign: it isn't an owner here, or every Safe already has enough signatures.`}</div>`}
  <div class="row small">
    <span class="grow muted">Executed <b>${executed}</b> of ${S.rows.length}${ready ? html` · <b class="good">${ready} ready to execute</b> (anyone can, and pays gas)` : nothing}</span>
    ${S.account && ready && !busy ? html`<button @click=${executeAll}>Execute ${ready}</button>` : nothing}
    ${S.executing ? html`<button @click=${() => stop()}>Stop</button>` : nothing}
    <button class="ghost" @click=${refresh} ?disabled=${busy} title="Re-read the chain and the Safe service">↻ Refresh</button>
  </div>
  ${!storageOk ? html`<div class="notice">This browser can't save signatures. Keep the tab open until they're uploaded, or copy them below.</div>` : nothing}
  ${S.notice ? html`<div class="notice">${S.notice}</div>` : nothing}`
}

function batchView() {
  if (S.loadError) return html`<section class="card"><div class="errors">${S.loadError}</div><button @click=${() => { location.hash = ''; S.mode = 'compose'; update() }}>New batch</button></section>`
  const b = S.batch!
  const manual = S.rows.filter(r => r.svc === 'none' && needsWork(r))
  const toShare = S.rows.reduce((n, r) => n + unshared(r).length, 0)
  return html`
  <section class="card">
    <div class="row">
      <h2 class="grow">${b.title}</h2>
      <span class="fingerprint" title="Fingerprint of every safeTxHash in this batch. Confirm it with the proposer.">${S.id}</span>
    </div>
    <div class="muted small">${plural(S.rows.length, 'Safe')} · ${plural(new Set(S.rows.map(r => r.tx.chainId)).size, 'chain')} · created ${new Date(b.created).toLocaleString()}
      · <a href="#" @click=${(e: Event) => { e.preventDefault(); copy(location.href) }}>copy link</a> · <a href="#" @click=${(e: Event) => { e.preventDefault(); edit() }}>edit as new batch</a></div>
    ${changeView(b.txs, rowResult, b.labels)}
  </section>

  <section class="card sticky">${progressView()}</section>

  <section class="card list">
    <div class="scroll"><table><tbody>${S.rows.map(r => {
      const st = status(r)
      const link = safeLink(r.tx, r.proposed ? r.hash : undefined)
      const conflict = r.others.some(o => !o.isExecuted) && needsWork(r)
      const toggle = () => { r.open = !r.open; update() }
      return html`<tr class=${`click ${r === S.current ? 'active' : ''}`} @click=${toggle}>
        <td class="ico-cell">${icon(r, st.kind)}</td>
        <td>${chainChip(r.tx.chainId)}</td>
        <td>${addr(r.tx.safe)}</td>
        <td class="muted nowrap nonce-cell">nonce ${r.tx.nonce}</td>
        <td class="grow-cell">
          <span class=${KIND_CLASS[st.kind]}>${r === S.current && r.phase ? r.phase : st.text}</span>
          ${r.svc === 'none' ? html` <span class="tag" title="No Safe Transaction Service on this chain: share signatures with a bundle">manual</span>` : nothing}
          ${conflict ? html`<div class="small warn">⚠ Another transaction is also queued at nonce ${r.tx.nonce}; only one of them can execute.</div>` : nothing}
          ${r.error && st.kind !== 'unknown' ? html`<div class="small bad">${r.error}</div>` : nothing}
        </td>
        <td><button class="ghost disclose" aria-expanded=${!!r.open} aria-label=${`Details for ${chainName(r.tx.chainId)}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${r.open ? '▾' : '▸'}</button></td>
      </tr>
      ${r.open ? html`<tr class="details"><td></td><td colspan="5">
        <div class="kv">
          <span>to</span><span class="mono wrap">${r.tx.to}</span>
          <span>value</span><span class="mono">${r.tx.value}</span>
          <span>operation</span><span>${r.tx.operation === 1 ? 'DELEGATECALL (1)' : 'CALL (0)'}</span>
          <span>data</span><span class="mono wrap">${r.tx.data}</span>
          <span>gas and refund</span><span class="mono">all zero</span>
          <span>safeTxHash</span><span class="mono wrap">${r.hash}</span>
          <span>domain hash</span><span class="mono wrap">${domainHash(r.tx)}</span>
          <span>message hash</span><span class="mono wrap">${messageHash(r.tx)}</span>
          <span>signed by</span><span>${validSigs(r).map(s => html`<div>${addr(s.owner)}${r.svc === 'ok' && !s.posted ? html` <span class="warn">not uploaded</span>` : nothing}</div>`)}</span>
          ${link ? html`<span>open in</span><span><a href=${link} target="_blank" rel="noopener">${chainOf(r.tx.chainId)?.service ? 'Safe{Wallet}' : 'explorer'}</a>${r.execHash ? html` · <a href=${`${chainOf(r.tx.chainId)?.explorer}/tx/${r.execHash}`} target="_blank" rel="noopener">execution</a>` : nothing}</span>` : nothing}
        </div>
      </td></tr>` : nothing}`
    })}</tbody></table></div>
  </section>

  ${manual.length || toShare ? html`<section class="card">
    <h3>Share signatures by hand</h3>
    <p class="muted small">
      ${manual.length ? html`${manual.map(r => chainChip(r.tx.chainId))} ${manual.length === 1 ? 'has' : 'have'} no Safe Transaction Service. ` : nothing}
      ${toShare ? `${plural(toShare, 'signature')} here ${toShare === 1 ? "isn't" : "aren't"} on the Safe service. ` : nothing}
      Copy the bundle into your team chat; whoever executes pastes everyone's bundles.
    </p>
    <div class="row">
      <button @click=${() => copy(exportSigs())} ?disabled=${!toShare}>Copy ${plural(toShare, 'signature')}</button>
      <textarea class="grow" rows="2" placeholder="Paste one or more safesync-sigs:… bundles" .value=${live(S.pasted)} @input=${(e: any) => { S.pasted = e.target.value; update() }}></textarea>
      <button @click=${importSigs} ?disabled=${!S.pasted.trim()}>Add</button>
    </div>
  </section>` : nothing}`
}

// ---------------------------------------------------------------- settings & shell

function settingsView() {
  const set = (k: 'rpc' | 'service' | 'apiKey') => (e: any) => (S.settings[k] = e.target.value)
  return html`<div class="modal" @click=${(e: Event) => e.target === e.currentTarget && ((S.settingsOpen = false), update())}><section class="card">
    <h3>Settings</h3>
    <label><span>RPC overrides</span><textarea rows="4" spellcheck="false" placeholder="1 https://my-node.example\narb1 https://…" .value=${live(S.settings.rpc)} @input=${set('rpc')}></textarea>
      <small>One <code>chain url</code> per line. Also adds chains that are not listed below.</small></label>
    <label><span>Safe Transaction Service overrides</span><textarea rows="2" spellcheck="false" placeholder="167000 https://safe-transaction.example.xyz" .value=${live(S.settings.service)} @input=${set('service')}></textarea>
      <small>For chains with a community-run service.</small></label>
    <label><span>Safe API key (optional)</span><input .value=${live(S.settings.apiKey)} @input=${set('apiKey')} placeholder="Raises the monthly request quota">
      <small>Stored only in this browser. Requests stay at 1 per second either way.</small></label>
    ${S.settingsErrors.length ? html`<div class="errors">${S.settingsErrors.map(e => html`<div>${e}</div>`)}</div>` : nothing}
    <div class="row"><span class="grow"></span><button class="primary" @click=${() => {
      S.settingsErrors = applySettings()
      if (!S.settingsErrors.length) { store.set('safesync:settings', S.settings); S.settingsOpen = false; if (S.mode === 'batch') refresh() }
      update()
    }}>Save</button></div>
    <details><summary>Supported chains (${CHAINS.length})</summary>
      <div class="chains">${CHAINS.map(c => html`<div><span class="chip">${c.short}</span> ${c.id} ${c.name}${c.service ? '' : html` <span class="muted">(no service)</span>`}</div>`)}</div>
    </details>
  </section></div>`
}

function view(): TemplateResult {
  return html`
  <header>
    <a class="brand" href=${location.pathname + location.search} @click=${(e: Event) => { if (S.mode === 'batch') { e.preventDefault(); history.pushState(null, '', location.pathname + location.search); S.mode = 'compose'; update() } }}>Safe Sync</a>
    <span class="muted small grow">keep a Safe the same on every chain</span>
    <button class="ghost" @click=${() => { S.settingsOpen = true; update() }}>Settings</button>
  </header>
  <main>${S.mode === 'batch' ? batchView() : composeView()}</main>
  ${S.settingsOpen ? settingsView() : nothing}`
}

function route() {
  const h = location.hash.slice(1)
  if (h) openBatch(h)
  else {
    S.mode = 'compose'; update()
    if (S.d.safes && !S.found.length && !S.finding) find()
    if (S.d.mode === 'replicate' && S.d.source && !S.lines) loadSource()
  }
}
window.addEventListener('hashchange', route)
// Signatures are kept in localStorage and re-uploaded on the next visit; only warn mid-session.
window.addEventListener('beforeunload', e => { if (S.signing || S.executing || S.waiting) e.preventDefault() })
route()
