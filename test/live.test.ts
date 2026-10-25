// Needs network access and ETHEREUM_RPC_URL; skipped otherwise.
import { expect, test } from 'bun:test'
import { config, parseActions, resolveNames } from '../src/safe'

test.skipIf(!process.env.ETHEREUM_RPC_URL)('ENS names resolve on Ethereum', async () => {
  config.rpc[1] = process.env.ETHEREUM_RPC_URL!
  const names = await resolveNames(parseActions('swap 0x99BC02c239025E431D5741cC1DbA8CE77fc51CE3 winthorpe.eth').actions)
  expect(names['winthorpe.eth']).toBe('0xBd0a74e51729a4D0B92742e67183C4cBc97bCA92')
}, 30_000)
