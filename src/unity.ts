import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { PORTAL_LIMITS } from './constants.js'
import { WizardError } from './errors.js'
import { listFiles, readText, sha256File } from './files.js'

/**
 * Unity: the local editor (found the way Unity Hub installs it), the editor
 * script injected into a scratch copy for a batch-mode WebGL build, the
 * facts of a WebGL build, and the Brotli packing of an uncompressed build
 * that would not fit OriginGame's upload limits otherwise.
 */

export const UNITY_VERSION = /^\d{4,}\.\d+\.\d+[abcfpx]\d+$/

export interface UnityEditor {
  executable: string
  /** The editor's version when its install path shows it (Unity Hub always does). */
  version: string | null
  source: 'UNITY' | 'Unity Hub' | 'PATH'
  /** The WebGL Build Support module (`PlaybackEngines/WebGLSupport`), or null when it is not installed. */
  webgl: string | null
}

function readJsonString(file: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/** The directories Unity Hub installs editors into (one `<version>/` per editor), default and custom. */
export function hubEditorRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir()
  const roots: string[] = []
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (base) roots.push(path.win32.join(base, 'Unity', 'Hub', 'Editor'))
    if (env.APPDATA) { const custom = readJsonString(path.join(env.APPDATA, 'UnityHub', 'secondaryInstallPath.json')); if (custom) roots.push(custom) }
  } else if (platform === 'darwin') {
    roots.push('/Applications/Unity/Hub/Editor', path.join(home, 'Applications', 'Unity', 'Hub', 'Editor'))
    const custom = readJsonString(path.join(home, 'Library', 'Application Support', 'UnityHub', 'secondaryInstallPath.json'))
    if (custom) roots.push(custom)
  } else {
    roots.push(path.join(home, 'Unity', 'Hub', 'Editor'))
    const custom = readJsonString(path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'UnityHub', 'secondaryInstallPath.json'))
    if (custom) roots.push(custom)
  }
  return [...new Set(roots)]
}

/** The editor executable inside one Hub install directory (`<root>/<version>`). */
export function editorExecutable(versionDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(versionDir, 'Editor', 'Unity.exe')
  if (platform === 'darwin') return path.join(versionDir, 'Unity.app', 'Contents', 'MacOS', 'Unity')
  return path.join(versionDir, 'Editor', 'Unity')
}

/** Where the WebGL Build Support module lives for an editor executable, on every platform's layout. */
export function webglSupport(executable: string): string | null {
  const dir = path.dirname(executable)
  const candidates = [
    path.join(dir, 'Data', 'PlaybackEngines', 'WebGLSupport'),
    path.join(dir, 'PlaybackEngines', 'WebGLSupport'),
    // macOS: <version>/Unity.app/Contents/MacOS/Unity → <version>/PlaybackEngines/WebGLSupport
    path.join(dir, '..', '..', '..', 'PlaybackEngines', 'WebGLSupport'),
    path.join(dir, '..', 'PlaybackEngines', 'WebGLSupport'),
  ]
  return candidates.map(c => path.resolve(c)).find(c => fs.existsSync(c) && fs.statSync(c).isDirectory()) ?? null
}

function versionInPath(file: string): string | null {
  return file.split(/[\\/]/).find(part => UNITY_VERSION.test(part)) ?? null
}

/** `UNITY` may name the executable, a macOS `Unity.app`, or a Hub install directory. */
function resolveUnityEnv(value: string): string | null {
  const candidates = [value, path.join(value, 'Contents', 'MacOS', 'Unity'), editorExecutable(value), editorExecutable(value, 'win32'), editorExecutable(value, 'darwin')]
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

/**
 * The editor for `version`: `UNITY` when set, else the Unity Hub install of
 * exactly that version, else a `Unity` on PATH. `installed` lists the Hub
 * versions that are there, for the error message.
 */
export function findUnityEditor(version: string | null, env: NodeJS.ProcessEnv = process.env): { editor: UnityEditor | null; installed: string[]; problem: string | null } {
  const installed: string[] = []
  for (const root of hubEditorRoots(env)) {
    let entries: string[] = []
    try { entries = fs.readdirSync(root) } catch { continue }
    for (const name of entries) if (UNITY_VERSION.test(name) && fs.existsSync(editorExecutable(path.join(root, name)))) installed.push(name)
  }
  const unique = [...new Set(installed)].sort()
  if (env.UNITY) {
    const executable = resolveUnityEnv(env.UNITY)
    if (!executable) return { editor: null, installed: unique, problem: `UNITY=${env.UNITY} is not a Unity Editor executable` }
    return { editor: { executable, version: versionInPath(executable), source: 'UNITY', webgl: webglSupport(executable) }, installed: unique, problem: null }
  }
  if (version) {
    for (const root of hubEditorRoots(env)) {
      const executable = editorExecutable(path.join(root, version))
      if (fs.existsSync(executable)) return { editor: { executable, version, source: 'Unity Hub', webgl: webglSupport(executable) }, installed: unique, problem: null }
    }
  }
  for (const name of process.platform === 'win32' ? ['Unity.exe'] : ['Unity', 'unity-editor']) {
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const full = path.join(dir, name)
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const real = fs.realpathSync(full)
        const found = versionInPath(real)
        if (version && found && found !== version) continue
        return { editor: { executable: full, version: found, source: 'PATH', webgl: webglSupport(real) }, installed: unique, problem: null }
      }
    }
  }
  return { editor: null, installed: unique, problem: null }
}

/** The person-facing steps to get the right editor, for a Unity project of `version`. */
export function installEditorSteps(version: string | null, revision: string | null, installed: string[]): string {
  const v = version ?? 'the version in ProjectSettings/ProjectVersion.txt'
  return [
    `Unity ${v} is not installed${installed.length ? ` (Unity Hub has ${installed.join(', ')})` : ''}.`,
    `Install it with Unity Hub: Installs > Install Editor > Archive > "download archive", pick ${v}${revision && version ? ` (or open unityhub://${version}/${revision})` : ''},`,
    'and tick the module "Web Build Support" ("WebGL Build Support" before Unity 6). Then run npx origingame again.',
    'To use an editor you already have, set UNITY=/path/to/Unity (the build runs in a scratch copy, so an upgrade never touches your project).',
  ].join('\n')
}

export function webglModuleSteps(editor: UnityEditor): string {
  const v = editor.version ?? 'this editor'
  return [
    `Unity ${v} (${editor.executable}) has no WebGL Build Support module.`,
    `Add it in Unity Hub: Installs > ${v} > the gear (Manage) > Add modules > tick "Web Build Support" ("WebGL Build Support" before Unity 6) > Install,`,
    'then run npx origingame again.',
  ].join('\n')
}

/** The class and method the batch-mode build runs (`-executeMethod`). */
export const BUILD_METHOD = 'OriginGameWizardBuild.BuildWebGL'
/** Where the build script goes in the scratch copy, with its own Editor-only assembly so asmdef layouts cannot exclude it. */
export const BUILD_SCRIPT_DIR = 'Assets/OriginGameWizard/Editor'

const BUILD_SCRIPT = `// Written by Origin Wizard (npx origingame) into a scratch copy of the project
// for one batch-mode WebGL build. It is never written to your project.
#if UNITY_EDITOR
using System;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class OriginGameWizardBuild
{
    public static void BuildWebGL()
    {
        string output = Argument("-originGameOutput");
        if (string.IsNullOrEmpty(output)) { Fail(2, "-originGameOutput is missing"); return; }
        string[] scenes = EditorBuildSettings.scenes.Where(s => s.enabled && !string.IsNullOrEmpty(s.path)).Select(s => s.path).ToArray();
        if (scenes.Length == 0) { Fail(3, "no enabled scenes in File > Build Settings (Build Profiles in Unity 6): add your scenes there and run again"); return; }
        if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL)) { Fail(4, "WebGL Build Support is not installed for this editor"); return; }
        var options = new BuildPlayerOptions { scenes = scenes, locationPathName = output, target = BuildTarget.WebGL, targetGroup = BuildTargetGroup.WebGL, options = BuildOptions.None };
        BuildReport report = BuildPipeline.BuildPlayer(options);
        Debug.Log("[OriginGameWizard] result " + report.summary.result + ", " + report.summary.totalErrors + " errors, " + report.summary.totalSize + " bytes, scenes " + string.Join(", ", scenes));
        EditorApplication.Exit(report.summary.result == BuildResult.Succeeded ? 0 : 1);
    }

    static void Fail(int code, string message)
    {
        Debug.LogError("[OriginGameWizard] " + message);
        EditorApplication.Exit(code);
    }

    static string Argument(string name)
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
        return null;
    }
}
#endif
`

const BUILD_ASMDEF = `${JSON.stringify({ name: 'OriginGameWizard.Editor', includePlatforms: ['Editor'], autoReferenced: false }, null, 2)}\n`

/** Writes the build script into the scratch project; returns the files written (relative). */
export function injectBuildScript(project: string): string[] {
  const dir = path.join(project, ...BUILD_SCRIPT_DIR.split('/'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'OriginGameWizardBuild.cs'), BUILD_SCRIPT)
  fs.writeFileSync(path.join(dir, 'OriginGameWizard.Editor.asmdef'), BUILD_ASMDEF)
  return [`${BUILD_SCRIPT_DIR}/OriginGameWizardBuild.cs`, `${BUILD_SCRIPT_DIR}/OriginGameWizard.Editor.asmdef`]
}

export function batchArgs(project: string, output: string, log: string): string[] {
  return ['-batchmode', '-nographics', '-quit', '-projectPath', project, '-buildTarget', 'WebGL', '-executeMethod', BUILD_METHOD, '-logFile', log, '-originGameOutput', output]
}

/** A short, actionable reading of a failed Unity log. */
export function explainUnityLog(log: string): string | null {
  if (/No valid Unity Editor license|License is not active|com\.unity\.editor\.headless|Unity has not been activated|LICENSE SYSTEM.*(?:No ULF|not activated|failed)/i.test(log)) {
    return 'Unity needs an activated license for batch builds: open Unity Hub, sign in, and add a license under Preferences > Licenses (Personal is free), then run again.'
  }
  const wizard = /\[OriginGameWizard\] (.+)/.exec(log)
  if (wizard && !/^result Succeeded/.test(wizard[1]!)) return `the build script reports: ${wizard[1]!.trim()}`
  if (/Scripts have compiler errors|error CS\d{4}/.test(log)) {
    const first = /^.*error CS\d{4}.*$/m.exec(log)?.[0]?.trim()
    return `your project's scripts do not compile for WebGL${first ? ` (${first})` : ''}; open the project in Unity, switch to WebGL in Build Settings, fix the errors and run again`
  }
  if (/executeMethod.*could not be found|Invalid method name/i.test(log)) return "the editor could not run the Wizard's build script, usually because the project's scripts do not compile; open the project in Unity and fix the console errors"
  if (/another Unity instance is running|Multiple Unity instances cannot open the same project/i.test(log)) return 'another Unity instance holds the project; close it and run again'
  return null
}

/**
 * The Library cache: Unity's import cache, kept under ~/.origingame/unity/
 * per project between runs so only the first build pays for importing every
 * asset. It moves into the scratch copy for the build and back afterwards.
 */
export function libraryCache(home: string, key: string): string {
  return path.join(home, 'unity', key.slice(0, 32), 'Library')
}

// ---------------------------------------------------------------------------
// The facts of a WebGL build.

export type BuildCompression = 'brotli' | 'gzip' | 'fallback' | 'none'

export interface UnityBuildFile { path: string; role: 'data' | 'framework' | 'code' | 'symbols' | 'other'; compression: 'br' | 'gz' | 'unityweb' | null; bytes: number }

export interface UnityBuild {
  loader: string
  legacy: boolean
  files: UnityBuildFile[]
  /** Brotli or gzip files the server must send with Content-Encoding; `fallback` when the loader decompresses `.unityweb` itself. */
  compression: BuildCompression
  /** The default template's fixed-size canvas, when the page has one. */
  fixedCanvas: { width: number; height: number } | null
  /** The PWA template's service worker registration, exactly as Unity writes it. */
  serviceWorker: { file: string; worker: string | null; manifest: string | null } | null
}

const PWA_REGISTER = /navigator\.serviceWorker\.register\(\s*(["'])ServiceWorker\.js\1\s*\)\s*;/

/** A Unity WebGL build at the root of `site`, or null. */
export function unityBuildIn(site: string, entry = 'index.html'): UnityBuild | null {
  const buildDir = path.join(site, 'Build')
  if (!fs.existsSync(buildDir) || !fs.statSync(buildDir).isDirectory()) return null
  const names = fs.readdirSync(buildDir).filter(n => fs.statSync(path.join(buildDir, n)).isFile())
  const loader = names.find(n => /\.loader\.js$/i.test(n)) ?? (names.includes('UnityLoader.js') ? 'UnityLoader.js' : undefined)
  if (!loader) return null
  const files: UnityBuildFile[] = names.filter(n => n !== loader).map(n => {
    const compression = /\.br$/i.test(n) ? 'br' : /\.gz$/i.test(n) ? 'gz' : /\.unityweb$/i.test(n) ? 'unityweb' : null
    const bare = n.replace(/\.(br|gz|unityweb)$/i, '')
    const role = /\.data$/i.test(bare) ? 'data' : /\.framework\.js$/i.test(bare) ? 'framework' : /\.wasm$/i.test(bare) ? 'code' : /\.symbols\.json$/i.test(bare) ? 'symbols' : 'other'
    return { path: `Build/${n}`, role, compression, bytes: fs.statSync(path.join(buildDir, n)).size }
  })
  const served = files.filter(f => f.role !== 'other' && f.role !== 'symbols')
  const compression: BuildCompression = served.some(f => f.compression === 'br') ? 'brotli' : served.some(f => f.compression === 'gz') ? 'gzip' : served.some(f => f.compression === 'unityweb') ? 'fallback' : 'none'
  const html = readText(path.join(site, entry), 1024 * 1024) ?? ''
  let fixedCanvas: UnityBuild['fixedCanvas'] = null
  const canvas = /<canvas[^>]*id=["']?unity-canvas["']?[^>]*>/i.exec(html)?.[0] ?? ''
  const attr = /\bwidth\s*=\s*["']?(\d+)[^>]*\bheight\s*=\s*["']?(\d+)/i.exec(canvas)
  const styled = /canvas\.style\.width\s*=\s*["'](\d+)px["'][\s\S]{0,200}?canvas\.style\.height\s*=\s*["'](\d+)px["']/.exec(html)
  const legacy = /<div[^>]*id=["']unityContainer["'][^>]*style=["'][^"']*width:\s*(\d+)px;\s*height:\s*(\d+)px/i.exec(html)
  const fills = /canvas\.style\.width\s*=\s*["']100%|#unity-canvas\s*\{[^}]*width\s*:\s*100%|<canvas[^>]*id=["']?unity-canvas["']?[^>]*style=["'][^"']*width\s*:\s*100%/i.test(html)
  const fixed = styled ?? attr ?? legacy
  if (!fills && fixed) fixedCanvas = { width: Number(fixed[1]), height: Number(fixed[2]) }
  let serviceWorker: UnityBuild['serviceWorker'] = null
  if (PWA_REGISTER.test(html)) {
    const manifest = /<link[^>]*rel=["']manifest["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? null
    serviceWorker = { file: entry, worker: fs.existsSync(path.join(site, 'ServiceWorker.js')) ? 'ServiceWorker.js' : null, manifest: manifest && !/^[a-z]+:|^\//i.test(manifest) && fs.existsSync(path.join(site, manifest)) ? manifest : null }
  }
  return { loader: `Build/${loader}`, legacy: loader === 'UnityLoader.js', files, compression, fixedCanvas, serviceWorker }
}

/** Turns off the PWA template's service worker: the registration becomes a no-op and the worker and manifest are left out. */
export function disableUnityServiceWorker(site: string, sw: NonNullable<UnityBuild['serviceWorker']>): string[] {
  const file = path.join(site, sw.file)
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(PWA_REGISTER, 'void 0; /* OriginGame: offline caching belongs to the Player */')
    .replace(/[ \t]*<link[^>]*rel=["']manifest["'][^>]*>[ \t]*\r?\n?/i, '')
  const done: string[] = []
  if (next !== text) { fs.writeFileSync(file, next); done.push(`service worker registration turned off in ${sw.file}`) }
  for (const extra of [sw.worker, sw.manifest]) {
    if (extra) { fs.rmSync(path.join(site, extra), { force: true }); done.push(`left out ${extra}`) }
  }
  return done
}

// ---------------------------------------------------------------------------
// origingame.runtime.json

export const RUNTIME_FILE = 'origingame.runtime.json'

/**
 * The release's runtime declaration (`{"version":1, ...}`), or null when there
 * is none. `invalid` when a file is there but is not a version-1 object: the
 * Wizard never rewrites a declaration it cannot read.
 */
export function readRuntime(site: string): Record<string, unknown> | null | 'invalid' {
  const file = path.join(site, RUNTIME_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 ? value as Record<string, unknown> : 'invalid'
  } catch {
    return 'invalid'
  }
}

/** Adds `fields` to the declaration, keeping every field already there. Returns false when the file is unreadable. */
export function mergeRuntime(site: string, fields: Record<string, true>): boolean {
  const current = readRuntime(site)
  if (current === 'invalid') return false
  fs.writeFileSync(path.join(site, RUNTIME_FILE), `${JSON.stringify({ ...(current ?? { version: 1 }), ...fields })}\n`)
  return true
}

// ---------------------------------------------------------------------------
// Packing: Brotli for an uncompressed build that is over the limits.

export interface PackPlan { files: Array<{ path: string; ref: string }>; reason: string }

const overLimits = (sizes: Map<string, number>) => {
  let total = 0
  let big: string | null = null
  for (const [file, bytes] of sizes) { total += bytes; if (bytes > PORTAL_LIMITS.maxFileBytes && !big) big = file }
  return { total, big, over: total > PORTAL_LIMITS.maxTotalBytes || big !== null }
}

export function sizesOf(site: string): Map<string, number> {
  return new Map(listFiles(site).map(f => [f, fs.statSync(path.join(site, f)).size]))
}

/** Advice for a Unity build that is too large, in Unity's own menu names. */
export function unitySizeAdvice(build: UnityBuild | null): string {
  return [
    build && build.compression === 'none' ? 'enable compression (Player Settings > Publishing Settings > Compression Format: Brotli),' : null,
    'lower texture sizes (Max Size and Compression in the texture import settings, or Crunch Compression),',
    'set Managed Stripping Level to High and leave out unused scenes and assets, and load large optional content',
    'with Addressables from a CDN you control (it must allow cross-origin requests). OriginGame accepts files up to 50 MiB and 200 MiB in total.',
  ].filter(Boolean).join(' ')
}

/**
 * Which files of an uncompressed Unity build to Brotli-compress so the release
 * fits, or null when it already fits or packing cannot be done safely. Every
 * packed file must be named exactly once in the page's loader config.
 */
export function planPack(site: string, entry: string): PackPlan | null | { refused: string } {
  const build = unityBuildIn(site, entry)
  const sizes = sizesOf(site)
  if (!overLimits(sizes).over) return null
  if (!build || build.legacy) return null
  if (build.compression !== 'none') return null
  const targets = build.files.filter(f => f.role === 'data' || f.role === 'framework' || f.role === 'code')
  if (!targets.length) return null
  const html = readText(path.join(site, entry), 4 * 1024 * 1024) ?? ''
  const files: PackPlan['files'] = []
  for (const target of targets) {
    const name = path.posix.basename(target.path)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const refs = [...html.matchAll(new RegExp(`(["'])((?:[^"'\\n]*/)?${escaped})\\1`, 'g'))]
    if (refs.length !== 1) return { refused: `${entry} names ${name} ${refs.length} times in its loader config (expected once), so the Wizard cannot point it at a compressed copy` }
    files.push({ path: target.path, ref: refs[0]![0] })
  }
  const big = overLimits(sizes)
  return { files, reason: big.big ? `${big.big} is ${(sizes.get(big.big)! / 1048576).toFixed(1)} MiB` : `the build is ${(big.total / 1048576).toFixed(1)} MiB` }
}

async function brotli(from: string, to: string, quality: number): Promise<void> {
  const size = fs.statSync(from).size
  await pipeline(fs.createReadStream(from), zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } }), fs.createWriteStream(to))
}

/**
 * Compresses the planned files into `cache` (keyed by content, so a second
 * pass of the same run reuses them) and returns the sizes the release would
 * have. Nothing in `site` changes.
 */
export async function compressPlanned(site: string, plan: PackPlan, cache: string): Promise<Map<string, { packed: string; bytes: number }>> {
  fs.mkdirSync(cache, { recursive: true })
  const out = new Map<string, { packed: string; bytes: number }>()
  for (const quality of [9, 11]) {
    out.clear()
    for (const file of plan.files) {
      const source = path.join(site, file.path)
      const packed = path.join(cache, `${sha256File(source)}.q${quality}.br`)
      if (!fs.existsSync(packed)) {
        await brotli(source, `${packed}.tmp`, quality)
        fs.renameSync(`${packed}.tmp`, packed)
      }
      out.set(file.path, { packed, bytes: fs.statSync(packed).size })
    }
    const sizes = sizesOf(site)
    for (const [file, p] of out) { sizes.delete(file); sizes.set(`${file}.br`, p.bytes) }
    if (!overLimits(sizes).over) break
  }
  return out
}

/** Whether the sizes after packing fit, and if not why. */
export function packedFits(site: string, packed: Map<string, { bytes: number }>): string | null {
  const sizes = sizesOf(site)
  for (const [file, p] of packed) { sizes.delete(file); sizes.set(`${file}.br`, p.bytes) }
  const after = overLimits(sizes)
  if (!after.over) return null
  return after.big ? `${after.big} is still ${(sizes.get(after.big)! / 1048576).toFixed(1)} MiB after Brotli compression` : `the build is still ${(after.total / 1048576).toFixed(1)} MiB after Brotli compression`
}

/** Replaces the planned files by their `.br` copies, points the loader config at them and declares `precompressed`. */
export function applyPack(site: string, entry: string, plan: PackPlan, packed: Map<string, { packed: string }>): string[] {
  const page = path.join(site, entry)
  let html = fs.readFileSync(page, 'utf8')
  const done: string[] = []
  for (const file of plan.files) {
    const p = packed.get(file.path)!
    fs.copyFileSync(p.packed, path.join(site, `${file.path}.br`))
    fs.rmSync(path.join(site, file.path))
    const quote = file.ref[0]!
    html = html.replace(file.ref, `${file.ref.slice(0, -1)}.br${quote}`)
    done.push(`compressed ${file.path} with Brotli (${file.path}.br)`)
  }
  fs.writeFileSync(page, html)
  if (!mergeRuntime(site, { precompressed: true })) throw new WizardError('upload_failed', `${RUNTIME_FILE} in the build is not a version-1 JSON object, so the Wizard cannot declare the compressed files; fix or remove it`)
  done.push(`${RUNTIME_FILE} declares precompressed`)
  return done
}
