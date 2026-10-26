// UI. Two screens: compose (proposer) and batch (signers and executors, opened from the link).
// All state lives in the link, the Safe Transaction Service, the chain, and localStorage.
import { html, nothing, render, type TemplateResult } from 'lit-html'
import { live } from 'lit-html/directives/live.js'
import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem'
import { CHAINS } from './chains'
import {
  applyOps, batchId, chainName, chainOf, client, config, decodeBatch, describe, domainHash, encodeBatch, execData, findSafe, linesFromTx,
  linesFromTxBuilder, messageHash, msg, normalizeSig, onchainHash, parseActions, pickNonce, prepareTarget, readSafe, resolveNames,
  ownerOps, revertData, revertReason, SAFE_ABI, safeTxHash, settingsFrom, short, sigOwner, walletTypedData,
  type Action, type Batch, type Found, type NonceChoice, type OwnerOp, type Prepared, type Queued, type Step, type Target, type Tx,
} from './safe'
import * as svc from './service'

// ---------------------------------------------------------------- state

type Sig = { owner: Address; sig: Hex; posted: boolean; uploading?: boolean }
type Kind = 'loading' | 'collecting' | 'ready' | 'waiting' | 'executed' | 'blocked' | 'unknown'
type Row = {
  tx: Tx; hash: Hex; sigs: Record<string, Sig>
  owners?: Address[]; threshold?: number; chainNonce?: number
  svc: 'loading' | 'ok' | 'none' | 'error'; proposed: boolean; svcExecuted?: boolean; readAt: number
  trusted?: boolean // false: proposed unsigned, so out of Safe{Wallet}'s queue until an owner signs
  proposer?: Address; proposing?: boolean // proposer: the delegate that proposed it, if one did
  others: { safeTxHash: Hex; isExecuted: boolean }[] // other transactions at the same nonce
  phase?: string; error?: string; fatal?: string; execHash?: Hex; execOk?: boolean; open?: boolean
  uploadError?: string // a signature or proposal made here that didn't reach the service
  loaded?: Promise<void>; posting?: Promise<void>
}
type Wallet = { info: { name: string; icon: string; rdns: string }; provider: any }
type DelegationLookup = { data?: svc.Delegation[]; promise: Promise<void> }
/** What the proposer entered. Also stored in the link, so "edit as new batch" can bring it back. */
/** One owner in the target: `from` is who it started as (none for an added owner), `to` who it becomes (null: removed). */
type OwnerRow = { from?: string; to: string | null; at?: number } // at: when it was replaced, so replacements keep that order
type Draft = {
  safes: string[]; mode: 'owners' | 'replicate' // safes: one address per field, first is the main Safe
  // The target, copied once from a Safe and then only edited: never recomputed from what the chains hold now.
  owners: OwnerRow[]; threshold: number | null; startedFrom: string // startedFrom: "chainId:safe"
  excluded: string[] // "chainId:safe" of chains left out
  source: string
  nonces: Record<string, NonceChoice> // "chainId:safe" → choice, for Safes with something else queued; 'after' unless chosen
}
type Pick = Found & { selected: boolean }
type Endpoint = 'rpc' | 'service'
type Edit = { text: string; state: 'typing' | 'checking' | 'saved' | 'bad'; note?: string } // a Settings field being saved
// queue: other transactions queued at or after the on-chain nonce. same: this very transaction is one of them.
type Prep = Prepared & { queue?: Queued[]; same?: boolean; checking?: boolean }
type Stage = 1 | 2 | 3 // Safe, Build Txn, Review

let storageOk = true
const store = {
  get: <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { storageOk = false } },
}
const blank = (): Draft => ({ safes: [''], mode: 'owners', owners: [], threshold: null, startedFrom: '', excluded: [], source: '', nonces: {} })
/** Reads a Safe address out of whatever was pasted: a plain address, chain:0x…, or a Safe{Wallet} link. */
const addressIn = (s: string): Address | undefined => { const m = s.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/); return m ? getAddress(m[0]) : undefined }
/** Drafts saved by older versions kept all Safes in one text field. */
const asDraft = (d: Omit<Partial<Draft>, 'safes'> & { safes?: unknown }): Draft => {
  const safes = typeof d.safes === 'string' ? (d.safes.match(/0x[0-9a-fA-F]{40}/g) ?? []) : Array.isArray(d.safes) ? d.safes.map(String) : []
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : [])
  const nonces = d.nonces && typeof d.nonces === 'object' && !Array.isArray(d.nonces) ? d.nonces : {}
  return { ...blank(), ...d, safes: safes.length ? safes : [''], owners: list<OwnerRow>(d.owners), excluded: list<string>(d.excluded), nonces }
}
const keyOf = (f: { chainId: number; safe: string }) => `${f.chainId}:${f.safe}`

const S = {
  mode: 'compose' as 'compose' | 'batch', stage: 1 as Stage,
  d: asDraft(store.get<Partial<Draft>>('safesync:draft', {})),
  found: [] as Pick[], looking: new Set<string>(), lines: '', sourceNote: '', loadingSource: false,
  preparing: false, prepared: [] as Prep[], errors: [] as string[], names: {} as Record<string, Address>, link: '',
  batch: null as Batch | null, id: '', rows: [] as Row[], loadError: '', pasted: '',
  wallets: [] as Wallet[], provider: null as any, account: null as Address | null, walletMenu: false,
  delegations: {} as Record<string, DelegationLookup>, // keyed "account:chainId"
  signing: false, executing: false, waiting: false, current: null as Row | null, open: new Set<string>(), notice: '', copied: '' as '' | 'yes' | 'failed',
  settings: settingsFrom(store.get('safesync:settings', {})), settingsOpen: !!history.state?.settings, settingsChanged: false, closing: false,
  edits: {} as Record<string, Edit>, chainQuery: '', customOnly: false, openChain: null as number | null, addingChain: null as number | null,
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
    if (tipFor) showTip(tipFor)
  })
}

// One tooltip for every [data-tip]: shown at once on hover or keyboard focus, fixed to the viewport so a scrolling
// table can't clip it, and kept in step with its element across re-renders.
const tip = Object.assign(document.createElement('div'), { className: 'tip', role: 'tooltip' })
document.documentElement.append(tip)
let tipFor: Element | null = null
function showTip(el: Element | null) {
  tipFor = el?.isConnected ? el : null
  const text = tipFor?.getAttribute('data-tip')
  tip.classList.toggle('on', !!text)
  if (!tipFor || !text) return
  tip.textContent = text
  tip.classList.toggle('mono', /^0x[0-9a-f]+$/i.test(text)) // addresses and hashes, in full on one line
  const a = tipFor.getBoundingClientRect(), t = tip.getBoundingClientRect(), above = a.top - t.height - 8
  const left = Math.min(Math.max(8, a.left + a.width / 2 - t.width / 2), innerWidth - t.width - 8)
  tip.style.left = `${left}px`
  tip.style.top = `${above >= 8 ? above : a.bottom + 8}px`
  // The pointer stays on the element even when the tooltip is pushed in from the viewport's edge.
  tip.dataset.side = above >= 8 ? 'above' : 'below'
  tip.style.setProperty('--pointer', `${Math.min(Math.max(10, a.left + a.width / 2 - left), t.width - 10)}px`)
}
const tipTarget = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null)
document.addEventListener('pointerover', e => showTip(tipTarget(e)))
document.addEventListener('pointerout', e => { if (!e.relatedTarget) showTip(null) })
document.addEventListener('focusin', e => showTip(tipTarget(e)))
document.addEventListener('focusout', () => showTip(null))
addEventListener('scroll', () => showTip(null), true)

/** The user's overrides replace each chain's defaults from now on, and are kept in this browser. */
function applySettings() {
  config.rpc = S.settings.rpc; svc.config.service = S.settings.service; svc.config.apiKey = S.settings.apiKey.trim()
  store.set('safesync:settings', S.settings)
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
  setReference(base.from)
}

function setReference(f: Pick) {
  if (!f.state) return
  S.d.owners = f.state.owners.map(o => ({ from: o, to: o }))
  S.d.threshold = f.state.threshold
  S.d.startedFrom = keyOf(f)
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
  const threshold = thresholds.sort((a, b) => thresholds.filter(x => x === b).length - thresholds.filter(x => x === a).length)[0] ?? 1
  return { from: sel.find(f => top && key(f.state!.owners) === top[0] && f.state!.threshold === threshold) }
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

/** Build Txn needs a selected Safe; Review also needs a complete change. */
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
  S.loadingSource = true; update()
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
  finally { if (current()) S.loadingSource = false }
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
    S.prepared = targets.map(x => ({ ...x, notes: [] }))
    update()
    await Promise.all(targets.map((x, i) => prepareOne(x, i, my, a.actions, names)))
  } catch (e) { if (my === run) S.errors.push(msg(e)) }
  if (my === run) { S.preparing = false; update() }
}

/** Builds one Safe's transaction. What's already queued decides its nonce, so nothing queued is replaced unless chosen. */
async function prepareOne(x: Target, i: number, my: number, actions: Action[], names: Record<string, Address>) {
  let queue: Queued[] = []
  const p: Prep = await prepareTarget(x, actions, names, async tx => {
    // A chain without a Safe service has no queue to read: the on-chain nonce it is.
    if (svc.serviceUrl(tx.chainId)) queue = await svc.queued(tx.chainId, tx.safe, tx.nonce).catch(e => { throw new Error(`Couldn't read the queue: ${msg(e)}`) })
    return pickNonce(tx, queue, S.d.nonces[keyOf(x)] ?? 'after').nonce
  })
  if (my !== run) return
  p.queue = queue; p.same = !!p.tx && queue.some(q => q.nonce === p.tx!.nonce && q.safeTxHash.toLowerCase() === p.hash)
  S.prepared[i] = p; update()
}

function retryPrepare(i: number) {
  const x = { chainId: S.prepared[i].chainId, safe: S.prepared[i].safe } // only the target: nothing from the failed try carries over
  S.prepared[i] = { ...x, notes: [] }; S.link = ''; S.copied = ''; update()
  prepareOne(x, i, run, actionsFor().actions, S.names)
}

/** Something other than this transaction is queued, so the proposer picks: go after it, or replace it. */
const queuedAhead = (p: Prep) => !!p.tx && !p.error && !p.same && !!p.queue?.length
const choiceOf = (p: Prep) => S.d.nonces[keyOf(p)] ?? 'after'

/** Redoes only this Safe: its nonce, hash and on-chain hash check. The link is made again afterwards. */
async function chooseNonce(p: Prep, choice: NonceChoice) {
  S.d.nonces[keyOf(p)] = choice; store.set('safesync:draft', S.d)
  const nonce = pickNonce({ ...p.tx!, nonce: p.state!.nonce }, p.queue ?? [], choice).nonce
  if (nonce === p.tx!.nonce) return update()
  const tx = { ...p.tx!, nonce }, hash = safeTxHash(tx)
  p.tx = tx; p.hash = hash; p.checking = true; S.link = ''; S.copied = ''; update()
  const onchain = await onchainHash(tx).catch(e => e)
  if (p.tx !== tx) return // chosen again meanwhile
  p.checking = false
  if (onchain !== hash) p.error = typeof onchain === 'string' ? `Hash mismatch: local ${hash}, on-chain ${onchain}` : `Couldn't check the hash: ${msg(onchain)}`
  update()
}

const prepKind = (p: Prep) => (p.error ? 'attention' : p.skip ? 'synced' : p.tx && !p.checking ? 'ready' : 'loading')

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
  findDelegations()
}

/** Read trusted transactions at this nonce, with a hash lookup if ours is absent or still unsigned. */
async function readService(r: Row) {
  try {
    const all = await svc.atNonce(r.tx.chainId, r.tx.safe, r.tx.nonce)
    const t = all.find(x => x.safeTxHash.toLowerCase() === r.hash.toLowerCase()) ?? await svc.getTx(r.tx.chainId, r.hash)
    // Anyone can post an unsigned proposal, so only a trusted (or executed) competitor counts.
    r.others = all.filter(x => x !== t && (x.trusted || x.isExecuted)).map(x => ({ safeTxHash: x.safeTxHash, isExecuted: x.isExecuted }))
    r.proposed = !!t; r.trusted = t?.trusted; r.svcExecuted = t?.isExecuted; r.readAt = Date.now(); r.svc = 'ok'
    r.proposer = t?.proposedByDelegate ?? undefined
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
      // It counts as uploaded once the service lists it, not just because the upload was accepted.
      await readService(r)
      if (r.svc !== 'ok') s.posted = true // accepted, though it couldn't be read back just now
      r.uploadError = s.posted ? undefined : "Signed, but the Safe service doesn't list it. It's saved in this browser: Retry upload."
    } catch (e) { r.uploadError = `Signed but not uploaded: ${msg(e)}. It's saved in this browser and uploads again on your next visit, or with Retry upload.` }
    s.uploading = false; update()
  })
}

/**
 * A proposer's signature only creates the proposal, so it isn't kept: a failed proposal is simply proposed again.
 * It counts once the service lists it as proposed by this proposer.
 */
function postProposal(r: Row, from: Address, sig: Hex) {
  r.proposing = true
  r.posting = (r.posting ?? Promise.resolve()).then(async () => {
    try {
      await svc.propose(r.tx, r.hash, from, sig)
      await readService(r)
      if (r.svc !== 'ok') r.proposer = from // accepted, though it couldn't be read back just now
      r.uploadError = r.proposer?.toLowerCase() === from.toLowerCase() ? undefined : "Proposed, but the Safe service doesn't list it. Propose again to retry."
    } catch (e) { r.uploadError = `Not proposed: ${msg(e)}. Propose again to retry.` }
    r.proposing = false; update()
  })
}

// Proposers are the delegates an owner named in Safe{Wallet}: they propose signed, and their signature never counts.
// Anyone else only views the link. Looked up once per account and chain, only where the account might propose.
const needsDelegations = (r: Row, a: Address) => r.svc === 'ok' && (!r.proposed || r.trusted === false) && !isOwner(r, a) && needsWork(r)
function lookupDelegations(chainId: number, account: Address): DelegationLookup {
  const key = `${account}:${chainId}`
  if (S.delegations[key]) return S.delegations[key]
  const lookup: DelegationLookup = {
    promise: svc.delegations(chainId, account).then(data => { lookup.data = data }, e => {
      lookup.data = []; S.notice = `Couldn't check whether you're a proposer on ${chainName(chainId)}: ${msg(e)}`
    }).finally(update),
  }
  S.delegations[key] = lookup
  return lookup
}
function findDelegations() {
  const a = S.account
  if (!a) return
  for (const r of S.rows) if (needsDelegations(r, a)) lookupDelegations(r.tx.chainId, a)
}
// As the service decides: for this Safe or all of the delegator's, named by a current owner, not expired.
const isDelegate = (r: Row, a: Address) => !!S.delegations[`${a}:${r.tx.chainId}`]?.data?.some(d =>
  (!d.safe || d.safe.toLowerCase() === r.tx.safe.toLowerCase()) && isOwner(r, d.delegator) && (!d.expiryDate || Date.parse(d.expiryDate) > Date.now()))

const isOwner = (r: Row, a?: Address | null) => !!a && !!r.owners?.some(o => o.toLowerCase() === a.toLowerCase())
const validSigs = (r: Row) => Object.values(r.sigs).filter(s => isOwner(r, s.owner))
function status(r: Row): { kind: Kind; text: string; detail?: string } {
  if (r.fatal) return { kind: 'blocked', text: 'hash mismatch', detail: r.fatal }
  if (r.chainNonce === undefined) return r.error ? { kind: 'unknown', text: "couldn't read the chain" } : { kind: 'loading', text: 'loading…' }
  if (r.chainNonce > r.tx.nonce) {
    if (r.svcExecuted || r.execOk) return { kind: 'executed', text: 'executed' }
    if (r.svc === 'loading' || r.execHash) return { kind: 'loading', text: 'checking…' }
    if (r.svc === 'ok') return { kind: 'blocked', text: `nonce ${r.tx.nonce} was used by another transaction` }
    return { kind: 'unknown', text: `nonce ${r.tx.nonce} is used; can't confirm it was this transaction` }
  }
  if (r.execHash) return { kind: 'waiting', text: 'executing…' }
  const n = validSigs(r).length, t = r.threshold!
  if (n >= t) return r.chainNonce === r.tx.nonce ? { kind: 'ready', text: 'ready to execute' } : { kind: 'waiting', text: `signed; nonce ${r.chainNonce} must execute first` }
  return { kind: 'collecting', text: `${n === 0 && r.proposed ? 'proposed, ' : ''}${n} of ${t} signatures` }
}
const needsWork = (r: Row) => ['collecting', 'ready', 'waiting'].includes(status(r).kind)
const loadingRow = (r: Row) => status(r).kind === 'loading' || r.svc === 'loading'
const mine = (r: Row) => !!S.account && !!r.sigs[S.account.toLowerCase()]
const canSign = (r: Row) => isOwner(r, S.account) && !mine(r) && status(r).kind === 'collecting'
/** A proposer, on a transaction nobody has proposed yet (or only unsigned: a proposer's signed proposal makes it trusted). */
const canPropose = (r: Row) => !!S.account && r.svc === 'ok' && !r.proposing && !isOwner(r, S.account) && isDelegate(r, S.account)
  && (!r.proposed || r.trusted === false) && status(r).kind === 'collecting'
const proposedByMe = (r: Row) => !!S.account && !isOwner(r, S.account) && (!!r.proposing || r.proposer?.toLowerCase() === S.account.toLowerCase())

// ---------------------------------------------------------------- wallet

window.addEventListener('eip6963:announceProvider', (e: any) => {
  const w: Wallet = e.detail
  if (S.wallets.some(x => x.info.rdns === w.info.rdns)) return
  S.wallets.push(w)
  // The wallet used last time reconnects quietly, if it still shares an account without asking.
  if (!S.account && w.info.rdns === store.get('safesync:wallet', '')) w.provider.request({ method: 'eth_accounts' }).then((a: string[]) => { if (a?.[0] && !S.account) use(w.provider, a[0]) }, () => {})
  update()
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

let unlisten = () => {}
/** Starts using a wallet's account, and follows the account the wallet switches to. */
function use(provider: any, account: string) {
  unlisten()
  const changed = (a: string[]) => {
    S.account = a[0] ? getAddress(a[0]) : null
    if (S.signing || S.executing) stop('Wallet account changed, so I stopped.')
    findDelegations(); update()
  }
  provider.on?.('accountsChanged', changed)
  unlisten = () => provider.removeListener?.('accountsChanged', changed)
  // Wallets may return lowercase addresses; the Safe service rejects anything not checksummed.
  S.provider = provider; S.account = getAddress(account)
  findDelegations(); update()
}

/** Connects the only wallet there is; with several (or none), opens the menu to pick from. */
async function connect(w?: Wallet) {
  const wallet = w ?? (S.wallets.length === 1 ? S.wallets[0] : undefined)
  const provider = wallet?.provider ?? (S.wallets.length ? undefined : (window as any).ethereum)
  if (!provider) return void ((S.walletMenu = !S.walletMenu), update())
  S.walletMenu = false
  try {
    const [account] = await provider.request({ method: 'eth_requestAccounts' })
    use(provider, account)
    store.set('safesync:wallet', wallet?.info.rdns ?? '')
  } catch (e) { S.notice = msg(e); update() }
}

function disconnect() {
  const provider = S.provider
  stop(); unlisten(); unlisten = () => {}
  S.account = S.provider = null; S.delegations = {}; S.walletMenu = false
  store.set('safesync:wallet', '')
  // Wallets that support it forget this site as well, so the next Connect asks again.
  provider?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {})
  update()
}

// A wallet menu closes on a click elsewhere, or Escape.
document.addEventListener('click', e => { if (S.walletMenu && !(e.target as Element).closest?.('.wallet')) S.walletMenu = false, update() })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.walletMenu) S.walletMenu = false, update() })

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
  // An owner signs; a proposer signs only to propose what nobody has proposed yet.
  const todo = (r: Row) => canSign(r) || canPropose(r)
  for (const r of S.rows) {
    if (stopped()) break
    if (loadingRow(r)) { S.current = r; r.phase = 'waiting for this Safe to load'; update() }
    await r.loaded
    if (stopped()) break
    if (needsDelegations(r, account)) {
      S.current = r; r.phase = 'checking proposer access'; update()
      await lookupDelegations(r.tx.chainId, account).promise
    }
    r.phase = undefined
    if (stopped()) break
    if (!todo(r)) continue
    S.current = r
    try {
      // Fresh reads right before involving the wallet: skip anything executed, completed or proposed meanwhile.
      r.phase = 'checking'; update()
      const nonce = Number(await client(r.tx.chainId).readContract({ address: r.tx.safe, abi: SAFE_ABI, functionName: 'nonce' }))
      if (nonce > r.tx.nonce) { r.chainNonce = nonce; continue }
      if (r.svc !== 'none' && Date.now() - r.readAt > 30_000) await readService(r)
      if (stopped() || !todo(r)) continue
      r.phase = 'switching network'; update()
      await ask(() => ensureChain(r.tx.chainId))
      if (stopped()) break
      r.phase = 'confirm in your wallet'; update()
      const sig = normalizeSig(await ask(() => S.provider.request({ method: 'eth_signTypedData_v4', params: [account, walletTypedData(r.tx)] })))
      if ((await sigOwner(r.hash, sig))?.toLowerCase() !== account.toLowerCase()) throw new Error('The wallet returned a signature for a different account or message')
      r.error = undefined
      if (!isOwner(r, account)) { postProposal(r, account, sig); continue }
      // Kept even if Pause was pressed while the wallet was open: it is a valid signature.
      const s = (r.sigs[account.toLowerCase()] = { owner: account, sig, posted: false })
      saveSigs(r)
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
  S.delegations = {}
  for (const r of S.rows) { r.error = r.uploadError = undefined; r.svc = 'loading'; r.loaded = loadRow(r) }
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
/**
 * A copy button that answers with a check (or turns red) for a moment. The feedback lives on the button itself, so only
 * the one clicked answers, wherever else the same address shows.
 */
function copyButton(text: string, label = 'Copy address') {
  const click = (e: Event) => {
    e.stopPropagation() // rows open and close on click
    const b = e.currentTarget as HTMLElement
    const answer = (ok: boolean) => {
      b.classList.remove('ok', 'failed'); void b.offsetWidth // restart the check's animation on a second click
      b.classList.add(ok ? 'ok' : 'failed'); b.dataset.tip = ok ? 'Copied' : "Couldn't copy"; showTip(b)
      clearTimeout(Number(b.dataset.timer))
      b.dataset.timer = String(setTimeout(() => { b.classList.remove('ok', 'failed'); b.dataset.tip = label; if (tipFor === b) showTip(b) }, 1500))
    }
    navigator.clipboard.writeText(text).then(() => answer(true), () => answer(false))
  }
  return html`<button class="ghost copy" aria-label=${label} data-tip=${label} @click=${click}>
    <svg class="copy-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>
    <svg class="check-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>
  </button>`
}
/** An address: short, the full one in its tooltip, with a copy button and its label (an ENS name) if it has one. */
const addr = (a: string, labels: Record<string, string> = S.batch?.labels ?? {}, cls = 'mono') =>
  html`<span class="addr"><span class=${cls} data-tip=${a}>${short(a)}</span>${copyButton(a)}</span>${labels[a.toLowerCase()] ? html` <span class="label">(${labels[a.toLowerCase()]})</span>` : nothing}`
const chainChip = (id: number) => html`<span class="chip" data-tip=${chainName(id)}>${chainOf(id)?.short ?? id}</span>`
const safeLink = (tx: { chainId: number; safe: string }, hash?: string) => {
  const c = chainOf(tx.chainId), s = c?.service
  if (s) return `${s.app}/${hash ? `transactions/tx?safe=${s.prefix}:${tx.safe}&id=multisig_${tx.safe}_${hash}` : `home?safe=${s.prefix}:${tx.safe}`}`
  return c?.explorer ? `${c.explorer}/address/${tx.safe}` : undefined
}
/** A Safe's address in a list: opens the Safe in Safe{Wallet} (or the explorer), with a copy button. */
function safeAddr(chainId: number, safe: string, labels: Record<string, string>) {
  const link = safeLink({ chainId, safe })
  return html`<span class="addr">
    ${link ? html`<a class="mono" href=${link} target="_blank" rel="noopener" data-tip=${safe} @click=${(e: Event) => e.stopPropagation()}>${short(safe)}</a>` : html`<span class="mono" data-tip=${safe}>${short(safe)}</span>`}
    ${copyButton(safe)}
    ${labels[safe.toLowerCase()] ? html`<span class="label">(${labels[safe.toLowerCase()]})</span>` : nothing}
  </span>`
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** A status mark: what it means is its tooltip, and what a screen reader says. */
const mark = (cls: string, tip: string, glyph = '') => html`<span class=${`ico ${cls}`} role="img" aria-label=${tip} data-tip=${tip}>${glyph}</span>`
// Two kinds of waiting: work that blocks the next step spins on that step's own (disabled) button and says what it is
// waiting for; background work is a quiet line that blocks nothing.
const waitButton = (text: string) => html`<button class="primary" disabled><i class="spin"></i>${text}</button>`
const busyLine = (text: string) => html`<span class="small busy"><i class="spin"></i>${text}</span>`
const fmt = ([t, n]: [number, number]) => `${t}-of-${n}`
const argValue = (v: string, labels: Record<string, string>) => (isAddress(v) ? addr(v, labels) : v === 'this Safe' ? html`<b>this Safe</b>` : html`<span class="mono wrap">${v}</span>`)

/** Every decoded field, for the technical view. */
function steps(list: Step[], labels: Record<string, string>) {
  return html`<ol class="steps">${list.map(s => html`<li>
    <span class="fn">${s.fn}</span> <span class="muted">on</span> <b>${s.target === 'self' ? 'this Safe' : addr(s.target, labels)}</b>
    ${s.op === 1 ? html`<span class="bad"> DELEGATECALL</span>` : nothing}
    ${s.value ? html` <span class="muted">with</span> ${s.value.toString()} wei` : nothing}
    ${s.args.length ? html`<div class="args">${s.args.map(([k, v]) => html`<div><span class="muted">${k}</span> ${argValue(v, labels)}</div>`)}</div>` : nothing}
    ${s.raw ? html`<div class="mono small wrap">${s.raw}</div>` : nothing}
  </li>`)}</ol>`
}

/** What one Safe's transaction does, as exact steps: the detail behind each row. */
const actionsView = (tx: Tx, labels: Record<string, string>) => html`<div class="actions-detail">
  ${steps(describe(tx), labels)}
  ${tx.operation === 1 ? html`<div class="muted small">Sent as delegatecall via <span data-tip=${tx.to}>MultiSend</span></div>` : nothing}
</div>`

const OWNER_FNS = ['swapOwner', 'addOwnerWithThreshold', 'removeOwner', 'changeThreshold']

/**
 * One line per call in the calldata: a verb and what it acts on. Owner calls skip encoding details such as prevOwner
 * and show the threshold only where they change it; `cur` carries the Safe's threshold through its steps.
 */
function intent(s: Step, labels: Record<string, string>, cur: { t?: number }): { key: string; verb: unknown; view: unknown } {
  const a = Object.fromEntries(s.args)
  const who = (x: string, cls: string) => html`<span class=${cls}>${addr(x, labels)}</span>`
  const threshold = (n: number) => { const was = cur.t; cur.t = n; return was === n ? '' : was === undefined ? `threshold ${n}` : `threshold ${was} → ${n}` }
  const note = (t: string) => (t ? html`<span class="muted aside">${t}</span>` : nothing)
  if (s.target === 'self' && s.op === 0) {
    if (s.fn === 'swapOwner') return { key: `swap ${a.oldOwner} ${a.newOwner}`, verb: 'Swap', view: html`${who(a.oldOwner, 'out')} <span class="muted">→</span> ${who(a.newOwner, 'in')}` }
    if (s.fn === 'addOwnerWithThreshold') { const t = threshold(Number(a._threshold)); return { key: `add ${a.owner} ${t}`, verb: 'Add', view: html`${who(a.owner, 'in')}${note(t)}` } }
    if (s.fn === 'removeOwner') { const t = threshold(Number(a._threshold)); return { key: `remove ${a.owner} ${t}`, verb: 'Remove', view: html`${who(a.owner, 'out')}${note(t)}` } }
    if (s.fn === 'changeThreshold') { const t = threshold(Number(a._threshold)) || `threshold ${a._threshold}`; return { key: `set ${t}`, verb: 'Set', view: t } }
  }
  const target = s.target === 'self' ? html`this Safe` : addr(s.target, labels)
  return {
    key: JSON.stringify([s.target, s.fn, s.args, String(s.value), s.op, s.raw]),
    verb: s.op === 1 ? html`<b class="bad">Delegatecall</b>` : 'Call',
    view: html`<span class="fn">${s.fn}</span>${s.args.length ? html`(${s.args.map(([k, v], i) => html`${i ? ', ' : ''}<span class="muted">${k}</span> ${argValue(v, labels)}`)})` : nothing} on ${target}${s.value ? html` with ${s.value.toString()} wei` : nothing}`,
  }
}

/** "swap 2 owners, threshold 5 → 4": what one Safe's transaction does. */
function changeText(ops: OwnerOp[], before?: number) {
  const n = (k: OwnerOp['kind']) => ops.filter(op => op.kind === k).length
  const parts = [n('swap') && `swap ${plural(n('swap'), 'owner')}`, n('add') && `add ${plural(n('add'), 'owner')}`, n('remove') && `remove ${plural(n('remove'), 'owner')}`].filter(Boolean) as string[]
  const after = before === undefined ? undefined : applyOps([], before, ops).threshold
  if (after !== undefined && after !== before) parts.push(`threshold ${before} → ${after}`)
  return parts.join(', ')
}
const mostCommon = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0]

// done: already executed, so the owners read are already the result. failed: its state couldn't be read.
type Item = { tx: Tx; owners?: Address[]; threshold?: number; done?: boolean; failed?: boolean }
const changesOwners = (tx: Tx) => describe(tx).some(s => s.target === 'self' && OWNER_FNS.includes(s.fn))

/**
 * What the calldata does, one line per call, grouped by the Safes whose calls match; each row below opens to its exact
 * steps. Owner changes wait until every Safe is read, since which thresholds change depends on each Safe.
 */
function reviewView(items: Item[], labels: Record<string, string>) {
  if (items.some(i => changesOwners(i.tx) && !i.failed && (!i.owners || i.threshold === undefined))) return html`<div class="change"><div class="small busy"><i class="spin"></i>Reading every Safe…</div></div>`
  const groups = new Map<string, { items: Item[]; lines: { verb: unknown; view: unknown }[] }>()
  for (const i of items) {
    // An executed Safe's threshold is already the result, so its calls show the threshold they set.
    const cur = { t: i.done ? undefined : i.threshold }, lines = describe(i.tx).map(s => intent(s, labels, cur)), key = lines.map(l => l.key).join('\n')
    const g = groups.get(key) ?? { items: [], lines }
    g.items.push(i); groups.set(key, g)
  }
  return [...groups.values()].map(g => {
    const kept = unchanged(g.items)
    return html`<div class="change">
      ${groups.size > 1 ? html`<div class="muted small">On ${plural(g.items.length, 'Safe')}: ${g.items.map(i => chainChip(i.tx.chainId))}</div>` : nothing}
      <div class="acts">${g.lines.map(l => html`<span class="verb">${l.verb}</span><span>${l.view}</span>`)}</div>
      ${kept.length ? html`<details><summary>${plural(kept.length, 'unchanged owner')}</summary><div class="kept">${kept.map(o => html`<span>${addr(getAddress(o), labels)}</span>`)}</div></details>` : nothing}
    </div>`
  })
}

/** The owners an owner change leaves in place, when every Safe in the group starts from the same list. */
function unchanged(items: Item[]): string[] {
  const ops = items.map(i => ownerOps(i.tx)), key = (o: string[]) => o.map(x => x.toLowerCase()).sort().join()
  if (ops.some(o => !o) || items.some(i => i.done || !i.owners || i.threshold === undefined) || new Set(items.map(i => key(i.owners!))).size !== 1) return []
  const before = items[0].owners!.map(o => o.toLowerCase())
  return applyOps(before, items[0].threshold!, ops[0]!).owners.filter(o => before.includes(o))
}

/** Per-Safe exceptions: a row only says what it changes when that differs from what most Safes change. */
function exceptions(items: Item[]) {
  const texts = items.map(i => { const o = ownerOps(i.tx); return o ? changeText(o, i.threshold) : '' })
  const common = mostCommon(texts)
  return (i: number) => (texts[i] && texts[i] !== common ? texts[i] : '')
}

// ---------------------------------------------------------------- compose view

/** "Swap 2 owners on 15 Safes": the batch's title, from what every Safe's transaction does. */
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
    count('swapOwner') && `swap ${plural(count('swapOwner'), 'owner')}`, count('addOwnerWithThreshold') && `add ${plural(count('addOwnerWithThreshold'), 'owner')}`,
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
      : a && S.looking.has(a) ? html`<div class="small busy"><i class="spin"></i>Searching every chain…</div>`
      : a && !list.length ? html`<div class="small bad">Not found on any chain</div>` : nothing}
      ${ok.length ? html`<div class="chips">${ok.map(f => html`<button class=${`pick ${f.selected ? 'on' : ''} ${differs(f) ? 'drift' : ''}`} aria-pressed=${f.selected}
        data-tip=${`${chainName(f.chainId)}, ${fmt([f.state!.threshold, f.state!.owners.length])}${differs(f) ? ', different owners' : ''}`}
        @click=${() => toggle(f)}>${f.selected ? '✓ ' : ''}${chainOf(f.chainId)?.short ?? f.chainId}</button>`)}</div>` : nothing}
      ${bad.length ? html`<div class="chips">${bad.map(f => html`<button class="pick unreachable" data-tip=${`Couldn't reach this chain: ${f.error ?? ''}. Click to try again.`} @click=${() => retry(f)}>${chainOf(f.chainId)?.short ?? f.chainId} ↻</button>`)}</div>` : nothing}
    </div>`
  }
  return html`
    ${S.d.safes.map(block)}
    ${S.found.some(f => f.state) ? html`<div><button class="ghost" @click=${() => { S.d.safes.push(''); edited() }}>+ Another address</button></div>` : nothing}`
}

function ownersEditor() {
  const t = targetOwners(), references = S.found.filter(f => f.state)
  const changed = () => { S.errors = []; edited() } // a fix clears the complaint; Review checks again
  const set = (i: number, patch: Partial<OwnerRow>) => { Object.assign(S.d.owners[i], patch); changed() }
  return html`
    <div class="reference">
      <label><span class="muted small">Reference Safe</span><span class="select"><select aria-label="Reference Safe" ?disabled=${!references.length} @change=${(e: any) => {
        const f = references.find(f => keyOf(f) === e.target.value)
        if (f) { setReference(f); changed() }
      }}>
        ${!references.some(f => keyOf(f) === S.d.startedFrom) ? html`<option value=${S.d.startedFrom} selected disabled>${S.looking.size ? 'Loading reference…' : S.d.startedFrom ? 'Saved reference (unavailable)' : 'Choose a Safe'}</option>` : nothing}
        ${references.map(f => html`<option value=${keyOf(f)} .selected=${keyOf(f) === S.d.startedFrom}>${chainName(f.chainId)} | ${short(f.safe)} | ${fmt([f.state!.threshold, f.state!.owners.length])}${f.selected ? '' : ' (excluded)'}</option>`)}
      </select></span></label>
      <div class="muted small">Changing reference copies its owners and threshold, replacing your edits. Your edited setup applies to all selected Safes.</div>
    </div>
    <div class="owners">${S.d.owners.map((r, i) => r.from ? html`<div class="owner">
        <span>${addr(r.from, {}, r.to === null ? 'mono gone' : 'mono')}</span>
        ${r.to === r.from ? html`<span></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: '', at: Date.now() })}>Swap</button><button class="ghost" @click=${() => set(i, { to: null })}>Remove</button></span>`
        : r.to === null ? html`<span></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: r.from, at: undefined })}>Undo</button></span>`
        : html`<span class="swap"><span class="muted">→</span><input class="mono" placeholder="New owner (0x… or name.eth)" .value=${live(r.to)} @input=${(ev: any) => { r.to = ev.target.value; changed() }}></span><span class="actions"><button class="ghost" @click=${() => set(i, { to: r.from, at: undefined })}>Undo</button></span>`}
      </div>` : html`<div class="owner">
        <span class="swap add"><span class="good" aria-hidden="true">+</span><input class="mono" placeholder="Address to add (0x… or name.eth)" aria-label="Owner to add" .value=${live(r.to ?? '')} @input=${(ev: any) => { r.to = ev.target.value; changed() }}></span>
        <span class="actions"><button class="ghost" aria-label="Don't add" @click=${() => { S.d.owners.splice(i, 1); changed() }}>✕</button></span>
      </div>`)}
    </div>
    <div class="row">
      <button class="ghost" @click=${() => { S.d.owners.push({ to: '' }); changed() }}>+ Add owner</button>
      <span class="grow"></span>
      <label class="check">Threshold <span class="select"><select @change=${(e: any) => { S.d.threshold = Number(e.target.value); changed() }}>
        ${Array.from({ length: Math.max(t.owners.length, t.threshold) }, (_, i) => html`<option .selected=${i + 1 === t.threshold} value=${i + 1}>${i + 1}</option>`)}
      </select></span> of ${t.owners.length}</label>
    </div>`
}

function replicateEditor() {
  return html`
    <textarea rows="3" spellcheck="false" aria-label="Transaction to copy" placeholder="Safe{Wallet} transaction link, or Transaction Builder JSON"
      .value=${live(S.d.source)} @input=${(e: any) => { S.d.source = e.target.value; S.lines = ''; edited(); loadSource() }}></textarea>
    ${S.lines ? html`<div class="small good">✓ ${S.sourceNote}</div>` : nothing}`
}

const STAGES = ['Safe', 'Build Txn', 'Review']
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
    ${footer(0, !n && S.looking.size ? waitButton('Searching every chain…')
      : html`<button class="primary" ?disabled=${!n} @click=${() => goTo(2)}>Continue${n ? ` with ${plural(n, 'Safe')}` : ''}</button>`)}
  </section>`
}

function changeStage() {
  const mode = (m: Draft['mode'], label: string) => html`<button class=${S.d.mode === m ? 'seg on' : 'seg'} aria-pressed=${S.d.mode === m} @click=${() => { S.d.mode = m; edited() }}>${label}</button>`
  return html`<section class="card">
    <div class="row"><span class="segs">${mode('owners', 'Owners')}${mode('replicate', 'Other transaction')}</span></div>
    ${S.d.mode === 'owners' ? ownersEditor() : replicateEditor()}
    ${errorList()}
    ${footer(1, S.d.mode === 'replicate' && S.loadingSource ? waitButton('Loading the transaction…')
      : html`<button class="primary" ?disabled=${S.d.mode === 'replicate' && !S.lines} @click=${() => goTo(3)}>Review ${plural(selected().length, 'Safe')}</button>`)}
  </section>`
}

/** After the queue (the default) or replacing what's queued at the on-chain nonce: the proposer's call, per Safe. */
function nonceSelect(p: Prep) {
  const choice = choiceOf(p), after = pickNonce({ ...p.tx!, nonce: p.state!.nonce }, p.queue!, 'after').nonce
  return html`<span class=${`select small ${choice === 'replace' ? 'warn' : ''}`} @click=${(e: Event) => e.stopPropagation()}>
    <select aria-label=${`Nonce on ${chainName(p.chainId)}`} @change=${(e: any) => chooseNonce(p, e.target.value)}>
      <option value="after" .selected=${choice === 'after'}>After queue (nonce ${after})</option>
      <option value="replace" .selected=${choice === 'replace'}>Replace (nonce ${p.state!.nonce})</option>
    </select>
  </span>`
}

function reviewStage() {
  const by = (k: string) => S.prepared.filter(p => prepKind(p) === k)
  const ready = by('ready'), synced = by('synced'), attention = by('attention'), loading = by('loading')
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const items: Item[] = ready.map(p => ({ tx: p.tx!, owners: p.state?.owners, threshold: p.state?.threshold }))
  const except = exceptions(items), flagged = S.prepared.filter(queuedAhead)
  const allChoose = (c: NonceChoice, label: string) => html`<button class=${flagged.every(p => choiceOf(p) === c) ? 'seg on' : 'seg'} @click=${() => flagged.forEach(p => chooseNonce(p, c))}>${label}</button>`
  return html`<section class="card">
    ${!S.prepared.length ? html`<div class="muted">${S.preparing || S.looking.size ? 'Checking every Safe…' : ''}</div>` : html`
    <div class="summary">
      <span>${ready.length} ready to sign</span>
      ${synced.length ? html`<span class="muted">${synced.length} already in sync</span>` : nothing}
      ${attention.length ? html`<span class="bad">${attention.length} need${attention.length === 1 ? 's' : ''} attention</span>` : nothing}
      ${loading.length ? html`<span class="muted">${loading.length} checking…</span>` : nothing}
    </div>
    ${ready.length ? reviewView(items, labels) : nothing}
    ${flagged.length > 1 ? html`<div class="row queue-bar"><span class="grow">Queued ahead on ${plural(flagged.length, 'Safe')}</span><span class="segs">${allChoose('after', 'After queue')}${allChoose('replace', 'Replace')}</span></div>` : nothing}
    <div class="scroll"><table class="list"><tbody>${S.prepared.map((p, i) => {
      const k = prepKind(p), notes = p.notes
      const only = p.tx ? except(ready.indexOf(p)) : ''
      const key = keyOf(p), open = !!p.tx && S.open.has(key)
      const toggle = () => { if (!p.tx) return; open ? S.open.delete(key) : S.open.add(key); update() }
      return html`<tr class=${`${p.tx ? 'click' : ''} ${queuedAhead(p) ? 'has-sub' : ''}`} @click=${toggle}>
        <td class="ico-cell">${k === 'ready' ? mark('todo', 'Needs signatures') : k === 'synced' ? mark('idle', 'Already in sync', '–') : k === 'attention' ? mark('warn', p.error ?? 'Needs attention', '!') : mark('load', 'Checking this Safe…')}</td>
        <td>${chainChip(p.chainId)}</td>
        <td>${safeAddr(p.chainId, p.safe, labels)}</td>
        <td class="grow-cell small">
          ${p.error ? html`<span class="bad">${p.error}</span> <button class="ghost retry" aria-label="Try again" @click=${(e: Event) => { e.stopPropagation(); retryPrepare(i) }}>↻</button>` : nothing}
          ${p.same ? html`<span class="muted">already queued; its signatures count</span>` : nothing}
          ${only ? html`<span>${only}</span>` : nothing}
          ${p.sim && !p.sim.ok && !p.sim.definite ? html`<span class="warn">${p.sim.error}</span>` : nothing}
          ${notes.length ? html`<span class=${notes.some(x => x.startsWith('⚠')) ? 'warn' : 'muted'}>${notes.join('; ')}</span>` : nothing}
        </td>
        <td>${p.tx ? html`<button class="ghost disclose" aria-expanded=${open} aria-label=${`Details for ${chainName(p.chainId)}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${open ? '▾' : '▸'}</button>` : nothing}</td>
      </tr>
      ${queuedAhead(p) ? html`<tr class="sub"><td></td><td colspan="4">${nonceSelect(p)}</td></tr>` : nothing}
      ${open ? html`<tr class="details"><td></td><td colspan="4">
        ${queuedAhead(p) ? html`<div class="queued small"><span class="muted">Queued</span>${p.queue!.map(q => html`<a href=${safeLink(p, q.safeTxHash)!} target="_blank" rel="noopener">nonce ${q.nonce}</a>`)}</div>` : nothing}
        ${actionsView(p.tx!, labels)}
      </td></tr>` : nothing}`
    })}</tbody></table></div>
    ${S.link ? html`<input readonly class="mono small" aria-label="Signing link" .value=${live(S.link)} @focus=${(e: any) => e.target.select()}>` : nothing}`}
    ${errorList()}
    ${footer(2, html`
      ${S.link ? html`<a class="button" href=${S.link} data-tip="Open the link here to sign it, or propose it, so it shows up in Safe{Wallet}">Propose now</a>` : nothing}
      ${S.preparing || loading.length ? waitButton(S.prepared.length ? `Building ${S.prepared.length - loading.length} of ${S.prepared.length}…` : 'Reading every Safe…')
      : html`<button class=${S.copied === 'failed' ? 'bad-btn' : 'primary'} @click=${copyLink} ?disabled=${!ready.length}>${S.copied === 'yes' ? 'Copied ✓' : S.copied === 'failed' ? 'Copy failed' : 'Copy signing link'}</button>`}`)}
  </section>`
}

const composeView = () => html`${stageBar(S.stage)}${S.stage === 1 ? safeStage() : S.stage === 2 ? changeStage() : reviewStage()}`

// ---------------------------------------------------------------- batch view

/**
 * The connected account's checklist: ✓ the Safe service has your signature or proposal, ○ it needs you, – nothing for
 * you to do (anyone who isn't an owner or proposer only views the link). A dashed
 * ring is yours but not in the Safe service yet (yellow: the upload failed), ! is a problem, a thin spinner still
 * loading. The details are in each mark's tooltip.
 */
function icon(r: Row, st: ReturnType<typeof status>) {
  if (r === S.current) return mark('now', r.phase ?? 'Working on this Safe')
  if (st.kind === 'blocked') return mark('warn', st.detail ?? st.text, '!')
  if (r.uploadError) return mark('pending failed', r.uploadError)
  if (r.error) return mark('warn', r.error, '!')
  if (loadingRow(r)) return mark('load', 'Reading this Safe…')
  if (S.account && !isOwner(r, S.account) && S.delegations[`${S.account}:${r.tx.chainId}`] && !S.delegations[`${S.account}:${r.tx.chainId}`].data) return mark('load', 'Checking whether you can propose this…')
  if (!S.account) return mark('todo quiet', 'Connect a wallet to see what you can do here')
  if (r.proposing || (mine(r) && r.sigs[S.account.toLowerCase()].uploading)) return mark('pending', 'Uploading to the Safe service…')
  if (mine(r)) return r.svc === 'ok' && !r.sigs[S.account.toLowerCase()].posted ? mark('pending', 'Signed, not in the Safe service yet') : mark('done', 'You signed this', '✓')
  if (proposedByMe(r)) return mark('done', 'You proposed this', '✓')
  if (canSign(r)) return mark('todo', 'Needs your signature')
  if (canPropose(r)) return mark('todo', 'Not proposed yet: you can, as a proposer')
  return mark('idle', 'Nothing for you to do', '–')
}
const KIND_CLASS: Record<Kind, string> = { loading: 'muted', collecting: '', ready: 'good', waiting: 'muted', executed: 'good', blocked: 'bad', unknown: 'warn' }


function progressView() {
  // An owner's work is signing; a proposer's is proposing what nobody has proposed yet.
  const signs = S.account ? S.rows.filter(r => mine(r) || canSign(r)) : []
  const proposals = S.account ? S.rows.filter(r => proposedByMe(r) || canPropose(r)) : []
  const yours = [...signs, ...proposals]
  const signed = signs.filter(mine).length, proposed = proposals.filter(proposedByMe).length
  const done = signed + proposed, remaining = yours.length - done
  const both = signs.length > 0 && proposals.length > 0
  const action = [signs.length - signed && `sign ${signs.length - signed}`, proposals.length - proposed && `propose ${proposals.length - proposed}`].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase())
  const progress = [signs.length && `signed ${signed} of ${signs.length}`, proposals.length && `proposed ${proposed} of ${proposals.length}`].filter(Boolean).join(', ')
  const working = both ? 'Signing and proposing' : proposals.length ? 'Proposing' : 'Signing'
  const finished = both ? `Signed ${signs.length}, proposed ${proposals.length}` : `${proposals.length ? 'Proposed' : 'Signed'} all ${yours.length}`
  const involved = !!S.account && S.rows.some(r => isOwner(r, S.account) || isDelegate(r, S.account!))
  const reading = S.rows.filter(loadingRow).length, read = S.rows.length - reading
  const lookingUp = S.account && S.rows.some(r => { const lookup = S.delegations[`${S.account}:${r.tx.chainId}`]; return lookup && !lookup.data })
  const waitText = reading ? `Reading ${read} of ${S.rows.length} Safes` : lookingUp ? 'Checking proposer access…' : ''
  // Nothing found for you yet, and still reading: too early to say there's nothing, so the card shows the reading line alone.
  const undecided = !yours.length && !!waitText
  const ready = S.rows.filter(r => status(r).kind === 'ready').length
  const executed = S.rows.filter(r => status(r).kind === 'executed').length
  const busy = S.signing || S.executing || S.waiting
  const pending = (r: Row) => (r.svc === 'ok' ? unshared(r) : [])
  const uploading = S.rows.reduce((n, r) => n + pending(r).filter(x => x.uploading).length, 0) + S.rows.filter(r => r.proposing).length
  const notUploaded = S.rows.reduce((n, r) => n + pending(r).filter(x => !x.uploading).length, 0)
  const manual = S.rows.filter(r => r.svc === 'none' && needsWork(r) && Object.keys(r.sigs).length)
  const bar = html`<div class="bar"><i style=${`width:${yours.length ? Math.round((done / yours.length) * 100) : 0}%`}></i></div>`
  const cur = S.current
  return html`
  ${!S.account ? nothing
  : S.signing ? html`<div class="row"><b class="grow">${working} ${Math.min(done + 1, yours.length)} of ${yours.length}</b><button @click=${() => stop()}>Pause</button></div>
      ${bar}
      ${cur ? html`<div class="current">
        <div class="spaced"><b>${chainName(cur.tx.chainId)}</b>${addr(cur.tx.safe)}<span class="muted">${cur.phase ?? ''}</span></div>
        <div class="hashes"><span class="muted">safeTxHash</span><span class="mono">${cur.hash}</span></div>
        <div class="hashes"><span class="muted">domain hash</span><span class="mono">${domainHash(cur.tx)}</span></div>
        <div class="hashes"><span class="muted">message hash</span><span class="mono">${messageHash(cur.tx)}</span></div>
      </div>` : nothing}`
  : remaining ? html`<div class="row">
      <span class="grow">${progress.replace(/^./, c => c.toUpperCase())}</span>
      <button class="primary" @click=${signAll} ?disabled=${busy}>${S.waiting ? 'Waiting for wallet…' : action}</button>
    </div>${bar}`
  : yours.length ? html`<div class="row">
      <span class="done-msg grow">✓ ${finished}${uploading && !notUploaded ? html` <span class="muted small">uploading…</span>` : nothing}</span>
      ${notUploaded ? html`<button @click=${refresh}>Retry upload (${notUploaded})</button>` : nothing}
      ${manual.length ? html`<button @click=${() => copy(exportSigs())}>Copy signatures for ${manual.map(r => chainChip(r.tx.chainId))}</button>` : nothing}
    </div>${bar}`
  : undecided ? nothing
  : html`<div class="muted">${involved ? 'Nothing left for you to sign' : 'Not an owner of these Safes'}</div>`}
  <div class="row small">
    <div class="grow stack">
      ${waitText ? busyLine(waitText) : nothing}
      <span class="muted">Executed ${executed} of ${S.rows.length}</span>
    </div>
    ${S.account && ready && !busy ? html`<button @click=${executeAll}>Execute ${ready}</button>` : nothing}
    ${S.executing ? html`<button @click=${() => stop()}>Stop</button>` : nothing}
    <button class="ghost" aria-label="Refresh" data-tip="Read every Safe again" @click=${refresh} ?disabled=${busy}>↻</button>
  </div>
  ${!storageOk ? html`<div class="notice">This browser can't save signatures</div>` : nothing}
  ${S.notice ? html`<div class="notice">${S.notice}</div>` : nothing}`
}

function batchView() {
  if (S.loadError) return html`<section class="card"><div class="errors">${S.loadError}</div><button @click=${() => { location.hash = ''; S.mode = 'compose'; update() }}>New batch</button></section>`
  const b = S.batch!
  const items: Item[] = S.rows.map(r => ({ tx: r.tx, owners: r.owners, threshold: r.threshold, done: status(r).kind === 'executed', failed: r.chainNonce === undefined && !!r.error }))
  const except = exceptions(items)
  return html`
  <section class="card">
    <div class="row">
      <span class="grow muted">${b.title}</span>
      <span class="fingerprint" tabindex="0" data-tip="Fingerprint of every transaction in this link. Confirm it with whoever sent it.">${S.id}</span>
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
        <td class="ico-cell">${icon(r, st)}</td>
        <td>${chainChip(r.tx.chainId)}</td>
        <td>${safeAddr(r.tx.chainId, r.tx.safe, b.labels)}</td>
        <td class="grow-cell">
          <span class=${KIND_CLASS[st.kind]} data-tip=${r.proposed && r.trusted === false && st.kind === 'collecting' ? 'Proposed unsigned: Safe{Wallet} lists it once an owner signs' : nothing}>${r === S.current && r.phase ? r.phase : st.text}</span>
          ${except(S.rows.indexOf(r)) ? html`<div class="small">${except(S.rows.indexOf(r))}</div>` : nothing}
          ${conflict ? html`<div class="small warn">⚠ competes with another transaction at nonce ${r.tx.nonce}</div>` : nothing}
        </td>
        <td><button class="ghost disclose" aria-expanded=${!!r.open} aria-label=${`Details for ${chainName(r.tx.chainId)}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${r.open ? '▾' : '▸'}</button></td>
      </tr>
      ${r.open ? html`<tr class="details"><td></td><td colspan="4">
        ${actionsView(r.tx, b.labels)}
        <div class="kv">
          <span>nonce</span><span class="mono">${r.tx.nonce}</span>
          <span>to</span><span><span class="mono wrap">${r.tx.to}</span>${copyButton(r.tx.to)}</span>
          <span>value</span><span class="mono">${r.tx.value}</span>
          <span>operation</span><span>${r.tx.operation === 1 ? 'DELEGATECALL (1)' : 'CALL (0)'}</span>
          <span>data</span><span class="mono wrap">${r.tx.data} <a class="nowrap" href=${`https://safe.eth.sh/calldata-decoder?calldata=${encodeURIComponent(r.tx.data)}`} target="_blank" rel="noopener noreferrer" title="Decode in ETH.sh">View on ETH.sh ↗</a></span>
          <span>gas and refund</span><span class="mono">all zero</span>
          <span>safeTxHash</span><span class="mono wrap">${r.hash}</span>
          <span>domain hash</span><span class="mono wrap">${domainHash(r.tx)}</span>
          <span>message hash</span><span class="mono wrap">${messageHash(r.tx)}</span>
          <span>signed by</span><span>${validSigs(r).map(x => html`<div>${addr(x.owner)}${r.svc === 'ok' && !x.posted ? html` <span class="warn">not uploaded</span>` : nothing}</div>`)}</span>
          ${r.svc === 'none' && needsWork(r) ? html`<span>add signatures</span><span class="row">
            <textarea class="grow mono small" rows="1" aria-label="Paste signatures" placeholder="Signatures copied from another signer" .value=${live(S.pasted)} @input=${(e: any) => { S.pasted = e.target.value; update() }}></textarea>
            <button @click=${importSigs} ?disabled=${!S.pasted.trim()}>Add</button>
          </span>` : nothing}
          ${link ? html`<span>open in</span><span><a href=${link} target="_blank" rel="noopener">${chainOf(r.tx.chainId)?.service ? 'Safe{Wallet}' : 'explorer'}</a>${r.execHash ? html`<a class="aside" href=${`${chainOf(r.tx.chainId)?.explorer}/tx/${r.execHash}`} target="_blank" rel="noopener">execution</a>` : nothing}</span>` : nothing}
        </div>
      </td></tr>` : nothing}`
    })}</tbody></table></div>
  </section>`
}

// ---------------------------------------------------------------- settings & shell

/** Tries an endpoint from this browser, so CORS is tested for real. Returns what's wrong, or nothing. */
async function tryUrl(url: string, init: RequestInit, wrong: (j: any) => string | undefined): Promise<string | undefined> {
  if (!/^https?:\/\/[^\s/]+/.test(url)) return 'Not a URL'
  if (location.protocol === 'https:' && url.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return 'Use https:// (this page is https, so the browser blocks http://)'
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
    return res.ok ? wrong(await res.json().catch(() => null)) : `It answered ${res.status}`
  } catch (e) { return (e as Error).name === 'TimeoutError' ? 'No answer in 8 seconds' : 'No answer: unreachable, or the browser blocked it (CORS)' }
}
const checkRpc = (url: string, id: number) => tryUrl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) },
  j => (j?.result === undefined ? 'Not a JSON-RPC endpoint' : Number(j.result) !== id ? `That's chain ${Number(j.result)}, not ${id}` : undefined))
const checkService = (url: string) => tryUrl(`${url}/api/v1/about/`, {}, j => (j?.name === 'Safe Transaction Service' ? undefined : 'Not a Safe Transaction Service'))

const checking = new Set<Promise<unknown>>()
/** The endpoint a chain uses unless overridden: its first public RPC, or its Safe service. */
const defaultEndpoint = (kind: Endpoint, id: number) => { const c = CHAINS.find(c => c.id === id); return kind === 'rpc' ? c?.rpcs[0] : c?.service?.url }
// Settings save themselves: a field that holds a whole URL saves when you pause typing, and leaving it (or Enter, or
// closing Settings) saves whatever it holds, an empty field included.
const pauses: Record<string, ReturnType<typeof setTimeout>> = {}
function typed(kind: Endpoint, id: number, text: string) {
  const key = `${kind}:${id}`
  S.edits[key] = { text, state: 'typing' }
  clearTimeout(pauses[key])
  if (/^https?:\/\/[^\s/]+\.[^\s/]{2,}/.test(text.trim())) pauses[key] = setTimeout(() => saveEndpoint(kind, id, text), 700)
}
/** Saves an override once it works from here; an empty field, or the default typed back in, goes back to the default. */
async function saveEndpoint(kind: Endpoint, id: number, text: string) {
  const key = `${kind}:${id}`, url = kind === 'service' ? text.trim().replace(/\/+$/, '').replace(/\/api$/, '') : text.trim()
  const done = (edit?: Edit) => { if (edit) S.edits[key] = edit; else delete S.edits[key]; update() }
  clearTimeout(pauses[key])
  const now = S.edits[key]
  if (now && now.text === text && now.state !== 'typing') return // already being checked, saved or refused as it stands
  if (!url || url === defaultEndpoint(kind, id)) {
    if (S.settings[kind][id] !== undefined) { delete S.settings[kind][id]; applySettings(); S.settingsChanged = true }
    return done()
  }
  if (url === S.settings[kind][id]) return done()
  done({ text, state: 'checking' })
  const check = kind === 'rpc' ? checkRpc(url, id) : checkService(url)
  checking.add(check)
  const wrong = await check
  checking.delete(check)
  if (S.edits[key]?.text !== text) return // changed again meanwhile
  if (wrong) return done({ text, state: 'bad', note: wrong })
  S.settings[kind][id] = url; applySettings(); S.settingsChanged = true
  done({ text: url, state: 'saved' })
}

function resetChain(id: number) {
  delete S.settings.rpc[id]; delete S.settings.service[id]; delete S.edits[`rpc:${id}`]; delete S.edits[`service:${id}`]
  if (!CHAINS.some(c => c.id === id)) S.openChain = S.addingChain = null
  applySettings(); S.settingsChanged = true; update()
}

/** Settings is a page of its own: a history entry, so the browser's Back closes it too. */
function openSettings() {
  history.pushState({ ...history.state, settings: true }, '', location.href)
  S.settingsOpen = true; S.settingsChanged = false; update(); scrollTo(0, 0)
}
/** Closing saves what's still being typed and waits for its check: it closes once saved, or stays open to say what's wrong. */
async function closeSettings() {
  for (const [key, e] of Object.entries(S.edits)) if (e.state === 'typing') saveEndpoint(key.split(':')[0] as Endpoint, Number(key.split(':')[1]), e.text)
  if (checking.size) {
    S.closing = true; update(); await Promise.all(checking); S.closing = false
    if (Object.values(S.edits).some(e => e.state === 'bad')) return update()
  }
  if (history.state?.settings) history.back(); else settingsClosed()
}
// Escape closes Settings, except while it's clearing the chain search.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.settingsOpen && !(e.target instanceof HTMLInputElement && e.target.type === 'search' && e.target.value)) closeSettings()
})
function settingsClosed() {
  S.settingsOpen = false; S.edits = {}; S.openChain = S.addingChain = null
  if (S.settingsChanged && S.mode === 'batch') refresh() // read every Safe again through the new endpoints
  S.settingsChanged = false; update()
}

/** The URL in use, as plain text: the override if there is one, else the default. A line below only while it matters. */
function endpointField(kind: Endpoint, id: number) {
  const e = S.edits[`${kind}:${id}`], value = S.settings[kind][id] ?? defaultEndpoint(kind, id) ?? ''
  return html`<label class="endpoint">
    <span class="small muted">${kind === 'rpc' ? 'RPC' : 'Safe Transaction Service'}</span>
    <input class="mono small" spellcheck="false" autocomplete="off" placeholder=${kind === 'rpc' ? 'https://…' : 'None'}
      .value=${live(e?.text ?? value)} @input=${(ev: any) => typed(kind, id, ev.target.value)} @change=${(ev: any) => saveEndpoint(kind, id, ev.target.value)}>
    ${e?.state === 'checking' ? html`<span class="small muted">Checking…</span>`
    : e?.state === 'bad' ? html`<span class="small bad">${e.note}</span>`
    : e?.state === 'saved' ? html`<span class="small good">Saved</span>` : nothing}
  </label>`
}

function settingsView() {
  const known = new Set(CHAINS.map(c => c.id)), custom = (id: number) => !!(S.settings.rpc[id] || S.settings.service[id])
  const added = [...new Set([...Object.keys(S.settings.rpc), ...Object.keys(S.settings.service)].map(Number))].filter(id => !known.has(id))
  const ids = [...known, ...added, ...(S.addingChain && !known.has(S.addingChain) && !added.includes(S.addingChain) ? [S.addingChain] : [])]
  const q = S.chainQuery.trim().toLowerCase(), customized = ids.filter(custom).length
  const matches = (id: number) => { const c = CHAINS.find(c => c.id === id); return !q || String(id) === q || !!c && (c.short.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) }
  const shown = ids.filter(id => matches(id) && (!S.customOnly || custom(id) || id === S.addingChain))
  const addable = /^[1-9]\d{0,15}$/.test(q) && !ids.includes(Number(q))
  const row = (id: number) => {
    const c = CHAINS.find(c => c.id === id), open = S.openChain === id, name = c?.name ?? `Chain ${id}`
    const toggle = () => { S.openChain = open ? null : id; update() }
    return html`<tr class="click" @click=${toggle}>
      <td>${chainChip(id)}</td>
      <td class="grow-cell">${name}</td>
      <td>${custom(id) ? html`<span class="badge">${c ? 'Custom' : 'Added'}</span>` : nothing}</td>
      <td><button class="ghost disclose" aria-expanded=${open} aria-label=${`Settings for ${name}`} @click=${(e: Event) => { e.stopPropagation(); toggle() }}>${open ? '▾' : '▸'}</button></td>
    </tr>
    ${open ? html`<tr class="details"><td colspan="4">
      ${endpointField('rpc', id)}
      ${endpointField('service', id)}
      ${custom(id) ? html`<button class="ghost" @click=${() => resetChain(id)}>${c ? 'Reset to default' : 'Remove'}</button>` : nothing}
    </td></tr>` : nothing}`
  }
  return html`<section class="card">
    <div class="row"><h2 class="grow">Settings</h2>
      <button class="ghost close" aria-label="Close settings" data-tip=${S.closing ? 'Checking your last change…' : 'Close'} ?disabled=${S.closing} @click=${closeSettings}>
        ${S.closing ? html`<i class="spin"></i>` : html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`}
      </button>
    </div>
    <label class="endpoint">
      <span class="small muted">Safe API key</span>
      <input class="mono small" spellcheck="false" autocomplete="off" placeholder="Optional: raises Safe's rate limits" .value=${live(S.settings.apiKey)}
        @input=${(e: any) => { S.settings.apiKey = e.target.value; applySettings(); S.settingsChanged = true }}>
    </label>
    <div class="row">
      <input class="grow" type="search" placeholder="Search chains" aria-label="Search chains" .value=${live(S.chainQuery)} @input=${(e: any) => { S.chainQuery = e.target.value; update() }}>
      ${customized ? html`<button class=${`pick text ${S.customOnly ? 'on' : ''}`} aria-pressed=${S.customOnly} @click=${() => { S.customOnly = !S.customOnly; update() }}>Customized ${customized}</button>` : nothing}
    </div>
    <div class="scroll"><table class="list"><tbody>${shown.map(row)}</tbody></table></div>
    ${addable ? html`<div><button class="ghost" @click=${() => { S.addingChain = S.openChain = Number(q); S.customOnly = false; update() }}>+ Add chain ${q}</button></div>`
    : !shown.length ? html`<div class="small muted">No chain matches "${S.chainQuery.trim()}"</div>` : nothing}
    ${customized ? html`<div class="row"><span class="grow"></span><button class="ghost" @click=${() => { S.settings.rpc = {}; S.settings.service = {}; S.edits = {}; S.addingChain = null; applySettings(); S.settingsChanged = true; update() }}>Reset all to defaults</button></div>` : nothing}
  </section>`
}

/** Connected: the address (with copy) and Disconnect. Otherwise the wallets this browser has. */
const walletMenu = () => html`<div class="menu" role="menu">${S.account
  ? html`<div class="row">${addr(S.account)}</div><button class="ghost" role="menuitem" @click=${disconnect}>Disconnect</button>`
  : S.wallets.length ? S.wallets.map(w => html`<button class="ghost" role="menuitem" @click=${() => connect(w)}><img src=${w.info.icon} alt="">${w.info.name}</button>`)
  : html`<div class="muted small">No browser wallet found</div>`}</div>`

/** The one place to connect, see the connected account, and disconnect. */
function walletButton() {
  return html`<span class="wallet">
    ${S.account
      ? html`<button class="account" aria-haspopup="menu" aria-expanded=${S.walletMenu} @click=${() => { S.walletMenu = !S.walletMenu; update() }}><i class="dot"></i><span class="mono">${short(S.account)}</span></button>`
      : html`<button aria-haspopup="menu" aria-expanded=${S.walletMenu} @click=${() => connect()}>Connect wallet</button>`}
    ${S.walletMenu ? walletMenu() : nothing}
  </span>`
}

function view(): TemplateResult {
  return html`
  <header>
    <a class="brand grow" href=${location.pathname + location.search} @click=${(e: Event) => { e.preventDefault(); if (S.mode === 'compose') return void (S.stage > 1 && goTo(1)); history.pushState({ stage: 1 }, '', location.pathname + location.search); route() }}>Safe Sync</a>
    ${S.settingsOpen ? nothing : html`<button class="ghost" @click=${openSettings}>Settings</button>`}
    ${walletButton()}
  </header>
  <main class=${S.settingsOpen || S.mode === 'compose' ? 'narrow' : ''}>${S.settingsOpen ? settingsView() : S.mode === 'batch' ? batchView() : composeView()}</main>`
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
window.addEventListener('popstate', () => {
  if (S.settingsOpen && !history.state?.settings) settingsClosed()
  S.settingsOpen = !!history.state?.settings
  if (!location.hash) route(); else update()
})
// Signatures are kept in localStorage and re-uploaded on the next visit; only warn mid-session, or while a proposal
// (whose signature isn't kept) is still uploading.
window.addEventListener('beforeunload', e => { if (S.signing || S.executing || S.waiting || S.rows.some(r => r.proposing)) e.preventDefault() })
route()
