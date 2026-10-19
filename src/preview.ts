import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'

/**
 * The local preview: the folder served the way OriginGame serves a release
 * (under a deep path, so a path starting with `/` breaks here as it would on
 * the platform; `origingame.runtime.json` honoured), opened in a headless
 * Chrome or Chromium when one is installed. What it reports is what a person
 * would see go wrong: console errors, uncaught exceptions, failed requests,
 * whether anything was drawn.
 */

const BASE = '/play/preview/release/'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.data': 'application/octet-stream',
}

interface Runtime { precompressed: boolean; crossOriginIsolated: boolean }

function runtimeOf(dir: string): Runtime {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'origingame.runtime.json'), 'utf8'))
    return { precompressed: value?.precompressed === true, crossOriginIsolated: value?.crossOriginIsolated === true }
  } catch {
    return { precompressed: false, crossOriginIsolated: false }
  }
}

export async function serve(dir: string): Promise<{ url: string; close: () => Promise<void>; misses: string[] }> {
  const runtime = runtimeOf(dir)
  const misses: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) } catch { pathname = url.pathname }
    // Browsers ask for /favicon.ico by themselves; the Player never does.
    if (pathname === '/favicon.ico') { res.writeHead(404).end(); return }
    if (!pathname.startsWith(BASE)) {
      misses.push(`${pathname} (outside the release folder: a path that starts with / does not work on OriginGame)`)
      res.writeHead(404).end('outside the release')
      return
    }
    let relative = pathname.slice(BASE.length)
    if (!relative || relative.endsWith('/')) relative += 'index.html'
    const file = path.join(dir, relative)
    if (path.relative(dir, file).startsWith('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      misses.push(`${relative} (not in the folder)`)
      res.writeHead(404).end('not found')
      return
    }
    let ext = path.extname(file).toLowerCase()
    const headers: Record<string, string> = { 'cache-control': 'no-store' }
    if (runtime.precompressed && (ext === '.br' || ext === '.gz')) {
      headers['content-encoding'] = ext === '.br' ? 'br' : 'gzip'
      ext = path.extname(file.slice(0, -ext.length)).toLowerCase()
    }
    headers['content-type'] = TYPES[ext] ?? 'application/octet-stream'
    if (runtime.crossOriginIsolated) {
      headers['cross-origin-opener-policy'] = 'same-origin'
      headers['cross-origin-embedder-policy'] = 'require-corp'
    }
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}${BASE}`,
    misses,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

/** A Chrome, Chromium or Edge on this machine: `CHROME_PATH`, else the usual places. */
export function findBrowser(): string | null {
  const candidates = [process.env.CHROME_PATH ?? '']
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue
      candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'), path.join(base, 'Chromium/Application/chrome.exe'))
    }
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome']) candidates.push(path.join(dir, name))
    }
    const agentBrowser = path.join(os.homedir(), '.agent-browser', 'browsers')
    if (fs.existsSync(agentBrowser)) for (const d of fs.readdirSync(agentBrowser).sort().reverse()) candidates.push(path.join(agentBrowser, d, 'chrome'))
    const playwright = path.join(os.homedir(), '.cache', 'ms-playwright')
    if (fs.existsSync(playwright)) for (const d of fs.readdirSync(playwright).sort().reverse()) candidates.push(path.join(playwright, d, 'chrome-linux', 'chrome'), path.join(playwright, d, 'chrome-linux64', 'chrome'))
  }
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) return c } catch { /* next */ }
  }
  return null
}

type Cdp = { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>; on: (fn: (msg: any) => void) => void; close: () => void }

async function connect(url: string): Promise<Cdp> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WS) throw new Error('this Node.js has no WebSocket (Node 22 or newer has it)')
  const ws = new WS(url)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('could not connect to the browser')) })
  let id = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const listeners: Array<(msg: any) => void> = []
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data))
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
    } else for (const l of listeners) l(msg)
  }
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
    }),
    on: fn => { listeners.push(fn) },
    close: () => { try { ws.close() } catch { /* closed */ } },
  }
}

function launch(browser: string, profile: string): Promise<{ child: ChildProcess; endpoint: string }> {
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,720', '--mute-audio', 'about:blank']
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox')
  const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  return new Promise((resolve, reject) => {
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the browser did not start within 20 s')) }, 20_000)
    child.stderr!.on('data', chunk => {
      err += String(chunk)
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(err)
      if (match) { clearTimeout(timer); resolve({ child, endpoint: match[1]! }) }
    })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the browser exited (${code}): ${err.slice(-300)}`)) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

/** Share of the most common colour among sampled pixels: 1 means the page drew nothing but one colour. */
function uniformity(png: Buffer): number {
  try {
    const image = PNG.sync.read(png)
    const counts = new Map<number, number>()
    let samples = 0
    for (let y = 0; y < image.height; y += 8) {
      for (let x = 0; x < image.width; x += 8) {
        const i = (y * image.width + x) * 4
        const key = (image.data[i]! >> 3) << 10 | (image.data[i + 1]! >> 3) << 5 | (image.data[i + 2]! >> 3)
        counts.set(key, (counts.get(key) ?? 0) + 1)
        samples++
      }
    }
    return samples ? Math.max(...counts.values()) / samples : 1
  } catch {
    return 0
  }
}

export interface PreviewReport {
  url: string
  browser: string | null
  loaded: boolean
  title?: string
  consoleErrors: string[]
  exceptions: string[]
  failedRequests: string[]
  missingFiles: string[]
  canvases?: Array<{ width: number; height: number }>
  bodyText?: string
  /** Share of the screenshot in one colour after the wait and a click; ≥ 0.98 means nothing visible was drawn. */
  uniformity?: number
  screenshot?: string
  note?: string
}

export async function preview(dir: string, options: { waitMs: number; screenshot: string }): Promise<PreviewReport> {
  const server = await serve(dir)
  const report: PreviewReport = { url: server.url, browser: null, loaded: false, consoleErrors: [], exceptions: [], failedRequests: [], missingFiles: server.misses }
  // The entry page and what it names directly are always fetched, so broken paths show even without a browser.
  const res = await fetch(server.url).catch(() => null)
  report.loaded = Boolean(res?.ok)
  const html = res?.ok ? await res.text() : ''
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi)) {
    const ref = m[1]!
    if (/^(?:[a-z]+:|\/\/|data:)/i.test(ref)) continue
    await fetch(new URL(ref, server.url)).then(r => r.body?.cancel()).catch(() => {})
  }
  const browser = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? findBrowser() : null
  if (!browser) {
    report.note = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
      ? 'no Chrome, Chromium or Edge found (set CHROME_PATH): only the entry page and the files it names directly were fetched; JavaScript was not run'
      : 'this Node.js has no WebSocket (Node 22 or newer has it), so no browser was driven: only the entry page and the files it names directly were fetched'
    await server.close()
    return report
  }
  report.browser = path.basename(browser)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'origingame-preview-'))
  let child: ChildProcess | null = null
  let cdp: Cdp | null = null
  try {
    const launched = await launch(browser, profile)
    child = launched.child
    cdp = await connect(launched.endpoint)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    let loaded = false
    const requests = new Map<string, string>()
    cdp.on(msg => {
      if (msg.sessionId !== sessionId) return
      const p = msg.params ?? {}
      if (msg.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
        report.consoleErrors.push(p.args?.map((a: any) => a.value ?? a.description ?? a.type).join(' ').slice(0, 500))
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails ?? {}
        report.exceptions.push(`${d.exception?.description ?? d.text ?? 'exception'}${d.url ? ` at ${d.url.replace(server.url, '')}:${d.lineNumber}` : ''}`.slice(0, 800))
      } else if (msg.method === 'Log.entryAdded' && p.entry?.level === 'error') {
        report.consoleErrors.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url.replace(server.url, '')})` : ''}`.slice(0, 500))
      } else if (msg.method === 'Network.requestWillBeSent') {
        requests.set(p.requestId, p.request?.url ?? '')
      } else if (msg.method === 'Network.loadingFailed' && !p.canceled) {
        report.failedRequests.push(`${(requests.get(p.requestId) ?? '').replace(server.url, '')}: ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ''}`)
      } else if (msg.method === 'Network.responseReceived' && p.response?.status >= 400) {
        report.failedRequests.push(`${String(p.response.url).replace(server.url, '')}: HTTP ${p.response.status}`)
      } else if (msg.method === 'Page.loadEventFired') {
        loaded = true
      }
    })
    for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await cdp.send(domain, {}, sessionId)
    await cdp.send('Page.navigate', { url: server.url }, sessionId)
    const start = Date.now()
    while (!loaded && Date.now() - start < 30_000) await new Promise(r => setTimeout(r, 200))
    report.loaded = report.loaded && loaded
    await new Promise(r => setTimeout(r, Math.max(1000, options.waitMs)))
    // A tap in the middle, as a player would start the game.
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: 640, y: 360, button: 'left', clickCount: 1 }, sessionId).catch(() => {})
    await new Promise(r => setTimeout(r, 2000))
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({title: document.title, canvases: [...document.querySelectorAll("canvas")].slice(0, 5).map(c => ({width: c.width, height: c.height})), text: (document.body && document.body.innerText || "").slice(0, 400)})',
      returnByValue: true,
    }, sessionId).catch(() => null)
    try {
      const info = JSON.parse(evaluated?.result?.value ?? '{}')
      report.title = info.title
      report.canvases = info.canvases
      report.bodyText = info.text
    } catch { /* page gone */ }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId).catch(() => null)
    if (shot?.data) {
      const bytes = Buffer.from(shot.data, 'base64')
      fs.mkdirSync(path.dirname(options.screenshot), { recursive: true })
      fs.writeFileSync(options.screenshot, bytes)
      report.screenshot = options.screenshot
      report.uniformity = Number(uniformity(bytes).toFixed(3))
    }
  } catch (error) {
    report.note = `the browser preview failed: ${(error as Error).message}`
  } finally {
    cdp?.close()
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child!.once('exit', resolve))
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    }
    await server.close()
    // The browser may still be flushing its profile; what is left behind is a temporary folder.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
  }
  const noise = (line: string) => line.includes('/favicon.ico')
  report.consoleErrors = [...new Set(report.consoleErrors.filter(l => !noise(l)))].slice(0, 30)
  report.exceptions = [...new Set(report.exceptions)].slice(0, 20)
  report.failedRequests = [...new Set(report.failedRequests.filter(l => !noise(l)))].slice(0, 30)
  report.missingFiles.splice(0, report.missingFiles.length, ...[...new Set(report.missingFiles)].slice(0, 30))
  return report
}
