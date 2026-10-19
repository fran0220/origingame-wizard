import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { listFiles, readText, toPosix } from './files.js'
import type { ToolSpec } from './model.js'
import { preview } from './preview.js'
import { redact } from './redact.js'
import { findSecrets, isSecretFile } from './secrets.js'
import type { Ui } from './ui.js'

/**
 * The tools of the publishing loop. Every path is inside the run's workspace
 * (the origingame/publish worktree or the copy) or its scratch folder, never
 * the person's folder. Credential files are never read, and a line that
 * looks like a credential is withheld from anything the model sees.
 */

export interface ToolHost {
  /** The game folder inside the workspace: relative paths start here. */
  root: string
  /** Other folders the tools may use (the scratch folder). */
  extra: string[]
  ui: Ui
  /** Manual mode: every command is confirmed by the person; `ask` is available. */
  manual: boolean
  /** When the session ends (ms since epoch); commands never run past it. */
  deadline: number
  screenshots: string
  publish(args: Record<string, unknown>): Promise<string>
  /** Why `finish` cannot end the run yet (nothing published), or null. */
  finishRefusal?(): string | null
}

const OUTPUT_HEAD = 4 * 1024
const OUTPUT_TAIL = 12 * 1024
const READ_MAX = 60 * 1024
const SKIP = new Set(['node_modules', '.git', '.svn', '.hg'])

export class ToolError extends Error {}

/** A finishing call: the loop ends with it. */
export class Finish { constructor(readonly ok: boolean, readonly text: string) {} }

function resolveIn(host: ToolHost, raw: unknown, what = 'path'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ToolError(`${what} is required`)
  const absolute = path.resolve(host.root, raw.trim())
  for (const allowed of [host.root, ...host.extra]) {
    const rel = path.relative(allowed, absolute)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      if (rel.split(path.sep).includes('.git')) throw new ToolError(`${raw}: the .git folder is off limits`)
      return absolute
    }
  }
  throw new ToolError(`${raw} is outside the workspace (${host.root}); only the workspace and ${host.extra.join(', ')} can be used`)
}

const shown = (host: ToolHost, absolute: string) => {
  const rel = toPosix(path.relative(host.root, absolute))
  return rel.startsWith('..') ? absolute : rel || '.'
}

/** Text with every credential-like line replaced, and known token shapes redacted. */
export function scrub(text: string): string {
  const hits = new Set(findSecrets(text).map(h => h.line))
  const lines = hits.size ? text.split('\n').map((line, i) => (hits.has(i + 1) ? '[line withheld: it looks like a credential]' : line)).join('\n') : text
  return redact(lines)
}

function binary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

function size(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`
}

function listTool(host: ToolHost, args: any): string {
  const dir = resolveIn(host, args.path ?? '.')
  if (!fs.existsSync(dir)) throw new ToolError(`${args.path} does not exist`)
  if (!fs.statSync(dir).isDirectory()) throw new ToolError(`${args.path} is a file`)
  const depth = Math.min(8, Math.max(1, Number(args.depth) || 3))
  const files = listFiles(dir, rel => SKIP.has(path.posix.basename(rel)) || rel.split('/').length > depth)
  const dirs = new Map<string, { files: number; bytes: number }>()
  const lines: string[] = []
  let total = 0
  for (const file of files) {
    const stat = fs.statSync(path.join(dir, file))
    total += stat.size
    if (lines.length < 400) lines.push(`${file}  ${size(stat.size)}${isSecretFile(file) ? '  (credential file: never read or published)' : ''}`)
    const top = file.includes('/') ? file.slice(0, file.indexOf('/')) : '.'
    const d = dirs.get(top) ?? { files: 0, bytes: 0 }
    d.files++; d.bytes += stat.size
    dirs.set(top, d)
  }
  const skipped = fs.readdirSync(dir).filter(n => SKIP.has(n))
  return [
    `${shown(host, dir)}: ${files.length} files, ${size(total)} (depth ${depth}${skipped.length ? `; not listed: ${skipped.join(', ')}` : ''})`,
    ...lines,
    ...(files.length > lines.length ? [`… ${files.length - lines.length} more. By top-level folder: ${[...dirs].map(([d, s]) => `${d} ${s.files} files ${size(s.bytes)}`).join('; ')}`] : []),
  ].join('\n')
}

function readTool(host: ToolHost, args: any): string {
  const file = resolveIn(host, args.path)
  if (isSecretFile(file)) throw new ToolError(`${args.path} is a credential file; it is never read`)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ToolError(`${args.path} is not a file`)
  const stat = fs.statSync(file)
  const head = Buffer.alloc(Math.min(stat.size, 8192))
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
  if (binary(head)) return `${shown(host, file)} is binary, ${size(stat.size)}; first bytes (hex): ${head.subarray(0, 32).toString('hex')}`
  const text = readText(file, 64 * 1024 * 1024) ?? ''
  const lines = text.split('\n')
  const from = Math.max(1, Number(args.offset) || 1)
  const count = Math.min(4000, Math.max(1, Number(args.limit) || 800))
  let out = lines.slice(from - 1, from - 1 + count).join('\n')
  let cut = from - 1 + count < lines.length
  if (out.length > READ_MAX) { out = out.slice(0, READ_MAX); cut = true }
  return `${shown(host, file)} (${lines.length} lines, ${size(stat.size)}; lines ${from}-${Math.min(lines.length, from - 1 + count)})${cut ? ' [truncated: pass offset/limit for more]' : ''}\n${scrub(out)}`
}

function searchTool(host: ToolHost, args: any): string {
  const dir = resolveIn(host, args.path ?? '.')
  let pattern: RegExp
  try { pattern = new RegExp(String(args.pattern ?? ''), args.case_sensitive ? '' : 'i') } catch (error) { throw new ToolError(`invalid pattern: ${(error as Error).message}`) }
  if (!args.pattern) throw new ToolError('pattern is required')
  const files = fs.statSync(dir).isFile() ? [''] : listFiles(dir, rel => SKIP.has(path.posix.basename(rel)))
  const hits: string[] = []
  for (const file of files) {
    const absolute = path.join(dir, file)
    if (isSecretFile(absolute)) continue
    const stat = fs.statSync(absolute)
    if (stat.size > 16 * 1024 * 1024) continue
    const buffer = fs.readFileSync(absolute)
    if (binary(buffer)) continue
    const lines = buffer.toString('utf8').split('\n')
    for (let i = 0; i < lines.length && hits.length < 200; i++) {
      if (!pattern.test(lines[i]!)) continue
      const line = lines[i]!.length > 300 ? `${lines[i]!.slice(Math.max(0, lines[i]!.search(pattern) - 100), lines[i]!.search(pattern) + 200)} [long line, excerpt]` : lines[i]!
      hits.push(`${shown(host, absolute)}:${i + 1}: ${scrub(line)}`)
    }
    if (hits.length >= 200) break
  }
  return hits.length ? `${hits.length}${hits.length >= 200 ? '+' : ''} matches\n${hits.join('\n')}` : 'no matches'
}

function writeTool(host: ToolHost, args: any): string {
  const file = resolveIn(host, args.path)
  if (isSecretFile(file)) throw new ToolError(`${args.path} is a credential file; it is never written`)
  if (typeof args.content !== 'string') throw new ToolError('content is required')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const existed = fs.existsSync(file)
  fs.writeFileSync(file, args.content)
  return `${existed ? 'replaced' : 'created'} ${shown(host, file)} (${size(Buffer.byteLength(args.content))})`
}

function editTool(host: ToolHost, args: any): string {
  const file = resolveIn(host, args.path)
  if (isSecretFile(file)) throw new ToolError(`${args.path} is a credential file; it is never edited`)
  if (!fs.existsSync(file)) throw new ToolError(`${args.path} does not exist`)
  if (typeof args.old_text !== 'string' || !args.old_text) throw new ToolError('old_text is required')
  if (typeof args.new_text !== 'string') throw new ToolError('new_text is required')
  const text = fs.readFileSync(file, 'utf8')
  const count = text.split(args.old_text).length - 1
  if (count === 0) throw new ToolError(`old_text was not found in ${args.path}; read the file again and copy the text exactly`)
  if (count > 1 && !args.replace_all) throw new ToolError(`old_text appears ${count} times in ${args.path}; include more context or pass replace_all`)
  fs.writeFileSync(file, args.replace_all ? text.split(args.old_text).join(args.new_text) : text.replace(args.old_text, () => args.new_text))
  return `edited ${shown(host, file)} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`
}

function deleteTool(host: ToolHost, args: any): string {
  const target = resolveIn(host, args.path)
  if (target === host.root) throw new ToolError('the workspace root cannot be deleted')
  if (!fs.existsSync(target)) return `${args.path} does not exist`
  fs.rmSync(target, { recursive: true, force: true })
  return `deleted ${shown(host, target)}`
}

function moveTool(host: ToolHost, args: any): string {
  const from = resolveIn(host, args.from, 'from')
  const to = resolveIn(host, args.to, 'to')
  if (!fs.existsSync(from)) throw new ToolError(`${args.from} does not exist`)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  return `moved ${shown(host, from)} to ${shown(host, to)}`
}

/** The environment a command gets: the person's, without anything that looks like a credential. */
function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|^OG_|^ORIGINGAME_|AUTH/i.test(key)) continue
    env[key] = value
  }
  return env
}

async function runTool(host: ToolHost, args: any): Promise<string> {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command) throw new ToolError('command is required')
  const cwd = resolveIn(host, args.cwd ?? '.', 'cwd')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ToolError(`cwd ${args.cwd} is not a folder`)
  if (host.manual && host.ui.interactive) {
    const yes = await host.ui.confirm(`Run \`${command}\` in ${shown(host, cwd)}?`, true)
    if (!yes) return 'the person declined to run this command; find another way or ask them'
  }
  const left = host.deadline - Date.now() - 30_000
  const timeoutMs = Math.max(5_000, Math.min(Number(args.timeout_seconds) > 0 ? Number(args.timeout_seconds) * 1000 : 600_000, 1_800_000, left))
  const started = Date.now()
  const s = host.ui.spinner(`$ ${command.length > 100 ? `${command.slice(0, 100)}…` : command}`)
  let head = ''
  let tail = ''
  let total = 0
  const take = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    total += text.length
    if (head.length < OUTPUT_HEAD) head += text.slice(0, OUTPUT_HEAD - head.length)
    tail = (tail + text).slice(-OUTPUT_TAIL)
  }
  const child = spawn(command, { cwd, shell: true, env: commandEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  child.stdout!.on('data', take)
  child.stderr!.on('data', take)
  let timedOut = false
  const kill = () => {
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
  const code = await new Promise<number | null>(resolve => {
    child.on('close', c => resolve(c))
    child.on('error', error => { take(Buffer.from(String(error.message))); resolve(127) })
  })
  clearTimeout(timer)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (code === 0) s.stop(`$ ${command.slice(0, 100)} (${seconds} s)`)
  else s.fail(`$ ${command.slice(0, 100)} ${timedOut ? 'timed out' : `exited ${code}`} (${seconds} s)`)
  const output = total <= OUTPUT_HEAD + OUTPUT_TAIL ? tail : `${head}\n… [${total - head.length - tail.length} characters omitted] …\n${tail}`
  return `${timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s and was killed (never start servers or watchers; use preview)` : `exit code ${code}`} after ${seconds} s\n${scrub(output) || '(no output)'}`
}

async function previewTool(host: ToolHost, args: any): Promise<string> {
  const dir = resolveIn(host, args.dir)
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new ToolError(`${args.dir} has no index.html`)
  const s = host.ui.spinner(`Previewing ${shown(host, dir)} in a local browser`)
  const report = await preview(dir, { waitMs: Math.min(20_000, Math.max(2_000, (Number(args.wait_seconds) || 6) * 1000)), screenshot: path.join(host.screenshots, `preview-${Date.now()}.png`) })
  s.stop(`Preview: ${report.exceptions.length} exception${report.exceptions.length === 1 ? '' : 's'}, ${report.failedRequests.length + report.missingFiles.length} failed request${report.failedRequests.length + report.missingFiles.length === 1 ? '' : 's'}${report.uniformity !== undefined ? `, screen ${report.uniformity >= 0.98 ? 'blank' : 'drawn'}` : ''}`)
  return scrub(JSON.stringify(report, null, 1))
}

async function askTool(host: ToolHost, args: any): Promise<string> {
  const question = String(args.question ?? '').trim()
  if (!question) throw new ToolError('question is required')
  const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 6) : []
  if (options.length) {
    const other = '__other__'
    const answer = await host.ui.select<string>(question, [...options.map((o: string) => ({ value: o, label: o })), { value: other, label: 'Something else (type it)' }], options[0]!)
    return answer === other ? await host.ui.text(question, '') : answer
  }
  return await host.ui.text(question, '')
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const fn = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({ type: 'function', function: { name, description, parameters } })

export function toolSpecs(options: { manual: boolean; genres: string[]; created: boolean }): ToolSpec[] {
  const listing = {
    title: { type: 'string', description: 'Game title (max 60 characters), in the language of the game\'s own text.' },
    genre: { type: 'string', enum: options.genres },
    tagline: { type: 'string', description: 'One short line.' },
    description: { type: 'string', description: 'What the game is and how it plays, from what the files show; never invented features.' },
    controls: { type: 'string', description: 'How to play: keys, mouse, touch.' },
    tags: { type: 'array', items: { type: 'string' } },
    languages: { type: 'array', items: { type: 'string' }, description: 'BCP 47 codes of the game\'s own text, e.g. ["zh-CN"].' },
    orientation: { type: 'string', enum: ['landscape', 'portrait', 'any'] },
    aspect: { type: 'string', description: '"fill" or "W:H" such as "16:9" when the game needs a fixed aspect.' },
    input_hints: { type: 'array', items: { type: 'string', enum: ['touch', 'keyboard', 'gamepad'] } },
    art_direction: { type: 'string', description: 'Look and mood for the cover and poster, from the game\'s real art.' },
  }
  return [
    fn('list_files', 'List files under a folder of the workspace with their sizes (node_modules and .git are not entered).', obj({ path: { type: 'string', description: 'Folder, relative to the game folder; default "."' }, depth: { type: 'integer', description: 'How many folder levels (1-8, default 3).' } })),
    fn('read_file', 'Read a text file (credential files are never read; credential-like lines are withheld). Large files: use offset/limit (lines).', obj({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path'])),
    fn('search', 'Search text files for a regular expression; returns file:line: text.', obj({ pattern: { type: 'string' }, path: { type: 'string' }, case_sensitive: { type: 'boolean' } }, ['pattern'])),
    fn('write_file', 'Create or replace a file in the workspace.', obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'])),
    fn('edit_file', 'Replace exact text in a file (old_text must match exactly once unless replace_all).', obj({ path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text'])),
    fn('delete_path', 'Delete a file or folder in the workspace.', obj({ path: { type: 'string' } }, ['path'])),
    fn('move_path', 'Move or rename a file or folder in the workspace.', obj({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to'])),
    fn('run', `Run a shell command in the workspace (${process.platform}) and get its exit code and output. For installs, builds, exports, compression. Never start servers or watchers.${options.manual ? ' The person confirms every command.' : ''}`, obj({ command: { type: 'string' }, cwd: { type: 'string', description: 'Folder relative to the game folder; default "."' }, timeout_seconds: { type: 'integer', description: 'Default 600, max 1800.' } }, ['command'])),
    fn('preview', 'Serve a folder the way OriginGame serves a release and open it in a headless browser: console errors, exceptions, failed requests, canvases, whether anything was drawn.', obj({ dir: { type: 'string', description: 'The folder with index.html.' }, wait_seconds: { type: 'integer', description: 'How long to let the game run before looking (default 6).' } }, ['dir'])),
    fn('publish', `Upload a folder (its index.html at the root) to OriginGame and publish it, then wait for the platform's readiness check (the game opened in the real Player). Returns Portal's answer as it is: on a refusal or a failed readiness check, fix the cause and publish again (later calls update the same game).${options.created ? ' The first publication creates the game and needs the listing fields; a cover and poster are drawn from them.' : ' This updates an existing game; its listing stays unless you pass title.'}`,
      obj({ dir: { type: 'string' }, engine: { type: 'string', enum: ['html', 'origin-engine', 'threejs', 'unity'], description: 'origin-engine only for an og build; unity for a Unity WebGL build; threejs for a three.js game; html for everything else.' }, ...listing }, ['dir', 'engine'])),
    ...(options.manual ? [fn('ask', 'Ask the person a question (Manual mode). Give options when there are clear choices.', obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']))] : []),
    fn('finish', 'End the run after a successful publication: what was changed and why, in a few lines for the person.', obj({ summary: { type: 'string' } }, ['summary'])),
    fn('give_up', 'End the run without a playable publication, only when the game cannot be published at all (for example no Web build is possible on this machine). Say exactly what the person must do.', obj({ reason: { type: 'string' } }, ['reason'])),
  ]
}

/** Runs one tool call; returns what the model reads, or a Finish. Errors become text, so the loop goes on. */
export async function callTool(host: ToolHost, name: string, rawArgs: string): Promise<string | Finish> {
  let args: any
  try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {} } catch { return `error: the arguments are not valid JSON: ${rawArgs.slice(0, 200)}` }
  try {
    switch (name) {
      case 'list_files': return listTool(host, args)
      case 'read_file': return readTool(host, args)
      case 'search': return searchTool(host, args)
      case 'write_file': return writeTool(host, args)
      case 'edit_file': return editTool(host, args)
      case 'delete_path': return deleteTool(host, args)
      case 'move_path': return moveTool(host, args)
      case 'run': return await runTool(host, args)
      case 'preview': return await previewTool(host, args)
      case 'publish': return await host.publish(args)
      case 'ask': if (host.manual) return await askTool(host, args); break
      case 'finish': return new Finish(true, String(args.summary ?? '').trim())
      case 'give_up': return new Finish(false, String(args.reason ?? '').trim())
    }
    return `error: there is no tool ${name}`
  } catch (error) {
    if (error instanceof ToolError) return `error: ${error.message}`
    if ((error as { code?: string }).code === 'aborted') throw error
    return `error: ${redact((error as Error).message ?? String(error))}`
  }
}

/** A one-line description of a call for the person watching. */
export function describeCall(name: string, rawArgs: string): string {
  let args: any = {}
  try { args = JSON.parse(rawArgs) } catch { /* shown raw */ }
  switch (name) {
    case 'list_files': return `list ${args.path ?? '.'}`
    case 'read_file': return `read ${args.path}`
    case 'search': return `search /${args.pattern}/ in ${args.path ?? '.'}`
    case 'write_file': return `write ${args.path}`
    case 'edit_file': return `edit ${args.path}`
    case 'delete_path': return `delete ${args.path}`
    case 'move_path': return `move ${args.from} → ${args.to}`
    case 'publish': return `publish ${args.dir} as ${args.engine}`
    case 'preview': return `preview ${args.dir}`
    default: return name
  }
}
