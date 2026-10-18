import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SOURCE_LIMITS, VERSION } from './constants.js'
import { WizardError } from './errors.js'
import { UNITY_IGNORE, walkTracked } from './gitignore.js'
import { describe, errorCode, request, type HttpResponse } from './http.js'
import { sha256 } from './files.js'
import { findSecrets, isSecretFile } from './secrets.js'
import type { Ui } from './ui.js'

/**
 * The source upload (contracts §9, on by default): the project's source, as Git would track it,
 * committed to a private Agent Service repository owned by the signed-in
 * account and pinned as a checkpoint that the publication then names in
 * `source_checkpoint`, so Portal links the release to it and the person can
 * continue in Origin. Files of up to `lfsThreshold` bytes go through the
 * server-side commit route; larger ones through Git LFS. Nothing is sent
 * without the explicit flag, credential files and files with a credential-like
 * line are withheld, and the project directory is never written.
 */

/** Agent Service keeps what the Wizard last committed here, so a later upload sends only what changed. */
export const SOURCE_MANIFEST = '.origin/wizard-source.json'
const ATTRIBUTES = '.gitattributes'
const LFS_BEGIN = '# origingame-wizard: Git LFS (generated)'
const LFS_END = '# origingame-wizard: end'
const BRANCH = 'main'
const SKIP = new Set(['node_modules', '.git', '.godot', '.import', '.svn', '.hg', '.cache', '.vite', '.next'])
// Agent Service's path rule (agent-service docs/facts.md, server-side commits).
const VALID_SEGMENT = /^[^\u0000-\u001f\u007f\\]+$/

export interface SourceFile { path: string; size: number }
export interface Withheld { path: string; reason: string }
export interface SourcePlan { root: string; files: SourceFile[]; withheld: Withheld[]; totalBytes: number }

export interface SourceReport {
  repositoryId: string
  checkpointId: string
  commit: string
  createdRepository: boolean
  files: number
  bytes: number
  committed: number
  deleted: number
  lfsObjects: number
  withheld: Withheld[]
}

function textLike(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0)
}

function validPath(file: string): boolean {
  return file.split('/').every(s => s && s !== '.' && s !== '..' && s.toLowerCase() !== '.git' && s.toLowerCase() !== '.gitmodules' && VALID_SEGMENT.test(s))
}

/** What the source upload would send, checked against the limits before anything is sent. */
export function planSource(projectDir: string): SourcePlan {
  const unity = fs.existsSync(path.join(projectDir, 'ProjectSettings', 'ProjectVersion.txt'))
  const walked = walkTracked(projectDir, SKIP, unity ? UNITY_IGNORE : [])
  const files: SourceFile[] = []
  const withheld: Withheld[] = walked.links.map(p => ({ path: p, reason: 'symbolic link' }))
  let totalBytes = 0
  for (const entry of walked.files) {
    if (entry.path === SOURCE_MANIFEST) continue
    if (!validPath(entry.path)) { withheld.push({ path: entry.path, reason: 'a path Git repositories on OriginGame do not accept' }); continue }
    if (isSecretFile(entry.path)) { withheld.push({ path: entry.path, reason: 'credential file' }); continue }
    if (entry.size <= SOURCE_LIMITS.scanBytes) {
      let bytes: Buffer
      try { bytes = fs.readFileSync(path.join(projectDir, entry.path)) } catch { withheld.push({ path: entry.path, reason: 'unreadable' }); continue }
      const hit = textLike(bytes) ? findSecrets(bytes.toString('utf8'))[0] : undefined
      if (hit) { withheld.push({ path: entry.path, reason: `line ${hit.line} looks like a ${hit.kind}` }); continue }
    }
    if (entry.size > SOURCE_LIMITS.maxFileBytes) {
      throw new WizardError('source_failed', `${entry.path} is ${(entry.size / 1048576).toFixed(0)} MiB; source files are limited to ${SOURCE_LIMITS.maxFileBytes / 1048576} MiB (add it to .gitignore or pass --no-source)`)
    }
    files.push(entry)
    totalBytes += entry.size
  }
  if (!files.length) throw new WizardError('source_failed', 'there are no source files to upload (everything is ignored or withheld)')
  if (files.length > SOURCE_LIMITS.maxFiles) throw new WizardError('source_failed', `the source has ${files.length} files; the limit is ${SOURCE_LIMITS.maxFiles} (check .gitignore)`)
  if (totalBytes > SOURCE_LIMITS.maxTotalBytes) throw new WizardError('source_failed', `the source is ${(totalBytes / 1048576).toFixed(0)} MiB; the limit is ${SOURCE_LIMITS.maxTotalBytes / 1048576} MiB (check .gitignore)`)
  return { root: projectDir, files, withheld, totalBytes }
}

/** Agent Service's public origin: `ORIGINGAME_AGENT_ORIGIN`, else `https://agent.<host>` (a loopback host serves it itself). */
export function agentOrigin(host: string): string {
  const raw = process.env.ORIGINGAME_AGENT_ORIGIN
  if (raw) {
    let url: URL
    try { url = new URL(raw) } catch { throw new WizardError('invalid_arguments', 'ORIGINGAME_AGENT_ORIGIN must be an origin') }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new WizardError('invalid_arguments', 'ORIGINGAME_AGENT_ORIGIN must use https (http is allowed only for localhost)')
    }
    return url.origin
  }
  const url = new URL(host)
  // A loopback development ingress serves every owner itself, as for the relay (apiOrigin).
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin
  return `https://agent.${url.hostname}`
}

const key = () => `wizard-${randomBytes(16).toString('hex')}`

class Agent {
  constructor(readonly origin: string, private readonly token: string) {}

  call(method: string, route: string, options: { json?: unknown; idempotency?: string; accept?: string; timeoutMs?: number } = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    if (options.idempotency) headers['idempotency-key'] = options.idempotency
    if (options.accept) headers.accept = options.accept
    return request(`${this.origin}${route}`, { method, headers, ...(options.json === undefined ? {} : { json: options.json }), timeoutMs: options.timeoutMs ?? 60_000 })
      .catch(error => { throw new WizardError('source_failed', `could not reach Agent Service: ${(error as Error).message}`) })
  }

  async ok(method: string, route: string, what: string, options: Parameters<Agent['call']>[2] = {}): Promise<any> {
    const response = await this.call(method, route, options)
    if (response.status === 401) throw new WizardError('not_logged_in', `Agent Service refused the sign-in while ${what}; run \`npx origingame login\``)
    if (!response.ok) throw new WizardError('source_failed', `${what} failed: ${describe(response)}`, errorCode(response) ? { agentCode: errorCode(response) } : undefined)
    return response.json
  }
}

/** The repository already linked to `gameId` that this account can write, or null. */
async function linkedRepository(agent: Agent, gameId: string): Promise<string | null> {
  const memberships = await agent.ok('GET', '/v1/memberships', 'listing your repositories')
  const writable = (Array.isArray(memberships) ? memberships : [])
    .filter((m: any) => (m.role === 'owner' || m.role === 'editor') && !m.archived && typeof m.repository_id === 'string')
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50)
  for (const m of writable) {
    const page = await agent.ok('GET', `/v1/repositories/${encodeURIComponent(m.repository_id)}/publications?limit=200`, 'reading publications')
    if ((page?.items ?? []).some((p: any) => p?.game_id === gameId)) return m.repository_id
  }
  return null
}

async function writable(agent: Agent, repositoryId: string): Promise<boolean> {
  const response = await agent.call('GET', `/v1/repositories/${encodeURIComponent(repositoryId)}/access`)
  return response.ok && response.json?.can_write === true
}

/** Git LFS pointer text (git-lfs spec v1). */
function pointer(oid: string, size: number): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`
}

/** A `.gitattributes` line that matches exactly this path (characters a pattern cannot spell become `?`). */
function attributePattern(file: string): string {
  return `/${file.replace(/[^A-Za-z0-9._/-]/g, '?')} filter=lfs diff=lfs merge=lfs -text`
}

async function uploadLfs(agent: Agent, repositoryId: string, objects: Array<{ oid: string; size: number; file: string }>, ui: Ui): Promise<void> {
  const lfs = 'application/vnd.git-lfs+json'
  for (let at = 0; at < objects.length; at += 100) {
    const batch = objects.slice(at, at + 100)
    const answer = await agent.ok('POST', `/git/${encodeURIComponent(repositoryId)}.git/info/lfs/objects/batch`, 'preparing large files', {
      json: { operation: 'upload', transfers: ['basic'], hash_algo: 'sha256', objects: batch.map(o => ({ oid: o.oid, size: o.size })) }, accept: lfs,
    })
    for (const item of answer?.objects ?? []) {
      const object = batch.find(o => o.oid === item.oid)
      if (!object) continue
      if (item.error) throw new WizardError('source_failed', `${object.file} could not be stored: ${item.error.message ?? item.error.code}`)
      const upload = item.actions?.upload
      if (!upload) continue
      const bytes = fs.readFileSync(object.file)
      const put = await request(upload.href, { method: 'PUT', headers: { ...(upload.header ?? {}) }, body: bytes, timeoutMs: 60_000 + Math.ceil(bytes.length / 1048576) * 2_000 })
        .catch(error => { throw new WizardError('source_failed', `uploading ${path.basename(object.file)} failed: ${(error as Error).message}`) })
      if (!put.ok) throw new WizardError('source_failed', `uploading ${path.basename(object.file)} failed: HTTP ${put.status}`)
      const verify = item.actions?.verify
      if (verify) {
        const checked = await request(verify.href, { headers: { ...(verify.header ?? {}), accept: lfs, 'content-type': lfs }, body: JSON.stringify({ oid: object.oid, size: object.size }), method: 'POST' })
          .catch(error => { throw new WizardError('source_failed', `verifying ${path.basename(object.file)} failed: ${(error as Error).message}`) })
        if (!checked.ok) throw new WizardError('source_failed', `verifying ${path.basename(object.file)} failed: ${describe(checked)}`)
      }
    }
    ui.info(`Stored ${Math.min(at + batch.length, objects.length)}/${objects.length} large files with Git LFS`)
  }
}

interface Blob { path: string; content: Buffer; sha: string }

/**
 * Commits the planned source to `main` of the game's repository (reused when
 * one is remembered or already linked to `gameId`, else created), then pins a
 * checkpoint. Only files whose committed content changed since the last
 * upload are sent; files the last upload committed and the project no longer
 * has are deleted.
 */
export async function uploadSource(options: {
  host: string
  token: string
  plan: SourcePlan
  name: string
  gameId: string | undefined
  remembered: string | undefined
  ui: Ui
}): Promise<SourceReport> {
  const { plan, ui } = options
  const agent = new Agent(agentOrigin(options.host), options.token)
  let repositoryId: string | null = null
  if (options.remembered && await writable(agent, options.remembered)) repositoryId = options.remembered
  if (!repositoryId && options.gameId) repositoryId = await linkedRepository(agent, options.gameId)
  let createdRepository = false
  if (!repositoryId) {
    const created = await agent.ok('POST', '/v1/repositories', 'creating the source repository', { json: { name: options.name.trim().slice(0, 120) || 'Game source' }, idempotency: key() })
    if (typeof created?.id !== 'string') throw new WizardError('source_failed', 'Agent Service did not return a repository id')
    repositoryId = created.id as string
    createdRepository = true
    ui.step(`Created the private source repository ${repositoryId}`)
  } else {
    ui.step(`Updating the source repository ${repositoryId}`)
  }
  const repo = encodeURIComponent(repositoryId)

  const refs = await agent.ok('GET', `/v1/repositories/${repo}/refs`, 'reading the repository')
  let head: string | null = (Array.isArray(refs) ? refs : []).find((r: any) => r?.name === `refs/heads/${BRANCH}`)?.commit ?? null
  let previous: Record<string, string> | null = null
  if (head) {
    const manifest = await agent.call('GET', `/v1/repositories/${repo}/file?revision=${head}&path=${encodeURIComponent(SOURCE_MANIFEST)}`)
    if (manifest.ok && manifest.json && typeof manifest.json.files === 'object') previous = manifest.json.files as Record<string, string>
  }

  // What `main` should hold: small files as they are, large ones as LFS pointers.
  const blobs: Blob[] = []
  const lfsObjects: Array<{ oid: string; size: number; file: string; path: string }> = []
  let attributes: Buffer | null = null
  for (const file of plan.files) {
    const absolute = path.join(plan.root, file.path)
    if (file.path === ATTRIBUTES) { attributes = fs.readFileSync(absolute); continue }
    if (file.size > SOURCE_LIMITS.lfsThreshold) {
      const oid = sha256(fs.readFileSync(absolute))
      lfsObjects.push({ oid, size: file.size, file: absolute, path: file.path })
      const content = Buffer.from(pointer(oid, file.size))
      blobs.push({ path: file.path, content, sha: sha256(content) })
    } else {
      const content = fs.readFileSync(absolute)
      blobs.push({ path: file.path, content, sha: sha256(content) })
    }
  }
  if (lfsObjects.length || attributes) {
    const own = (attributes?.toString('utf8') ?? '').replace(new RegExp(`\\n?${LFS_BEGIN}[\\s\\S]*?${LFS_END}\\n?`), '\n').replace(/\n+$/, '')
    const block = lfsObjects.length ? [LFS_BEGIN, ...lfsObjects.map(o => attributePattern(o.path)), LFS_END].join('\n') : ''
    const content = Buffer.from(`${[own, block].filter(Boolean).join('\n\n')}\n`)
    blobs.push({ path: ATTRIBUTES, content, sha: sha256(content) })
  }
  const desired = new Map(blobs.map(b => [b.path, b]))
  const changed = blobs.filter(b => previous?.[b.path] !== b.sha)
  const deleted = previous ? Object.keys(previous).filter(p => !desired.has(p) && p !== SOURCE_MANIFEST) : []
  const lfsChanged = lfsObjects.filter(o => changed.some(b => b.path === o.path))
  if (lfsChanged.length) await uploadLfs(agent, repositoryId, lfsChanged, ui)

  const manifest = Buffer.from(`${JSON.stringify({ version: 1, tool: `origingame-wizard/${VERSION}`, files: Object.fromEntries(blobs.map(b => [b.path, b.sha])) }, null, 2)}\n`)
  type Entry = { path: string; content_base64: string } | { path: string; delete: true }
  const entries: Array<{ entry: Entry; bytes: number }> = [
    ...changed.map(b => ({ entry: { path: b.path, content_base64: b.content.toString('base64') }, bytes: b.content.length })),
    ...deleted.map(p => ({ entry: { path: p, delete: true as const }, bytes: 0 })),
  ]
  if (entries.length || !previous) entries.push({ entry: { path: SOURCE_MANIFEST, content_base64: manifest.toString('base64') }, bytes: manifest.length })
  const commits: Entry[][] = []
  let current: Entry[] = []
  let currentBytes = 0
  for (const { entry, bytes } of entries) {
    if (current.length && (current.length >= SOURCE_LIMITS.commitFiles || currentBytes + bytes > SOURCE_LIMITS.commitBytes)) {
      commits.push(current)
      current = []
      currentBytes = 0
    }
    current.push(entry)
    currentBytes += bytes
  }
  if (current.length) commits.push(current)
  for (let i = 0; i < commits.length; i++) {
    const message = commits.length === 1 ? 'Origin Wizard: upload source' : `Origin Wizard: upload source (${i + 1}/${commits.length})`
    const response = await agent.call('POST', `/v1/repositories/${repo}/commits`, { json: { branch: BRANCH, expected_head: head, message, files: commits[i] }, idempotency: key() })
    if (response.status === 409 && errorCode(response) === 'stale_head') {
      throw new WizardError('source_failed', 'the source repository changed while uploading; run the command again')
    }
    if (response.status === 401) throw new WizardError('not_logged_in', 'Agent Service refused the sign-in; run `npx origingame login`')
    if (!response.ok || typeof response.json?.commit !== 'string') throw new WizardError('source_failed', `committing the source failed: ${describe(response)}`)
    head = response.json.commit as string
    if (commits.length > 1) ui.info(`Committed ${i + 1}/${commits.length}`)
  }
  if (!head) throw new WizardError('source_failed', 'the source repository has no main branch')
  const checkpoint = await agent.ok('POST', '/v1/checkpoints', 'pinning the source checkpoint', {
    json: { repository_id: repositoryId, commit: head, reason: 'Origin Wizard source upload' }, idempotency: `wizard-checkpoint-${sha256(`${repositoryId}:${head}`).slice(0, 40)}`,
  })
  if (typeof checkpoint?.id !== 'string') throw new WizardError('source_failed', 'Agent Service did not return a checkpoint id')
  return {
    repositoryId, checkpointId: checkpoint.id, commit: head, createdRepository,
    files: plan.files.length, bytes: plan.totalBytes, committed: changed.length, deleted: deleted.length, lfsObjects: lfsChanged.length, withheld: plan.withheld,
  }
}
