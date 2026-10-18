// A stand-in for the OriginGame platform that implements the Wizard's contracts
// (goals/origingame-wizard/contracts.md §1.1–1.3, §4, §5, §6): Identity device
// sign-in, Wizard sessions and revocation, the public rules document, the AI
// Gateway's chat and image routes (scripted answers, real PNGs of the requested
// size, model allowlist), Portal's source uploads, deploys and releases, and
// the Agent Service routes `--with-source` uses (agent-service README.md and
// docs/facts.md: repositories, memberships, access, refs, file, server-side
// commits with their 64-file / 512 KiB / 1 MiB limits and compare-and-swap,
// checkpoints, publications, Git LFS batch/verify against an object store).
// It records every request so tests can assert what the CLI actually sent.
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { PNG } from 'pngjs'

export const ACCOUNT = { id: 42, username: 'maker', display_name: 'Maker' }
export const DEVICE_TOKEN = 'og-device-fixture-0123456789abcdef'
export const MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'qwen-image-2.1-turbo-aliyun']

const sha256 = data => createHash('sha256').update(data).digest('hex')

/** The rules document exactly as the site composes it: rules.json + prompts/*.md + a content version. */
export function composeRules(dir) {
  const rules = JSON.parse(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'))
  const prompts = {}
  for (const name of ['system', 'analyze', 'adapt', 'metadata', 'artwork']) prompts[name] = fs.readFileSync(path.join(dir, 'prompts', `${name}.md`), 'utf8')
  const body = { ...rules, prompts }
  return { version: sha256(JSON.stringify(body)).slice(0, 16), ...body }
}

function png(width, height, seed) {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      image.data[i] = (x * 255 / width + seed * 40) & 255
      image.data[i + 1] = (y * 255 / height) & 255
      image.data[i + 2] = (seed * 90) & 255
      image.data[i + 3] = 255
    }
  }
  return PNG.sync.write(image)
}

export function imageDims(bytes) {
  if (bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: 'png' }
  let at = 2
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) { at++; continue }
    const marker = bytes[at + 1]
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7), type: 'jpeg' }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return null
}

/** Portal's own acceptance rule (server/src/lib/game-media.ts). */
export function portalAccepts(kind, bytes) {
  const d = imageDims(bytes)
  if (!d || bytes.length > 5 * 1024 * 1024) return false
  const ratio = d.width / d.height
  return kind === 'poster'
    ? d.width >= 600 && d.height >= 800 && Math.abs(ratio - 0.75) <= 0.04
    : d.width >= 640 && d.height >= 360 && Math.abs(ratio - 16 / 9) <= 0.08
}

export async function startPlatform({ rulesDir }) {
  const state = {
    requests: [],
    chat: [],
    images: [],
    sessions: new Map(),
    deviceTokens: new Set([DEVICE_TOKEN]),
    revokedDevices: new Set(),
    devicePolls: 0,
    uploads: new Map(),
    blobs: new Map(),
    games: new Map(),
    deploys: [],
    // Knobs a test may turn.
    rulesDown: false,
    imageStatus: 200,
    readiness422: false,
    readinessSequence: null,
    script: () => { throw new Error('no model script') },
    // AIGCC finals (aigcc/server/src/finals.ts): null = the account's team is not in the finals.
    aigcc: { team: null, open: true, refuseBind: false, submissions: [] },
    agent: { repos: new Map(), commits: new Map(), checkpoints: new Map(), lfs: new Map(), objects: new Map(), receipts: new Map(), bodies: [], raceNextCommit: false },
  }
  let imageSeq = 0
  const files = new Map()

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const fail = (res, status, code, message) => json(res, status, { error: { code, message } })
  const bearer = req => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null

  const liveSession = req => {
    const token = bearer(req)
    const session = token && [...state.sessions.values()].find(s => s.credential === token)
    if (!session || session.revoked || Date.parse(session.expires_at) < Date.now()) return null
    return session
  }
  /** Portal accepts the person's og- credential, or a publish delegation with its repository header. */
  const portalOwner = req => {
    const token = bearer(req)
    if (token && state.deviceTokens.has(token) && !state.revokedDevices.has(token)) return `user:${ACCOUNT.id}`
    if (token?.startsWith('ogd-') && req.headers['x-origin-repository']) return `user:${ACCOUNT.id}`
    return null
  }

  /** Portal's `universe.publish_link` job: Agent links the release when the publisher owns the checkpoint's repository. */
  function linkSource(checkpointId, gameId, releaseId) {
    const checkpoint = checkpointId && state.agent.checkpoints.get(checkpointId)
    const repo = checkpoint && state.agent.repos.get(checkpoint.repo)
    if (!repo || repo.owner !== String(ACCOUNT.id)) return
    repo.publications.unshift({ release_id: releaseId, game_id: gameId, checkpoint_id: checkpointId, commit_oid: checkpoint.commit, published_by: String(ACCOUNT.id), created_at: new Date().toISOString() })
  }

  async function body(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  function issueSession(origin) {
    const id = `pak_${randomBytes(6).toString('hex')}`
    const session = {
      session_id: id, credential: `ogp-${randomBytes(18).toString('hex')}`, channel: 'wizard',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), models: [...MODELS], budget_quota: 1000000,
      account: ACCOUNT, revoked: false, origin,
    }
    state.sessions.set(id, session)
    return session
  }

  function publicSession(session) {
    const { revoked, origin, ...rest } = session
    return rest
  }

  // Agent Service (an account credential is an owner principal, as for any account key).
  const agentOwner = req => {
    const token = bearer(req)
    return token && state.deviceTokens.has(token) && !state.revokedDevices.has(token) ? String(ACCOUNT.id) : null
  }
  const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/
  const strict = (raw, allowed, limit = 256 << 10) => {
    if (raw.length > limit) return { status: 413 }
    let value
    try { value = JSON.parse(raw.toString()) } catch { return { status: 400 } }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) return { status: 400 }
    return { value }
  }
  const validRepoPath = p => typeof p === 'string' && !p.startsWith('/') && p.split('/').every(s => s && s !== '.' && s !== '..' && !/[\u0000-\u001f\u007f\\]/.test(s) && !['.git', '.gitmodules'].includes(s.toLowerCase()))
  const oid40 = () => randomBytes(20).toString('hex')
  function replay(owner, scope, keyValue, input, run) {
    const id = `${owner}:${scope}:${keyValue}`
    const hash = sha256(JSON.stringify(input))
    const prior = state.agent.receipts.get(id)
    if (prior) return prior.hash === hash ? { ...prior.answer, replayed: true } : { status: 409, body: { error: { code: 'idempotency_conflict', message: 'idempotency key reused with different input' } } }
    const answer = run()
    if (answer.status < 300) state.agent.receipts.set(id, { hash, answer })
    return answer
  }
  const treeOf = commit => (commit ? new Map(state.agent.commits.get(commit).tree) : new Map())

  async function agentRoute(req, res, url, raw) {
    const route = `${req.method} ${url.pathname}`
    state.agent.bodies.push({ method: req.method, path: url.pathname, body: raw })
    const owner = agentOwner(req)
    if (!owner) return fail(res, 401, 'unauthorized', 'invalid credential')
    const send = a => json(res, a.status, a.body, a.replayed ? { 'idempotent-replayed': 'true' } : {})
    const member = id => {
      const repo = state.agent.repos.get(id)
      return repo && repo.owner === owner ? repo : null
    }
    if (route === 'POST /v1/repositories') {
      const key = req.headers['idempotency-key']
      const { value, status } = strict(raw, ['name'])
      if (!value) return fail(res, status, 'invalid_request', 'invalid JSON fields')
      const name = String(value.name ?? '').trim()
      if (name.length < 1 || Buffer.byteLength(name) > 120) return fail(res, 400, 'invalid_request', 'name must be 1-120 bytes')
      if (!IDEMPOTENCY.test(key ?? '')) return fail(res, 400, 'invalid_request', 'Idempotency-Key must be 16-128 alphanumeric, dash or underscore characters')
      return send(replay(owner, 'repository.create', key, value, () => {
        const id = randomBytes(16).toString('hex')
        state.agent.repos.set(id, { id, owner, name, archived: false, created_at: new Date().toISOString(), branches: new Map(), publications: [] })
        return { status: 201, body: { id, name, git_path: `/git/${id}.git` } }
      }))
    }
    if (route === 'GET /v1/memberships') {
      return json(res, 200, [...state.agent.repos.values()].filter(r => r.owner === owner).map(r => ({ repository_id: r.id, user_id: owner, role: 'owner', archived: r.archived, name: r.name, title: r.name, created_at: r.created_at })))
    }
    if (route === 'POST /v1/checkpoints') {
      const key = req.headers['idempotency-key']
      const { value, status } = strict(raw, ['id', 'repository_id', 'commit', 'reason', 'parent_id', 'environment'])
      if (!value) return fail(res, status, 'invalid_request', 'invalid JSON fields')
      if (typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 240) return fail(res, 400, 'invalid_request', 'reason must be 1-240 bytes')
      const repo = member(value.repository_id)
      if (!repo) return fail(res, 404, 'not_found', 'repository not found')
      if (!IDEMPOTENCY.test(key ?? '')) return fail(res, 400, 'invalid_request', 'Idempotency-Key must be 16-128 alphanumeric, dash or underscore characters')
      return send(replay(owner, 'checkpoint.create', key, value, () => {
        const commit = state.agent.commits.get(value.commit)
        if (!commit || commit.repo !== repo.id) return { status: 400, body: { error: { code: 'invalid_request', message: 'commit not present on server' } } }
        const id = randomBytes(16).toString('hex')
        state.agent.checkpoints.set(id, { id, repo: repo.id, owner: repo.owner, commit: value.commit })
        return { status: 201, body: { id, commit_oid: value.commit, ref: `refs/checkpoints/${id}` } }
      }))
    }
    let m = /^\/v1\/repositories\/([0-9a-f]{32})\/(access|refs|file|commits|publications)$/.exec(url.pathname)
    if (m) {
      const repo = member(m[1])
      if (!repo) return fail(res, 404, 'not_found', 'repository not found')
      if (req.method === 'GET' && m[2] === 'access') return json(res, 200, { repository_id: repo.id, role: 'owner', can_write: !repo.archived, can_publish: true })
      if (req.method === 'GET' && m[2] === 'refs') {
        return json(res, 200, [...[...repo.branches].map(([name, commit]) => ({ name: `refs/heads/${name}`, commit })),
          ...[...state.agent.checkpoints.values()].filter(c => c.repo === repo.id).map(c => ({ name: `refs/checkpoints/${c.id}`, commit: c.commit }))])
      }
      if (req.method === 'GET' && m[2] === 'file') {
        const revision = url.searchParams.get('revision') ?? ''
        const commit = /^[0-9a-f]{40}$/.test(revision) ? state.agent.commits.get(revision) : null
        const bytes = commit?.repo === repo.id ? commit.tree.get(url.searchParams.get('path') ?? '') : undefined
        if (!bytes) return fail(res, 400, 'invalid_request', 'file unavailable')
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' }).end(bytes)
        return
      }
      if (req.method === 'GET' && m[2] === 'publications') return json(res, 200, { items: repo.publications, next_cursor: null })
      if (req.method === 'POST' && m[2] === 'commits') {
        const { value, status } = strict(raw, ['branch', 'expected_head', 'message', 'files'], 1 << 20)
        if (!value) return fail(res, status, status === 413 ? 'payload_too_large' : 'invalid_request', status === 413 ? 'JSON too large' : 'invalid JSON fields')
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.branch ?? '')) return fail(res, 400, 'invalid_request', 'invalid branch')
        const expected = value.expected_head ?? ''
        if (expected && !/^[0-9a-f]{40}$/.test(expected)) return fail(res, 400, 'invalid_request', 'expected_head must be a 40-hex commit')
        if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 8192) return fail(res, 400, 'invalid_request', 'message must be 1-8192 bytes')
        if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 64) return fail(res, 400, 'invalid_request', 'files must hold 1-64 entries')
        const seen = new Set()
        let total = 0
        const decoded = []
        for (const f of value.files) {
          if (!validRepoPath(f?.path) || seen.has(f.path)) return fail(res, 400, 'invalid_request', 'invalid or repeated file path')
          seen.add(f.path)
          if ((f.delete === true) === (typeof f.content_base64 === 'string')) return fail(res, 400, 'invalid_request', 'each file needs content_base64 or delete:true')
          const content = f.delete ? null : Buffer.from(f.content_base64, 'base64')
          if (content && content.toString('base64') !== f.content_base64) return fail(res, 400, 'invalid_request', 'content_base64 must be standard base64')
          total += content?.length ?? 0
          decoded.push({ path: f.path, content })
        }
        if (total > 512 * 1024) return fail(res, 413, 'payload_too_large', 'commit content exceeds 512 KiB')
        const key = req.headers['idempotency-key']
        if (!IDEMPOTENCY.test(key ?? '')) return fail(res, 400, 'invalid_request', 'Idempotency-Key must be 16-128 alphanumeric, dash or underscore characters')
        if (state.agent.raceNextCommit) {
          // Another writer moved the branch in the meantime.
          state.agent.raceNextCommit = false
          const other = oid40()
          const parent = repo.branches.get(value.branch) ?? null
          state.agent.commits.set(other, { repo: repo.id, parent, tree: treeOf(parent).set('elsewhere.txt', Buffer.from('another writer\n')) })
          repo.branches.set(value.branch, other)
        }
        return send(replay(owner, `repository.commit/${repo.id}`, key, value, () => {
          const head = repo.branches.get(value.branch) ?? ''
          if (head !== expected) return { status: 409, body: { error: { code: 'stale_head', message: 'the branch head is not expected_head; reread the branch and retry', current_head: head || null } } }
          const tree = treeOf(head || null)
          for (const f of decoded) {
            if (f.content) {
              if ([...tree.keys()].some(p => p.startsWith(`${f.path}/`) || f.path.startsWith(`${p}/`))) return { status: 409, body: { error: { code: 'path_conflict', message: 'path conflict' } } }
              tree.set(f.path, f.content)
            } else tree.delete(f.path)
          }
          const commit = oid40()
          state.agent.commits.set(commit, { repo: repo.id, parent: head || null, tree, message: value.message, files: value.files.length, bytes: total })
          repo.branches.set(value.branch, commit)
          return { status: 201, body: { branch: value.branch, commit, parent: head || null } }
        }))
      }
    }
    m = /^\/git\/([0-9a-f]{32})\.git\/info\/lfs\/objects\/(batch|verify)$/.exec(url.pathname)
    if (m && req.method === 'POST') {
      const repo = member(m[1])
      if (!repo) return fail(res, 404, 'not_found', 'repository not found')
      if (m[2] === 'verify') {
        const { value } = strict(raw, ['oid', 'size'])
        const object = value && state.agent.lfs.get(value.oid)
        const bytes = value && state.agent.objects.get(value.oid)
        if (!object || !bytes || bytes.length !== value.size || sha256(bytes) !== value.oid) return fail(res, 409, 'conflict', 'LFS uploaded bytes mismatch')
        object.verified = true
        return json(res, 200, {})
      }
      const { value } = strict(raw, ['operation', 'transfers', 'objects', 'ref', 'hash_algo'])
      if (!value || value.operation !== 'upload' || !Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > 100) return fail(res, 400, 'invalid_request', 'invalid LFS batch')
      const objects = value.objects.map(o => {
        if (!/^[a-f0-9]{64}$/.test(o.oid) || !(o.size >= 0)) return { oid: o.oid, size: o.size, error: { code: 422, message: 'invalid object' } }
        const known = state.agent.lfs.get(o.oid) ?? { size: o.size, verified: false, repos: new Set() }
        known.repos.add(repo.id)
        state.agent.lfs.set(o.oid, known)
        if (known.verified) return { oid: o.oid, size: o.size, authenticated: true }
        return {
          oid: o.oid, size: o.size, authenticated: true, actions: {
            upload: { href: `${state.origin}/objects/lfs/${o.oid}`, header: { 'x-amz-checksum-sha256': Buffer.from(o.oid, 'hex').toString('base64') }, expires_in: 900 },
            verify: { href: `${state.origin}/git/${repo.id}.git/info/lfs/objects/verify`, header: { Authorization: req.headers.authorization }, expires_in: 900 },
          },
        }
      })
      return json(res, 200, { transfer: 'basic', objects, hash_algo: 'sha256' })
    }
    return fail(res, 404, 'not_found', 'not found')
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake')
    const raw = await body(req)
    const record = { method: req.method, host: req.headers.host ?? null, path: url.pathname, query: url.search, authorization: req.headers.authorization ?? null, repository: req.headers['x-origin-repository'] ?? null, contentType: req.headers['content-type'] ?? null, bytes: raw.length }
    state.requests.push(record)
    const route = `${req.method} ${url.pathname}`

    // Public rules (contracts §4).
    if (route === 'GET /wizard/v1/rules.json') {
      if (state.rulesDown) return json(res, 503, { error: 'unavailable' })
      return json(res, 200, composeRules(rulesDir), { 'cache-control': 'public, max-age=300' })
    }

    // Identity (contracts §1.1–1.3).
    if (route === 'POST /identity/v1/connector/device/authorizations') {
      const input = JSON.parse(raw.toString() || '{}')
      state.deviceStart = input
      return json(res, 200, { device_code: 'dc-fixture', user_code: 'WXYZ2345', verification_uri: `${state.origin}/connector`, verification_uri_complete: `${state.origin}/connector?user_code=WXYZ2345`, expires_in: 600, interval: 1 })
    }
    if (route === 'POST /identity/v1/connector/device/token') {
      state.devicePolls++
      if (state.devicePolls < 2) return fail(res, 400, 'authorization_pending', 'authorization is pending')
      const token = `og-device-${randomBytes(12).toString('hex')}`
      state.deviceTokens.add(token)
      return json(res, 200, { access_token: token, token_type: 'Bearer', credential_kind: 'device', device_id: 7, account: ACCOUNT })
    }
    if (route === 'POST /identity/v1/connector/revoke') {
      const token = bearer(req)
      if (!token || !state.deviceTokens.has(token)) return fail(res, 401, 'unauthorized', 'Invalid credential')
      state.revokedDevices.add(token)
      res.writeHead(204).end()
      return
    }
    if (route === 'GET /identity/v1/connector/session') {
      // Identity's device-session answer has no numeric account id (identity-service internal/api/desktop.go connectorSession).
      const token = bearer(req)
      if (!token || !state.deviceTokens.has(token) || state.revokedDevices.has(token)) return fail(res, 401, 'unauthorized', 'Invalid credential')
      return json(res, 200, { device_id: 'dev_1', client: 'wizard', account: { username: ACCOUNT.username, display_name: ACCOUNT.display_name } })
    }
    if (route === 'POST /identity/v1/wizard/sessions') {
      const token = bearer(req)
      if (!token?.startsWith('og-') || !state.deviceTokens.has(token) || state.revokedDevices.has(token)) return fail(res, 401, 'unauthorized', 'account credential required')
      const input = JSON.parse(raw.toString() || '{}')
      if (typeof input.client_version !== 'string' || input.client_version.length > 64) return fail(res, 400, 'invalid_request', 'client_version required')
      const session = issueSession('identity')
      session.request = input
      return json(res, 201, publicSession(session), { 'cache-control': 'no-store' })
    }
    if (route === 'POST /identity/v1/wizard/sessions/revoke') {
      const token = bearer(req)
      const session = [...state.sessions.values()].find(s => s.credential === token)
      if (session) session.revoked = true
      res.writeHead(204).end()
      return
    }

    // AI Gateway (contracts §6).
    if (route === 'POST /v1/chat/completions') {
      const session = liveSession(req)
      if (!session) return fail(res, 401, 'unauthorized', 'invalid session')
      const input = JSON.parse(raw.toString())
      state.chat.push({ model: input.model, body: input, session: session.session_id })
      if (!session.models.includes(input.model)) return fail(res, 403, 'model_not_allowed', `model ${input.model} not allowed`)
      const user = input.messages.at(-1).content
      const first = input.messages.find(m => m.role === 'user').content
      const task = /^TASK: (\w+)/.exec(first)?.[1]
      const inputJson = JSON.parse(first.slice(first.indexOf('INPUT:\n') + 7))
      const answer = await state.script({ task, input: inputJson, retry: user !== first, attempt: input.messages.filter(m => m.role === 'assistant').length + 1 })
      const content = typeof answer === 'string' ? answer : JSON.stringify(answer)
      return json(res, 200, { id: 'chatcmpl-fixture', object: 'chat.completion', model: input.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 } })
    }
    if (route === 'POST /v1/images/generations') {
      const session = liveSession(req)
      if (!session) return fail(res, 401, 'unauthorized', 'invalid session')
      const input = JSON.parse(raw.toString())
      state.images.push({ model: input.model, size: input.size, prompt: input.prompt, n: input.n })
      if (!session.models.includes(input.model)) return fail(res, 403, 'model_not_allowed', `model ${input.model} not allowed`)
      if (state.imageStatus !== 200) return fail(res, state.imageStatus, 'upstream_error', 'image provider failed')
      const [width, height] = String(input.size).split('x').map(Number)
      const bytes = png(width, height, ++imageSeq)
      if (imageSeq % 2) return json(res, 200, { created: 1, data: [{ b64_json: bytes.toString('base64') }] })
      const name = `/files/image-${imageSeq}.png`
      files.set(name, bytes)
      return json(res, 200, { created: 1, data: [{ url: `${state.origin}${name}` }] })
    }
    if (req.method === 'GET' && files.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'image/png' }).end(files.get(url.pathname))
      return
    }

    // Agent Service.
    if (/^\/v1\/(repositories|memberships|checkpoints)(\/|$)/.test(url.pathname) || url.pathname.startsWith('/git/')) return agentRoute(req, res, url, raw)
    // The object store behind LFS's presigned PUT URLs (checksum-bound).
    const lfsPut = /^\/objects\/lfs\/([a-f0-9]{64})$/.exec(url.pathname)
    if (lfsPut && req.method === 'PUT') {
      const expected = state.agent.lfs.get(lfsPut[1])
      if (!expected || raw.length !== expected.size || Buffer.from(lfsPut[1], 'hex').toString('base64') !== req.headers['x-amz-checksum-sha256'] || sha256(raw) !== lfsPut[1]) return json(res, 400, { error: 'BadDigest' })
      state.agent.objects.set(lfsPut[1], raw)
      res.writeHead(200).end()
      return
    }

    // AIGCC finals: the person's own sign-in only (a publish delegation is refused), Portal's receipt decides ownership.
    if (url.pathname.startsWith('/api/aigcc/entry/finals')) {
      const token = bearer(req)
      if (!token || !state.deviceTokens.has(token) || state.revokedDevices.has(token)) return json(res, 401, { error: 'authentication required' })
      const owner = `user:${ACCOUNT.id}`
      const { team, open } = state.aigcc
      const latest = state.aigcc.submissions.at(-1) ?? null
      const game = latest && { submissionId: `sub-${latest.version}`, version: latest.version, gameId: latest.gameId, releaseId: latest.releaseId, releaseVersion: 1, playUrl: `${state.origin}/play/${latest.gameId}/`, boundBy: ACCOUNT.id, createdAt: Date.now() }
      if (route === 'GET /api/aigcc/entry/finals') {
        if (!team) return json(res, 200, { eligible: false, open: false, reason: 'finals material requires finalist status', registration: null, game: null })
        return json(res, 200, { eligible: true, open, reason: open ? null : 'outside submission window', registration: team, game })
      }
      if (route === 'POST /api/aigcc/entry/finals/game') {
        if (!team) return json(res, 403, { error: 'finals material requires finalist status' })
        if (!open || state.aigcc.refuseBind) return json(res, 403, { error: 'outside submission window' })
        const input = JSON.parse(raw.toString())
        const target = state.games.get(input.gameId)
        if (!target || target.owner !== owner) return json(res, 409, { error: 'published release unavailable' })
        if (input.releaseId !== target.currentReleaseId) return json(res, 409, { error: 'published release unavailable' })
        state.aigcc.submissions.push({ gameId: input.gameId, releaseId: input.releaseId, version: state.aigcc.submissions.length + 1 })
        return json(res, 201, { ok: true, game: { ...game, version: state.aigcc.submissions.length, gameId: input.gameId, releaseId: input.releaseId, playUrl: `${state.origin}/play/${input.gameId}/` }, classification: 'classified' })
      }
    }

    // Portal (contracts §5).
    if (url.pathname.startsWith('/api/deploy')) {
      const owner = portalOwner(req)
      if (!owner) return json(res, 401, { error: 'invalid api key' })
      // The account's own games, newest first (server/src/routes/deploy.ts `GET /api/deploy/mine`).
      if (route === 'GET /api/deploy/mine') {
        const games = [...state.games.values()].filter(g => g.owner === owner).reverse()
        return json(res, 200, { games: games.map(g => ({ id: g.id, slug: g.slug, title: g.fields.title, version: g.version, unlisted: g.unlisted, current_release_id: g.currentReleaseId })) })
      }
      if (route === 'POST /api/deploy/source-uploads') {
        const { files: entries } = JSON.parse(raw.toString())
        // Portal's own limits (server/src/storage/source-uploads.ts): 50 MiB per file, 200 MiB in total.
        const tooBig = entries.find(e => e.sizeBytes > 50 * 1024 * 1024)
        if (tooBig || entries.reduce((n, e) => n + e.sizeBytes, 0) > 200 * 1024 * 1024) return json(res, 413, { error: `source upload too large${tooBig ? `: ${tooBig.path}` : ''}` })
        const sorted = [...entries].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
        const id = `source_${randomBytes(16).toString('hex')}`
        const manifestHash = sha256(JSON.stringify({ version: 1, files: sorted }))
        const missing = sorted.filter(e => !state.blobs.has(`${owner}:${e.sha256}`)).map(e => e.path)
        state.uploads.set(id, { owner, entries: sorted, manifestHash, state: 'open', received: [], missing })
        return json(res, 201, { sourceUploadId: id, expiresAt: Math.floor(Date.now() / 1000) + 900, manifestHash, missing })
      }
      let m = /^\/api\/deploy\/source-uploads\/([^/]+)\/files$/.exec(url.pathname)
      if (m && req.method === 'PUT') {
        const upload = state.uploads.get(decodeURIComponent(m[1]))
        const file = url.searchParams.get('path')
        const entry = upload?.entries.find(e => e.path === file)
        if (!upload || !entry) return json(res, 404, { error: 'not found' })
        if (Number(req.headers['content-length']) !== raw.length || raw.length !== entry.sizeBytes || sha256(raw) !== entry.sha256) return json(res, 422, { error: 'source file size or sha256 verification mismatch' })
        state.blobs.set(`${owner}:${entry.sha256}`, raw)
        upload.received.push(file)
        return json(res, 200, { path: file, stored: true })
      }
      m = /^\/api\/deploy\/source-uploads\/([^/]+)\/finalize$/.exec(url.pathname)
      if (m && req.method === 'POST') {
        const upload = state.uploads.get(decodeURIComponent(m[1]))
        if (!upload) return json(res, 404, { error: 'not found' })
        if (upload.entries.some(e => !state.blobs.has(`${owner}:${e.sha256}`))) return json(res, 409, { error: 'upload incomplete' })
        upload.state = 'finalized'
        return json(res, 200, { sourceUploadId: m[1], state: 'finalized', manifestHash: upload.manifestHash })
      }
      m = /^\/api\/deploy\/games\/([^/]+)\/releases$/.exec(url.pathname)
      if (m && req.method === 'GET') {
        const game = state.games.get(m[1])
        if (!game) return json(res, 404, { error: 'not found' })
        const releases = game.releases.map(r => {
          const readiness = state.readinessSequence?.length ? state.readinessSequence.shift() : { status: 'ready', protocol: 0, source: 'publication' }
          return { releaseId: r.releaseId, version: r.version, current: r.releaseId === game.currentReleaseId, readiness }
        })
        return json(res, 200, { gameId: game.id, currentReleaseId: game.currentReleaseId, revision: game.revision, latestVersion: game.version, releases })
      }
      if (route === 'POST /api/deploy' || (req.method === 'PUT' && /^\/api\/deploy\/[A-Za-z0-9_-]+$/.test(url.pathname))) {
        const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData()
        const fields = {}
        const blobs = {}
        for (const [key, value] of form.entries()) {
          if (typeof value === 'string') fields[key] = value
          else blobs[key] = Buffer.from(await value.arrayBuffer())
        }
        const deploy = { method: req.method, path: url.pathname, fields, images: blobs, repository: record.repository, authorization: record.authorization }
        state.deploys.push(deploy)
        const upload = state.uploads.get(fields.sourceUploadId)
        if (!upload || upload.state !== 'finalized' || upload.owner !== owner) return json(res, 400, { error: 'source upload not found' })
        if (!/^release_[0-9a-f]{32,64}$/.test(fields.operation_id ?? '')) return json(res, 400, { error: 'invalid operation_id' })
        if (record.authorization?.startsWith('Bearer ogd-') && !fields.source_checkpoint) return json(res, 400, { error: 'source_checkpoint required' })
        deploy.files = Object.fromEntries(upload.entries.map(e => [e.path, state.blobs.get(`${owner}:${e.sha256}`)]))
        if (req.method === 'POST') {
          if (!fields.title) return json(res, 400, { error: 'missing title' })
          if (!blobs.cover) return json(res, 400, { error: 'cover is required' })
          if (!portalAccepts('cover', blobs.cover)) return json(res, 400, { error: 'cover must be a 16:9 image at least 640×360' })
          if (blobs.poster && !portalAccepts('poster', blobs.poster)) return json(res, 400, { error: 'poster must be a 3:4 image at least 600×800' })
          if (state.readiness422 || state.readinessFails?.(deploy.files)) return json(res, 422, { error: 'readiness_failed: the game did not become ready in the Player because it said hello but never sent ready. Nothing was published.', readiness: { status: 'timeout', protocol: 2, consoleErrors: { count: 0, samples: [] }, failedResources: { count: 0, samples: [] } } })
          const id = randomBytes(5).toString('hex')
          const slug = fields.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          const releaseId = `release_${id}_v1`
          const game = { id, slug, owner, unlisted: fields.unlisted === '1', version: 1, revision: 3, currentReleaseId: releaseId, releases: [{ releaseId, version: 1 }], fields }
          state.games.set(id, game)
          linkSource(fields.source_checkpoint, id, releaseId)
          return json(res, 201, { gameId: id, slug, version: 1, releaseId, traceId: fields.operation_id, warnings: [], playUrl: `${state.origin}/play/${id}/`, portalUrl: `${state.origin}/g/${slug}`, operationId: fields.operation_id })
        }
        const game = state.games.get(url.pathname.split('/').at(-1))
        if (!game) return json(res, 404, { error: 'not found' })
        if (fields.expected_revision === undefined) return json(res, 428, { error: 'expected_revision required; read release history before updating' })
        if (Number(fields.expected_revision) !== game.revision) return json(res, 409, { error: 'game changed; refresh release history and review update', revision: game.revision })
        if (state.readiness422 || state.readinessFails?.(deploy.files)) return json(res, 422, { error: 'readiness_failed: it crashed after ready (TypeError). Nothing was published.', readiness: { status: 'crashed' } })
        // Portal keeps the visibility unless the form names it (formBoolean(body.unlisted, current.unlisted)).
        if (fields.unlisted !== undefined) game.unlisted = fields.unlisted === '1'
        game.version++
        game.revision++
        const releaseId = `release_${game.id}_v${game.version}`
        game.releases.unshift({ releaseId, version: game.version })
        game.currentReleaseId = releaseId
        linkSource(fields.source_checkpoint, game.id, releaseId)
        return json(res, 200, { gameId: game.id, slug: game.slug, version: game.version, releaseId, traceId: fields.operation_id, warnings: [{ code: 'size.total', message: 'fixture advisory' }], playUrl: `${state.origin}/play/${game.id}/`, portalUrl: `${state.origin}/g/${game.slug}`, operationId: fields.operation_id })
      }
    }
    json(res, 404, { error: 'not found' })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => { if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error) }) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${server.address().port}`
  return { state, origin: state.origin, sandboxSession: () => publicSession(issueSession('sandbox')), close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }) }
}
