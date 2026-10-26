// Where the app is served. A JSON POST needs an accepted preflight and permission for content-type.
const ORIGIN = 'https://safe-sync.wavey.info'
const allows = (res: Response) => ['*', ORIGIN].includes(res.headers.get('access-control-allow-origin') ?? '')

export async function probe(url: string, id: number): Promise<{ ms: number; revert: boolean }> {
  const t0 = performance.now()
  const pre = await fetch(url, {
    method: 'OPTIONS', signal: AbortSignal.timeout(4000),
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  })
  const headers = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(h => h.trim())
  if (!pre.ok || !allows(pre) || !headers.some(h => h === '*' || h === 'content-type')) throw new Error('preflight refused')
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok || !allows(res)) throw new Error('RPC request failed or CORS refused')
    return res.json()
  }
  // A reverting eth_call too: simulation needs the revert data back.
  const [chain, block, revert] = await Promise.all([call('eth_chainId', []), call('eth_blockNumber', []), call('eth_call', [{ data: '0x60016000526001601ffd' }, 'latest'])])
  if (Number(chain.result) !== id || !block.result) throw new Error('bad')
  // Non-EVM-equivalent chains (zkSync) cannot run init code in eth_call; accept them, but rank lower.
  return { ms: performance.now() - t0, revert: JSON.stringify(revert.error ?? '').includes('"0x01"') }
}
