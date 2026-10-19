const config = JSON.parse(document.getElementById('og-config').textContent)
const canvas = document.getElementById('og-canvas')
const bytes = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()) }
async function boot() {
  const manifest = new TextDecoder().decode(await bytes('./cooked/.cook.ogt'))
  const blobs = [...manifest.matchAll(/file "([^"]+)"/g)].map(m => m[1])
  for (const file of blobs) await bytes('./cooked/' + file)
  const host = await import('./origin-engine.js')
  await host.default(await bytes('./origin-engine_bg.wasm'))
  const worker = new Worker('./game.js', { type: 'module' })
  const tiles = await new Promise(resolve => { worker.onmessage = e => resolve(e.data.tiles); worker.postMessage({ blobs: blobs.length }) })
  const ctx = canvas.getContext('2d')
  const draw = () => {
    canvas.width = innerWidth; canvas.height = innerHeight
    const size = Math.min(canvas.width, canvas.height) / 8
    tiles.forEach((t, i) => { ctx.fillStyle = ['#e9c46a', '#2a9d8f', '#e76f51', '#8ecae6'][t]; ctx.fillRect((i % 8) * size + 2, Math.floor(i / 8) * size + 2, size - 4, size - 4) })
  }
  draw()
  addEventListener('resize', draw)
  performance.mark('og:first-frame')
}
boot().catch(error => { document.title = 'Tile Swap (failed)'; console.error('og: start failed', error) })
if (config.serviceWorker && 'serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {})
