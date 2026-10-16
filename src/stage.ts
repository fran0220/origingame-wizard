import fs from 'node:fs'
import path from 'node:path'
import { PORTAL_LIMITS } from './constants.js'
import { WizardError } from './errors.js'
import { listFiles, sha256 } from './files.js'
import { isSecretFile } from './secrets.js'

export interface Excluded { path: string; reason: string }

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '__MACOSX', '.godot', '.import'])
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Why a build file stays out of the staged copy, or null to stage it. */
export function exclusionReason(file: string): string | null {
  const parts = file.split('/')
  const name = parts.at(-1)!
  if (parts.some(p => SKIP_DIRS.has(p))) return 'tooling directory'
  if (parts[0] === '__og') return 'platform-generated files are not source'
  if (isSecretFile(file)) return 'credential file'
  if (JUNK.has(name)) return 'system file'
  if (name.endsWith('.map')) return 'source map'
  if (parts.some(p => p.startsWith('.') && p !== '.well-known')) return 'hidden file'
  return null
}

/**
 * Copies the build output into `site` (the staged copy). Only this copy is
 * adapted and uploaded; the project and its build output are never changed.
 */
export function stageCopy(outputDir: string, site: string): { files: string[]; excluded: Excluded[] } {
  fs.rmSync(site, { recursive: true, force: true })
  fs.mkdirSync(site, { recursive: true })
  const excluded: Excluded[] = []
  const files: string[] = []
  for (const file of listFiles(outputDir, new Set(['.git', 'node_modules']))) {
    const reason = exclusionReason(file)
    if (reason) { excluded.push({ path: file, reason }); continue }
    const target = path.join(site, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(outputDir, file), target)
    files.push(file)
  }
  return { files, excluded }
}

export interface ManifestEntry { path: string; sizeBytes: number; sha256: string }
export interface Manifest { entries: ManifestEntry[]; hash: string; totalBytes: number; local: Map<string, string> }

/** The canonical source manifest, hashed exactly as Portal hashes it (`stageSha256`). */
export function stageManifest(site: string): Manifest {
  const local = new Map<string, string>()
  const entries = listFiles(site).map(file => {
    const data = fs.readFileSync(path.join(site, file))
    const name = file.normalize('NFC')
    local.set(name, path.join(site, file))
    return { path: name, sizeBytes: data.byteLength, sha256: sha256(data) }
  }).sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
  const json = JSON.stringify({ version: 1, files: entries })
  return { entries, hash: sha256(json), totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0), local }
}

/** Fails before any upload (or model spend) when Portal would refuse the files. */
export function checkPortalLimits(manifest: Manifest): void {
  const { entries } = manifest
  if (!entries.some(e => e.path === 'index.html')) throw new WizardError('upload_failed', 'the staged build has no index.html at its root')
  if (entries.length > PORTAL_LIMITS.maxFiles) throw new WizardError('upload_failed', `the build has ${entries.length} files; OriginGame accepts at most ${PORTAL_LIMITS.maxFiles}`)
  if (manifest.totalBytes > PORTAL_LIMITS.maxTotalBytes) throw new WizardError('upload_failed', `the build is ${(manifest.totalBytes / 1048576).toFixed(1)} MiB; OriginGame accepts at most 200 MiB`)
  const folded = new Set<string>()
  for (const entry of entries) {
    if (entry.sizeBytes > PORTAL_LIMITS.maxFileBytes) throw new WizardError('upload_failed', `${entry.path} is ${(entry.sizeBytes / 1048576).toFixed(1)} MiB; OriginGame accepts files up to 50 MiB`)
    if (entry.path.length > 1024 || entry.path.includes('%') || entry.path.includes('\\') || /[\x00-\x1f\x7f]/.test(entry.path)) {
      throw new WizardError('upload_failed', `OriginGame does not accept the file name ${JSON.stringify(entry.path)} (no %, backslash or control characters); rename it in your project`)
    }
    const lower = entry.path.toLocaleLowerCase('en-US')
    if (folded.has(lower)) throw new WizardError('upload_failed', `two files differ only in letter case (${entry.path}); OriginGame needs case-unique names`)
    folded.add(lower)
  }
}
