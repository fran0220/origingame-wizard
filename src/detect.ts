import path from 'node:path'
import type { Engine } from './constants.js'

/**
 * Deterministic project detection: a pure function of the file list and a
 * few small file contents. No model is involved and nothing is executed.
 *
 * - `static`: hand-written HTML (or any page) served as-is from `root`.
 * - `prebuilt`: a build output that is already there (`dist/` and friends) with no build to run.
 * - `node-build`: a package with a `build` script (Vite, webpack, …), built into a scratch copy.
 * - `godot-export`: a Godot Web export (`.html` + `.pck` + `.wasm`).
 * - `godot-project`: a Godot project, exported with the local Godot editor when available.
 */
export type ProjectKind = 'static' | 'prebuilt' | 'node-build' | 'godot-project' | 'godot-export'

export interface BuildPlan {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  script: string
  /** True when `vite build` is the last command of the script, so `--base ./ --outDir` can be appended. */
  viteLast: boolean
}

export interface Detection {
  kind: ProjectKind
  engine: Engine
  /** Directory (relative to the project, '' for the project itself) holding the page for static/prebuilt/export kinds. */
  root: string
  /** Entry page relative to `root`; Portal needs it published as `index.html`. */
  entry: string
  build?: BuildPlan
  /** Output directories to look in after a node build, most specific first. */
  outputs: string[]
  /** For a Godot project: a Web export already in the tree, used when no Godot editor is available. */
  existingExport?: { root: string; entry: string }
  reasons: string[]
}

export interface DetectInput {
  /** Every file, relative to the project, `/`-separated. */
  files: string[]
  /** Small text file contents (`null` when absent or too large). */
  read(file: string): string | null
  /** Engine markers from the rules, in order; the first engine with a matching marker wins. */
  engines: Array<{ id: Engine; markers: string[] }>
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.godot', '.import', '.svn', '.hg', '.cache', '.vite', '.next', '.parcel-cache'])
const OUTPUT_DIRS = ['dist', 'build', 'out', 'www', 'public']

function visible(file: string): boolean {
  return !file.split('/').some(part => IGNORED_SEGMENTS.has(part))
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * One marker: `glob` (some file's basename matches), `glob:needle` (such a
 * file contains `needle`), or `a+b` (every part matches).
 */
export function markerMatches(marker: string, files: string[], read: (file: string) => string | null): boolean {
  return marker.split('+').every(part => {
    const colon = part.indexOf(':')
    const glob = colon === -1 ? part : part.slice(0, colon)
    const needle = colon === -1 ? null : part.slice(colon + 1)
    const pattern = globToRegExp(glob)
    return files.some(file => {
      if (!pattern.test(path.posix.basename(file))) return false
      if (needle === null) return true
      return read(file)?.includes(needle) ?? false
    })
  })
}

export function classifyEngine(files: string[], read: (file: string) => string | null, engines: DetectInput['engines']): { engine: Engine; marker: string | null } {
  for (const engine of engines) {
    for (const marker of engine.markers) {
      if (markerMatches(marker, files, read)) return { engine: engine.id, marker }
    }
  }
  return { engine: 'html', marker: null }
}

function within(files: string[], root: string): string[] {
  if (!root) return files
  const prefix = `${root}/`
  return files.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length))
}

function directChildren(files: string[], dir: string): string[] {
  return within(files, dir).filter(f => !f.includes('/'))
}

function packageManager(files: string[], manifest: any): BuildPlan['packageManager'] {
  const declared = typeof manifest?.packageManager === 'string' ? manifest.packageManager.split('@')[0] : ''
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared as BuildPlan['packageManager']
  if (files.includes('bun.lock') || files.includes('bun.lockb')) return 'bun'
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  return 'npm'
}

export function viteIsLast(script: string): boolean {
  const commands = script.split('&&').map(s => s.trim())
  const last = commands.at(-1) ?? ''
  return /^(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+)?)?vite\s+build(?:\s+[^;|&<>`$]*)?$/.test(last)
}

/** A Godot Web export: an HTML page beside a `.pck` and a `.wasm` in one directory. */
function godotExportIn(files: string[], dir: string): { root: string; entry: string } | null {
  const names = directChildren(files, dir)
  const pck = names.filter(n => /\.pck$/i.test(n))
  const wasm = names.some(n => /\.wasm$/i.test(n))
  const html = names.filter(n => /\.html?$/i.test(n))
  if (!pck.length || !wasm || !html.length) return null
  const stem = pck[0]!.replace(/\.pck$/i, '')
  const entry = html.find(n => n.toLowerCase() === 'index.html') ?? html.find(n => n.replace(/\.html?$/i, '') === stem) ?? html[0]!
  return { root: dir, entry }
}

function candidateDirs(files: string[]): string[] {
  const dirs = new Set<string>([''])
  for (const file of files) {
    const parts = file.split('/')
    for (let depth = 1; depth < parts.length && depth <= 3; depth++) dirs.add(parts.slice(0, depth).join('/'))
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

function viteOutDir(read: DetectInput['read'], files: string[]): string | null {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    if (!files.includes(name)) continue
    const match = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(read(name) ?? '')
    if (match && !match[1]!.startsWith('/') && !match[1]!.includes('..')) return match[1]!.replace(/^\.\//, '').replace(/\/$/, '')
  }
  return null
}

export function detectProject(input: DetectInput): Detection | null {
  const files = input.files.filter(visible).sort()
  const read = (file: string) => input.read(file)
  const reasons: string[] = []
  const has = (file: string) => files.includes(file)
  const engineOf = (scope: string[], prefix: string) => {
    const result = classifyEngine(scope, f => read(prefix ? `${prefix}/${f}` : f), input.engines)
    reasons.push(result.marker ? `engine ${result.engine}: marker "${result.marker}"` : 'engine html: no engine marker matched')
    return result.engine
  }

  const exportDirs = candidateDirs(files).map(dir => godotExportIn(files, dir)).filter((x): x is { root: string; entry: string } => x !== null)

  if (has('project.godot')) {
    reasons.push('project.godot at the project root')
    const existing = exportDirs[0]
    if (existing) reasons.push(`existing Web export in ${existing.root || '.'}`)
    return { kind: 'godot-project', engine: 'godot', root: '', entry: 'index.html', outputs: [], reasons, ...(existing ? { existingExport: existing } : {}) }
  }

  const rootExport = exportDirs.find(e => e.root === '')
  if (rootExport) {
    reasons.push('Godot Web export (.html + .pck + .wasm) at the project root')
    return { kind: 'godot-export', engine: engineOf(directChildren(files, ''), ''), root: '', entry: rootExport.entry, outputs: [], reasons }
  }

  let manifest: any = null
  if (has('package.json')) {
    try { manifest = JSON.parse(read('package.json') ?? '') } catch { manifest = null }
  }
  const script = typeof manifest?.scripts?.build === 'string' ? manifest.scripts.build.trim() : ''
  if (script) {
    reasons.push(`package.json build script: ${script}`)
    const outDir = viteOutDir(read, files)
    const outputs = [...new Set([...(outDir ? [outDir] : []), ...OUTPUT_DIRS])]
    const sourceScope = files.filter(f => !outputs.some(o => f === o || f.startsWith(`${o}/`)) || f.startsWith('public/'))
    return {
      kind: 'node-build', engine: engineOf(sourceScope, ''), root: '', entry: 'index.html', outputs, reasons,
      build: { packageManager: packageManager(files, manifest), script, viteLast: viteIsLast(script) },
    }
  }

  if (has('index.html')) {
    reasons.push('index.html at the project root')
    return { kind: 'static', engine: engineOf(files, ''), root: '', entry: 'index.html', outputs: [], reasons }
  }

  const nestedExport = exportDirs[0]
  if (nestedExport) {
    reasons.push(`Godot Web export in ${nestedExport.root}`)
    return { kind: 'godot-export', engine: engineOf(directChildren(files, nestedExport.root), nestedExport.root), root: nestedExport.root, entry: nestedExport.entry, outputs: [], reasons }
  }

  for (const dir of OUTPUT_DIRS) {
    if (has(`${dir}/index.html`)) {
      reasons.push(`prebuilt ${dir}/index.html`)
      return { kind: 'prebuilt', engine: engineOf(within(files, dir), dir), root: dir, entry: 'index.html', outputs: [], reasons }
    }
  }

  const rootPages = directChildren(files, '').filter(n => /\.html?$/i.test(n))
  if (rootPages.length === 1) {
    reasons.push(`single page ${rootPages[0]} at the project root`)
    return { kind: 'static', engine: engineOf(files, ''), root: '', entry: rootPages[0]!, outputs: [], reasons }
  }

  const nested = files.filter(f => /^[^/]+\/index\.html$/i.test(f))
  if (nested.length === 1) {
    const root = nested[0]!.split('/')[0]!
    reasons.push(`index.html in ${root}/`)
    return { kind: 'static', engine: engineOf(within(files, root), root), root, entry: 'index.html', outputs: [], reasons }
  }
  return null
}
