// Injected by `bun run sandbox` only (never part of dist/safe-sync.html): seeds the app's settings and draft
// for the local chains, and adds an EIP-6963 wallet that signs with the local test accounts.
// In the full sandbox (real chain ids) it also hides other wallets: a real wallet would send executions
// to the real networks. The simple sandbox uses local-only chain ids, so real wallets are fine there.
// It behaves like MetaMask where it matters: lowercase accounts, chainId must match for typed data,
// one confirmation per request (with a short delay), and rejections (code 4001).
;(() => {
  const cfg = window.__SANDBOX__
  if (localStorage.getItem('safesync:sandbox-run') !== cfg.runId) {
    for (const k of Object.keys(localStorage)) if (k.startsWith('safesync:')) localStorage.removeItem(k)
    localStorage.setItem('safesync:settings', JSON.stringify(cfg.settings))
    localStorage.setItem('safesync:draft', JSON.stringify(cfg.draft))
    localStorage.setItem('safesync:sandbox-run', cfg.runId)
  }

  let chain = 1, account = cfg.accounts[1].address, rejectNext = false
  const listeners = {}
  const emit = (event, value) => (listeners[event] || []).forEach(f => f(value))
  const fail = (message, code) => Object.assign(new Error(message), { code })
  const confirm = () => new Promise((resolve, reject) => setTimeout(() => {
    if (rejectNext) { rejectNext = false; box.querySelector('input').checked = false; reject(fail('User rejected the request.', 4001)) } else resolve()
  }, 700))
  const rpc = async (method, params) => {
    const res = await fetch(cfg.rpcs[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const j = await res.json()
    if (j.error) throw fail(j.error.message, j.error.code)
    return j.result
  }

  const provider = {
    async request({ method, params = [] }) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [account.toLowerCase()]
        case 'eth_chainId': return '0x' + chain.toString(16)
        case 'wallet_switchEthereumChain': {
          const id = parseInt(params[0].chainId, 16)
          if (!cfg.rpcs[id]) throw fail(`Unrecognized chain ID ${params[0].chainId}`, 4902)
          chain = id; emit('chainChanged', params[0].chainId); return null
        }
        case 'wallet_addEthereumChain': return null
        case 'eth_signTypedData_v4': {
          const data = JSON.parse(params[1])
          if (Number(data.domain.chainId) !== chain) throw fail(`Provided chainId "${data.domain.chainId}" must match the active chainId "${chain}"`, -32602)
          await confirm()
          return rpc(method, [account, params[1]])
        }
        case 'eth_sendTransaction': await confirm(); return rpc(method, [{ ...params[0], from: account }])
        default: return rpc(method, params)
      }
    },
    on(event, f) { (listeners[event] = listeners[event] || []).push(f) },
    removeListener(event, f) { listeners[event] = (listeners[event] || []).filter(g => g !== f) },
  }

  const info = { uuid: '00000000-0000-4000-8000-000000000000', name: 'Sandbox wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 1 1%22%3E%3Crect width=%221%22 height=%221%22 fill=%22%23f0b45a%22/%3E%3C/svg%3E', rdns: 'local.safesync.sandbox' }
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  // Capture runs before the app's listener, so other wallets' announcements never reach it.
  if (cfg.walletOnly) window.addEventListener('eip6963:announceProvider', e => { if (e.detail?.info?.rdns !== info.rdns) e.stopImmediatePropagation() }, true)
  announce()

  const box = document.createElement('div')
  // Bottom-left: the app keeps its main buttons on the right.
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99;background:#f0b45a;color:#1b1300;border-radius:10px;padding:8px 12px;font:13px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 24px)'
  box.innerHTML = '<b>Sandbox wallet</b><label style="display:flex;gap:6px;align-items:center">Signing as <select></select></label>'
    + '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" style="width:auto"> Reject next request</label>'
  const select = box.querySelector('select')
  for (const a of cfg.accounts) select.add(new Option(`${a.label} · ${a.address.slice(0, 6)}…${a.address.slice(-4)}`, a.address))
  select.value = account
  select.onchange = () => { account = select.value; emit('accountsChanged', [account.toLowerCase()]) }
  box.querySelector('input').onchange = e => (rejectNext = e.target.checked)
  // Outside <body>, which the app renders into, with room below the page so it never covers the app's buttons.
  addEventListener('DOMContentLoaded', () => {
    document.documentElement.appendChild(box)
    const room = () => (document.documentElement.style.paddingBottom = box.offsetHeight + 24 + 'px')
    room(); addEventListener('resize', room)
  })
})()
