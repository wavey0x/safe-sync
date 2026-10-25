// Full lifecycle on anvil forks: prepare → link → sign (two owners) → Safe service → execute.
// Needs anvil plus ETHEREUM_RPC_URL and ARBITRUM_RPC_URL; skipped otherwise.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createWalletClient, http, publicActions, type Address } from 'viem'
import {
  batchId, config, decodeBatch, encodeBatch, execData, normalizeSig, parseActions, parseTargets, payloadKey, prepareTarget,
  readSafe, resolveNames, safeTxHash, sigOwner, walletTypedData, type Tx,
} from '../src/safe'
import * as svc from '../src/service'
import { ACCOUNTS, startForks } from './forks'
import { startMockService } from './mock-service'

const enabled = !!(process.env.ETHEREUM_RPC_URL && process.env.ARBITRUM_RPC_URL && Bun.which('anvil'))
let env: Awaited<ReturnType<typeof startForks>>, service: ReturnType<typeof startMockService>

beforeAll(async () => {
  if (!enabled) return
  env = await startForks(8745)
  service = startMockService()
  for (const f of env.forks) config.rpc[f.chainId] = f.rpc, svc.config.service[f.chainId] = service.url(f.chainId)
}, 60_000)
afterAll(() => { env?.stop(); service?.stop() })

test.skipIf(!enabled)('rotate an owner and add one on two chains, end to end', async () => {
  const [a0, a1, a2, a3] = ACCOUNTS
  const NEW = '0x000000000000000000000000000000000000dEaD' as Address
  const targets = parseTargets(`${env.safe} eth arb1`)
  const actions = parseActions(`swap ${a2.address} ${a3.address}\nadd ${NEW}`)
  expect([...targets.errors, ...actions.errors]).toEqual([])

  // Proposer: prepare and share
  const prepared = await Promise.all(targets.targets.map(t => prepareTarget(t, actions.actions, {})))
  for (const p of prepared) {
    expect(p.error).toBeUndefined()
    expect(p.sim?.ok).toBe(true)
    expect(p.owners).toEqual([NEW, a0.address, a1.address, a3.address])
  }
  expect(new Set(prepared.map(p => payloadKey(p.tx!))).size).toBe(1)
  const link = await encodeBatch({ title: 'test', created: Date.now(), txs: prepared.map(p => p.tx!), labels: {}, src: { targets: '', actions: '' } })

  // Signers: open the link, sign every transaction, post to the service
  const batch = await decodeBatch(link)
  expect(batchId(batch)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/)
  for (const [i, signer] of [a0, a1].entries()) {
    for (const tx of batch.txs) {
      const hash = safeTxHash(tx)
      const p = JSON.parse(walletTypedData(tx))
      delete p.types.EIP712Domain
      const sig = normalizeSig(await signer.signTypedData(p))
      expect(await sigOwner(hash, sig)).toBe(signer.address)
      const before = await svc.getTx(tx.chainId, hash)
      expect(!!before).toBe(i > 0) // first signer proposes, second confirms
      await svc.submit(tx, hash, signer.address, sig, !!before)
    }
  }
  // A second submit of the same signature, or one that guesses "proposed" wrongly, still lands.
  const t0 = batch.txs[0], h0 = safeTxHash(t0)
  const again = (await svc.getTx(t0.chainId, h0))!.confirmations[0]
  await svc.submit(t0, h0, again.owner, again.signature, false)

  // Executor: anyone with gas
  for (const tx of batch.txs) {
    const s = (await svc.getTx(tx.chainId, safeTxHash(tx)))!
    expect(s.confirmations.length).toBe(2)
    const fork = env.forks.find(f => f.chainId === tx.chainId)!
    const w = createWalletClient({ account: a3, transport: http(fork.rpc) }).extend(publicActions)
    const data = execData(tx, s.confirmations.map(c => ({ owner: c.owner, sig: c.signature })), 2)
    const rc = await w.waitForTransactionReceipt({ hash: await w.sendTransaction({ to: tx.safe, data, chain: null }) })
    expect(rc.status).toBe('success')
    const after = await readSafe(tx.chainId, tx.safe)
    expect(after.owners).toEqual([NEW, a0.address, a1.address, a3.address])
    expect(after.nonce).toBe(1)
  }

  // Re-running the same batch is a no-op rather than a failing transaction.
  const rerun = await prepareTarget(targets.targets[0], actions.actions, {})
  expect(rerun.skip).toBe('Nothing to do')
}, 120_000)

test.skipIf(!enabled)('a reverting payload is caught before anyone signs', async () => {
  const p = await prepareTarget({ chainId: 1, safe: env.safe }, parseActions(`self removeOwner(address,address,uint256) 0x0000000000000000000000000000000000000001 ${ACCOUNTS[3].address} 9`).actions, {})
  expect(p.error).toContain('GS')
}, 60_000)

test('ENS names resolve on Ethereum (live)', async () => {
  if (!process.env.ETHEREUM_RPC_URL) return
  config.rpc[1] ??= process.env.ETHEREUM_RPC_URL
  const names = await resolveNames(parseActions('swap 0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3 winthorpe.eth').actions)
  expect(names['winthorpe.eth']).toBe('0xBd0a74e51729a4D0B92742e67183C4cBc97bCA92')
}, 30_000)
