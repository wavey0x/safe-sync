// UI. Two screens: compose (proposer) and batch (signers and executors, opened from the link).
// All state lives in the link, the Safe Transaction Service, the chain, and localStorage.
import { html, nothing, render, type TemplateResult } from 'lit-html'
import { live } from 'lit-html/directives/live.js'
import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem'
import { CHAINS } from './chains'
import {
  applyOps, batchId, chainName, chainOf, client, config, decodeBatch, describe, domainHash, encodeBatch, execData, findSafe, linesFromTx,
  linesFromTxBuilder, messageHash, msg, normalizeSig, onchainHash, parseActions, prepareTarget, readSafe, resolveNames,
  ownerOps, revertData, revertReason, SAFE_ABI, safeTxHash, short, sigOwner, walletTypedData,
  type Action, type Batch, type Found, type OwnerOp, type Prepared, type Step, type Tx,
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
/** One owner in the target: `from` is who it started as (none for an added owner), `to` who it becomes (null: removed). */
type OwnerRow = { from?: string; to: string | null; at?: number } // at: when it was replaced, so replacements keep that order
type Draft = {
  safes: string[]; mode: 'owners' | 'replicate' // safes: one address per field, first is the main Safe
  // The target, copied once from a Safe and then only edited: never recomputed from what the chains hold now.
  owners: OwnerRow[]; threshold: number | null; startedFrom: string // startedFrom: "chainId:safe"
  excluded: string[] // "chainId:safe" of chains left out
  source: string
}
type Pick = Found & { selected: boolean }
type Stage = 1 | 2 | 3 // Safe, Change, Review

let storageOk = true
const store = {
  get: <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { storageOk = false } },
}
const blank = (): Draft => ({ safes: [''], mode: 'owners', owners: [], threshold: null, startedFrom: '', excluded: [], source: '' })
/** Reads a Safe address out of whatever was pasted: a plain address, chain:0x…, or a Safe{Wallet} link. */
const addressIn = (s: string): Address | undefined => { const m = s.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/); return m ? getAddress(m[0]) : undefined }
/** Drafts saved by older versions kept all Safes in one text field. */
const asDraft = (d: Omit<Partial<Draft>, 'safes'> & { safes?: unknown }): Draft => {
  const safes = typeof d.safes === 'string' ? (d.safes.match(/0x[0-9a-fA-F]{40}/g) ?? []) : Array.isArray(d.safes) ? d.safes.map(String) : []
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : [])
  return { ...blank(), ...d, safes: safes.length ? safes : [''], owners: list<OwnerRow>(d.owners), excluded: list<string>(d.excluded) }
}
const keyOf = (f: { chainId: number; safe: string }) => `${f.chainId}:${f.safe}`

const S = {
  mode: 'compose' as 'compose' | 'batch', stage: 1 as Stage,
  d: asDraft(store.get<Partial<Draft>>('safesync:draft', {})),
  found: [] as Pick[], looking: new Set<string>(), lines: '', sourceNote: '',
  preparing: false, prepared: [] as Prepared[], errors: [] as string[], names: {} as Record<string, Address>, link: '',
  batch: null as Batch | null, id: '', rows: [] as Row[], loadError: '', pasted: '',
  wallets: [] as Wallet[], provider: null as any, account: null as Address | null, choosing: false,
  signing: false, executing: false, waiting: false, current: null as Row | null, open: new Set<string>(), notice: '', copied: '' as '' | 'yes' | 'failed',
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

/** Looks one Safe address up on every chain, replacing earlier results for it. */
async function lookup(a: Address) {
  if (S.looking.has(a)) return
  S.looking.add(a); S.found = S.found.filter(f => f.safe !== a); edited()
  const res = await findSafe(a)
  S.looking.delete(a)
  if (S.d.safes.some(x => addressIn(x) === a)) S.found = [...S.found.filter(f => f.safe !== a), ...res.map(f => ({ ...f, selected: !!f.state && !S.d.excluded.includes(keyOf(f)) }))]
  startTarget(); edited()
}

/** The first time Safes are found, their owners become the editable target (the list most of them share). */
function startTarget() {
  if (S.d.owners.length) return
  const base = baseOwners()
  if (!base.from) return
  S.d.owners = base.owners.map(o => ({ from: o, to: o }))
  S.d.threshold = base.threshold
  S.d.startedFrom = keyOf(base.from)
}

function toggle(f: Pick) {
  f.selected = !f.selected
  S.d.excluded = f.selected ? S.d.excluded.filter(k => k !== keyOf(f)) : [...S.d.excluded, keyOf(f)]
  edited()
}

function setSafe(i: number, value: string) {
  const before = addressIn(S.d.safes[i] ?? '')
  S.d.safes[i] = value
  const after = addressIn(value)
  if (before && before !== after && !S.d.safes.some(x => addressIn(x) === before)) S.found = S.found.filter(f => f.safe !== before)
  // A different main Safe starts a new target.
  if (i === 0 && after !== before) S.d.owners = [], S.d.threshold = null, S.d.startedFrom = ''
  edited()
  if (after && after !== before) lookup(after)
}

function removeSafe(i: number) {
  const a = addressIn(S.d.safes[i])
  S.d.safes.splice(i, 1)
  if (a && !S.d.safes.some(x => addressIn(x) === a)) S.found = S.found.filter(f => f.safe !== a)
  edited()
}

const lookupAll = () => Promise.all([...new Set(S.d.safes.map(addressIn).filter((a): a is Address => !!a))].map(lookup))

async function retry(p: Pick) {
  p.error = undefined; update()
  try { p.state = await readSafe(p.chainId, p.safe); p.selected = !S.d.excluded.includes(keyOf(p)) } catch (e) { p.error = msg(e) }
  startTarget(); edited()
}

/** Selected Safes, in the order their addresses were entered (lookups finish in any order). */
const selected = () => {
  const order = (f: Pick) => S.d.safes.findIndex(x => addressIn(x) === f.safe)
  return S.found.filter(f => f.selected && f.state).sort((a, b) => order(a) - order(b))
}

/** The owner list most of the selected Safes share, in the order of the first one that has it. */
function baseOwners() {
  const sel = selected(), key = (o: Address[]) => o.map(a => a.toLowerCase()).sort().join()
  const counts = new Map<string, number>()
  for (const f of sel) counts.set(key(f.state!.owners), (counts.get(key(f.state!.owners)) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  const first = sel.find(f => top && key(f.state!.owners) === top[0])
  const thresholds = sel.filter(f => f === first || (top && key(f.state!.owners) === top[0])).map(f => f.state!.threshold)
  return { from: first, owners: first?.state!.owners ?? [], threshold: thresholds.sort((a, b) => thresholds.filter(x => x === b).length - thresholds.filter(x => x === a).length)[0] ?? 1 }
}

/** The owner list every Safe should end up with, straight from the stored target. */
function targetOwners() {
  const owners = S.d.owners.flatMap(r => (r.to === null ? [] : [r.to.trim() || r.from || ''])).filter(Boolean)
  const replace = S.d.owners.filter(r => r.from && r.to?.trim() && r.to.trim().toLowerCase() !== r.from.toLowerCase())
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(r => [r.from!, r.to!.trim()] as [string, string])
  return { owners, replace, threshold: S.d.threshold ?? 1 }
}

const validOwner = (s: string) => isAddress(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(s)

// ---------------------------------------------------------------- compose: stages

/** Change needs a selected Safe; Review also needs a complete change. */
const reachable = (n: Stage) => n === 1 || (selected().length > 0 && (n === 2 || !actionsFor().errors.length))

/** Each move is a browser history entry, so the browser's Back and Forward step through the stages too. */
function goTo(n: Stage) {
  if (n === 3) { const a = actionsFor(); if (a.errors.length) return void ((S.errors = a.errors), update()) }
  if (n > 1 && !selected().length) return
  // Stepping back to the stage we came from is the browser's Back, so history doesn't fill with repeats.
  if (n < S.stage && history.state?.prev === n) return history.back()
  history.pushState({ stage: n, prev: S.stage }, '', location.pathname + location.search)
  S.stage = n; S.errors = []
  resume(); update(); scrollTo(0, 0)
}

/** Once the Safes are found (again): no Safe selected sends you back to Safe, and Review builds its results. */
function resume() {
  if (S.mode !== 'compose' || S.looking.size) return
  if (S.stage > 1 && !selected().length) { S.stage = 1; history.replaceState({ stage: 1 }, '', location.pathname + location.search); update() }
  else if (S.stage === 3 && !S.prepared.length && !S.preparing) prepare()
}

// ---------------------------------------------------------------- compose: replicate a transaction

async function loadSource() {
  const src = S.d.source.trim()
  if (!src) return void (S.lines = '')
  const current = () => S.d.source.trim() === src // a slower answer for an older paste must not land
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
      if (!current()) return
      if (!t) throw new Error('That transaction isn\'t in the Safe Transaction Service')
      S.lines = linesFromTx(t)
      S.sourceNote = `From ${chain.name} ${short(t.safe)}, nonce ${t.nonce}`
    }
    S.errors = []
  } catch (e) { if (!current()) return; S.lines = ''; S.sourceNote = ''; S.errors = [msg(e)] }
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
      const p = await prepareTarget(x, a.actions, names)
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

const prepKind = (p: Prepared) => (p.error ? 'attention' : p.skip ? 'synced' : p.tx ? 'ready' : 'loading')

/** Builds the link (once per Review) and copies it; the button itself says "Copied". */
async function copyLink() {
  if (!S.link) {
    const ready = S.prepared.filter(p => prepKind(p) === 'ready')
    const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
    const title = titleFor(ready.map(p => ({ tx: p.tx!, owners: p.state?.owners, threshold: p.state?.threshold })))
    S.link = `${location.href.split('#')[0]}#${await encodeBatch({ title, created: Date.now(), txs: ready.map(p => p.tx!), labels, src: S.d })}`
  }
  try {
    await navigator.clipboard.writeText(S.link)
    S.copied = 'yes'
  } catch {
    S.copied = 'failed'
    setTimeout(() => { const el = document.querySelector<HTMLInputElement>('input[aria-label="Signing link"]'); el?.focus(); el?.select() })
  }
  update()
  setTimeout(() => { S.copied = ''; update() }, 2500)
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
  done(my)
}

/** A run that ends (or was paused) clears its marker, unless a newer run has taken over. */
function done(my: number) {
  if (my === session) S.signing = S.executing = false
  if (!S.signing && !S.executing) S.current = null
  update()
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
  done(my)
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
  stop()
  const src = S.batch.src as Partial<Draft> | null
  S.d = asDraft(src && typeof src === 'object' ? src : {})
  history.pushState({ stage: 2 }, '', location.pathname + location.search)
  S.mode = 'compose'; S.stage = 2; S.found = []; edited()
  lookupAll().then(resume)
  if (S.d.mode === 'replicate' && S.d.source) loadSource()
}

// ---------------------------------------------------------------- view helpers

function copy(text: string) {
  Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(
    () => { S.notice = 'Copied.'; update(); setTimeout(() => { if (S.notice === 'Copied.') S.notice = '', update() }, 1500) },
    () => { S.notice = "Couldn't copy: clipboard access was blocked"; update() },
  )
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

/** What one Safe's transaction does, as exact steps: the detail behind each row. */
const actionsView = (tx: Tx, labels: Record<string, string>) => html`<div class="actions-detail">
  ${steps(describe(tx), labels)}
  ${tx.operation === 1 ? html`<div class="muted small">Sent through MultiSendCallOnly ${short(tx.to)} (delegatecall), so the inner calls run as the Safe.</div>` : nothing}
</div>`

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

/** The intended change in plain language, grouped across Safes; each row opens to its exact steps. */
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
    return html`<div class="change">
      <div class="muted small">${groups.size === 1 ? `On all ${plural(g.txs.length, 'Safe')}` : html`On ${plural(g.txs.length, 'Safe')}: ${g.txs.map(t => chainChip(t.chainId))}`}</div>
      <ul>${g.lines.map(l => html`<li>${l}</li>`)}</ul>
      ${g.owners && one ? html`<div class="result">${!uniform ? 'Owner counts differ between Safes' : fmt(one.before) === fmt(one.after) ? `Threshold stays ${fmt(one.after)}` : `${fmt(one.before)} → ${fmt(one.after)}`}</div>` : nothing}
    </div>`
  })
}

/** "replace 2 owners, threshold 5 → 4": what one Safe's transaction does. */
function changeText(ops: OwnerOp[], before?: number) {
  const n = (k: OwnerOp['kind']) => ops.filter(op => op.kind === k).length
  const parts = [n('swap') && `replace ${plural(n('swap'), 'owner')}`, n('add') && `add ${plural(n('add'), 'owner')}`, n('remove') && `remove ${plural(n('remove'), 'owner')}`].filter(Boolean) as string[]
  const after = before === undefined ? undefined : applyOps([], before, ops).threshold
  if (after !== undefined && after !== before) parts.push(`threshold ${before} → ${after}`)
  return parts.join(', ')
}
const mostCommon = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0]

// done: already executed, so the owners read are already the result. failed: its state couldn't be read.
type Item = { tx: Tx; owners?: Address[]; threshold?: number; done?: boolean; failed?: boolean }
/**
 * For owner changes, the review leads with the configuration every Safe ends up with; what differs per Safe goes on its row.
 * Anything else falls back to the step-by-step summary.
 */
function reviewView(items: Item[], labels: Record<string, string>) {
  const ops = items.map(i => ownerOps(i.tx))
  const generic = () => changeView(items.map(i => i.tx), tx => {
    const i = items.find(x => x.tx === tx)!, o = ownerOps(tx)
    if (!i.owners || i.threshold === undefined || i.done || !o) return undefined
    const a = applyOps(i.owners, i.threshold, o)
    return { before: [i.threshold, i.owners.length], after: [a.threshold, a.owners.length] }
  }, labels)
  if (ops.some(o => !o) || items.some(i => i.failed)) return generic()
  // "On all Safes" is only claimed once every Safe's current owners are known.
  if (items.some(i => !i.owners || i.threshold === undefined)) return html`<div class="change"><div class="muted small">Reading every Safe…</div></div>`
  const known = items
  const after = known.map((i, k) => (i.done ? { owners: i.owners!.map(o => o.toLowerCase()), threshold: i.threshold! } : applyOps(i.owners!, i.threshold!, ops[k]!)))
  const sig = (a: { owners: string[]; threshold: number }) => `${[...a.owners].sort().join()}|${a.threshold}`
  if (new Set(after.map(sig)).size !== 1) return generic()
  const final = after[0], first = known.find(i => !i.done) ?? known[0], before = first.owners!.map(o => o.toLowerCase())
  const removed = before.filter(o => !final.owners.includes(o))
  return html`<div class="change">
    <div class="muted small">Owners after, on all ${plural(items.length, 'Safe')}</div>
    <div class="chips">${final.owners.map(o => html`<span class=${`owner-chip ${before.includes(o) ? '' : 'new'}`}>${addr(getAddress(o), labels)}${before.includes(o) ? nothing : html` <b class="good">added</b>`}</span>`)}</div>
    ${removed.length ? html`<div class="chips"><span class="muted small">Removed</span>${removed.map(o => html`<span class="owner-chip gone">${addr(getAddress(o), labels)}</span>`)}</div>` : nothing}
    <div class="result">${final.threshold} of ${final.owners.length} signatures needed${first.threshold !== final.threshold || before.length !== final.owners.length ? html` <span class="muted">(was ${first.threshold} of ${before.length})</span>` : nothing}</div>
  </div>`
}

/** Per-Safe exceptions: a row only says what it changes when that differs from what most Safes change. */
function exceptions(items: Item[]) {
  const texts = items.map(i => { const o = ownerOps(i.tx); return o ? changeText(o, i.threshold) : '' })
  const common = mostCommon(texts)
  return (i: number) => (texts[i] && texts[i] !== common ? texts[i] : '')
}

// ---------------------------------------------------------------- compose view

/** "Replace 2 owners on 15 Safes": the batch's title, from what every Safe's transaction does. */
function titleFor(items: Item[]): string {
  const changes = items.map(i => ownerOps(i.tx))
  if (changes.every(Boolean)) {
    const texts = new Set(changes.map((o, i) => changeText(o!, items[i].threshold)))
    const t = texts.size === 1 ? [...texts][0] || 'update owners' : 'update owners'
    return `${t[0].toUpperCase()}${t.slice(1)} on ${plural(items.length, 'Safe')}`
  }
  const txs = items.map(i => i.tx)
  const steps = describe(txs[0]), count = (fn: string) => steps.filter(st => st.target === 'self' && st.fn === fn).length
  const parts = [
    count('swapOwner') && `replace ${plural(count('swapOwner'), 'owner')}`, count('addOwnerWithThreshold') && `add ${plural(count('addOwnerWithThreshold'), 'owner')}`,
    count('removeOwner') && `remove ${plural(count('removeOwner'), 'owner')}`, count('changeThreshold') && 'change the threshold',
  ].filter(Boolean) as string[]
  const calls = steps.filter(st => !(st.target === 'self' && OWNER_FNS.includes(st.fn)))
  if (calls.length) parts.push(calls.length === 1 ? `call ${calls[0].fn}` : plural(calls.length, 'call'))
  const t = parts.join(', ') || 'change'
  return `${t[0].toUpperCase()}${t.slice(1)} on ${plural(txs.length, 'Safe')}`
}

function safesBody() {
  const key = (o: string[]) => o.map(a => a.toLowerCase()).sort().join(), start = key(S.d.owners.flatMap(r => (r.from ? [r.from] : [])))
  const differs = (f: Pick) => S.d.mode === 'owners' && f.selected && !!f.state && !!S.d.owners.length && key(f.state.owners) !== start
  const block = (raw: string, i: number) => {
    const a = addressIn(raw), list = S.found.filter(f => f.safe === a), ok = list.filter(f => f.state), bad = list.filter(f => !f.state)
    return html`<div class="found">
      <div class="row">
        <input class="grow mono" spellcheck="false" placeholder="Safe address, 0x…" aria-label=${i ? 'Another Safe address' : 'Safe address'} .value=${live(raw)} @input=${(e: any) => setSafe(i, e.target.value)}>
        ${i ? html`<button class="ghost" aria-label="Remove this address" @click=${() => removeSafe(i)}>✕</button>` : nothing}
      </div>
      ${raw.trim() && !a ? html`<div class="small bad">Not an address</div>`
      : a && S.looking.has(a) ? html`<div class="small muted">Searching every chain…</div>`
      : a && !list.length ? html`<div class="small bad">Not found on any chain</div>` : nothing}
      ${ok.length ? html`<div class="chips">${ok.map(f => html`<button class=${`pick ${f.selected ? 'on' : ''} ${differs(f) ? 'drift' : ''}`} aria-pressed=${f.selected}
        title=${`${chainName(f.chainId)} · ${fmt([f.state!.threshold, f.state!.owners.length])}${differs(f) ? ' · different owners' : ''}`}
        @click=${() => toggle(f)}>${f.selected ? '✓ ' : ''}${chainOf(f.chainId)?.short ?? f.chainId}</button>`)}</div>` : nothing}
      ${bad.length ? html`<div class="chips">${bad.map(f => html`<button class="pick unreachable" title=${`Couldn't reach this chain: ${f.error ?? ''}`} @click=${() => retry(f)}>${chainOf(f.chainId)?.short ?? f.chainId} ↻</button>`)}</div>` : nothing}
    </div>`
  }
  return html`
    ${S.d.safes.map(block)}
    ${S.found.some(f => f.state) ? html`<div><button class="ghost" @click=${() => { S.d.safes.push(''); edited() }}>+ Another address</button></div>` : nothing}`
}

function ownersEditor() {
  const t = targetOwners(), start = S.found.find(f => keyOf(f) === S.d.startedFrom)
  const changed = () => { S.errors = []; edited() } // a fix clears the complaint; Review checks again
  const set = (i: number, patch: Partial<OwnerRow>) => { Object.assign(S.d.owners[i], patch); changed() }
  return html`
    ${start ? html`<div class="muted small">Starting from ${chainChip(start.chainId)} ${addr(start.safe)}</div>` : nothing}
    <div class="owners">${S.d.owners.map((r, i) => r.from ? html`<div class="owner">
        <span class=${r.to === null ? 'mono gone' : 'mono'} title=${r.from}>${short(r.from)}</span>
        ${r.to === r.from ? html`<span></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: '', at: Date.now() })}>Replace</button><button class="ghost" @click=${() => set(i, { to: null })}>Remove</button></span>`
        : r.to === null ? html`<span></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: r.from, at: undefined })}>Undo</button></span>`
        : html`<span class="swap"><span class="muted">→</span><input class="mono" placeholder="Replacement (0x… or name.eth)" .value=${live(r.to)} @input=${(ev: any) => { r.to = ev.target.value; changed() }}></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: r.from, at: undefined })}>Undo</button></span>`}
      </div>` : html`<div class="owner">
        <span class="swap add"><span class="good" aria-hidden="true">+</span><input class="mono" placeholder="Address to add (0x… or name.eth)" aria-label="Owner to add" .value=${live(r.to ?? '')} @input=${(ev: any) => { r.to = ev.target.value; changed() }}></span>
        <span class="actions"><button class="ghost" aria-label="Don't add" @click=${() => { S.d.owners.splice(i, 1); changed() }}>✕</button></span>
      </div>`)}
    </div>
    <div class="row">
      <button class="ghost" @click=${() => { S.d.owners.push({ to: '' }); changed() }}>+ Add owner</button>
      <span class="grow"></span>
      <label class="check">Signatures needed <input class="num" type="number" min="1" max=${t.owners.length} .value=${live(String(t.threshold))} @input=${(e: any) => { S.d.threshold = Number(e.target.value) || null; changed() }}> of ${t.owners.length}</label>
    </div>`
}

function replicateEditor() {
  return html`
    <textarea rows="3" spellcheck="false" aria-label="Transaction to copy" placeholder="Safe{Wallet} transaction link, or Transaction Builder JSON"
      .value=${live(S.d.source)} @input=${(e: any) => { S.d.source = e.target.value; S.lines = ''; edited(); loadSource() }}></textarea>
    ${S.lines ? html`<div class="small good">✓ ${S.sourceNote}</div>` : nothing}`
}

const STAGES = ['Safe', 'Change', 'Review']
function stageBar(stage: Stage) {
  return html`<nav class="stages" aria-label="Steps">${STAGES.map((label, i) => {
    const n = (i + 1) as Stage
    return html`${i ? html`<span class=${`stage-line ${n <= stage ? 'done' : ''}`}></span>` : nothing}
      <button class=${`stage ${n === stage ? 'on' : n < stage ? 'done' : ''}`} aria-current=${n === stage ? 'step' : nothing}
        ?disabled=${n > stage && !reachable(n)} @click=${() => n !== stage && goTo(n)}><span class="stage-n">${n}</span>${label}</button>`
  })}</nav>`
}
const footer = (back: Stage | 0, next: TemplateResult) =>
  html`<div class="footer">${back ? html`<button class="ghost" @click=${() => goTo(back)}>← Back</button>` : nothing}<span class="grow"></span>${next}</div>`
const errorList = () => (S.errors.length ? html`<div class="errors">${S.errors.map(e => html`<div>${e}</div>`)}</div>` : nothing)

function safeStage() {
  const n = selected().length
  return html`<section class="card">
    ${safesBody()}
    ${footer(0, html`<button class="primary" ?disabled=${!n} @click=${() => goTo(2)}>Continue${n ? ` with ${plural(n, 'Safe')}` : ''}</button>`)}
  </section>`
}

function changeStage() {
  const mode = (m: Draft['mode'], label: string) => html`<button class=${S.d.mode === m ? 'seg on' : 'seg'} aria-pressed=${S.d.mode === m} @click=${() => { S.d.mode = m; edited() }}>${label}</button>`
  return html`<section class="card">
    <div class="row"><span class="segs">${mode('owners', 'Owners')}${mode('replicate', 'Other transaction')}</span></div>
    ${S.d.mode === 'owners' ? ownersEditor() : replicateEditor()}
    ${errorList()}
    ${footer(1, html`<button class="primary" ?disabled=${S.d.mode === 'replicate' && !S.lines} @click=${() => goTo(3)}>Review ${plural(selected().length, 'Safe')}</button>`)}
  </section>`
}

function reviewStage() {
  const by = (k: string) => S.prepared.filter(p => prepKind(p) === k)
  const ready = by('ready'), synced = by('synced'), attention = by('attention'), loading = by('loading')
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const items: Item[] = ready.map(p => ({ tx: p.tx!, owners: p.state?.owners, threshold: p.state?.threshold }))
  const except = exceptions(items)
  return html`<section class="card">
    ${!S.prepared.length ? html`<div class="muted">${S.preparing || S.looking.size ? 'Checking every Safe…' : ''}</div>` : html`
    <div class="summary">
      <span>${ready.length} ready to sign</span>
      ${synced.length ? html` · <span class="muted">${synced.length} already in sync</span>` : nothing}
      ${attention.length ? html` · <span class="bad">${attention.length} need${attention.length === 1 ? 's' : ''} attention</span>` : nothing}
      ${loading.length ? html` · <span class="muted">${loading.length} checking…</span>` : nothing}
    </div>
    ${ready.length ? reviewView(items, labels) : nothing}
    <div class="scroll"><table class="list"><tbody>${S.prepared.map(p => {
      const k = prepKind(p), notes = p.notes.filter(x => x !== 'checking the queue…')
      const only = p.tx ? except(ready.indexOf(p)) : ''
      const key = keyOf(p), open = !!p.tx && S.open.has(key)
      const toggle = () => { if (!p.tx) return; open ? S.open.delete(key) : S.open.add(key); update() }
      return html`<tr class=${p.tx ? 'click' : ''} @click=${toggle}>
        <td class="ico-cell">${k === 'ready' ? html`<span class="ico todo" title="Needs signatures"></span>` : k === 'synced' ? html`<span class="ico idle" title="Already in sync">–</span>` : k === 'attention' ? html`<span class="ico warn" title="Needs attention">!</span>` : html`<span class="ico now"></span>`}</td>
        <td>${chainChip(p.chainId)}</td>
        <td>${addr(p.safe, labels)}</td>
        <td class="grow-cell small">
          ${p.error ? html`<span class="bad">${p.error}</span>` : p.skip ? html`<span class="muted">${p.skip}</span>` : nothing}
          ${only ? html`<span>${only}</span>` : nothing}
          ${p.sim && !p.sim.ok && !p.sim.definite ? html`<span class="warn">${p.sim.error}</span>` : nothing}
          ${notes.length ? html`<span class=${notes.some(x => x.startsWith('⚠')) ? 'warn' : 'muted'}>${notes.join('; ')}</span>` : nothing}
        </td>
        <td>${p.tx ? html`<button class="ghost disclose" aria-expanded=${open} aria-label=${`Details for ${chainName(p.chainId)}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${open ? '▾' : '▸'}</button>` : nothing}</td>
      </tr>
      ${open ? html`<tr class="details"><td></td><td colspan="4">${actionsView(p.tx!, labels)}</td></tr>` : nothing}`
    })}</tbody></table></div>
    ${S.link ? html`<input readonly class="mono small" aria-label="Signing link" .value=${live(S.link)} @focus=${(e: any) => e.target.select()}>` : nothing}`}
    ${errorList()}
    ${footer(2, html`
      ${S.link ? html`<a class="button" href=${S.link}>Sign now</a>` : nothing}
      <button class=${S.copied === 'failed' ? 'bad-btn' : 'primary'} @click=${copyLink} ?disabled=${S.preparing || !ready.length}>${S.copied === 'yes' ? 'Copied ✓' : S.copied === 'failed' ? 'Copy failed' : 'Copy signing link'}</button>`)}
  </section>`
}

const composeView = () => html`${stageBar(S.stage)}${S.stage === 1 ? safeStage() : S.stage === 2 ? changeStage() : reviewStage()}`

// ---------------------------------------------------------------- batch view

/** The connected signer's checklist: ✓ you signed it, ○ it needs your signature, – nothing for you to do, ! a problem. */
function icon(r: Row, kind: Kind) {
  if (r === S.current) return html`<span class="ico now"></span>`
  if (kind === 'blocked') return html`<span class="ico warn" title="Problem">!</span>`
  if (!S.account) return html`<span class="ico todo quiet"></span>`
  if (mine(r)) return html`<span class="ico done" title="You signed this">✓</span>`
  if (canSign(r)) return html`<span class="ico todo" title="Needs your signature"></span>`
  return html`<span class="ico idle" title="Nothing for you to do">–</span>`
}
const KIND_CLASS: Record<Kind, string> = { loading: 'muted', collecting: '', ready: 'good', waiting: 'muted', executed: 'good', blocked: 'bad', unknown: 'warn' }


function progressView() {
  const yours = S.account ? S.rows.filter(r => mine(r) || canSign(r)) : []
  const signed = yours.filter(mine).length, remaining = yours.length - signed
  const loading = S.rows.some(r => status(r).kind === 'loading')
  const ready = S.rows.filter(r => status(r).kind === 'ready').length
  const executed = S.rows.filter(r => status(r).kind === 'executed').length
  const busy = S.signing || S.executing || S.waiting
  const pending = (r: Row) => (r.svc === 'ok' ? unshared(r) : [])
  const uploading = S.rows.reduce((n, r) => n + pending(r).filter(x => x.uploading).length, 0)
  const notUploaded = S.rows.reduce((n, r) => n + pending(r).filter(x => !x.uploading).length, 0)
  const manual = S.rows.filter(r => r.svc === 'none' && needsWork(r) && Object.keys(r.sigs).length)
  const bar = html`<div class="bar"><i style=${`width:${yours.length ? Math.round((signed / yours.length) * 100) : 0}%`}></i></div>`
  const cur = S.current
  return html`
  ${!S.account ? html`<div class="row">
      <button class="primary" @click=${() => connect()}>Connect wallet</button>
      ${S.choosing ? S.wallets.map(w => html`<button @click=${() => connect(w)}><img src=${w.info.icon} alt="">${w.info.name}</button>`) : nothing}
    </div>`
  : S.signing ? html`<div class="row"><b class="grow">Signing ${Math.min(signed + 1, yours.length)} of ${yours.length}</b><button @click=${() => stop()}>Pause</button></div>
      ${bar}
      ${cur ? html`<div class="current">
        <div><b>${chainName(cur.tx.chainId)}</b> · ${addr(cur.tx.safe)} · <span class="muted">${cur.phase ?? ''}</span></div>
        <div class="hashes"><span class="muted">safeTxHash</span><span class="mono">${cur.hash}</span></div>
        <div class="hashes"><span class="muted">domain hash</span><span class="mono">${domainHash(cur.tx)}</span></div>
        <div class="hashes"><span class="muted">message hash</span><span class="mono">${messageHash(cur.tx)}</span></div>
      </div>` : nothing}`
  : remaining ? html`<div class="row">
      <span class="grow">${addr(S.account)} · signed ${signed} of ${yours.length}</span>
      <button class="primary" @click=${signAll} ?disabled=${busy}>${S.waiting ? 'Waiting for wallet…' : `Sign ${remaining}`}</button>
    </div>${bar}`
  : yours.length ? html`<div class="row">
      <span class="done-msg grow">✓ Signed all ${yours.length}${uploading && !notUploaded ? html` <span class="muted small">uploading…</span>` : nothing}</span>
      ${notUploaded ? html`<button @click=${refresh}>Retry upload (${notUploaded})</button>` : nothing}
      ${manual.length ? html`<button @click=${() => copy(exportSigs())}>Copy signatures for ${manual.map(r => chainChip(r.tx.chainId))}</button>` : nothing}
    </div>${bar}`
  : html`<div class="muted">${loading ? 'Loading…' : html`${addr(S.account)} · nothing to sign`}</div>`}
  <div class="row small">
    <span class="grow muted">Executed ${executed} of ${S.rows.length}</span>
    ${S.account && ready && !busy ? html`<button @click=${executeAll}>Execute ${ready}</button>` : nothing}
    ${S.executing ? html`<button @click=${() => stop()}>Stop</button>` : nothing}
    <button class="ghost" aria-label="Refresh" title="Refresh" @click=${refresh} ?disabled=${busy}>↻</button>
  </div>
  ${!storageOk ? html`<div class="notice">This browser can't save signatures</div>` : nothing}
  ${S.notice ? html`<div class="notice">${S.notice}</div>` : nothing}`
}

function batchView() {
  if (S.loadError) return html`<section class="card"><div class="errors">${S.loadError}</div><button @click=${() => { location.hash = ''; S.mode = 'compose'; update() }}>New batch</button></section>`
  const b = S.batch!
  const items: Item[] = S.rows.map(r => ({ tx: r.tx, owners: r.owners, threshold: r.threshold, done: status(r).kind === 'executed', failed: r.chainNonce === undefined && !!r.error }))
  const except = exceptions(items)
  const manual = S.rows.filter(r => r.svc === 'none' && needsWork(r))
  const toShare = S.rows.reduce((n, r) => n + unshared(r).length, 0)
  return html`
  <section class="card">
    <div class="row">
      <h2 class="grow">${b.title}</h2>
      <span class="fingerprint" title="Fingerprint of every transaction in this link. Confirm it with whoever sent it.">${S.id}</span>
      <button class="ghost" @click=${edit}>Edit</button>
    </div>
    ${reviewView(items, b.labels)}
  </section>

  <section class="card sticky">${progressView()}</section>

  <section class="card">
    <div class="scroll"><table class="list"><tbody>${S.rows.map(r => {
      const st = status(r)
      const link = safeLink(r.tx, r.proposed ? r.hash : undefined)
      const conflict = r.others.some(o => !o.isExecuted) && needsWork(r)
      const toggle = () => { r.open = !r.open; update() }
      return html`<tr class=${`click ${r === S.current ? 'active' : ''}`} @click=${toggle}>
        <td class="ico-cell">${icon(r, st.kind)}</td>
        <td>${chainChip(r.tx.chainId)}</td>
        <td>${addr(r.tx.safe)}</td>
        <td class="grow-cell">
          <span class=${KIND_CLASS[st.kind]}>${r === S.current && r.phase ? r.phase : st.text}</span>
          ${except(S.rows.indexOf(r)) ? html`<div class="small">${except(S.rows.indexOf(r))}</div>` : nothing}
          ${conflict ? html`<div class="small warn">⚠ competes with another transaction at nonce ${r.tx.nonce}</div>` : nothing}
          ${r.error && st.kind !== 'unknown' ? html`<div class="small bad">${r.error}</div>` : nothing}
        </td>
        <td><button class="ghost disclose" aria-expanded=${!!r.open} aria-label=${`Details for ${chainName(r.tx.chainId)}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${r.open ? '▾' : '▸'}</button></td>
      </tr>
      ${r.open ? html`<tr class="details"><td></td><td colspan="4">
        ${actionsView(r.tx, b.labels)}
        <div class="kv">
          <span>nonce</span><span class="mono">${r.tx.nonce}</span>
          <span>to</span><span class="mono wrap">${r.tx.to}</span>
          <span>value</span><span class="mono">${r.tx.value}</span>
          <span>operation</span><span>${r.tx.operation === 1 ? 'DELEGATECALL (1)' : 'CALL (0)'}</span>
          <span>data</span><span class="mono wrap">${r.tx.data}</span>
          <span>gas and refund</span><span class="mono">all zero</span>
          <span>safeTxHash</span><span class="mono wrap">${r.hash}</span>
          <span>domain hash</span><span class="mono wrap">${domainHash(r.tx)}</span>
          <span>message hash</span><span class="mono wrap">${messageHash(r.tx)}</span>
          <span>signed by</span><span>${validSigs(r).map(x => html`<div>${addr(x.owner)}${r.svc === 'ok' && !x.posted ? html` <span class="warn">not uploaded</span>` : nothing}</div>`)}</span>
          ${link ? html`<span>open in</span><span><a href=${link} target="_blank" rel="noopener">${chainOf(r.tx.chainId)?.service ? 'Safe{Wallet}' : 'explorer'}</a>${r.execHash ? html` · <a href=${`${chainOf(r.tx.chainId)?.explorer}/tx/${r.execHash}`} target="_blank" rel="noopener">execution</a>` : nothing}</span>` : nothing}
        </div>
      </td></tr>` : nothing}`
    })}</tbody></table></div>
  </section>

  ${manual.length || toShare ? html`<section class="card">
    <div class="row"><h3 class="grow">Share signatures</h3>${manual.map(r => chainChip(r.tx.chainId))}</div>
    <div class="row">
      <button @click=${() => copy(exportSigs())} ?disabled=${!toShare}>Copy ${plural(toShare, 'signature')}</button>
      <textarea class="grow" rows="1" aria-label="Paste signatures" placeholder="Paste signatures" .value=${live(S.pasted)} @input=${(e: any) => { S.pasted = e.target.value; update() }}></textarea>
      <button @click=${importSigs} ?disabled=${!S.pasted.trim()}>Add</button>
    </div>
  </section>` : nothing}`
}

// ---------------------------------------------------------------- settings & shell

function settingsView() {
  const set = (k: 'rpc' | 'service' | 'apiKey') => (e: any) => (S.settings[k] = e.target.value)
  return html`<div class="modal" @click=${(e: Event) => e.target === e.currentTarget && ((S.settingsOpen = false), update())}><section class="card">
    <h3>Settings</h3>
    <label><span>RPCs</span><textarea rows="4" spellcheck="false" placeholder="1 https://…\narb1 https://…" .value=${live(S.settings.rpc)} @input=${set('rpc')}></textarea></label>
    <label><span>Safe Transaction Services</span><textarea rows="2" spellcheck="false" placeholder="167000 https://…" .value=${live(S.settings.service)} @input=${set('service')}></textarea></label>
    <label><span>Safe API key</span><input .value=${live(S.settings.apiKey)} @input=${set('apiKey')} placeholder="Optional"></label>
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
    <a class="brand grow" href=${location.pathname + location.search} @click=${(e: Event) => { e.preventDefault(); if (S.mode === 'compose') return void (S.stage > 1 && goTo(1)); history.pushState({ stage: 1 }, '', location.pathname + location.search); route() }}>Safe Sync</a>
    <button class="ghost" @click=${() => { S.settingsOpen = true; update() }}>Settings</button>
  </header>
  <main class=${S.mode === 'compose' ? 'narrow' : ''}>${S.mode === 'batch' ? batchView() : composeView()}</main>
  ${S.settingsOpen ? settingsView() : nothing}`
}

function route() {
  const h = location.hash.slice(1)
  if (h) return void openBatch(h)
  S.mode = 'compose'; S.errors = []
  S.stage = ([1, 2, 3].includes(history.state?.stage) ? history.state.stage : 1) as Stage
  update()
  Promise.all([S.found.length ? null : lookupAll(), S.d.mode === 'replicate' && S.d.source && !S.lines ? loadSource() : null]).then(resume)
}
// Leaving a link fires both events: each one handles its own direction, so a move routes once.
window.addEventListener('hashchange', () => { if (location.hash) route() })
window.addEventListener('popstate', () => { if (!location.hash) route() })
// Signatures are kept in localStorage and re-uploaded on the next visit; only warn mid-session.
window.addEventListener('beforeunload', e => { if (S.signing || S.executing || S.waiting) e.preventDefault() })
route()
