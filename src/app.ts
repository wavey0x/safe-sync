// UI. Two screens: compose (proposer) and batch (everyone, opened from the link).
// All state lives in the link, the Safe Transaction Service, the chain, and localStorage.
import { html, nothing, render, type TemplateResult } from 'lit-html'
import { live } from 'lit-html/directives/live.js'
import { isAddress, toHex, type Address, type Hex } from 'viem'
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
type Row = {
  tx: Tx; hash: Hex; key: string; sigs: Record<string, Sig>
  owners?: Address[]; threshold?: number; chainNonce?: number
  proposed: boolean; svcExecuted?: boolean; svc: 'loading' | 'ok' | 'none' | 'error'
  phase?: string; error?: string; fatal?: string; execHash?: Hex; open?: boolean
  loaded?: Promise<void>; posting?: Promise<void>
}
type Wallet = { info: { name: string; icon: string; rdns: string }; provider: any }

const store = {
  get: <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
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
const update = () => { if (!queued) queued = true, queueMicrotask(() => { queued = false; render(view(), document.body) }) }
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

async function prepare() {
  const t = parseTargets(S.targets), a = parseActions(S.actions)
  S.errors = [...t.errors, ...a.errors]
  if (!t.targets.length) S.errors.push('Add at least one Safe.')
  if (!a.actions.length) S.errors.push('Add at least one action.')
  S.prepared = []; S.link = ''
  if (S.errors.length) return update()
  S.preparing = true; update()
  try {
    S.names = await resolveNames(a.actions)
    S.prepared = t.targets.map(x => ({ ...x, notes: [] }))
    update()
    await Promise.all(t.targets.map(async (x, i) => {
      const p = await prepareTarget(x, a.actions, S.names, S.afterQueue ? queueEnd : undefined)
      S.prepared[i] = p; update()
      if (p.tx && svc.serviceUrl(p.chainId)) {
        try {
          const q = await svc.queued(p.chainId, p.safe, p.tx.nonce)
          if (q.some(o => o.safeTxHash === p.hash)) p.notes.push('already queued in Safe{Wallet}: its signatures count')
          else if (q.some(o => o.nonce === p.tx!.nonce)) p.notes.push(`⚠ another transaction is queued at nonce ${p.tx.nonce}`)
        } catch (e) { p.notes.push(`queue check failed: ${msg(e)}`) }
        update()
      }
    }))
  } catch (e) { S.errors.push(msg(e)) }
  S.preparing = false; update()
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
    S.importRef = ''; S.errors = []; saveDraft()
  } catch (e) { S.errors = [msg(e)] }
  update()
}

async function createLink() {
  const ok = S.prepared.filter(p => p.tx && !p.error && !p.skip)
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  const batch: Batch = { title: S.title.trim() || 'Untitled batch', created: Date.now(), txs: ok.map(p => p.tx!), labels, src: { targets: S.targets, actions: S.actions } }
  S.link = `${location.href.split('#')[0]}#${await encodeBatch(batch)}`
  copy(S.link)
  update()
}

// ---------------------------------------------------------------- batch

const sigKey = () => `fanout:sigs:${S.id}`
function saveSigs() {
  store.set(sigKey(), Object.fromEntries(S.rows.map(r => [r.hash, r.sigs])))
}

async function openBatch(encoded: string) {
  try {
    const batch = await decodeBatch(encoded)
    S.batch = batch; S.id = batchId(batch); S.mode = 'batch'; S.loadError = ''
    const saved = store.get<Record<string, Record<string, Sig>>>(`fanout:sigs:${S.id}`, {})
    S.rows = batch.txs.map(tx => { const hash = safeTxHash(tx); return { tx, hash, key: payloadKey(tx), sigs: saved[hash] ?? {}, proposed: false, svc: 'loading' } })
    S.rows.forEach(r => (r.loaded = loadRow(r)))
  } catch (e) { S.loadError = `This link is not a valid batch: ${msg(e)}`; S.mode = 'batch' }
  update()
}

async function loadRow(r: Row) {
  const { chainId, safe } = r.tx
  try {
    const [st, h] = await Promise.all([readSafe(chainId, safe), onchainHash(r.tx)])
    if (h !== r.hash) r.fatal = `Hash mismatch: the Safe computes ${h}`
    r.owners = st.owners; r.threshold = st.threshold; r.chainNonce = st.nonce
  } catch (e) { r.error = `RPC: ${msg(e)}` }
  update()
  if (svc.serviceUrl(chainId)) {
    try {
      const t = await svc.getTx(chainId, r.hash)
      r.proposed = !!t; r.svcExecuted = t?.isExecuted
      // The service is the truth: a local signature counts as posted only if the service has it
      // (a proposal can be deleted in Safe{Wallet}; a post can fail after the device signed).
      for (const [k, s] of Object.entries(r.sigs)) s.posted = !!t?.confirmations.some(c => c.owner.toLowerCase() === k)
      for (const c of t?.confirmations ?? []) r.sigs[c.owner.toLowerCase()] = { owner: c.owner, sig: c.signature, posted: true }
      r.svc = 'ok'
    } catch (e) { r.svc = 'error'; r.error = msg(e) }
  } else r.svc = 'none'
  // Drop anything that does not verify (corrupt storage, bad paste, contract signatures).
  for (const [k, s] of Object.entries(r.sigs)) if ((await sigOwner(r.hash, s.sig).catch(() => undefined))?.toLowerCase() !== k) delete r.sigs[k]
  saveSigs(); update()
  // Outbox: anything signed here but not yet on the service is (re)posted.
  if (r.svc === 'ok' && !status(r).done) for (const s of Object.values(r.sigs)) if (!s.posted) post(r, s)
}

function post(r: Row, s: Sig) {
  r.posting = (r.posting ?? Promise.resolve()).then(async () => {
    try {
      await svc.submit(r.tx, r.hash, s.owner, s.sig, r.proposed)
      s.posted = true; r.proposed = true; r.error = undefined; saveSigs()
    } catch (e) { r.error = `Saved here, not yet on Safe service (retries on reload): ${msg(e)}` }
    update()
  })
}

const isOwner = (r: Row, a?: Address | null) => !!a && !!r.owners?.some(o => o.toLowerCase() === a.toLowerCase())
const validSigs = (r: Row) => Object.values(r.sigs).filter(s => isOwner(r, s.owner))
function status(r: Row): { text: string; cls: string; ready?: boolean; done?: boolean } {
  if (r.fatal) return { text: r.fatal, cls: 'bad', done: true }
  if (r.chainNonce === undefined) return { text: r.error ?? 'loading…', cls: r.error ? 'bad' : 'muted' }
  if (r.chainNonce > r.tx.nonce) {
    if (r.svcExecuted || r.execHash) return { text: 'executed', cls: 'good', done: true }
    if (r.svc === 'loading') return { text: 'nonce used, checking…', cls: 'muted', done: true }
    return { text: r.svc === 'none' ? 'nonce used (executed?)' : 'nonce used by another transaction', cls: r.svc === 'none' ? 'good' : 'bad', done: true }
  }
  if (r.execHash) return { text: 'executing…', cls: 'muted' }
  const n = validSigs(r).length, t = r.threshold!
  if (n >= t && r.chainNonce === r.tx.nonce) return { text: 'ready to execute', cls: 'good', ready: true }
  if (n >= t) return { text: `signed; waits for nonce ${r.chainNonce}`, cls: 'muted' }
  return { text: `${n}/${t} signatures`, cls: '' }
}
const mine = (r: Row) => !!S.account && !!r.sigs[S.account.toLowerCase()]
const canSign = (r: Row) => isOwner(r, S.account) && !mine(r) && !status(r).done

// ---------------------------------------------------------------- wallet

window.addEventListener('eip6963:announceProvider', (e: any) => { if (!S.wallets.some(w => w.info.rdns === e.detail.info.rdns)) S.wallets.push(e.detail); update() })
window.dispatchEvent(new Event('eip6963:requestProvider'))

async function connect(w?: Wallet) {
  const provider = w?.provider ?? (S.wallets.length === 1 ? S.wallets[0].provider : S.wallets.length ? null : (window as any).ethereum)
  if (!provider) { S.choosing = S.wallets.length > 1; S.notice = S.wallets.length ? '' : 'No browser wallet found.'; return update() }
  S.choosing = false
  try {
    const [account] = await provider.request({ method: 'eth_requestAccounts' })
    S.provider = provider; S.account = account
    provider.on?.('accountsChanged', (a: Address[]) => { S.account = a[0] ?? null; if (S.signing) S.signing = false, S.notice = 'Account changed: stopped.'; update() })
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
  S.signing = true; S.notice = ''; update()
  for (const r of S.rows) {
    if (!S.signing) break
    await r.loaded
    if (!canSign(r)) continue
    S.current = r
    try {
      // Fresh nonce check right before involving the wallet: skip anything executed meanwhile.
      if (Number(await client(r.tx.chainId).readContract({ address: r.tx.safe, abi: SAFE_ABI, functionName: 'nonce' })) > r.tx.nonce) {
        r.chainNonce = r.tx.nonce + 1; continue
      }
      r.phase = 'switching chain'; update()
      await ensureChain(r.tx.chainId)
      r.phase = 'confirm in wallet'; update()
      const account = S.account!
      const sig = normalizeSig(await S.provider.request({ method: 'eth_signTypedData_v4', params: [account, walletTypedData(r.tx)] }))
      if ((await sigOwner(r.hash, sig))?.toLowerCase() !== account.toLowerCase()) throw new Error('Wallet returned a signature for a different account or message')
      const s = { owner: account, sig, posted: false }
      r.sigs[account.toLowerCase()] = s; r.error = undefined; saveSigs()
      if (r.svc === 'ok' || (r.svc === 'error' && svc.serviceUrl(r.tx.chainId))) post(r, s)
    } catch (e) {
      if (rejected(e)) { S.signing = false; S.notice = 'Paused: request rejected in wallet.' }
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  S.signing = false; S.current = null; update()
}

async function executeAll() {
  S.executing = true; S.notice = ''; update()
  for (const r of S.rows) {
    if (!S.executing) break
    if (!status(r).ready) continue
    S.current = r
    try {
      r.phase = 'switching chain'; update()
      await ensureChain(r.tx.chainId)
      const c = client(r.tx.chainId), account = S.account!
      const data = execData(r.tx, validSigs(r), r.threshold!)
      r.phase = 'simulating'; update()
      try { await c.call({ account, to: r.tx.safe, data }) } catch (e) {
        const d = revertData(e); throw new Error(`Execution would fail: ${d ? revertReason(d) : msg(e)}`)
      }
      const gas = await c.estimateGas({ account, to: r.tx.safe, data })
      r.phase = 'confirm in wallet'; update()
      r.execHash = await S.provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: r.tx.safe, data, gas: toHex((gas * 13n) / 10n) }] })
      c.waitForTransactionReceipt({ hash: r.execHash! }).then(rc => {
        if (rc.status === 'success') r.chainNonce = r.tx.nonce + 1, r.svcExecuted = true
        else r.error = 'Execution reverted', r.execHash = undefined
        update()
      }, e => { r.error = msg(e); update() })
    } catch (e) {
      if (rejected(e)) { S.executing = false; S.notice = 'Paused: request rejected in wallet.' }
      else r.error = msg(e)
    } finally { r.phase = undefined; update() }
  }
  S.executing = false; S.current = null; update()
}

// Chains without a Safe Transaction Service: signatures travel as a pasted bundle.
function exportSigs(): string {
  const entries = S.rows.filter(r => r.svc === 'none').flatMap(r => Object.values(r.sigs).map(s => [r.hash, s.sig]))
  return `fanout-sigs:${btoa(JSON.stringify(entries))}`
}
async function importSigs() {
  let added = 0
  try {
    for (const m of S.pasted.matchAll(/fanout-sigs:([A-Za-z0-9+/=]+)/g)) {
      for (const [hash, sig] of JSON.parse(atob(m[1])) as [Hex, Hex][]) {
        const r = S.rows.find(r => r.hash === hash)
        const owner = r && (await sigOwner(hash, sig).catch(() => undefined))
        if (r && owner && isOwner(r, owner) && !r.sigs[owner.toLowerCase()]) r.sigs[owner.toLowerCase()] = { owner, sig, posted: r.svc !== 'ok' }, added++
      }
    }
    S.notice = `Added ${added} signature${added === 1 ? '' : 's'}.`; S.pasted = ''; saveSigs()
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
  S.prepared = []; S.link = ''; saveDraft()
  history.pushState(null, '', location.pathname + location.search)
  S.mode = 'compose'; update()
}

// ---------------------------------------------------------------- view

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => { S.notice = 'Copied.'; update(); setTimeout(() => { if (S.notice === 'Copied.') S.notice = '', update() }, 1500) }, () => {})
}
const addr = (a: string, labels: Record<string, string> = S.batch?.labels ?? {}) =>
  html`<span class="mono" title=${a}>${short(a)}</span>${labels[a.toLowerCase()] ? html` <span class="label">${labels[a.toLowerCase()]}</span>` : nothing}`
const chainChip = (id: number) => html`<span class="chip" title=${chainName(id)}>${chainOf(id)?.short ?? id}</span>`
const safeLink = (tx: { chainId: number; safe: string }, hash?: string) => {
  const c = chainOf(tx.chainId)
  if (c?.service) return `https://app.safe.global/${hash ? `transactions/tx?safe=${c.short}:${tx.safe}&id=multisig_${tx.safe}_${hash}` : `home?safe=${c.short}:${tx.safe}`}`
  return c?.explorer ? `${c.explorer}/address/${tx.safe}` : undefined
}

function steps(list: Step[], labels: Record<string, string>) {
  return html`<ol class="steps">${list.map(s => html`<li>
    <b>${s.target === 'self' ? 'this Safe' : addr(s.target, labels)}</b> · <span class="fn">${s.fn}</span>
    ${s.op === 1 ? html`<span class="warn"> DELEGATECALL</span>` : nothing}
    ${s.value ? html` · value ${s.value.toString()} wei` : nothing}
    ${s.args.length ? html`<div class="args">${s.args.map(([k, v]) => html`<div><span class="muted">${k}</span> ${isAddress(v) ? addr(v, labels) : v === 'this Safe' ? html`<b>this Safe</b>` : html`<span class="mono wrap">${v}</span>`}</div>`)}</div>` : nothing}
    ${s.raw ? html`<div class="mono small wrap">${s.raw}</div>` : nothing}
  </li>`)}</ol>`
}

function groups(txs: Tx[], labels: Record<string, string>) {
  const g = new Map<string, Tx[]>()
  for (const tx of txs) g.set(payloadKey(tx), [...(g.get(payloadKey(tx)) ?? []), tx])
  return html`${[...g.values()].map(list => html`<div class="group">
    <div class="group-head">${g.size === 1 ? html`<b>Same actions on all ${list.length} Safe${list.length > 1 ? 's' : ''}</b>` : html`<b>${list.length} Safe${list.length > 1 ? 's' : ''}:</b>`}
      ${list.map(t => chainChip(t.chainId))}</div>
    ${steps(describe(list[0]), labels)}
    ${list[0].operation === 1 ? html`<div class="muted small">via MultiSendCallOnly ${short(list[0].to)} (delegatecall), so the inner calls run as this Safe</div>` : nothing}
  </div>`)}`
}

function composeView() {
  const ok = S.prepared.filter(p => p.tx && !p.error && !p.skip)
  const excluded = S.prepared.filter(p => p.error || p.skip)
  const labels = Object.fromEntries(Object.entries(S.names).map(([n, a]) => [a.toLowerCase(), n]))
  return html`
  <section class="card">
    <input class="title" placeholder="Batch title, e.g. Rotate signers Q4" .value=${live(S.title)} @input=${(e: any) => { S.title = e.target.value; saveDraft() }}>
    <div class="cols">
      <label><span>Safes</span>
        <textarea rows="9" spellcheck="false" placeholder=${'0xSafe… eth arb1 base oeth 252\neth:0xOtherSafe…\nhttps://app.safe.global/home?safe=gno:0x…'} .value=${live(S.targets)} @input=${(e: any) => { S.targets = e.target.value; saveDraft() }}></textarea>
        <small>One per line: <code>chain:0xSafe</code>, a Safe{Wallet} link, or one address followed by chains. Chains by short name or ID.</small>
      </label>
      <label><span>Actions</span>
        <textarea rows="9" spellcheck="false" placeholder=${'swap 0xOldOwner… newowner.eth\nadd 0x…   remove 0x…   threshold 4\n0xToken… transfer(address,uint256) 0xTo… 1000000\nself 0x<calldata, may contain {self}>'} .value=${live(S.actions)} @input=${(e: any) => { S.actions = e.target.value; saveDraft() }}></textarea>
        <small><code>swap</code>/<code>add</code>/<code>remove</code>/<code>threshold</code> are worked out per Safe (owner order differs). Other lines are calls; <code>self</code> means each target Safe. Or paste a Transaction Builder JSON.</small>
      </label>
    </div>
    <div class="row">
      <input class="grow" placeholder="Copy a queued Safe tx: paste its Safe{Wallet} link" .value=${live(S.importRef)} @input=${(e: any) => { S.importRef = e.target.value; update() }} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && importTx()}>
      <button @click=${importTx} ?disabled=${!S.importRef.trim()}>Import</button>
    </div>
    <div class="row">
      <label class="check"><input type="checkbox" .checked=${S.afterQueue} @change=${(e: any) => (S.afterQueue = e.target.checked)}> Queue after transactions already pending</label>
      <span class="grow"></span>
      <button class="primary" @click=${prepare} ?disabled=${S.preparing}>${S.preparing ? 'Preparing…' : 'Prepare'}</button>
    </div>
    ${S.errors.length ? html`<div class="errors">${S.errors.map(e => html`<div>${e}</div>`)}</div>` : nothing}
  </section>

  ${S.prepared.length ? html`
  <section class="card">
    <div class="summary">
      <b>${ok.length}</b> ready · ${new Set(ok.map(p => p.chainId)).size} chains
      ${excluded.length ? html` · <span class="bad">${excluded.length} excluded</span>` : nothing}
      ${S.prepared.some(p => !p.state && !p.error) ? html` · <span class="muted">reading…</span>` : nothing}
    </div>
    ${Object.keys(S.names).length ? html`<div class="muted small">Resolved on Ethereum: ${Object.entries(S.names).map(([n, a]) => html`${n} → <span class="mono">${a}</span> `)}</div>` : nothing}
    ${ok.length ? groups(ok.map(p => p.tx!), labels) : nothing}
    <div class="scroll"><table>
      <thead><tr><th>Chain</th><th>Safe</th><th>Ver</th><th>Nonce</th><th>Owners</th><th>Simulation</th><th>Notes</th></tr></thead>
      <tbody>${S.prepared.map(p => html`<tr class=${p.error ? 'err' : p.skip ? 'skip' : ''}>
        <td>${chainChip(p.chainId)}</td>
        <td>${addr(p.safe)}</td>
        <td>${p.state?.version ?? ''}</td>
        <td>${p.tx?.nonce ?? p.state?.nonce ?? ''}</td>
        <td>${p.state ? html`${p.state.threshold}/${p.state.owners.length}${p.owners && (p.owners.length !== p.state.owners.length || p.threshold !== p.state.threshold) ? html` → ${p.threshold}/${p.owners.length}` : nothing}` : ''}</td>
        <td>${p.sim ? (p.sim.ok ? html`<span class="good">✓ ${p.sim.gas.toString()} gas</span>` : html`<span class=${p.sim.definite ? 'bad' : 'warn'}>${p.sim.error}</span>`) : p.error ? '' : html`<span class="muted">…</span>`}</td>
        <td class="small">${p.error ? html`<span class="bad">${p.error}</span>` : p.skip ? html`<span class="muted">${p.skip}</span>` : nothing} ${p.notes.join('; ')}</td>
      </tr>`)}</tbody>
    </table></div>
    <div class="row">
      <span class="grow muted small">Gas and refund fields are zero: whoever executes pays gas.</span>
      <button class="primary" @click=${createLink} ?disabled=${S.preparing || !ok.length}>Create signing link</button>
    </div>
    ${S.link ? html`<div class="linkbox">
      <input readonly .value=${live(S.link)} @focus=${(e: any) => e.target.select()}>
      <button @click=${() => copy(S.link)}>Copy</button>
      <a class="button primary" href=${S.link}>Open to sign</a>
      <div class="muted small">${S.link.length} characters. Share it in your team chat; the link holds the whole batch and nothing is stored on a server.</div>
    </div>` : nothing}
  </section>` : nothing}`
}

function batchView() {
  if (S.loadError) return html`<section class="card"><div class="errors">${S.loadError}</div><button @click=${() => { location.hash = ''; S.mode = 'compose'; update() }}>New batch</button></section>`
  const b = S.batch!
  const toSign = S.rows.filter(canSign).length
  const ready = S.rows.filter(r => status(r).ready).length
  const done = S.rows.filter(r => status(r).done).length
  const offService = S.rows.filter(r => r.svc === 'none')
  const busy = S.signing || S.executing
  return html`
  <section class="card">
    <div class="row">
      <h2 class="grow">${b.title}</h2>
      <span class="fingerprint" title="Fingerprint of every safeTxHash in this batch. Confirm it with the proposer.">${S.id}</span>
    </div>
    <div class="muted small">${S.rows.length} Safes · ${new Set(S.rows.map(r => r.tx.chainId)).size} chains · created ${new Date(b.created).toLocaleString()}
      · <a href="#" @click=${(e: Event) => { e.preventDefault(); copy(location.href) }}>copy link</a> · <a href="#" @click=${(e: Event) => { e.preventDefault(); edit() }}>edit as new batch</a></div>
    ${groups(b.txs, b.labels)}
  </section>

  <section class="card sticky">
    <div class="row">
      ${S.account ? html`<span>${addr(S.account)}</span>` : html`<button class="primary" @click=${() => connect()}>Connect wallet</button>`}
      ${S.choosing ? S.wallets.map(w => html`<button @click=${() => connect(w)}><img src=${w.info.icon} alt="">${w.info.name}</button>`) : nothing}
      <span class="grow small">
        ${S.account ? html`<b>${toSign}</b> to sign · ` : nothing}<b>${ready}</b> ready to execute · <b>${done}</b>/${S.rows.length} done
      </span>
      ${S.account && !busy ? html`<button class="primary" @click=${signAll} ?disabled=${!toSign}>Sign ${toSign || ''}</button>` : nothing}
      ${S.account && !busy && ready ? html`<button @click=${executeAll}>Execute ${ready}</button>` : nothing}
      ${busy ? html`<button @click=${() => { S.signing = S.executing = false; update() }}>Pause</button>` : nothing}
      <button @click=${refresh} ?disabled=${busy} title="Re-read chain and Safe service">↻</button>
    </div>
    ${S.current ? html`<div class="current">
      <div><b>${chainName(S.current.tx.chainId)}</b> · ${addr(S.current.tx.safe)} · nonce ${S.current.tx.nonce} · <span class="muted">${S.current.phase ?? ''}</span>
        <span class="muted">(${S.rows.indexOf(S.current) + 1} of ${S.rows.length})</span></div>
      <div class="hashes"><span class="muted">safeTxHash</span> <span class="mono">${S.current.hash}</span></div>
      <div class="hashes"><span class="muted">domain hash</span> <span class="mono">${domainHash(S.current.tx)}</span></div>
      <div class="hashes"><span class="muted">message hash</span> <span class="mono">${messageHash(S.current.tx)}</span></div>
    </div>` : nothing}
    ${S.notice ? html`<div class="notice">${S.notice}</div>` : nothing}
  </section>

  <section class="card">
    <div class="scroll"><table>
      <thead><tr><th>Chain</th><th>Safe</th><th>Nonce</th><th>Status</th><th>You</th><th>safeTxHash</th></tr></thead>
      <tbody>${S.rows.map(r => {
        const st = status(r)
        const you = !S.account ? '' : r.phase ? r.phase : mine(r) ? (r.sigs[S.account.toLowerCase()].posted || r.svc !== 'ok' ? 'signed ✓' : 'signed, posting…') : r.owners ? (isOwner(r, S.account) ? (st.done ? '' : 'to sign') : 'not an owner') : ''
        const link = safeLink(r.tx, r.proposed ? r.hash : undefined)
        return html`<tr class=${r === S.current ? 'active' : ''}>
          <td>${chainChip(r.tx.chainId)}</td>
          <td>${link ? html`<a href=${link} target="_blank" rel="noopener">${addr(r.tx.safe)}</a>` : addr(r.tx.safe)}</td>
          <td>${r.tx.nonce}${r.chainNonce !== undefined && r.chainNonce < r.tx.nonce ? html` <span class="muted small">(next ${r.chainNonce})</span>` : nothing}</td>
          <td><span class=${st.cls}>${st.text}</span>${r.svc === 'none' ? html` <span class="muted small" title="No Safe Transaction Service on this chain: share signatures with the bundle below">offline</span>` : nothing}
            ${r.error && r.chainNonce !== undefined ? html`<div class="bad small">${r.error}</div>` : nothing}
            ${r.execHash ? html`<div class="small"><a target="_blank" rel="noopener" href=${`${chainOf(r.tx.chainId)?.explorer}/tx/${r.execHash}`}>execution tx</a></div>` : nothing}</td>
          <td class="small">${you}</td>
          <td><a href="#" class="mono" @click=${(e: Event) => { e.preventDefault(); r.open = !r.open; update() }}>${short(r.hash, 14)}</a></td>
        </tr>
        ${r.open ? html`<tr class="details"><td colspan="6">
          <div class="kv">
            <span>to</span><span class="mono">${r.tx.to}</span>
            <span>value</span><span class="mono">${r.tx.value}</span>
            <span>operation</span><span>${r.tx.operation === 1 ? 'DELEGATECALL (1)' : 'CALL (0)'}</span>
            <span>data</span><span class="mono wrap">${r.tx.data}</span>
            <span>safeTxGas, baseGas, gasPrice</span><span class="mono">0, 0, 0</span>
            <span>gasToken, refundReceiver</span><span class="mono">0x0000…0000</span>
            <span>domain hash</span><span class="mono">${domainHash(r.tx)}</span>
            <span>message hash</span><span class="mono">${messageHash(r.tx)}</span>
            <span>safeTxHash</span><span class="mono">${r.hash}</span>
            <span>signers</span><span class="mono small">${validSigs(r).map(s => html`<div>${addr(s.owner)}${s.posted ? '' : ' (not posted)'}</div>`)}</span>
          </div>
        </td></tr>` : nothing}`
      })}</tbody>
    </table></div>
  </section>

  ${offService.length ? html`<section class="card">
    <h3>Chains without a Safe Transaction Service</h3>
    <p class="muted small">${offService.map(r => chainChip(r.tx.chainId))} — signatures for these stay in this browser. Share yours as a bundle; whoever executes pastes everyone's bundles.</p>
    <div class="row">
      <button @click=${() => copy(exportSigs())} ?disabled=${!offService.some(r => Object.keys(r.sigs).length)}>Copy signature bundle</button>
      <textarea class="grow" rows="2" placeholder="Paste one or more fanout-sigs:… bundles" .value=${live(S.pasted)} @input=${(e: any) => { S.pasted = e.target.value; update() }}></textarea>
      <button @click=${importSigs} ?disabled=${!S.pasted.trim()}>Add</button>
    </div>
  </section>` : nothing}`
}

function settingsView() {
  const set = (k: 'rpc' | 'service' | 'apiKey') => (e: any) => (S.settings[k] = e.target.value)
  return html`<div class="modal" @click=${(e: Event) => e.target === e.currentTarget && ((S.settingsOpen = false), update())}><section class="card">
    <h3>Settings</h3>
    <label><span>RPC overrides</span><textarea rows="4" spellcheck="false" placeholder="1 https://my-node.example\narb1 https://…" .value=${live(S.settings.rpc)} @input=${set('rpc')}></textarea>
      <small>One <code>chain url</code> per line. Also adds chains that are not listed below.</small></label>
    <label><span>Safe Transaction Service overrides</span><textarea rows="2" spellcheck="false" placeholder="167000 https://safe-transaction.example.xyz" .value=${live(S.settings.service)} @input=${set('service')}></textarea>
      <small>For chains with a community-run service.</small></label>
    <label><span>Safe API key (optional)</span><input .value=${live(S.settings.apiKey)} @input=${set('apiKey')} placeholder="Raises the rate limit from 2 to 5 requests/second">
      <small>Stored only in this browser.</small></label>
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

// ---------------------------------------------------------------- boot

function route() {
  const h = location.hash.slice(1)
  if (h) openBatch(h)
  else { S.mode = 'compose'; update() }
}
window.addEventListener('hashchange', route)
// Signatures are kept in localStorage and re-posted on the next visit; only warn mid-session.
window.addEventListener('beforeunload', e => { if (S.signing || S.executing) e.preventDefault() })
route()
