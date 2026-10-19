import fs from 'node:fs'
import path from 'node:path'
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
 * `keep` names files an engine wrote and its runtime fetches, which are staged
 * even when hidden (an og build's `cooked/.cook.ogt`, the cook manifest the
 * engine loads first).
 */
export function stageCopy(outputDir: string, site: string, keep?: ReadonlySet<string> | 'hidden'): { files: string[]; excluded: Excluded[] } {
  fs.rmSync(site, { recursive: true, force: true })
  fs.mkdirSync(site, { recursive: true })
  const excluded: Excluded[] = []
  const files: string[] = []
  for (const file of listFiles(outputDir, new Set(['.git', 'node_modules']))) {
    const reason = exclusionReason(file)
    if (reason && !(reason === 'hidden file' && (keep === 'hidden' || keep?.has(file)))) { excluded.push({ path: file, reason }); continue }
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
