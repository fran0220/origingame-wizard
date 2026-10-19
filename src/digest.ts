import fs from 'node:fs'
import path from 'node:path'
import { UNITY_CACHE_DIRS, type Detection } from './detect.js'
import { isTextFile, listFiles, projectSkip, readText } from './files.js'
import type { Findings } from './findings.js'
import { findSecrets, isSecretFile } from './secrets.js'
import { exclusionReason } from './stage.js'

export type Scope = 'build' | 'source'

export interface Withheld { scope: Scope; path: string; reason: string }

export interface FileContent { scope: Scope; path: string; text: string; truncated: boolean }

/**
 * What the model sees: file lists, a bounded set of text files and the
 * deterministic findings. Every file passes the secret scanner first: a
 * credential file or a file with a credential-looking line is withheld by
 * name only, never by content.
 */
export interface Digest {
  project: { kind: string; engine: string; family: string | null; reasons: string[]; unity?: Detection['unity'] }
  build_files: Array<{ path: string; bytes: number }>
  source_files: Array<{ path: string; bytes: number }>
  more_build_files: number
  more_source_files: number
  contents: FileContent[]
  withheld: Withheld[]
  findings: Omit<Findings, 'items'> & { planned: Array<{ id: string; kind: string; title: string; reason: string }> }
}

const SOURCE_SKIP = new Set(['node_modules', '.git', '.godot', '.import', 'dist', '.cache', '.vite', '.next', 'coverage', 'cooked', 'og-out', '.og'])
const MAX_LIST = 250
const TOTAL_BUDGET = 120 * 1024

export class ContextReader {
  readonly withheld: Withheld[] = []
  private used = 0
  constructor(private readonly roots: Record<Scope, string | null>) {}

  /** A text file inside `scope`, or null (and recorded as withheld) when it must not be sent. */
  read(scope: Scope, relative: string, max: number, filterLines?: (line: string) => boolean): FileContent | null {
    const root = this.roots[scope]
    if (!root) return null
    const normalized = path.posix.normalize(relative.replace(/\\/g, '/'))
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return null
    const absolute = path.join(root, normalized)
    if (!absolute.startsWith(path.resolve(root) + path.sep)) return null
    if (isSecretFile(normalized) || exclusionReason(normalized) === 'credential file') {
      this.withhold(scope, normalized, 'credential file')
      return null
    }
    if (!isTextFile(normalized) && !/(^|\/)(project\.godot|export_presets\.cfg)$/.test(normalized)) return null
    if (this.used >= TOTAL_BUDGET) return null
    let text = readText(absolute, 4 * 1024 * 1024)
    if (text === null) return null
    if (filterLines) text = text.split('\n').filter(filterLines).join('\n')
    const hits = findSecrets(text)
    if (hits.length) {
      this.withhold(scope, normalized, `possible ${hits[0]!.kind} on line ${hits[0]!.line}`)
      return null
    }
    const budget = Math.min(max, TOTAL_BUDGET - this.used)
    const truncated = text.length > budget
    const out = truncated ? `${text.slice(0, budget)}\n…[truncated]` : text
    this.used += out.length
    return { scope, path: normalized, text: out, truncated }
  }

  private withhold(scope: Scope, file: string, reason: string) {
    if (!this.withheld.some(w => w.scope === scope && w.path === file)) this.withheld.push({ scope, path: file, reason })
  }
}

function listing(root: string, files: string[]): Array<{ path: string; bytes: number }> {
  return files.slice(0, MAX_LIST).map(file => ({ path: file, bytes: fs.statSync(path.join(root, file)).size }))
}

const isMinified = (text: string) => {
  const lines = text.split('\n')
  return text.length > 2000 && text.length / Math.max(1, lines.length) > 300
}

export function buildDigest(input: { projectDir: string; site: string; detection: Detection; findings: Findings; hasSource: boolean }): { digest: Digest; reader: ContextReader } {
  const { projectDir, site, detection, findings } = input
  const sourceRoot = input.hasSource ? projectDir : null
  const reader = new ContextReader({ build: site, source: sourceRoot })
  const buildFiles = listFiles(site)
  const sourceSkip = sourceRoot ? projectSkip(sourceRoot, SOURCE_SKIP, UNITY_CACHE_DIRS) : () => false
  // Unity's .meta files sit beside every asset and say nothing about the game.
  const sourceFiles = sourceRoot ? listFiles(sourceRoot, sourceSkip).filter(f => (!exclusionReason(f) || exclusionReason(f) === 'source map') && !f.endsWith('.meta')) : []
  const contents: FileContent[] = []
  const push = (c: FileContent | null) => { if (c) contents.push(c) }

  push(reader.read('build', 'index.html', 24 * 1024) ?? reader.read('build', detection.entry, 24 * 1024))
  if (sourceRoot) {
    for (const name of ['project.ogt', 'package.json', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'project.godot', 'ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'README.md']) {
      if (sourceFiles.includes(name)) push(reader.read('source', name, name === 'README.md' ? 4 * 1024 : 8 * 1024))
    }
    if (sourceFiles.includes('export_presets.cfg')) {
      push(reader.read('source', 'export_presets.cfg', 6 * 1024, line => !/pass|keystore|key|secret|token|user/i.test(line)))
    }
    const code = sourceFiles.filter(f => /\.(m?[jt]sx?|vue|svelte|gd|cs)$/.test(f) && !/\.(test|spec|d)\.[jt]sx?$/.test(f) && !f.startsWith('public/') && !/^Packages\//.test(f) && !/(^|\/)Editor\//.test(f))
    const ranked = code.sort((a, b) => {
      const main = (f: string) => /(^|\/)(main|index|game|app|gamemanager|player)\.[a-z]+$/i.test(f) ? 0 : 1
      return main(a) - main(b) || fs.statSync(path.join(sourceRoot, a)).size - fs.statSync(path.join(sourceRoot, b)).size
    })
    for (const file of ranked.slice(0, 24)) push(reader.read('source', file, 12 * 1024))
  } else {
    const scripts = buildFiles.filter(f => /\.(m?js)$/.test(f) && f !== 'index.html')
    for (const file of scripts.slice(0, 12)) {
      const text = readText(path.join(site, file), 64 * 1024) ?? ''
      if (!isMinified(text)) push(reader.read('build', file, 10 * 1024))
    }
  }
  if (sourceRoot) for (const file of listFiles(sourceRoot, sourceSkip).filter(f => isSecretFile(f))) reader.read('source', file, 0)

  const { items, ...facts } = findings
  const digest: Digest = {
    project: { kind: detection.kind, engine: detection.engine, family: detection.family?.label ?? null, reasons: detection.reasons, ...(detection.unity ? { unity: detection.unity } : {}) },
    build_files: listing(site, buildFiles),
    source_files: sourceRoot ? listing(sourceRoot, sourceFiles) : [],
    more_build_files: Math.max(0, buildFiles.length - MAX_LIST),
    more_source_files: Math.max(0, sourceFiles.length - MAX_LIST),
    contents,
    withheld: reader.withheld,
    findings: { ...facts, planned: items.map(i => ({ id: i.id, kind: i.kind, title: i.title, reason: i.reason })) },
  }
  return { digest, reader }
}
