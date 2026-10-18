import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const toPosix = (p: string) => p.split(path.sep).join('/')

/**
 * Regular files under `dir`, relative and `/`-separated, sorted. Directories
 * named in `skip` (or for which it returns true, given the directory's path
 * relative to `dir`) are not entered; symbolic links are not followed.
 */
export function listFiles(dir: string, skip: ReadonlySet<string> | ((relative: string) => boolean) = new Set()): string[] {
  const out: string[] = []
  const skipped = typeof skip === 'function' ? skip : (relative: string) => skip.has(path.posix.basename(relative))
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!skipped(toPosix(path.relative(dir, absolute)))) visit(absolute)
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(dir, absolute)))
      }
    }
  }
  visit(dir)
  return out.sort()
}

/** At most `max` bytes of a file as UTF-8, or null. */
export function readText(file: string, max = 256 * 1024): string | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, max))
      fs.readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function sha256File(file: string): string {
  return sha256(fs.readFileSync(file))
}

/**
 * Skips `names` anywhere, and a Unity project's caches (`Library/`, `Temp/` …)
 * at the top of `dir` when `dir` is a Unity project: they can hold hundreds of
 * thousands of files and are never part of the game or its source.
 */
export function projectSkip(dir: string, names: ReadonlySet<string>, unityCaches: readonly string[]): (relative: string) => boolean {
  const unity = fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))
  return relative => names.has(path.posix.basename(relative)) || (unity && !relative.includes('/') && unityCaches.includes(relative))
}

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.json', '.md', '.txt', '.gd', '.cfg', '.godot', '.tres', '.tscn', '.svg', '.xml', '.yml', '.yaml', '.toml', '.vue', '.svelte', '.glsl', '.vert', '.frag', '.wgsl', '.cs', '.shader', '.hlsl', '.asmdef', '.uss', '.uxml'])

export function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
}
