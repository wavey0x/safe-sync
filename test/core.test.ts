import { expect, test } from 'bun:test'
import { getAddress, hashTypedData, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  batchId, buildCalls, decodeBatch, describe, encodeBatch, linesFromTx, normalizeSig, packMultiSend, packSigs, parseActions,
  parseTargets, payloadKey, safeTxHash, sigOwner, unpackMultiSend, walletTypedData, type Tx,
} from '../src/safe'

// Real proposal queued in Safe{Wallet} (Transaction Builder) on 2026-10-25 for the plan's rotation example.
const ORIGINAL = '0x467947EE34aF926cF1DCac093870f613C96B1E0c' as Address
const OWNERS = ['0xe9A65fe8190fA5A4b5E277b84f0aAce686FDc174', '0x7A1057E6e9093DA9C1D4C1D049609B6889fC4c67', '0x2b47C57A4c9Fc1649B43500f4c0cDa6cF29be278', '0xDAa094A0Ed166FeDF8a0a4310f3F74a1e96F9195', '0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3', '0xAF17517aCD484429fC0da2312fd1f42039592cd0', '0xc6f3aAc21d8282f166938a8B30a9Ec62De30aCcC', '0xAAc0aa431c237C2C0B5f041c8e59B3f1a43aC78F', '0x8a7dbC2824AcaC4d272289a33b255C3F1f3cdf32'] as Address[]
const DATA = '0x8d80ff0a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000017200467947ee34af926cf1dcac093870f613c96b1e0c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064e318b52b000000000000000000000000daa094a0ed166fedf8a0a4310f3f74a1e96f919500000000000000000000000099bc02c239025e431d5741cc1dba8ce77fc51ce3000000000000000000000000bd0a74e51729a4d0b92742e67183c4cbc97bca9200467947ee34af926cf1dcac093870f613c96b1e0c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064e318b52b0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000e9a65fe8190fa5a4b5e277b84f0aace686fdc1740000000000000000000000004046b37ffc36b0c723d7fc64e0c763b698d819340000000000000000000000000000' as Hex
const EXAMPLE: Tx = { chainId: 1, safe: ORIGINAL, nonce: 13, to: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', value: '0', data: DATA, operation: 1 }
const NAMES = { 'winthorpe.eth': '0xBd0a74e51729a4D0B92742e67183C4cBc97bCA92' as Address }

test('reproduces the Safe{Wallet} proposal for the rotation example byte for byte', () => {
  const { actions } = parseActions('swap 0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3 winthorpe.eth\n0xe9A65fe8190fA5A4b5E277b84f0aAce686FDc174 -> 0x4046B37Ffc36B0C723d7Fc64e0C763B698D81934')
  const b = buildCalls(actions, ORIGINAL, { version: '1.3.0', owners: OWNERS, threshold: 5, nonce: 13 }, NAMES)
  expect(packMultiSend(b.calls)).toBe(DATA)
  expect(safeTxHash(EXAMPLE)).toBe('0x50e58d6df4e9e82b1d7adfdaed834632841a4bab3ed6a44dd8b8e7089c01029d')
  expect(b.owners[4]).toBe(NAMES['winthorpe.eth'])
  expect(b.owners[0]).toBe(getAddress('0x4046B37Ffc36B0C723d7Fc64e0C763B698D81934'))
  expect(b.threshold).toBe(5)
})

test('wallet typed-data payload hashes to the same safeTxHash and recovers the signer', async () => {
  const p = JSON.parse(walletTypedData(EXAMPLE))
  const { EIP712Domain, ...types } = p.types
  expect(hashTypedData({ domain: p.domain, types, primaryType: 'SafeTx', message: p.message })).toBe(safeTxHash(EXAMPLE))
  const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const sig = await acct.signTypedData({ domain: p.domain, types, primaryType: 'SafeTx', message: p.message })
  expect(await sigOwner(safeTxHash(EXAMPLE), sig)).toBe(acct.address)
  // v = 0/1 (some hardware paths) is normalised to 27/28
  const low = (sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0')) as Hex
  expect(normalizeSig(low)).toBe(sig)
  // eth_sign style (v + 4) and approved-hash (v = 1) signatures are recognised too
  const ethSign = await acct.signMessage({ message: { raw: safeTxHash(EXAMPLE) } })
  expect(await sigOwner(safeTxHash(EXAMPLE), (ethSign.slice(0, -2) + (parseInt(ethSign.slice(-2), 16) + 4).toString(16)) as Hex)).toBe(acct.address)
  expect(await sigOwner(safeTxHash(EXAMPLE), `0x${acct.address.slice(2).padStart(64, '0')}${'0'.repeat(64)}01`)).toBe(acct.address)
})

test('prevOwner follows the owner list as it changes', () => {
  const [a, b, c, d, e] = ['0xa', '0xb', '0xc', '0xd', '0xe'].map(x => getAddress(x.padEnd(42, '1')))
  const state = { version: '1.3.0', owners: [a, b, c], threshold: 2, nonce: 0 }
  // swap the first owner, then the one right after it: the second swap's prevOwner is the *new* first owner
  const r = buildCalls(parseActions(`swap ${a} ${d}\nswap ${b} ${e}\nremove ${c}\nthreshold 1`).actions, a, state, {})
  expect(r.owners).toEqual([d, e])
  expect(r.threshold).toBe(1)
  const steps = describe({ safe: a, to: a, value: '0', data: packMultiSend(r.calls), operation: 1 } as any)
  expect(r.calls.length).toBe(4)
  expect(steps.map(s => s.op)).toEqual([1]) // `to` is not a known MultiSend, so it is shown as one opaque DELEGATECALL
  const unpacked = unpackMultiSend(packMultiSend(r.calls))
  expect(unpacked.map(u => u.data.slice(0, 10))).toEqual(['0xe318b52b', '0xe318b52b', '0xf8dc5dd9', '0x694e80c3'])
  expect(unpacked[1].data).toContain(d.slice(2).toLowerCase()) // prevOwner of b is now d
  // removing with threshold 2 of 2 remaining lowers the threshold so the call cannot revert
  expect(buildCalls(parseActions(`remove ${c}`).actions, a, { ...state, threshold: 3 }, {}).threshold).toBe(2)
})

test('already-applied changes are skipped, impossible ones fail', () => {
  const [a, b, d] = ['0xa', '0xb', '0xd'].map(x => getAddress(x.padEnd(42, '1')))
  const state = { version: '1.3.0', owners: [d, b], threshold: 1, nonce: 0 }
  const r = buildCalls(parseActions(`swap ${a} ${d}`).actions, a, state, {})
  expect(r.calls.length).toBe(0)
  expect(r.notes[0]).toContain('already done')
  expect(() => buildCalls(parseActions(`swap ${a} 0x${'2'.repeat(40)}`).actions, a, state, {})).toThrow('not an owner')
  expect(() => buildCalls(parseActions('threshold 3').actions, a, state, {})).toThrow('invalid')
})

test('targets: pairs, Safe{Wallet} links and one address on many chains', () => {
  const s = '0x6d447e544D01a59cb0774763bf15526574CffFeD'
  const r = parseTargets(`${s} eth arb1, 10 base   # comment\nhttps://app.safe.global/home?safe=gno:${s}\neth:${s}\nnope:${s}`)
  expect(r.targets.map(t => t.chainId)).toEqual([1, 42161, 10, 8453, 100])
  expect(r.errors.length).toBe(1)
})

test('calls: signatures with args, value, self and raw calldata with {self}', () => {
  const safe = '0x6d447e544D01a59cb0774763bf15526574CffFeD' as Address
  const { actions, errors } = parseActions(`0x${'1'.repeat(40)} value=1.5ether transfer(address,uint256) self 1000\nself 0xabcd{self}\n0x${'2'.repeat(40)} setOwners(address[]) [self,0x${'3'.repeat(40)}]`)
  expect(errors).toEqual([])
  const { calls } = buildCalls(actions, safe, { version: '1.3.0', owners: [], threshold: 1, nonce: 0 }, {})
  expect(calls[0].value).toBe(1500000000000000000n)
  expect(calls[0].data).toContain(safe.slice(2).toLowerCase())
  expect(calls[1]).toEqual({ to: safe, value: 0n, data: `0xabcd${safe.slice(2).toLowerCase()}` })
  expect(calls[2].data).toContain('3'.repeat(40))
  expect(parseActions('0xnope transfer(address) x').errors.length).toBe(1)
})

test('importing a source Safe tx turns its own address into self', () => {
  const lines = linesFromTx({ safe: ORIGINAL, to: EXAMPLE.to, value: '0', data: DATA, operation: 1 })
  expect(lines.split('\n')).toHaveLength(2)
  expect(lines.startsWith('self 0xe318b52b')).toBe(true)
  const { calls } = buildCalls(parseActions(lines).actions, ORIGINAL, { version: '1.3.0', owners: OWNERS, threshold: 5, nonce: 13 }, {})
  expect(packMultiSend(calls)).toBe(DATA)
})

test('batch link round-trips and stores identical payloads once', async () => {
  const other = { ...EXAMPLE, safe: '0x6d447e544D01a59cb0774763bf15526574CffFeD' as Address, nonce: 0 }
  other.data = DATA.replaceAll(ORIGINAL.slice(2).toLowerCase(), other.safe.slice(2).toLowerCase()) as Hex
  const txs = [EXAMPLE, ...[10, 56, 100, 137, 8453, 42161].map(chainId => ({ ...other, chainId }))]
  const batch = { title: 'Rotate', created: 1, txs, labels: { [NAMES['winthorpe.eth'].toLowerCase()]: 'winthorpe.eth' }, src: { targets: 't', actions: 'a' } }
  const s = await encodeBatch(batch)
  expect(s.length).toBeLessThan(800)
  const back = await decodeBatch(s)
  expect(back).toEqual(batch)
  expect(batchId(back)).toBe(batchId(batch))
  expect(new Set(txs.map(payloadKey)).size).toBe(1)
  await expect(decodeBatch(s.slice(0, -10))).rejects.toThrow()
})

test('signatures are packed in ascending owner order, threshold only', () => {
  const sigs = ['0x3', '0x1', '0x2'].map(o => ({ owner: getAddress(o.padEnd(42, '0')), sig: `0x${o.slice(2).repeat(130)}` as Hex }))
  expect(packSigs(sigs, 2)).toBe(`0x${'1'.repeat(130)}${'2'.repeat(130)}`)
})
