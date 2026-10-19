import fs from 'node:fs'
import path from 'node:path'
import { readText } from './files.js'

/**
 * Origin Engine (the engine's docs/web-export.md): a project is a directory
 * with `project.ogt`; `og build . --publish` writes a static directory with
 * `og-build.json` (the build manifest), `index.html` carrying
 * `<meta name="og-engine">`, the web host (`origin-engine.js`,
 * `origin-engine_bg.wasm`), `cooked/` (with its `.cook.ogt` manifest, which
 * the engine fetches at start), `_headers`, `origingame.runtime.json` unless
 * isolation is off, and the PWA (`sw.js`, `manifest.webmanifest`). Portal
 * keeps that PWA for an `origin-engine` release, so the Wizard publishes the
 * directory exactly as og wrote it.
 */
export const OG_BUILD_MANIFEST = 'og-build.json'

export interface OgBuild {
  /** `publish` for `og build --publish`, `dev` for a plain `og build`; null when the manifest does not say. */
  build: 'publish' | 'dev' | null
  /** project.ogt `publish.isolation`: `required`, `preferred` or `off`; null when the manifest does not say. */
  isolation: 'required' | 'preferred' | 'off' | null
  /** Every file og wrote (relative paths), og-build.json included. */
  files: Set<string>
}

/** og-build.json in `dir`, when it is an Origin Engine build manifest. */
export function readOgBuild(dir: string): OgBuild | null {
  const text = readText(path.join(dir, OG_BUILD_MANIFEST), 8 * 1024 * 1024)
  if (text === null) return null
  let manifest: any
  try { manifest = JSON.parse(text) } catch { return null }
  if (manifest?.engine?.name !== 'origin-engine') return null
  const files = new Set<string>([OG_BUILD_MANIFEST])
  for (const f of Array.isArray(manifest.files) ? manifest.files : []) if (typeof f?.path === 'string') files.add(f.path)
  const build = manifest.build === 'publish' || manifest.build === 'dev' ? manifest.build : null
  const isolation = ['required', 'preferred', 'off'].includes(manifest.crossOriginIsolation) ? manifest.crossOriginIsolation : null
  return { build, isolation, files }
}

/** project.ogt's `publish { out "…" }`, when it names a directory inside the project. */
export function publishOut(projectOgt: string | null): string | null {
  const block = /^\s*publish\s*\{([\s\S]*?)^\s*\}/m.exec(projectOgt ?? '')?.[1] ?? ''
  const out = /^\s*out\s+"([^"]+)"/m.exec(block)?.[1]
  if (!out) return null
  const normalized = path.posix.normalize(out.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '')
  return !normalized || normalized === '.' || normalized.startsWith('..') || path.posix.isAbsolute(normalized) ? null : normalized
}

/** The `og` command: `OG`, the project's `node_modules/.bin/og` (from `@origingame/engine`), then `og` on PATH. */
export function findOg(projectDir: string): string | null {
  const win = process.platform === 'win32'
  const names = win ? ['og.cmd', 'og.exe', 'og'] : ['og']
  if (process.env.OG) return fs.existsSync(process.env.OG) ? process.env.OG : null
  for (const name of names) {
    const local = path.join(projectDir, 'node_modules', '.bin', name)
    if (fs.existsSync(local)) return local
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const full = path.join(dir, name)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}
