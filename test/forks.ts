// Starts anvil forks of Ethereum and Arbitrum and deploys the same fresh 2-of-3 Safe 1.3.0
// on both (same factory, initializer and salt => same address). Shared by the fork test and
// the browser end-to-end run:  bun test/forks.ts
import { createWalletClient, encodeFunctionData, http, parseAbi, publicActions, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const
export const ACCOUNTS = KEYS.map(k => privateKeyToAccount(k))

const FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' // SafeProxyFactory 1.3.0
const SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' // SafeL2 1.3.0
const HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' // CompatibilityFallbackHandler 1.3.0
const abi = parseAbi([
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)',
])

export type Fork = { chainId: number; rpc: string; proc: ReturnType<typeof Bun.spawn> }

export async function startForks(base = 8645): Promise<{ forks: Fork[]; safe: Address; stop: () => void }> {
  const sources = [[1, process.env.ETHEREUM_RPC_URL], [42161, process.env.ARBITRUM_RPC_URL]] as const
  if (sources.some(([, u]) => !u)) throw new Error('ETHEREUM_RPC_URL and ARBITRUM_RPC_URL are required')
  const forks = sources.map(([chainId, url], i): Fork => ({
    chainId, rpc: `http://127.0.0.1:${base + i}`,
    proc: Bun.spawn(['anvil', '--fork-url', url!, '--port', String(base + i), '--silent'], { stdout: 'ignore', stderr: 'ignore' }),
  }))
  const stop = () => forks.forEach(f => f.proc.kill())
  try {
    let safe: Address | undefined
    for (const f of forks) {
      for (let i = 0; ; i++) {
        try { await fetch(f.rpc, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', headers: { 'content-type': 'application/json' } }); break }
        catch { if (i > 100) throw new Error('anvil did not start'); await Bun.sleep(200) }
      }
      const w = createWalletClient({ account: ACCOUNTS[0], transport: http(f.rpc) }).extend(publicActions)
      const init = encodeFunctionData({ abi, functionName: 'setup', args: [ACCOUNTS.slice(0, 3).map(a => a.address), 2n, '0x0000000000000000000000000000000000000000', '0x', HANDLER, '0x0000000000000000000000000000000000000000', 0n, '0x0000000000000000000000000000000000000000'] })
      const args = [SINGLETON, init, 20261025n] as const
      const { result } = await w.simulateContract({ address: FACTORY, abi, functionName: 'createProxyWithNonce', args })
      await w.waitForTransactionReceipt({ hash: await w.writeContract({ address: FACTORY, abi, functionName: 'createProxyWithNonce', args, chain: null }) })
      if (safe && safe !== result) throw new Error('Safe addresses differ across forks')
      safe = result
    }
    return { forks, safe: safe!, stop }
  } catch (e) { stop(); throw e }
}

if (import.meta.main) {
  const { forks, safe } = await startForks()
  console.log(`Safe ${safe} (owners ${ACCOUNTS.slice(0, 3).map(a => a.address).join(', ')}; threshold 2)`)
  for (const f of forks) console.log(`chain ${f.chainId}: ${f.rpc}`)
  console.log('Ctrl-C to stop')
}
