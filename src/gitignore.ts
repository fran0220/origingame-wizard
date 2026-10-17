import fs from 'node:fs'
import path from 'node:path'

/**
 * `.gitignore` semantics for the source upload (`--with-source`): every
 * directory's `.gitignore` applies to the entries below it; the last matching
 * pattern wins and `!` re-includes; a trailing `/` matches directories only; a
 * pattern with a `/` before its end is anchored to its file's directory,
 * otherwise it matches the entry's name at any depth; `*`, `?`, `[…]` and `**`
 * are globs. As in Git, nothing inside an ignored directory can be re-included,
 * because the walk never enters it.
 */
interface Rule { base: string; regex: RegExp; negate: boolean; dirOnly: boolean; anchored: boolean }

function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/'
        const after = glob[i + 2] === '/' || i + 2 === glob.length
        if (before && after) {
          if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
          continue
        }
      }
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2)
      if (end === -1) { out += '\\['; continue }
      let cls = glob.slice(i + 1, end)
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
      out += `[${cls.replace(/\\/g, '\\\\')}]`
      i = end
    } else if (c === '\\' && i + 1 < glob.length) {
      out += glob[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  return out
}

export function parseGitignore(text: string, base: string): Rule[] {
  const rules: Rule[] = []
  for (let line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    line = line.replace(/(?<!\\)\s+$/, '')
    if (!line) continue
    let negate = false
    if (line.startsWith('!')) { negate = true; line = line.slice(1) } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
    let dirOnly = false
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1) }
    if (!line) continue
    const anchored = line.includes('/')
    if (line.startsWith('/')) line = line.slice(1)
    rules.push({ base, regex: new RegExp(`^${globToRegex(line)}$`), negate, dirOnly, anchored })
  }
  return rules
}

/** Whether `relative` (posix, from the project root) is ignored by `rules`, Git's last-match-wins. */
export function ignored(rules: readonly Rule[], relative: string, isDir: boolean): boolean {
  let result = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.base && !relative.startsWith(`${rule.base}/`)) continue
    const own = rule.base ? relative.slice(rule.base.length + 1) : relative
    const subject = rule.anchored ? own : own.slice(own.lastIndexOf('/') + 1)
    if (rule.regex.test(subject)) result = !rule.negate
  }
  return result
}

export interface WalkEntry { path: string; size: number }

/**
 * Regular files under `root` that Git would track: `.gitignore` files apply,
 * directories in `skip` are never entered, symbolic links are not followed
 * (they are reported in `links`).
 */
export function walkTracked(root: string, skip: ReadonlySet<string>): { files: WalkEntry[]; links: string[] } {
  const files: WalkEntry[] = []
  const links: string[] = []
  const visit = (dir: string, relative: string, inherited: Rule[]) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    let rules = inherited
    const own = entries.find(e => e.name === '.gitignore' && e.isFile())
    if (own) {
      try { rules = [...inherited, ...parseGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), relative)] } catch { /* unreadable: inherit */ }
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { if (!ignored(rules, child, false)) links.push(child); continue }
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || ignored(rules, child, true)) continue
        visit(path.join(dir, entry.name), child, rules)
      } else if (entry.isFile() && !ignored(rules, child, false)) {
        let size = 0
        try { size = fs.statSync(path.join(dir, entry.name)).size } catch { continue }
        files.push({ path: child, size })
      }
    }
  }
  visit(root, '', [])
  return { files: files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path))), links }
}
