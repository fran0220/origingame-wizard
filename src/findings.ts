import fs from 'node:fs'
import path from 'node:path'
import { listFiles, readText } from './files.js'
import { readRuntime, RUNTIME_FILE, unityBuildIn, type UnityBuild } from './unity.js'
import { THREAD_SIGNALS, wasmHead, wasmUsesSharedMemory } from './wasm.js'

/**
 * Adaptations the Wizard knows how to apply to the staged copy. The model
 * chooses among these; it cannot invent another kind.
 */
export const ITEM_KINDS = [
  'entry_index',
  'strip_platform_config',
  'relative_paths',
  'cross_origin_isolation',
  'precompressed',
  'remove_service_worker',
  'exclude_files',
  'code_edit',
  'orientation',
] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export interface PlanItem {
  id: string
  kind: ItemKind
  title: string
  reason: string
  recommended: boolean
  /** Required items are applied without asking (Portal refuses the build otherwise). */
  required?: boolean
  paths?: string[]
  /** For `orientation`: the listing value. */
  value?: string
  source: 'check' | 'model'
}

export interface AbsoluteRef { file: string; value: string; target: string }

export interface Findings {
  items: PlanItem[]
  /** Root-absolute URLs in scripts, which only a code edit can fix safely. */
  scriptAbsolute: AbsoluteRef[]
  threadReasons: string[]
  externalOrigins: string[]
  localhostRefs: string[]
  serviceWorkerRegistrations: string[]
  orientationHints: string[]
  largeFiles: string[]
  /** A Unity WebGL build at the release root: its loader, build files and compression, canvas and service worker. */
  unity: UnityBuild | null
  /** The release's `origingame.runtime.json` as it is now (`invalid` when it cannot be read). */
  runtime: Record<string, unknown> | null | 'invalid'
}

const HTML_ATTR = /\b(src|href|poster|data-src|content)\s*=\s*(["'])(\/[^"'/][^"']*)\2/gi
const CSS_URL = /url\(\s*(["']?)(\/[^)"'/][^)"']*)\1\s*\)|@import\s+(["'])(\/[^"'/][^"']*)\3/gi
const SCRIPT_STRING = /(["'`])(\/[A-Za-z0-9_\-.~][^"'`\s?#]*\.[A-Za-z0-9]{1,8})(?:[?#][^"'`\s]*)?\1/g
const EXTERNAL = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?\//gi
const LOCALHOST = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s"'`)]*/gi

function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, '')
}

/** Root-absolute references in one HTML or CSS file whose target exists in the staged copy. */
export function absoluteRefs(file: string, text: string, exists: (p: string) => boolean): AbsoluteRef[] {
  const refs: AbsoluteRef[] = []
  const isHtml = /\.html?$/i.test(file)
  const add = (value: string) => {
    let target: string
    try { target = decodeURI(stripQuery(value)).slice(1) } catch { return }
    if (target && exists(target)) refs.push({ file, value, target })
  }
  if (isHtml) for (const match of text.matchAll(HTML_ATTR)) add(match[3]!)
  for (const match of text.matchAll(CSS_URL)) add(match[2] ?? match[4]!)
  if (isHtml) {
    for (const block of text.matchAll(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const value of block[1]!.matchAll(/"(\/[^"/][^"]*)"/g)) add(value[1]!)
    }
  }
  return refs
}

/** Deterministic checks on the staged copy. Facts here are not left to the model. */
export function collectFindings(site: string, entry: string): Findings {
  const files = listFiles(site)
  const present = new Set(files)
  const exists = (p: string) => present.has(p)
  const items: PlanItem[] = []
  const unity = unityBuildIn(site, present.has('index.html') ? 'index.html' : entry)
  const runtime = readRuntime(site)
  const findings: Findings = { items, scriptAbsolute: [], threadReasons: [], externalOrigins: [], localhostRefs: [], serviceWorkerRegistrations: [], orientationHints: [], largeFiles: [], unity, runtime }
  const external = new Set<string>()

  if (!present.has('index.html')) {
    items.push({ id: 'entry', kind: 'entry_index', title: `Publish ${entry} as index.html`, reason: 'OriginGame serves the release from index.html at its root', recommended: true, required: true, paths: [entry], source: 'check' })
  }

  const htmlRefs: AbsoluteRef[] = []
  const processed: string[] = []
  let godotSw: string | null = null
  let godotThreadsOff = false
  for (const file of files) {
    const absolute = path.join(site, file)
    const size = fs.statSync(absolute).size
    if (size > 25 * 1024 * 1024) findings.largeFiles.push(`${file} (${(size / 1048576).toFixed(1)} MiB)`)
    const ext = path.extname(file).toLowerCase()
    if (/\.wasm(\.(br|gz|unityweb))?$/i.test(file)) {
      const head = wasmHead(absolute)
      if (head && wasmUsesSharedMemory(head)) findings.threadReasons.push(`shared-memory:${file}`)
      continue
    }
    if (!['.html', '.htm', '.css', '.js', '.mjs'].includes(ext)) continue
    const text = readText(absolute, 16 * 1024 * 1024) ?? ''
    if (ext === '.html' || ext === '.htm') {
      if (/<script[^>]*id=["']__og-game-config["']/i.test(text)) processed.push(file)
      if (/GODOT_THREADS_ENABLED\s*=\s*false/.test(text)) godotThreadsOff = true
      const sw = /"serviceWorker"\s*:\s*"([^"]+)"/.exec(text)
      if (sw && /GODOT_CONFIG/.test(text)) godotSw = sw[1]!
      for (const m of text.matchAll(/screen\.orientation\.lock\(\s*["'](\w+)/g)) findings.orientationHints.push(`${file}: screen.orientation.lock('${m[1]}')`)
      const canvas = /<canvas[^>]*\bwidth\s*=\s*["']?(\d+)[^>]*\bheight\s*=\s*["']?(\d+)/i.exec(text)
      if (canvas) findings.orientationHints.push(`${file}: <canvas width=${canvas[1]} height=${canvas[2]}>`)
    }
    if (ext !== '.js' && ext !== '.mjs') htmlRefs.push(...absoluteRefs(file, text, exists))
    if (ext !== '.css') {
      for (const [pattern, reason] of THREAD_SIGNALS) if (pattern.test(text)) findings.threadReasons.push(`${reason}:${file}`)
      if (/navigator\.serviceWorker\.register\(/.test(text) && !godotSw && unity?.serviceWorker?.file !== file) findings.serviceWorkerRegistrations.push(file)
      for (const m of text.matchAll(LOCALHOST)) if (findings.localhostRefs.length < 10) findings.localhostRefs.push(`${file}: ${m[0]}`)
      for (const m of text.matchAll(EXTERNAL)) external.add(m[1]!.toLowerCase())
      for (const m of text.matchAll(/(?:width|height)\s*[:=]\s*(\d{3,4})\b/g)) if (findings.orientationHints.length < 12 && ext !== '.html') findings.orientationHints.push(`${file}: ${m[0]}`)
    }
    if (ext === '.js' || ext === '.mjs') {
      for (const m of text.matchAll(SCRIPT_STRING)) {
        const target = stripQuery(m[2]!).slice(1)
        if (exists(target) && findings.scriptAbsolute.length < 40) findings.scriptAbsolute.push({ file, value: m[2]!, target })
      }
    }
  }
  if (godotThreadsOff) findings.threadReasons = findings.threadReasons.filter(r => !r.startsWith('godot-threads:'))
  findings.threadReasons = [...new Set(findings.threadReasons)].sort()
  findings.externalOrigins = [...external].filter(h => !['www.w3.org', 'w3.org', 'github.com', 'threejs.org', 'godotengine.org', 'docs.godotengine.org'].includes(h)).sort().slice(0, 30)
  findings.orientationHints = findings.orientationHints.slice(0, 12)

  if (processed.length || present.has('__og')) {
    items.push({ id: 'platform-config', kind: 'strip_platform_config', title: 'Remove a previous OriginGame entry configuration', reason: `${processed.join(', ')} carries a __og-game-config script from an earlier release; Portal adds a fresh one at publication`, recommended: true, required: true, paths: processed, source: 'check' })
  }
  if (htmlRefs.length) {
    const sample = htmlRefs.slice(0, 4).map(r => `${r.file}: ${r.value}`).join('; ')
    items.push({ id: 'relative-paths', kind: 'relative_paths', title: `Make ${htmlRefs.length} root-absolute path${htmlRefs.length === 1 ? '' : 's'} relative`, reason: `a release is served under /play/<game>/<release>/, so "/…" points outside it (${sample})`, recommended: true, paths: [...new Set(htmlRefs.map(r => r.file))], source: 'check' })
  }
  const declared = (field: string) => runtime !== null && runtime !== 'invalid' && runtime[field] === true
  if (findings.threadReasons.length && !declared('crossOriginIsolated') && runtime !== 'invalid') {
    items.push({ id: 'isolation', kind: 'cross_origin_isolation', title: 'Declare cross-origin isolation (threads / SharedArrayBuffer)', reason: `the build needs SharedArrayBuffer: ${findings.threadReasons.slice(0, 3).join(', ')}; ${runtime ? `adds crossOriginIsolated to ${RUNTIME_FILE}` : `writes ${RUNTIME_FILE}`} so Portal sends COOP/COEP for this release only`, recommended: true, source: 'check' })
  }
  if (unity && (unity.compression === 'brotli' || unity.compression === 'gzip') && !declared('precompressed') && runtime !== 'invalid') {
    const compressed = unity.files.filter(f => f.compression === 'br' || f.compression === 'gz').map(f => f.path)
    items.push({ id: 'precompressed', kind: 'precompressed', title: `Declare the ${unity.compression === 'brotli' ? 'Brotli' : 'gzip'}-compressed Unity build files`, reason: `${compressed.slice(0, 3).join(', ')} must be served with Content-Encoding: ${unity.compression === 'brotli' ? 'br' : 'gzip'} or the Unity loader stops; ${runtime ? `adds precompressed to ${RUNTIME_FILE}` : `writes ${RUNTIME_FILE}`} so Portal does`, recommended: true, required: true, paths: compressed, source: 'check' })
  }
  if (unity?.serviceWorker) {
    const extra = [unity.serviceWorker.worker, unity.serviceWorker.manifest].filter((p): p is string => Boolean(p))
    items.push({ id: 'unity-service-worker', kind: 'remove_service_worker', title: "Turn off the Unity PWA template's service worker", reason: `${unity.serviceWorker.file} registers ServiceWorker.js; offline caching belongs to OriginGame's Player, and a game-level worker can serve stale releases`, recommended: true, paths: extra, source: 'check' })
  }
  if (unity?.fixedCanvas) {
    const paths = [present.has('index.html') ? 'index.html' : entry, ...(present.has('TemplateData/style.css') ? ['TemplateData/style.css'] : [])]
    items.push({ id: 'unity-canvas', kind: 'code_edit', title: `Let the Unity canvas fill the Player frame (now a fixed ${unity.fixedCanvas.width}x${unity.fixedCanvas.height})`, reason: `the template draws a ${unity.fixedCanvas.width}x${unity.fixedCanvas.height}px canvas with a footer, so inside the Player's frame it is cropped or letterboxed; the canvas should fill the page and follow its size`, recommended: true, paths, source: 'check' })
  }
  if (godotSw) {
    items.push({ id: 'godot-service-worker', kind: 'remove_service_worker', title: 'Turn off the Godot export\'s service worker', reason: `the export registers ${godotSw}; offline caching and isolation headers belong to OriginGame's Player, and a game-level worker can serve stale releases`, recommended: true, paths: present.has(godotSw) ? [godotSw] : [], source: 'check' })
  }
  return findings
}
