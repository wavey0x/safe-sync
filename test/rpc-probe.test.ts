import { expect, test } from 'bun:test'
import { probe } from '../scripts/rpc-probe'

function endpoint(status: number, allowHeaders: string, origin = '*') {
  const methods: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      methods.push(req.method)
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': allowHeaders }
      if (req.method === 'OPTIONS') return new Response(null, { status, headers })
      const { method } = await req.json()
      const result = method === 'eth_chainId' ? { result: '0x1' } : method === 'eth_blockNumber' ? { result: '0x123' } : { error: { code: 3, data: '0x01' } }
      return Response.json({ jsonrpc: '2.0', id: 1, ...result }, { headers })
    },
  })
  return { server, methods }
}

test.each([
  { status: 403, headers: 'content-type', origin: '*' },
  { status: 204, headers: '', origin: '*' },
  { status: 204, headers: 'x-custom-header', origin: '*' },
  { status: 204, headers: 'content-type', origin: 'https://another-site.example' },
])('RPC probe rejects invalid preflight %j before sending JSON', async ({ status, headers, origin }) => {
  const e = endpoint(status, headers, origin)
  try {
    await expect(probe(e.server.url.toString(), 1)).rejects.toThrow('preflight refused')
    expect(e.methods).toEqual(['OPTIONS'])
  } finally { e.server.stop(true) }
})

test.each([' Content-Type , X-Custom-Header ', '*'])('RPC probe accepts permitted JSON headers: %s', async headers => {
  const e = endpoint(204, headers)
  try {
    expect((await probe(e.server.url.toString(), 1)).revert).toBe(true)
    expect(e.methods).toEqual(['OPTIONS', 'POST', 'POST', 'POST'])
  } finally { e.server.stop(true) }
})
