// The README's screenshots: a Safe whose owners drifted apart across chains, brought back in sync.
// Runs the sandbox, drifts a few chains, then walks the app in headless Chrome and writes docs/*.png,
// each in light and dark. `bun run screenshots` builds first; CHROME=/path/to/chrome if it isn't in /Applications.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalletClient, http, type Address } from 'viem'
import { decodeBatch, execData, normalizeSig, parseActions, prepareTarget, safeTxHash, walletTypedData, type Tx } from '../src/safe'
import * as svc from '../src/service'
import { ACCOUNTS, INCOMING, OWNERS, startSandbox } from '../test/sandbox'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname)
const sb = await startSandbox({ rps: 1000 })
const team = sb.team
svc.config.service = sb.settings.service; svc.config.gapMs = 0
sb.service.txs.clear() // no queued transactions: this story is only about owners

const sign = async (tx: Tx, o: (typeof OWNERS)[number]) => {
  const p = JSON.parse(walletTypedData(tx)); delete p.types.EIP712Domain
  return { owner: o.address, sig: normalizeSig(await o.signTypedData(p)) }
}
const signers = OWNERS.slice(3, 8) // never rotated out, on any chain
async function drift(chainId: number, actions: string) {
  const tx = (await prepareTarget({ chainId, safe: team }, parseActions(actions).actions, {})).tx!
  const w = createWalletClient({ account: ACCOUNTS[0], transport: http(sb.rpc[chainId]) })
  await w.sendTransaction({ to: team, data: execData(tx, await Promise.all(signers.map(o => sign(tx, o))), 5), chain: null })
}
// The sandbox already finished the rotation on Linea. Elsewhere it's half done, or something else changed.
await drift(8453, `swap ${OWNERS[2].address} ${INCOMING[0].address}`)
await drift(56, `remove ${OWNERS[0].address}`)
await drift(42161, 'threshold 4')
await drift(5000, `add ${ACCOUNTS[12].address}`)

const target = OWNERS.map(o => o.address).map(a => (a === OWNERS[2].address ? INCOMING[0].address : a === OWNERS[0].address ? INCOMING[1].address : a))
const draft = (owners: { from: Address; to: Address }[]) => ({ mode: 'owners', source: '', excluded: [], nonces: {}, safes: [team], threshold: 5, startedFrom: `1:${team}`, owners })
const cfg = {
  runId: String(Date.now()), rpcs: sb.rpc, settings: sb.settings, walletOnly: true, fast: true, link: '',
  accounts: ACCOUNTS.map(a => ({ address: a.address, label: a.address })),
  draft: draft(OWNERS.map(o => ({ from: o.address, to: target[OWNERS.indexOf(o)] }))),
}
// The sandbox wallet's box stays in the page (it picks the account) but out of the picture.
const hide = '<style>html { padding-bottom: 0 !important } html > div:not(.tip) { display: none !important }</style>'
const server = Bun.serve({
  port: 0,
  async fetch() {
    const boot = `window.__SANDBOX__=${JSON.stringify(cfg)};\n${await Bun.file(`${root}test/sandbox-wallet.js`).text()}`
    const html = (await Bun.file(`${root}dist/safe-sync.html`).text()).replace('<head>', () => `<head><script>${boot}</script>${hide}`)
    return new Response(html, { headers: { 'content-type': 'text/html' } })
  },
})
const app = `http://localhost:${server.port}/`

// Headless Chrome over the DevTools protocol.
const profile = mkdtempSync(join(tmpdir(), 'safe-sync-shots-'))
const chrome = Bun.spawn([process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
let port = ''
for (let i = 0; !port; i++) {
  port = await Bun.file(`${profile}/DevToolsActivePort`).text().then(t => t.split('\n')[0], () => '')
  if (i > 100) throw new Error("Chrome didn't start")
  if (!port) await Bun.sleep(100)
}
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t: any) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => (ws.onopen = r))
const pending = new Map<number, (m: any) => void>()
let seq = 0
ws.onmessage = e => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id) }
const cdp = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
  pending.set(++seq, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
  ws.send(JSON.stringify({ id: seq, method, params }))
})
const js = async (body: string) => {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function until(cond: string, what: string) {
  for (let i = 0; i < 300; i++) { if (await js(`return !!(${cond})`)) return; await Bun.sleep(100) }
  throw new Error(`Timed out waiting for ${what}. The page says:\n${await js(`return document.body.innerText.slice(0, 1500)`)}`)
}
const click = (text: string) => js(`const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('No button ' + ${JSON.stringify(text)}); b.click()`)
// Through a blank page, so going to the same link again loads it again (a hash alone wouldn't).
const go = async (url: string) => {
  await cdp('Page.navigate', { url: 'about:blank' }); await cdp('Page.navigate', { url })
  await until(`document.readyState === 'complete' && document.querySelector('main')`, url)
}
const as = (a: Address) => js(`const s = document.querySelector('html > div select'); s.value = ${JSON.stringify(a)}; s.dispatchEvent(new Event('change'))`)

/** The page from the top of the first `from` element to the bottom of the last `to` element, in both themes. */
async function shot(name: string, from: string, to = from) {
  await Bun.sleep(300) // let tooltips and transitions settle
  const edge = (sel: string, side: 'top' | 'bottom', pick: 'min' | 'max') =>
    js(`return Math.${pick}(...[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.getBoundingClientRect().${side} + scrollY))`)
  const top = Math.max(0, (await edge(from, 'top', 'min')) - 12), bottom = (await edge(to, 'bottom', 'max')) + 12
  for (const theme of ['light', 'dark']) {
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await Bun.sleep(150)
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: top, width: 800, height: Math.ceil(bottom - top), scale: 1 } })
    await Bun.write(`${root}docs/${name}-${theme}.png`, Buffer.from(data, 'base64'))
  }
  console.log(`docs/${name}-{light,dark}.png`)
}
/** Hovers an element, which shows its tooltip. */
async function hover(sel: string, text: string) {
  const [x, y] = await js(`const r = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.includes(${JSON.stringify(text)})).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]`)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

try {
  await cdp('Page.enable'); await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 1000, deviceScaleFactor: 2, mobile: false })

  // 1. The Safe, found on every chain; amber where its owners differ.
  await go(app)
  await until(`document.querySelectorAll('.chips .pick').length >= 14 && !document.querySelector('.busy')`, 'the Safe on every chain')
  await hover('.pick', 'base')
  await shot('1-drift', 'main > .card, .tip.on', 'main > .card')

  // 2. The owners every chain should end up with.
  await click('Continue')
  await until(`document.querySelector('.owners')`, 'the owner editor')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
  await shot('2-target', 'main > .card')

  // 3. What each Safe needs to get there.
  await click('Review')
  await until(`/ready to sign/.test(document.querySelector('main').innerText) && !document.querySelector('main .spin')`, 'the review')
  await shot('3-review', 'main > .card', '.change')

  // 4. The signing link, three signatures in, as an owner who hasn't signed yet.
  await js(`navigator.clipboard.writeText = async t => { window.__link = t }`)
  await click('Copy signing link')
  await until(`window.__link`, 'the signing link')
  const link: string = await js(`return window.__link`)
  const txs = (await decodeBatch(link.split('#')[1])).txs
  const post = (o: (typeof OWNERS)[number], first: boolean) => Promise.all(txs.map(async tx => {
    const s = await sign(tx, o)
    await svc.submit(tx, safeTxHash(tx), s.owner, s.sig, !first)
  }))
  await post(OWNERS[3], true); await post(OWNERS[4], false); await post(OWNERS[6], false)
  await go(link)
  await click('Connect wallet'); await as(OWNERS[5].address)
  await until(`[...document.querySelectorAll('button')].some(b => /^Sign \\d/.test(b.textContent.trim())) && document.querySelectorAll('.count').length === ${txs.length} && !document.querySelector('.spin')`, 'the signing page')
  await shot('4-sign', '.card.sticky', 'main > .card:last-child')

  // Enough signatures: anyone executes.
  await post(OWNERS[5], false); await post(OWNERS[7], false)
  await go(link)
  await until(`[...document.querySelectorAll('button')].some(b => /^Execute \\d/.test(b.textContent.trim()))`, 'Execute')
  await click('Execute')
  await until(`/Executed ${txs.length} of ${txs.length}/.test(document.body.innerText)`, 'every execution')

  // 5. Afterwards: the same Safe, the same owners everywhere.
  await js(`localStorage.setItem('safesync:draft', ${JSON.stringify(JSON.stringify(draft(target.map(a => ({ from: a, to: a })))))})`)
  await go(app)
  await until(`document.querySelectorAll('.chips .pick').length >= 14 && !document.querySelector('.busy')`, 'the Safe on every chain')
  await hover('.pick', 'base')
  await shot('5-synced', 'main > .card, .tip.on', 'main > .card')
} finally {
  ws.close(); chrome.kill(); server.stop(true); sb.stop()
  rmSync(profile, { recursive: true, force: true })
}
