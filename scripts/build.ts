// Builds dist/safe-sync.html: one self-contained file (no CDN, no server), so anyone can
// host it anywhere and signers can check its sha256 against the published one.
// Usage: bun scripts/build.ts [--serve]
import { createHash } from 'node:crypto'

const root = decodeURIComponent(new URL('..', import.meta.url).pathname)
const out = await Bun.build({ entrypoints: [`${root}src/app.ts`], minify: true, target: 'browser' })
if (!out.success) throw new AggregateError(out.logs, 'build failed')
const js = (await out.outputs[0].text()).replaceAll('</script', '<\\/script')
const css = await Bun.file(`${root}src/style.css`).text()
const html = (await Bun.file(`${root}src/index.html`).text()).replace('/*CSS*/', () => css).replace('/*JS*/', () => js)
await Bun.write(`${root}dist/safe-sync.html`, html)
console.log(`dist/safe-sync.html  ${(html.length / 1024).toFixed(0)} KB  sha256 ${createHash('sha256').update(html).digest('hex')}`)

if (process.argv.includes('--serve')) {
  const server = Bun.serve({ port: Number(process.env.PORT ?? 5173), fetch: () => new Response(Bun.file(`${root}dist/safe-sync.html`), { headers: { 'content-type': 'text/html' } }) })
  console.log(`serving on http://localhost:${server.port}`)
}
