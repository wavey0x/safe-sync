// UI. Two screens: compose (proposer) and batch (signers and executors, opened from the link).
// All state lives in the link, the Safe Transaction Service, the chain, and localStorage.
import { html, nothing, render, type TemplateResult } from 'lit-html'
import { live } from 'lit-html/directives/live.js'
import { getAddress, isAddress, toHex, type Address, type Hex } from 'viem'
import { CHAINS } from './chains'
import {
  batchId, chainName, chainOf, client, config, decodeBatch, describe, domainHash, encodeBatch, execData, linesFromTx,
  messageHash, msg, normalizeSig, onchainHash, parseActions, parseTargets, payloadKey, prepareTarget, readSafe,
  resolveNames, revertData, revertReason, SAFE_ABI, safeTxHash, short, sigOwner, walletTypedData,
  type Batch, type Prepared, type Step, type Tx,
} from './safe'
import * as svc from './service'

// ---------------------------------------------------------------- state

type Sig = { owner: Address; sig: Hex; posted: boolean }
type Kind = 'loading' | 'collecting' | 'ready' | 'waiting' | 'executed' | 'blocked' | 'unknown'
type Row = {
  tx: Tx; hash: Hex; sigs: Record<string, Sig>
  owners?: Address[]; threshold?: number; chainNonce?: number
  svc: 'loading' | 'ok' | 'none' | 'error'; proposed: boolean; svcExecuted?: boolean; readAt: number
  phase?: string; error?: string; fatal?: string; execHash?: Hex; open?: boolean
  loaded?: Promise<void>; posting?: Promise<void>
}
type Wallet = { info: { name: string; icon: string; rdns: string }; provider: any }
type Result = { before: [number, number]; after: [number, number] }

let storageOk = true
const store = {
  get: <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { storageOk = false } },
}
const draft = store.get('fanout:draft', { title: '', targets: '', actions: '' })

const S = {
  mode: 'compose' as 'compose' | 'batch',
  title: draft.title, targets: draft.targets, actions: draft.actions, afterQueue: false, importRef: '',
  preparing: false, prepared: [] as Prepared[], errors: [] as string[], names: {} as Record<string, Address>, link: '',
  batch: null as Batch | null, id: '', rows: [] as Row[], loadError: '', pasted: '',
  wallets: [] as Wallet[], provider: null as any, account: null as Address | null, choosing: false,
  signing: false, executing: false, current: null as Row | null, notice: '',
  settingsOpen: false, settingsErrors: [] as string[], settings: store.get('fanout:settings', { rpc: '', service: '', apiKey: '' }),
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
const saveDraft = () => store.set('fanout:draft', { title: S.title, targets: S.targets, actions: S.actions })

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

// ---------------------------------------------------------------- compose

// Bumped on every edit: results of an older Prepare are discarded, so a link never carries stale transactions.
let run = 0
function edited() {
  run++
  S.prepared = []; S.link = ''; S.preparing = false
  saveDraft(); update()
}

async function prepare() {
  const my = ++run
  const t = parseTargets(S.targets), a = parseActions(S.actions)
  S.errors = [...t.errors, ...a.errors]
  if (!t.targets.length) S.errors.push('Add at least one Safe.')
  if (!a.actions.length) S.errors.push('Add at least one action.')
  S.prepared = []; S.link = ''
  if (S.errors.length) return update()
  S.preparing = true; update()
  try {
    const names = await resolveNames(a.actions)
    if (my !== run) return
    S.names = names
    S.prepared = t.targets.map(x => ({ ...x, notes: [] }))
    update()
    await Promise.all(t.targets.map(async (x, i) => {
      const p = await prepareTarget(x, a.actions, names, S.afterQueue ? queueEnd : undefined)
      if (my !== run) return
      S.prepared[i] = p; update()
      if (p.tx && !p.error && svc.serviceUrl(p.chainId)) checkQueue(p, my) // only adds notes; doesn't hold up the link
    }))
  } catch (e) { if (my === run) S.errors.push(msg(e)) }
  if (my === run) { S.preparing = false; update() }
}

async function checkQueue(p: Prepared, my: number) {
  try {
    const q = await svc.queued(p.chainId, p.safe, p.tx!.nonce)
    if (q.some(o => o.safeTxHash === p.hash)) p.notes.push('already queued in Safe{Wallet}; its signatures count')
    else if (q.some(o => o.nonce === p.tx!.nonce)) p.notes.push(`⚠ another transaction is queued at nonce ${p.tx!.nonce}`)
  } catch (e) { p.notes.push(`queue check failed: ${msg(e)}`) }
  if (my === run) update()
}

async function queueEnd(chainId: number, safe: Address, nonce: number): Promise<number> {
  if (!svc.serviceUrl(chainId)) return nonce
  const q = await svc.queued(chainId, safe, nonce)
  return Math.max(nonce, ...q.map(o => o.nonce + 1))
}

async function importTx() {
  try {
    const ref = S.importRef.trim()
    const hash = ref.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined
    const chain = chainOf(ref.match(/safe=([a-z0-9-]+):/i)?.[1] ?? ref.match(/^([a-z0-9-]+):0x/i)?.[1] ?? '')
    if (!hash || !chain) throw new Error('Paste a Safe{Wallet} transaction link, or chain:0xsafeTxHash')
    const t = await svc.getTx(chain.id, hash)
    if (!t) throw new Error('Transaction not found in the Safe Transaction Service')
    S.actions = [S.actions.trim(), `# from ${chain.short} ${short(t.safe)} nonce ${t.nonce}`, linesFromTx(t)].filter(Boolean).join('\n')
    S.importRef = ''; S.errors = []
    edited()
  } catch (e) { S.errors = [msg(e)]; update() }
}

const prepKind = (p: Prepared) => (p.error ? 'attention' : p.skip ? 'applied' : p.tx ? 'ready' : 'loading')

async function createLink() {
  const ready = S.prepared.filter(p => prepKind(p) === 'ready')
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const batch: Batch = { title: S.title.trim() || 'Untitled batch', created: Date.now(), txs: ready.map(p => p.tx!), labels, src: { targets: S.targets, actions: S.actions } }
  S.link = `${location.href.split('#')[0]}#${await encodeBatch(batch)}`
  copy(S.link)
}

// ---------------------------------------------------------------- batch

// Signatures are kept per safeTxHash, so they carry over when a batch is edited into a new link.
const sigKey = (h: Hex) => `fanout:sig:${h}`
const saveSigs = (r: Row) => store.set(sigKey(r.hash), Object.fromEntries(Object.entries(r.sigs).map(([k, s]) => [k, { owner: s.owner, sig: s.sig }])))

async function openBatch(encoded: string) {
  try {
    const batch = await decodeBatch(encoded)
    S.batch = batch; S.id = batchId(batch); S.mode = 'batch'; S.loadError = ''
    S.rows = batch.txs.map(tx => {
      const hash = safeTxHash(tx), saved = store.get<Record<string, { owner: Address; sig: Hex }>>(sigKey(hash), {})
      return { tx, hash, sigs: Object.fromEntries(Object.entries(saved).map(([k, s]) => [k, { ...s, posted: false }])), svc: 'loading', proposed: false, readAt: 0 }
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

async function readService(r: Row) {
  try {
    const t = await svc.getTx(r.tx.chainId, r.hash)
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
  r.posting = (r.posting ?? Promise.resolve()).then(async () => {
    if (s.posted) return
    try {
      await svc.submit(r.tx, r.hash, s.owner, s.sig, r.proposed)
      s.posted = true; r.proposed = true; r.error = undefined
    } catch (e) { r.error = `Signed but not uploaded: ${msg(e)}. Refresh retries; you can also copy it below.` }
    update()
  })
}

const isOwner = (r: Row, a?: Address | null) => !!a && !!r.owners?.some(o => o.toLowerCase() === a.toLowerCase())
const validSigs = (r: Row) => Object.values(r.sigs).filter(s => isOwner(r, s.owner))
function status(r: Row): { kind: Kind; text: string } {
  if (r.fatal) return { kind: 'blocked', text: r.fatal }
  if (r.chainNonce === undefined) return r.error ? { kind: 'unknown', text: r.error } : { kind: 'loading', text: 'loading…' }
  if (r.chainNonce > r.tx.nonce) {
    if (r.svcExecuted || r.execHash) return { kind: 'executed', text: 'executed' }
    if (r.svc === 'loading') return { kind: 'loading', text: 'checking…' }
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
      if (S.signing || S.executing) S.signing = S.executing = false, S.notice = 'Wallet account changed, so I stopped.'
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

async function signAll() {
  const account = S.account!
  S.signing = true; S.notice = ''; update()
  // Every await is a chance for Pause or an account switch: check before each wallet request.
  const stopped = () => !S.signing || S.account !== account
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
      await ensureChain(r.tx.chainId)
      if (stopped()) break
      r.phase = 'confirm in your wallet'; update()
      const sig = normalizeSig(await S.provider.request({ method: 'eth_signTypedData_v4', params: [account, walletTypedData(r.tx)] }))
      if ((await sigOwner(r.hash, sig))?.toLowerCase() !== account.toLowerCase()) throw new Error('The wallet returned a signature for a different account or message')
      const s = (r.sigs[account.toLowerCase()] = { owner: account, sig, posted: false })
      r.error = undefined; saveSigs(r)
      if (svc.serviceUrl(r.tx.chainId)) post(r, s)
    } catch (e) {
      if (rejected(e)) { S.signing = false; S.notice = 'Paused: the request was rejected in your wallet.' }
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  S.signing = false; S.current = null; update()
}

async function executeAll() {
  const account = S.account!
  S.executing = true; S.notice = ''; update()
  const stopped = () => !S.executing || S.account !== account
  for (const r of S.rows) {
    if (stopped()) break
    if (status(r).kind !== 'ready') continue
    S.current = r
    try {
      r.phase = 'switching network'; update()
      await ensureChain(r.tx.chainId)
      const c = client(r.tx.chainId)
      const data = execData(r.tx, validSigs(r), r.threshold!)
      r.phase = 'simulating'; update()
      try { await c.call({ account, to: r.tx.safe, data }) } catch (e) {
        const d = revertData(e); throw new Error(`Execution would fail: ${d ? revertReason(d) : msg(e)}`)
      }
      const gas = await c.estimateGas({ account, to: r.tx.safe, data })
      if (stopped()) break
      r.phase = 'confirm in your wallet'; update()
      r.execHash = await S.provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: r.tx.safe, data, gas: toHex((gas * 13n) / 10n) }] })
      c.waitForTransactionReceipt({ hash: r.execHash! }).then(rc => {
        if (rc.status === 'success') r.chainNonce = r.tx.nonce + 1, r.svcExecuted = true
        else r.error = 'Execution reverted', r.execHash = undefined
        update()
      }, e => { r.error = msg(e); update() })
    } catch (e) {
      if (rejected(e)) { S.executing = false; S.notice = 'Paused: the request was rejected in your wallet.' }
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  S.executing = false; S.current = null; update()
}

// Signatures the Safe service doesn't hold (no service on the chain, or upload failed) can be shared as a bundle.
const unshared = (r: Row) => (r.svc === 'loading' || !needsWork(r) ? [] : Object.values(r.sigs).filter(s => r.svc !== 'ok' || !s.posted))
const exportSigs = () => `fanout-sigs:${btoa(JSON.stringify(S.rows.flatMap(r => unshared(r).map(s => [r.hash, s.sig]))))}`

async function importSigs() {
  let added = 0
  try {
    for (const m of S.pasted.matchAll(/fanout-sigs:([A-Za-z0-9+/=]+)/g)) {
      for (const [hash, sig] of JSON.parse(atob(m[1])) as [Hex, Hex][]) {
        const r = S.rows.find(r => r.hash === hash)
        const owner = r && (await sigOwner(hash, sig).catch(() => undefined))
        if (!r || !owner || !isOwner(r, owner) || r.sigs[owner.toLowerCase()]) continue
        const s = (r.sigs[owner.toLowerCase()] = { owner, sig, posted: false })
        saveSigs(r); added++
        if (r.svc === 'ok' && needsWork(r)) post(r, s)
      }
    }
    S.notice = `Added ${added} signature${added === 1 ? '' : 's'}.`; S.pasted = ''
  } catch (e) { S.notice = `Could not read signatures: ${msg(e)}` }
  update()
}

function refresh() {
  for (const r of S.rows) { r.error = undefined; r.svc = 'loading'; r.loaded = loadRow(r) }
  update()
}

function edit() {
  if (!S.batch) return
  S.title = S.batch.title; S.targets = S.batch.src.targets; S.actions = S.batch.src.actions
  history.pushState(null, '', location.pathname + location.search)
  S.mode = 'compose'; edited()
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

/** Every decoded field, for the technical view. */
function steps(list: Step[], labels: Record<string, string>) {
  return html`<ol class="steps">${list.map(s => html`<li>
    <b>${s.target === 'self' ? 'this Safe' : addr(s.target, labels)}</b> · <span class="fn">${s.fn}</span>
    ${s.op === 1 ? html`<span class="bad"> DELEGATECALL</span>` : nothing}
    ${s.value ? html` · value ${s.value.toString()} wei` : nothing}
    ${s.args.length ? html`<div class="args">${s.args.map(([k, v]) => html`<div><span class="muted">${k}</span> ${isAddress(v) ? addr(v, labels) : v === 'this Safe' ? html`<b>this Safe</b>` : html`<span class="mono wrap">${v}</span>`}</div>`)}</div>` : nothing}
    ${s.raw ? html`<div class="mono small wrap">${s.raw}</div>` : nothing}
  </li>`)}</ol>`
}

const OWNER_FNS = ['swapOwner', 'addOwnerWithThreshold', 'removeOwner', 'changeThreshold']

/** One plain-language line per step. The key ignores encoding details such as prevOwner. */
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
    view: html`${s.op === 1 ? html`<b class="bad">DELEGATECALL </b>` : nothing}Call <span class="fn">${s.fn}</span> on ${target}${s.value ? html` with ${s.value.toString()} wei` : nothing}`,
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

function composeView() {
  const by = (k: string) => S.prepared.filter(p => prepKind(p) === k)
  const ready = by('ready'), applied = by('applied'), attention = by('attention'), loading = by('loading')
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const prepResult = (tx: Tx) => {
    const p = S.prepared.find(p => p.tx === tx)
    return p?.state && p.owners && p.threshold !== undefined ? { before: [p.state.threshold, p.state.owners.length], after: [p.threshold, p.owners.length] } as Result : undefined
  }
  return html`
  <section class="card">
    <input class="title" placeholder="Batch title, e.g. Rotate signers Q4" .value=${live(S.title)} @input=${(e: any) => { S.title = e.target.value; saveDraft() }}>
    <div class="cols">
      <label><span>Safes</span>
        <textarea rows="8" spellcheck="false" placeholder=${'0xSafe… eth arb1 base oeth 252\neth:0xOtherSafe…\nhttps://app.safe.global/home?safe=gno:0x…'} .value=${live(S.targets)} @input=${(e: any) => { S.targets = e.target.value; edited() }}></textarea>
        <small>One per line: <code>chain:0xSafe</code>, a Safe{Wallet} link, or one address followed by chains.</small>
      </label>
      <label><span>Change</span>
        <textarea rows="8" spellcheck="false" placeholder=${'swap 0xOldOwner… newowner.eth\nadd 0x…   remove 0x…   threshold 4\n0xToken… transfer(address,uint256) 0xTo… 1000000\nself 0x<calldata, may contain {self}>'} .value=${live(S.actions)} @input=${(e: any) => { S.actions = e.target.value; edited() }}></textarea>
        <small>Owner changes (<code>swap</code>, <code>add</code>, <code>remove</code>, <code>threshold</code>) are worked out per Safe. Other lines are calls; <code>self</code> means each Safe. Transaction Builder JSON works too.</small>
      </label>
    </div>
    <div class="row">
      <input class="grow" placeholder="Or copy a queued transaction: paste its Safe{Wallet} link" .value=${live(S.importRef)} @input=${(e: any) => { S.importRef = e.target.value; update() }} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && importTx()}>
      <button @click=${importTx} ?disabled=${!S.importRef.trim()}>Import</button>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" .checked=${S.afterQueue} @change=${(e: any) => { S.afterQueue = e.target.checked; edited() }}> Queue after transactions already pending</label>
      <span class="grow"></span>
      <button class="primary" @click=${prepare} ?disabled=${S.preparing}>${S.preparing ? 'Preparing…' : 'Prepare'}</button>
    </div>
    ${S.errors.length ? html`<div class="errors">${S.errors.map(e => html`<div>${e}</div>`)}</div>` : nothing}
  </section>

  ${S.prepared.length ? html`
  <section class="card">
    <div class="summary">
      <span class="good">✓ ${ready.length} ready</span>
      ${applied.length ? html` · <span class="muted">${applied.length} already applied</span>` : nothing}
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
          <td class="ico-cell">${k === 'ready' ? html`<span class="ico done">✓</span>` : k === 'applied' ? html`<span class="ico done quiet">✓</span>` : k === 'attention' ? html`<span class="ico warn">!</span>` : html`<span class="ico now"></span>`}</td>
          <td>${chainChip(p.chainId)}</td>
          <td>${addr(p.safe, labels)}</td>
          <td>${p.tx?.nonce ?? p.state?.nonce ?? ''}</td>
          <td>${p.state ? (p.owners && p.threshold !== undefined && (p.owners.length !== p.state.owners.length || p.threshold !== p.state.threshold) ? `${fmt([p.state.threshold, p.state.owners.length])} → ${fmt([p.threshold, p.owners.length])}` : fmt([p.state.threshold, p.state.owners.length])) : ''}</td>
          <td class="small">
            ${p.error ? html`<span class="bad">${p.error}</span>` : p.skip ? html`<span class="muted">${p.skip}</span>` : nothing}
            ${p.sim && !p.sim.ok && !p.sim.definite ? html`<span class="warn">${p.sim.error}</span>` : nothing}
            ${p.notes.join('; ')}
          </td>
        </tr>`
      })}</tbody>
    </table></div>
    <div class="row">
      <span class="grow muted small">The link covers the ${plural(ready.length, 'ready Safe')}. Gas and refund fields are zero: whoever executes pays gas.</span>
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
  const busy = S.signing || S.executing
  const bar = html`<div class="bar"><i style=${`width:${yours.length ? Math.round((signed / yours.length) * 100) : 0}%`}></i></div>`
  const cur = S.current
  return html`
  ${!S.account ? html`<div class="row">
      <button class="primary" @click=${() => connect()}>Connect wallet</button>
      ${S.choosing ? S.wallets.map(w => html`<button @click=${() => connect(w)}><img src=${w.info.icon} alt="">${w.info.name}</button>`) : nothing}
      <span class="muted grow">Connect the wallet you sign with to see which Safes need you.</span>
    </div>`
  : S.signing ? html`<div class="row"><b class="grow">Signing ${Math.min(signed + 1, yours.length)} of ${yours.length}</b><button @click=${() => { S.signing = false; update() }}>Pause</button></div>
      ${bar}
      ${cur ? html`<div class="current">
        <div><b>${chainName(cur.tx.chainId)}</b> · ${addr(cur.tx.safe)} · nonce ${cur.tx.nonce} · <span class="muted">${cur.phase ?? ''}</span></div>
        <div class="hashes"><span class="muted">safeTxHash</span><span class="mono">${cur.hash}</span></div>
        <div class="hashes"><span class="muted">domain hash</span><span class="mono">${domainHash(cur.tx)}</span></div>
        <div class="hashes"><span class="muted">message hash</span><span class="mono">${messageHash(cur.tx)}</span></div>
      </div>` : nothing}`
  : remaining ? html`<div class="row">
      <span class="grow">${addr(S.account)} · you've signed <b>${signed}</b> of ${yours.length}${loading ? html` <span class="muted">(still loading)</span>` : nothing}</span>
      <button class="primary" @click=${signAll} ?disabled=${busy}>Sign remaining ${remaining}</button>
    </div>${bar}`
  : yours.length ? html`<div class="done-msg">✓ You've signed all ${yours.length}. Nothing else is needed from you.</div>${bar}`
  : html`<div class="muted">${loading ? 'Checking which Safes need your signature…' : html`${addr(S.account)} has nothing to sign: it isn't an owner here, or every Safe already has enough signatures.`}</div>`}
  <div class="row small">
    <span class="grow muted">Executed <b>${executed}</b> of ${S.rows.length}${ready ? html` · <b class="good">${ready} ready to execute</b> (anyone can, and pays gas)` : nothing}</span>
    ${S.account && ready && !busy ? html`<button @click=${executeAll}>Execute ${ready}</button>` : nothing}
    ${S.executing ? html`<button @click=${() => { S.executing = false; update() }}>Stop</button>` : nothing}
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
      return html`<tr class=${`click ${r === S.current ? 'active' : ''}`} @click=${() => { r.open = !r.open; update() }}>
        <td class="ico-cell">${icon(r, st.kind)}</td>
        <td>${chainChip(r.tx.chainId)}</td>
        <td>${addr(r.tx.safe)}</td>
        <td class="muted nowrap">nonce ${r.tx.nonce}</td>
        <td class="grow-cell">
          <span class=${KIND_CLASS[st.kind]}>${r === S.current && r.phase ? r.phase : st.text}</span>
          ${r.svc === 'none' ? html` <span class="tag" title="No Safe Transaction Service on this chain: share signatures with a bundle">manual</span>` : nothing}
          ${r.error && st.kind !== 'unknown' ? html`<div class="small bad">${r.error}</div>` : nothing}
        </td>
        <td class="muted">${r.open ? '▾' : '▸'}</td>
      </tr>
      ${r.open ? html`<tr class="details"><td></td><td colspan="5">
        <div class="kv">
          <span>to</span><span class="mono">${r.tx.to}</span>
          <span>value</span><span class="mono">${r.tx.value}</span>
          <span>operation</span><span>${r.tx.operation === 1 ? 'DELEGATECALL (1)' : 'CALL (0)'}</span>
          <span>data</span><span class="mono wrap">${r.tx.data}</span>
          <span>gas and refund</span><span class="mono">all zero</span>
          <span>safeTxHash</span><span class="mono">${r.hash}</span>
          <span>domain hash</span><span class="mono">${domainHash(r.tx)}</span>
          <span>message hash</span><span class="mono">${messageHash(r.tx)}</span>
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
      <textarea class="grow" rows="2" placeholder="Paste one or more fanout-sigs:… bundles" .value=${live(S.pasted)} @input=${(e: any) => { S.pasted = e.target.value; update() }}></textarea>
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
      if (!S.settingsErrors.length) { store.set('fanout:settings', S.settings); S.settingsOpen = false; if (S.mode === 'batch') refresh() }
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
    <a class="brand" href=${location.pathname + location.search} @click=${(e: Event) => { if (S.mode === 'batch') { e.preventDefault(); history.pushState(null, '', location.pathname + location.search); S.mode = 'compose'; update() } }}>Fanout</a>
    <span class="muted small grow">one change, many Safes, one signing pass</span>
    <button class="ghost" @click=${() => { S.settingsOpen = true; update() }}>Settings</button>
  </header>
  <main>${S.mode === 'batch' ? batchView() : composeView()}</main>
  ${S.settingsOpen ? settingsView() : nothing}`
}

function route() {
  const h = location.hash.slice(1)
  if (h) openBatch(h)
  else { S.mode = 'compose'; update() }
}
window.addEventListener('hashchange', route)
// Signatures are kept in localStorage and re-uploaded on the next visit; only warn mid-session.
window.addEventListener('beforeunload', e => { if (S.signing || S.executing) e.preventDefault() })
route()
