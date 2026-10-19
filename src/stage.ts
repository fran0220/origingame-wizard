import fs from 'node:fs'
import path from 'node:path'
import { formatBytes, type Limits } from './constants.js'
import { WizardError } from './errors.js'
import { hashFile, listFiles, sha256 } from './files.js'
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

/**
 * The canonical source manifest, hashed exactly as Portal hashes it
 * (`stageSha256`). Files are read as streams, a few at a time, so memory stays
 * bounded whatever their size.
 */
export async function stageManifest(site: string): Promise<Manifest> {
  const local = new Map<string, string>()
  const files = listFiles(site)
  const entries: ManifestEntry[] = new Array(files.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < files.length; i = next++) {
      const file = files[i]!
      const { sha256: digest, size } = await hashFile(path.join(site, file))
      const name = file.normalize('NFC')
      local.set(name, path.join(site, file))
      entries[i] = { path: name, sizeBytes: size, sha256: digest }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
  const json = JSON.stringify({ version: 1, files: entries })
  return { entries, hash: sha256(json), totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0), local }
}

/** The same limits from sizes alone (no hashing), right after staging and before any model call. */
export function precheckPortalLimits(site: string, limits: Limits): void {
  const entries = listFiles(site).map(file => ({ path: file.normalize('NFC'), sizeBytes: fs.statSync(path.join(site, file)).size, sha256: '' }))
  const ignoreEntry = { entries: entries.some(e => e.path === 'index.html') ? entries : [...entries, { path: 'index.html', sizeBytes: 0, sha256: '' }] }
  checkPortalLimits({ ...ignoreEntry, hash: '', totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0), local: new Map() }, limits)
}

/** Fails before any upload (or model spend) when Portal would refuse the files. */
export function checkPortalLimits(manifest: Manifest, limits: Limits): void {
  const { entries } = manifest
  const { maxFiles, maxFileBytes, maxTotalBytes } = limits.portal
  if (!entries.some(e => e.path === 'index.html')) throw new WizardError('upload_failed', 'the staged build has no index.html at its root')
  if (entries.length > maxFiles) throw new WizardError('upload_failed', `the build has ${entries.length} files; OriginGame accepts at most ${maxFiles.toLocaleString('en-US')}`)
  if (manifest.totalBytes > maxTotalBytes) throw new WizardError('upload_failed', `the build is ${(manifest.totalBytes / 1048576).toFixed(1)} MiB; OriginGame accepts at most ${formatBytes(maxTotalBytes)} in total`)
  const folded = new Set<string>()
  for (const entry of entries) {
    if (entry.sizeBytes > maxFileBytes) throw new WizardError('upload_failed', `${entry.path} is ${(entry.sizeBytes / 1048576).toFixed(1)} MiB; OriginGame accepts files up to ${formatBytes(maxFileBytes)}`)
    if (entry.path.length > 1024 || entry.path.includes('%') || entry.path.includes('\\') || /[\x00-\x1f\x7f]/.test(entry.path)) {
      throw new WizardError('upload_failed', `OriginGame does not accept the file name ${JSON.stringify(entry.path)} (no %, backslash or control characters); rename it in your project`)
    }
    const lower = entry.path.toLocaleLowerCase('en-US')
    if (folded.has(lower)) throw new WizardError('upload_failed', `two files differ only in letter case (${entry.path}); OriginGame needs case-unique names`)
    folded.add(lower)
  }
}
