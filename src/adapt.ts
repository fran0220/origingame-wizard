import fs from 'node:fs'
import path from 'node:path'
import { absoluteRefs, type PlanItem } from './findings.js'
import { isTextFile, listFiles } from './files.js'
import { isSecretFile } from './secrets.js'
import type { Edit } from './tasks.js'
import { disableUnityServiceWorker, mergeRuntime, RUNTIME_FILE, unityBuildIn } from './unity.js'

export interface Applied { applied: string[]; skipped: string[] }

/** Resolves `relative` inside `root`, or null when it escapes it. */
export function inside(root: string, relative: string): string | null {
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/')).replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null
  const absolute = path.resolve(root, normalized)
  return absolute.startsWith(path.resolve(root) + path.sep) ? absolute : null
}

function occurrences(text: string, needle: string): number {
  let count = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++
  return count
}

/**
 * Applies exact find/replace edits. An edit is applied only when its file is
 * a text file inside `root` and `find` occurs exactly once; anything else is
 * skipped with the reason, never guessed.
 */
export function applyEdits(root: string, edits: Edit[], options: { allow: (relative: string) => string | null }): Applied {
  const result: Applied = { applied: [], skipped: [] }
  for (const edit of edits) {
    const label = `${edit.path}${edit.why ? ` (${edit.why})` : ''}`
    const refusal = options.allow(edit.path)
    const absolute = inside(root, edit.path)
    if (refusal || !absolute) { result.skipped.push(`${edit.path}: ${refusal ?? 'outside the directory'}`); continue }
    if (!fs.existsSync(absolute) || !isTextFile(absolute)) { result.skipped.push(`${edit.path}: not a text file in the build`); continue }
    if (!edit.find) { result.skipped.push(`${edit.path}: empty find text`); continue }
    const text = fs.readFileSync(absolute, 'utf8')
    const count = occurrences(text, edit.find)
    if (count !== 1) { result.skipped.push(`${edit.path}: the text to replace occurs ${count} times, expected once`); continue }
    if (/__og-game-config/.test(edit.replace)) { result.skipped.push(`${edit.path}: edits may not add platform configuration`); continue }
    const at = text.indexOf(edit.find)
    fs.writeFileSync(absolute, text.slice(0, at) + edit.replace + text.slice(at + edit.find.length))
    result.applied.push(label)
  }
  return result
}

function relativize(site: string): string[] {
  const changed: string[] = []
  const present = new Set(listFiles(site))
  for (const file of present) {
    if (!/\.(html?|css)$/i.test(file)) continue
    const absolute = path.join(site, file)
    let text = fs.readFileSync(absolute, 'utf8')
    const refs = absoluteRefs(file, text, p => present.has(p))
    if (!refs.length) continue
    const depth = file.split('/').length - 1
    const prefix = depth ? '../'.repeat(depth) : ''
    for (const value of [...new Set(refs.map(r => r.value))].sort((a, b) => b.length - a.length)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Only quoted attribute values, url(...) and importmap strings: the exact spans the check found.
      text = text.replace(new RegExp(`(["'(]\\s*)${escaped}(?=\\s*["')])`, 'g'), `$1${prefix}${value.slice(1)}`)
    }
    fs.writeFileSync(absolute, text)
    changed.push(file)
  }
  return changed
}

/** Applies the confirmed deterministic items to the staged copy (`site`). Code edits are applied separately. */
export function applyItems(site: string, items: PlanItem[], entry: string): Applied {
  const result: Applied = { applied: [], skipped: [] }
  for (const item of items) {
    switch (item.kind) {
      case 'entry_index': {
        const source = inside(site, entry)
        if (source && fs.existsSync(source) && !fs.existsSync(path.join(site, 'index.html'))) {
          fs.copyFileSync(source, path.join(site, 'index.html'))
          result.applied.push(`${entry} → index.html`)
        }
        break
      }
      case 'strip_platform_config': {
        for (const file of listFiles(site).filter(f => /\.html?$/i.test(f))) {
          const absolute = path.join(site, file)
          const text = fs.readFileSync(absolute, 'utf8')
          const next = text.replace(/<script[^>]*id=["']__og-game-config["'][^>]*>[\s\S]*?<\/script>\s*/gi, '')
          if (next !== text) { fs.writeFileSync(absolute, next); result.applied.push(`removed __og-game-config from ${file}`) }
        }
        fs.rmSync(path.join(site, '__og'), { recursive: true, force: true })
        break
      }
      case 'relative_paths': {
        const changed = relativize(site)
        result.applied.push(changed.length ? `relative paths in ${changed.join(', ')}` : 'relative paths (nothing left to change)')
        break
      }
      case 'cross_origin_isolation':
      case 'precompressed': {
        const field = item.kind === 'precompressed' ? 'precompressed' : 'crossOriginIsolated'
        if (mergeRuntime(site, { [field]: true })) result.applied.push(`${RUNTIME_FILE} declares ${field}`)
        else result.skipped.push(`${RUNTIME_FILE} is not a version-1 JSON object; ${field} was not declared`)
        break
      }
      case 'remove_service_worker': {
        for (const file of listFiles(site).filter(f => /\.html?$/i.test(f))) {
          const absolute = path.join(site, file)
          const text = fs.readFileSync(absolute, 'utf8')
          const next = text.replace(/("serviceWorker"\s*:\s*)"[^"]*"/g, '$1""')
            .replace(/("ensureCrossOriginIsolationHeaders"\s*:\s*)true/g, '$1false')
          if (next !== text) fs.writeFileSync(absolute, next)
        }
        const unity = unityBuildIn(site, fs.existsSync(path.join(site, 'index.html')) ? 'index.html' : entry)?.serviceWorker
        if (unity) disableUnityServiceWorker(site, unity)
        for (const worker of item.paths ?? []) {
          const absolute = inside(site, worker)
          if (absolute && worker !== 'index.html') fs.rmSync(absolute, { force: true })
        }
        result.applied.push('service worker turned off')
        break
      }
      case 'exclude_files':
        for (const file of item.paths ?? []) {
          const absolute = inside(site, file)
          if (absolute && file !== 'index.html') fs.rmSync(absolute, { force: true, recursive: true })
        }
        result.applied.push(`left out ${(item.paths ?? []).join(', ')}`)
        break
      case 'code_edit':
      case 'orientation':
        break
    }
  }
  return result
}

/** Which project files the score and save integration may edit, as a refusal reason or null. */
export function integrationRefusal(relative: string): string | null {
  const normalized = path.posix.normalize(relative.replace(/\\/g, '/'))
  if (normalized.split('/').some(p => ['node_modules', '.git', 'dist', 'build', '.godot', 'cooked', 'og-out', '.og'].includes(p))) return 'generated or tooling directory'
  if (isSecretFile(normalized)) return 'credential file'
  if (!isTextFile(normalized)) return 'not a source text file'
  return null
}

/** A compact unified diff of one text change (common prefix/suffix trimmed, three lines of context). */
export function unifiedDiff(file: string, before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const from = Math.max(0, start - 3)
  const toA = Math.min(a.length - 1, endA + 3)
  const toB = Math.min(b.length - 1, endB + 3)
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`]
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`)
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`)
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`)
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i]}`)
  return lines.join('\n')
}

