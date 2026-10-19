import path from 'node:path'
import type { Engine } from './constants.js'
import { OG_BUILD_MANIFEST, publishOut } from './og.js'
import type { Family } from './rules.js'

/**
 * Deterministic project detection: a pure function of the file list and a
 * few small file contents. No model is involved and nothing is executed.
 *
 * - `origin-engine`: an Origin Engine project (`project.ogt` at the root), built with `og build . --publish`.
 * - `origin-engine-build`: an `og build` output that is already there (`og-build.json`, the `og-engine`
 *   meta, the engine's web host, or a marker of a family whose engine is `origin-engine`).
 * - `static`: hand-written HTML (or any page) served as-is from `root`.
 * - `prebuilt`: a build output that is already there (`dist/`, an engine's Web export …) with no build to run.
 * - `node-build`: a package with a `build` script (Vite, webpack, …), built into a scratch copy.
 * - `godot-export`: a Godot Web export (`.html` + `.pck` + `.wasm`), also one inside a Godot project's tree.
 *   It publishes as `html`: Portal refuses `godot` for new games.
 * - `godot-project`: a Godot project with no Web export in it, which the Wizard cannot publish.
 * - `unity-webgl`: a Unity WebGL build (a page beside `Build/*.loader.js`).
 * - `unity-project`: a Unity project (`Assets/` + `ProjectSettings/ProjectVersion.txt`), built for WebGL with the local Unity Editor.
 * - `native`: something OriginGame cannot publish (a Windows, macOS, Linux, Android or iOS build, or an engine
 *   project whose editor the Wizard cannot drive); `native` says what it is, so the caller can find the
 *   project it came from or explain how to export it for the Web.
 */
export type ProjectKind = 'origin-engine' | 'origin-engine-build' | 'static' | 'prebuilt' | 'node-build' | 'godot-project' | 'godot-export' | 'unity-project' | 'unity-webgl' | 'native'

export interface BuildPlan {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
  script: string
  /** True when `vite build` is the last command of the script, so `--base ./ --outDir` can be appended. */
  viteLast: boolean
}

/** Facts from a Unity project's ProjectSettings (text serialization); null where a value is not there. */
export interface UnityFacts {
  /** `m_EditorVersion` of ProjectVersion.txt, e.g. `2022.3.10f1`. */
  version: string | null
  /** The changeset of `m_EditorVersionWithRevision`, for the Unity Hub install link. */
  revision: string | null
  productName: string | null
  /** The Web default canvas size (`defaultScreenWidthWeb` × `defaultScreenHeightWeb`). */
  webCanvas: { width: number; height: number } | null
  /** `webGLCompressionFormat`: Brotli, Gzip or Disabled. */
  compression: 'brotli' | 'gzip' | 'disabled' | null
  decompressionFallback: boolean | null
  threads: boolean | null
  template: string | null
  /** Enabled scenes in File > Build Settings. */
  scenes: number | null
}

export type NativePlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'project'

/** What a folder holds instead of a Web game. */
export interface NativeBuild {
  platform: NativePlatform
  /** The engine it came from, when the files show it. */
  engine: 'unity' | 'godot' | 'unreal' | 'gamemaker' | 'renpy' | 'electron' | 'nwjs' | 'love' | 'defold' | 'construct' | 'cocos' | 'rpgmaker' | null
  /** The file or directory that shows it, relative to the project (`Game.exe`, `Game.app`, `game.apk` …). */
  evidence: string[]
}

export interface Detection {
  kind: ProjectKind
  engine: Engine
  /** The game family named to the person (an engine or framework), when a marker shows one. */
  family: { id: string; label: string; generated: boolean } | null
  /** Directory (relative to the project, '' for the project itself) holding the page for static/prebuilt/export kinds. */
  root: string
  /** Entry page relative to `root`; Portal needs it published as `index.html`. */
  entry: string
  build?: BuildPlan
  /** Output directories to look in after a node build, most specific first. */
  outputs: string[]
  /** For a Unity or Origin Engine project: a Web build already in the tree, used when no editor or `og` is available. */
  existingExport?: { root: string; entry: string }
  unity?: UnityFacts
  native?: NativeBuild
  /** For an `og build` output: whether it is a `--publish` build (`publish`), a dev build (`dev`), or does not say (null). */
  ogBuild?: 'publish' | 'dev' | null
  reasons: string[]
}

export interface DetectInput {
  /** Every file, relative to the project, `/`-separated. */
  files: string[]
  /** Small text file contents (`null` when absent or too large). */
  read(file: string): string | null
  /** Engine markers from the rules, in order; the first engine with a matching marker wins. */
  engines: Array<{ id: Engine; markers: string[] }>
  /** Game families from the rules (absent from rules served to older Wizards). */
  families?: Family[]
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.godot', '.import', '.svn', '.hg', '.cache', '.vite', '.next', '.parcel-cache', '__MACOSX', '.og', 'og-out'])
const OUTPUT_DIRS = ['dist', 'build', 'out', 'www', 'public']
/** A Unity project's caches and build folders (top level only): never scanned, copied or uploaded as source. */
export const UNITY_CACHE_DIRS = ['Library', 'Temp', 'Logs', 'obj', 'UserSettings', 'MemoryCaptures', 'Recordings']

function visible(file: string): boolean {
  return !file.split('/').some(part => IGNORED_SEGMENTS.has(part))
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * One marker: `glob` (some file's basename matches), `glob:needle` (such a
 * file contains `needle`), or `a+b` (every part matches). A glob with a `/`
 * (`Build/*.loader.js`) matches a whole path relative to the scanned root.
 */
export function markerMatches(marker: string, files: string[], read: (file: string) => string | null): boolean {
  return marker.split('+').every(part => {
    const colon = part.indexOf(':')
    const glob = colon === -1 ? part : part.slice(0, colon)
    const needle = colon === -1 ? null : part.slice(colon + 1)
    const pattern = globToRegExp(glob)
    const whole = glob.includes('/')
    return files.some(file => {
      if (!pattern.test(whole ? file : path.posix.basename(file))) return false
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

/** The first family (in rules order) with a matching marker. */
export function classifyFamily(files: string[], read: (file: string) => string | null, families: readonly Family[], only?: (f: Family) => boolean): { family: Family; marker: string } | null {
  for (const family of families) {
    if (only && !only(family)) continue
    for (const marker of family.markers) {
      if (markerMatches(marker, files, read)) return { family, marker }
    }
  }
  return null
}

function within(files: string[], root: string): string[] {
  if (!root) return files
  const prefix = `${root}/`
  return files.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length))
}

function directChildren(files: string[], dir: string): string[] {
  return within(files, dir).filter(f => !f.includes('/'))
}

/** Names of the directories directly inside `dir`. */
function childDirs(files: string[], dir: string): Set<string> {
  const out = new Set<string>()
  for (const f of within(files, dir)) {
    const slash = f.indexOf('/')
    if (slash > 0) out.add(f.slice(0, slash))
  }
  return out
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

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

function entryOf(html: string[], stem?: string): string {
  return html.find(n => n.toLowerCase() === 'index.html') ?? (stem ? html.find(n => n.replace(/\.html?$/i, '') === stem) : undefined) ?? html[0]!
}

/** A Godot Web export: an HTML page beside a `.pck` and a `.wasm` in one directory. */
function godotExportIn(files: string[], dir: string): { root: string; entry: string } | null {
  const names = directChildren(files, dir)
  const pck = names.filter(n => /\.pck$/i.test(n))
  const wasm = names.some(n => /\.wasm$/i.test(n))
  const html = names.filter(n => /\.html?$/i.test(n))
  if (!pck.length || !wasm || !html.length) return null
  return { root: dir, entry: entryOf(html, pck[0]!.replace(/\.pck$/i, '')) }
}

/**
 * An Origin Engine build (`og build`, the engine's docs/web-export.md) in
 * `dir`: `index.html` beside `og-build.json` naming `origin-engine`, or a page
 * carrying the `og-engine` / `og-profile` meta, or the engine's web host
 * (`origin-engine.js` + `origin-engine_bg.wasm`), or a marker of a rules
 * family whose engine is `origin-engine`. `build` is `publish` or `dev` when
 * the manifest or the `og-build` meta says which.
 */
function ogBuildIn(files: string[], dir: string, read: (file: string) => string | null, families: readonly Family[]): { root: string; entry: string; build: 'publish' | 'dev' | null; evidence: string } | null {
  const names = directChildren(files, dir)
  if (!names.includes('index.html')) return null
  const at = (name: string) => join(dir, name)
  const kind = (value: unknown) => (value === 'publish' || value === 'dev' ? value : null)
  if (names.includes(OG_BUILD_MANIFEST)) {
    let manifest: any = null
    try { manifest = JSON.parse(read(at(OG_BUILD_MANIFEST)) ?? '') } catch { manifest = null }
    if (manifest?.engine?.name === 'origin-engine') return { root: dir, entry: 'index.html', build: kind(manifest.build), evidence: OG_BUILD_MANIFEST }
  }
  const page = read(at('index.html')) ?? ''
  const meta = /<meta\s[^>]*name=["']og-(?:engine|profile)["']/i.exec(page)
  const build = kind(/<meta\s[^>]*name=["']og-build["'][^>]*content=["'](\w+)["']/i.exec(page)?.[1])
  if (meta) return { root: dir, entry: 'index.html', build, evidence: 'the og-engine meta in index.html' }
  if (names.includes('origin-engine.js') && names.includes('origin-engine_bg.wasm')) return { root: dir, entry: 'index.html', build, evidence: 'origin-engine.js + origin-engine_bg.wasm' }
  const hit = classifyFamily(within(files, dir), f => read(at(f)), families, f => f.engine === 'origin-engine')
  return hit ? { root: dir, entry: 'index.html', build, evidence: `${hit.family.label} marker "${hit.marker}"` } : null
}

/**
 * A Unity WebGL build: a page beside `Build/<name>.loader.js` (Unity 2020 and
 * later) or `Build/UnityLoader.js` with its `Build/*.json` (2019 and earlier).
 */
function unityWebglIn(files: string[], dir: string): { root: string; entry: string; loader: string } | null {
  const html = directChildren(files, dir).filter(n => /\.html?$/i.test(n))
  if (!html.length) return null
  const build = directChildren(files, join(dir, 'Build'))
  const loader = build.find(n => /\.loader\.js$/i.test(n)) ?? (build.some(n => n === 'UnityLoader.js') && build.some(n => /\.json$/i.test(n)) ? 'UnityLoader.js' : undefined)
  if (!loader) return null
  return { root: dir, entry: entryOf(html, loader.replace(/\.loader\.js$/i, '')), loader }
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

/** True for a Unity project root: `ProjectSettings/ProjectVersion.txt` and an `Assets/` folder. */
export function isUnityProjectTree(files: string[], dir = ''): boolean {
  return files.includes(join(dir, 'ProjectSettings/ProjectVersion.txt')) && childDirs(files, dir).has('Assets')
}

const yamlValue = (text: string, key: string): string | null => new RegExp(`^\\s*${key}:[ \\t]*(.*?)\\s*$`, 'm').exec(text)?.[1] ?? null
const yamlInt = (text: string, key: string): number | null => {
  const v = yamlValue(text, key)
  return v !== null && /^-?\d+$/.test(v) ? Number(v) : null
}

export function unityFacts(read: (file: string) => string | null): UnityFacts {
  const version = read('ProjectSettings/ProjectVersion.txt') ?? ''
  const settings = read('ProjectSettings/ProjectSettings.asset') ?? ''
  const scenesText = read('ProjectSettings/EditorBuildSettings.asset')
  const width = yamlInt(settings, 'defaultScreenWidthWeb')
  const height = yamlInt(settings, 'defaultScreenHeightWeb')
  const compression = yamlInt(settings, 'webGLCompressionFormat')
  const fallback = yamlInt(settings, 'webGLDecompressionFallback')
  const threads = yamlInt(settings, 'webGLThreadsSupport')
  return {
    version: /m_EditorVersion:\s*(\S+)/.exec(version)?.[1] ?? null,
    revision: /m_EditorVersionWithRevision:\s*\S+\s*\(([0-9a-f]+)\)/.exec(version)?.[1] ?? null,
    productName: yamlValue(settings, 'productName'),
    webCanvas: width && height ? { width, height } : null,
    compression: compression === 0 ? 'brotli' : compression === 1 ? 'gzip' : compression === 2 ? 'disabled' : null,
    decompressionFallback: fallback === null ? null : fallback === 1,
    threads: threads === null ? null : threads === 1,
    template: yamlValue(settings, 'webGLTemplate'),
    scenes: scenesText === null ? null : [...scenesText.matchAll(/^\s*-\s*enabled:\s*1\s*$/gm)].length,
  }
}

const EXE_NOISE = /^(unitycrashhandler(32|64)?|unins\d*|vc_?redist.*|dxsetup|dxwebsetup|crashpad_handler|notification_helper|uninstall.*)\.exe$/i

/**
 * A build OriginGame cannot publish, at the top of `dir`: a Windows, macOS,
 * Linux, Android or iOS build. Its engine comes from the files beside it.
 */
function nativeIn(files: string[], dir: string): NativeBuild | null {
  const names = directChildren(files, dir)
  const dirs = childDirs(files, dir)
  const has = (re: RegExp) => names.some(n => re.test(n))
  const ev = (n: string) => join(dir, n)
  const exes = names.filter(n => /\.exe$/i.test(n) && !EXE_NOISE.test(n))
  const linux = names.filter(n => /\.(x86_64|x86|arm64|aarch64)$/i.test(n))
  const apps = [...dirs].filter(d => /\.app$/i.test(d) && files.some(f => f.startsWith(`${join(dir, d)}/Contents/`)))
  const xcode = [...dirs].filter(d => /\.xcodeproj$/i.test(d) && files.includes(`${join(dir, d)}/project.pbxproj`))
  const packages = names.filter(n => /\.(apk|aab)$/i.test(n))
  const dataDir = (stem: string) => dirs.has(`${stem}_Data`)
  const desktopEngine = (stems: string[]): NativeBuild['engine'] => {
    if (has(/^UnityPlayer\.(dll|so)$/i) || stems.some(dataDir)) return 'unity'
    if (has(/\.pck$/i)) return 'godot'
    if (dirs.has('Engine') && files.some(f => /\.pak$/i.test(f) && f.startsWith(dir ? `${dir}/` : ''))) return 'unreal'
    if (has(/^data\.win$/i) || has(/^game\.unx$/i)) return 'gamemaker'
    if (dirs.has('renpy') && dirs.has('game')) return 'renpy'
    if (dirs.has('resources') && files.some(f => f === join(dir, 'resources/app.asar') || f === join(dir, 'resources/app/package.json'))) return 'electron'
    if (has(/^(nw\.dll|nw_elf\.dll|package\.nw)$/i) || dirs.has('package.nw')) return 'nwjs'
    if (has(/^love\.dll$/i)) return 'love'
    if (has(/^game\.(arcd|dmanifest)$/i)) return 'defold'
    return null
  }
  if (exes.length) return { platform: 'windows', engine: desktopEngine(exes.map(n => n.replace(/\.exe$/i, ''))), evidence: exes.slice(0, 3).map(ev) }
  if (apps.length) {
    const app = join(dir, apps[0]!)
    const inside = within(files, app)
    const engine = inside.some(f => /UnityPlayer\.dylib$/i.test(f) || f.startsWith('Contents/Resources/Data/')) ? 'unity'
      : inside.some(f => /^Contents\/Resources\/.*\.pck$/i.test(f)) ? 'godot' : null
    return { platform: 'macos', engine, evidence: [app] }
  }
  if (linux.length) return { platform: 'linux', engine: desktopEngine(linux.map(n => n.replace(/\.[^.]+$/, ''))), evidence: linux.slice(0, 3).map(ev) }
  if (packages.length) return { platform: 'android', engine: null, evidence: packages.slice(0, 3).map(ev) }
  if (xcode.length) {
    const engine = xcode.includes('Unity-iPhone.xcodeproj') || dirs.has('UnityFramework') ? 'unity' : has(/\.pck$/i) ? 'godot' : null
    return { platform: 'ios', engine, evidence: xcode.slice(0, 1).map(ev) }
  }
  return null
}

/** An engine's own project with no Web build in it, whose editor the Wizard cannot drive. */
function engineProjectIn(files: string[]): NativeBuild | null {
  const names = directChildren(files, '')
  const dirs = childDirs(files, '')
  const has = (re: RegExp) => names.some(n => re.test(n))
  if (has(/\.uproject$/i)) return { platform: 'project', engine: 'unreal', evidence: names.filter(n => /\.uproject$/i.test(n)) }
  if (has(/\.yyp$/i)) return { platform: 'project', engine: 'gamemaker', evidence: names.filter(n => /\.yyp$/i.test(n)) }
  if (has(/\.c3p$/i) || (has(/^project\.c3proj$/i))) return { platform: 'project', engine: 'construct', evidence: names.filter(n => /\.(c3p|c3proj)$/i.test(n)) }
  if (has(/^game\.project$/i)) return { platform: 'project', engine: 'defold', evidence: ['game.project'] }
  if (has(/^(game\.rpgproject|game\.rmmzproject)$/i)) return { platform: 'project', engine: 'rpgmaker', evidence: names.filter(n => /^game\.(rpgproject|rmmzproject)$/i.test(n)) }
  if (dirs.has('game') && files.some(f => /^game\/[^/]+\.rpy$/i.test(f))) return { platform: 'project', engine: 'renpy', evidence: ['game/'] }
  if (dirs.has('assets') && dirs.has('settings') && (has(/^project\.json$/i) || has(/^package\.json$/i)) && files.some(f => /^settings\/(v2\/)?[^/]+\.json$/.test(f))) {
    return { platform: 'project', engine: 'cocos', evidence: ['assets/', 'settings/'] }
  }
  return null
}

export function detectProject(input: DetectInput): Detection | null {
  const families = input.families ?? []
  let files = input.files.filter(visible).sort()
  const read = (file: string) => input.read(file)
  const reasons: string[] = []
  const has = (file: string) => files.includes(file)
  const scoped = (prefix: string) => (f: string) => read(prefix ? `${prefix}/${f}` : f)
  const engineOf = (scope: string[], prefix: string) => {
    const result = classifyEngine(scope, scoped(prefix), input.engines)
    reasons.push(result.marker ? `engine ${result.engine}: marker "${result.marker}"` : 'engine html: no engine marker matched')
    return result.engine
  }
  /** The family named to the person and the Portal engine: a family with its own Portal engine (Unity) decides the engine. */
  const named = (scope: string[], prefix: string, engine: Engine, only?: (f: Family) => boolean): { engine: Engine; family: Detection['family'] } => {
    const hit = classifyFamily(scope, scoped(prefix), families, only)
    if (!hit) return { engine, family: null }
    reasons.push(`${hit.family.label}: marker "${hit.marker}"`)
    const family = { id: hit.family.id, label: hit.family.label, generated: hit.family.generated }
    return { engine: hit.family.engine !== 'html' && engine === 'html' ? hit.family.engine : engine, family }
  }
  const unityFamily = (): Detection['family'] => {
    const f = families.find(x => x.id === 'unity')
    return { id: 'unity', label: f?.label ?? 'Unity', generated: true }
  }
  const ogFamily = (): Detection['family'] => {
    const f = families.find(x => x.id === 'origin-engine') ?? families.find(x => x.engine === 'origin-engine')
    return { id: f?.id ?? 'origin-engine', label: f?.label ?? 'Origin Engine', generated: true }
  }
  /** A Godot Web export is published as `html` (Portal refuses `godot` for new games); the family keeps its name. */
  const godotFamily = (): Detection['family'] => {
    const f = families.find(x => x.id === 'godot')
    return { id: 'godot', label: f?.label ?? 'Godot', generated: true }
  }
  const ogBuildAt = (build: NonNullable<ReturnType<typeof ogBuildIn>>): Detection => {
    reasons.push(`og build${build.build ? ` (${build.build})` : ''} output ${build.root ? `in ${build.root}` : 'at the project root'}: ${build.evidence}`)
    return { kind: 'origin-engine-build', engine: 'origin-engine', family: ogFamily(), root: build.root, entry: build.entry, outputs: [], reasons, ogBuild: build.build }
  }

  if (has('project.ogt')) {
    // An Origin Engine project: built with `og build . --publish` into project.ogt's publish.out (default dist/).
    const out = publishOut(read('project.ogt'))
    const outputs = [...new Set([...(out ? [out] : []), 'dist'])]
    reasons.push('project.ogt at the project root (an Origin Engine project)')
    const existing = outputs.map(o => ogBuildIn(files, o, read, families)).find(b => b !== null && b.build !== 'dev')
    if (existing) reasons.push(`existing og build --publish output in ${existing.root}/`)
    return {
      kind: 'origin-engine', engine: 'origin-engine', family: ogFamily(), root: '', entry: 'index.html', outputs, reasons,
      ...(existing ? { existingExport: { root: existing.root, entry: existing.entry } } : {}),
    }
  }
  const rootOg = ogBuildIn(files, '', read, families)
  if (rootOg) return ogBuildAt(rootOg)

  if (isUnityProjectTree(files)) {
    // The Unity project itself: its caches never count as part of it.
    files = files.filter(f => !UNITY_CACHE_DIRS.includes(f.split('/')[0]!))
    const unity = unityFacts(read)
    reasons.push(`Unity project (ProjectSettings/ProjectVersion.txt${unity.version ? `: ${unity.version}` : ''})`)
    const existing = candidateDirs(files).map(dir => unityWebglIn(files, dir)).find(x => x !== null)
    if (existing) reasons.push(`existing WebGL build in ${existing.root || '.'}`)
    return {
      kind: 'unity-project', engine: 'unity', family: unityFamily(), root: '', entry: 'index.html', outputs: [], reasons, unity,
      ...(existing ? { existingExport: { root: existing.root, entry: existing.entry } } : {}),
    }
  }

  const exportDirs = candidateDirs(files).map(dir => godotExportIn(files, dir)).filter((x): x is { root: string; entry: string } => x !== null)

  if (has('project.godot')) {
    reasons.push('project.godot at the project root')
    const existing = exportDirs[0]
    if (existing) {
      // The project's own Web export is what gets published; the Wizard never runs the Godot editor.
      reasons.push(`its Web export in ${existing.root || '.'}`)
      return { kind: 'godot-export', engine: 'html', family: godotFamily(), root: existing.root, entry: existing.entry, outputs: [], reasons }
    }
    return { kind: 'godot-project', engine: 'html', family: godotFamily(), root: '', entry: 'index.html', outputs: [], reasons }
  }

  const unityBuilds = candidateDirs(files).map(dir => unityWebglIn(files, dir)).filter((x): x is NonNullable<typeof x> => x !== null)
  const unityAt = (build: NonNullable<ReturnType<typeof unityWebglIn>>): Detection => {
    reasons.push(`Unity WebGL build (${build.entry} + Build/${build.loader}) ${build.root ? `in ${build.root}` : 'at the project root'}`)
    return { kind: 'unity-webgl', engine: 'unity', family: unityFamily(), root: build.root, entry: build.entry, outputs: [], reasons }
  }
  const rootUnity = unityBuilds.find(b => b.root === '')
  if (rootUnity) return unityAt(rootUnity)

  const rootExport = exportDirs.find(e => e.root === '')
  if (rootExport) {
    reasons.push('Godot Web export (.html + .pck + .wasm) at the project root')
    return { kind: 'godot-export', engine: 'html', family: godotFamily(), root: '', entry: rootExport.entry, outputs: [], reasons }
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
    const n = named(sourceScope, '', engineOf(sourceScope, ''))
    return {
      kind: 'node-build', engine: n.engine, family: n.family, root: '', entry: 'index.html', outputs, reasons,
      build: { packageManager: packageManager(files, manifest), script, viteLast: viteIsLast(script) },
    }
  }

  if (has('index.html')) {
    reasons.push('index.html at the project root')
    const n = named(files, '', engineOf(files, ''))
    return { kind: 'static', engine: n.engine, family: n.family, root: '', entry: 'index.html', outputs: [], reasons }
  }

  const nestedOg = candidateDirs(files).filter(Boolean).map(dir => ogBuildIn(files, dir, read, families)).find(x => x !== null)
  if (nestedOg) return ogBuildAt(nestedOg)

  const nestedUnity = unityBuilds[0]
  if (nestedUnity) return unityAt(nestedUnity)

  const nestedExport = exportDirs[0]
  if (nestedExport) {
    reasons.push(`Godot Web export in ${nestedExport.root}`)
    return { kind: 'godot-export', engine: 'html', family: godotFamily(), root: nestedExport.root, entry: nestedExport.entry, outputs: [], reasons }
  }

  // An engine's Web export inside a larger folder (Construct, GameMaker, Cocos, Defold …), located by its family's markers.
  for (const dir of candidateDirs(files)) {
    if (!dir) continue
    const pages = directChildren(files, dir).filter(n => /\.html?$/i.test(n))
    if (!pages.length) continue
    const scope = within(files, dir)
    const hit = classifyFamily(scope, scoped(dir), families, f => f.locate)
    if (!hit) continue
    reasons.push(`${hit.family.label} Web export in ${dir} (marker "${hit.marker}")`)
    const engine = engineOf(scope, dir)
    return {
      kind: 'prebuilt', engine: hit.family.engine !== 'html' && engine === 'html' ? hit.family.engine : engine,
      family: { id: hit.family.id, label: hit.family.label, generated: hit.family.generated }, root: dir, entry: entryOf(pages), outputs: [], reasons,
    }
  }

  for (const dir of OUTPUT_DIRS) {
    if (has(`${dir}/index.html`)) {
      reasons.push(`prebuilt ${dir}/index.html`)
      const scope = within(files, dir)
      const n = named(scope, dir, engineOf(scope, dir))
      return { kind: 'prebuilt', engine: n.engine, family: n.family, root: dir, entry: 'index.html', outputs: [], reasons }
    }
  }

  const rootNative = nativeIn(files, '')
  if (rootNative) return nativeDetection(rootNative, '', reasons)

  const rootPages = directChildren(files, '').filter(n => /\.html?$/i.test(n))
  if (rootPages.length === 1) {
    reasons.push(`single page ${rootPages[0]} at the project root`)
    const n = named(files, '', engineOf(files, ''))
    return { kind: 'static', engine: n.engine, family: n.family, root: '', entry: rootPages[0]!, outputs: [], reasons }
  }

  const nested = files.filter(f => /^[^/]+\/index\.html$/i.test(f))
  if (nested.length === 1) {
    const root = nested[0]!.split('/')[0]!
    reasons.push(`index.html in ${root}/`)
    const scope = within(files, root)
    const n = named(scope, root, engineOf(scope, root))
    return { kind: 'static', engine: n.engine, family: n.family, root, entry: 'index.html', outputs: [], reasons }
  }

  for (const dir of candidateDirs(files)) {
    if (!dir) continue
    const native = nativeIn(files, dir)
    if (native) return nativeDetection(native, dir, reasons)
  }
  const project = engineProjectIn(files)
  if (project) return nativeDetection(project, '', reasons)
  return null
}

function nativeDetection(native: NativeBuild, root: string, reasons: string[]): Detection {
  reasons.push(`${native.platform === 'project' ? 'engine project' : `${native.platform} build`}${native.engine ? ` (${native.engine})` : ''}: ${native.evidence.join(', ')}`)
  return { kind: 'native', engine: 'html', family: null, root, entry: '', outputs: [], reasons, native }
}
