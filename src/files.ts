import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const toPosix = (p: string) => p.split(path.sep).join('/')

/**
 * Regular files under `dir`, relative and `/`-separated, sorted. Directories
 * named in `skip` are not entered; symbolic links are not followed.
 */
export function listFiles(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) visit(absolute)
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

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.json', '.md', '.txt', '.gd', '.cfg', '.godot', '.tres', '.tscn', '.svg', '.xml', '.yml', '.yaml', '.toml', '.vue', '.svelte', '.glsl', '.vert', '.frag', '.wgsl'])

export function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
}
