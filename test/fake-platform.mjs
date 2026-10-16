// A stand-in for the OriginGame platform that implements the Wizard's contracts
// (goals/origingame-wizard/contracts.md §1.1–1.3, §4, §5, §6): Identity device
// sign-in, Wizard sessions and revocation, the public rules document, the AI
// Gateway's chat and image routes (scripted answers, real PNGs of the requested
// size, model allowlist), and Portal's source uploads, deploys and releases.
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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake')
    const raw = await body(req)
    const record = { method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization ?? null, repository: req.headers['x-origin-repository'] ?? null, contentType: req.headers['content-type'] ?? null, bytes: raw.length }
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

    // Portal (contracts §5).
    if (url.pathname.startsWith('/api/deploy')) {
      const owner = portalOwner(req)
      if (!owner) return json(res, 401, { error: 'invalid api key' })
      if (route === 'POST /api/deploy/source-uploads') {
        const { files: entries } = JSON.parse(raw.toString())
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
          if (state.readiness422) return json(res, 422, { error: 'readiness_failed: the game did not become ready in the Player because it said hello but never sent ready. Nothing was published.', readiness: { status: 'timeout', protocol: 2, consoleErrors: { count: 0, samples: [] }, failedResources: { count: 0, samples: [] } } })
          const id = randomBytes(5).toString('hex')
          const slug = fields.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          const releaseId = `release_${id}_v1`
          const game = { id, slug, version: 1, revision: 3, currentReleaseId: releaseId, releases: [{ releaseId, version: 1 }], fields }
          state.games.set(id, game)
          return json(res, 201, { gameId: id, slug, version: 1, releaseId, traceId: fields.operation_id, warnings: [], playUrl: `${state.origin}/play/${id}/`, portalUrl: `${state.origin}/g/${slug}`, operationId: fields.operation_id })
        }
        const game = state.games.get(url.pathname.split('/').at(-1))
        if (!game) return json(res, 404, { error: 'not found' })
        if (fields.expected_revision === undefined) return json(res, 428, { error: 'expected_revision required; read release history before updating' })
        if (Number(fields.expected_revision) !== game.revision) return json(res, 409, { error: 'game changed; refresh release history and review update', revision: game.revision })
        if (state.readiness422) return json(res, 422, { error: 'readiness_failed: it crashed after ready (TypeError). Nothing was published.', readiness: { status: 'crashed' } })
        game.version++
        game.revision++
        const releaseId = `release_${game.id}_v${game.version}`
        game.releases.unshift({ releaseId, version: game.version })
        game.currentReleaseId = releaseId
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
