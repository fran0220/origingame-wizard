import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { WizardError } from './errors.js'
import { describe, request, sleep, NetworkError, type HttpResponse } from './http.js'
import type { Manifest } from './stage.js'
import type { PortalAuth } from './session.js'
import type { Ui } from './ui.js'

/**
 * Portal's publication API (contracts §5): content-addressed source uploads,
 * then one multipart create (POST /api/deploy) or update (PUT /api/deploy/:id).
 */
/** One of the account's games as `GET /api/deploy/mine` lists it. */
export interface OwnGame { id: string; title: string; version: number; unlisted: boolean }

export class Portal {
  constructor(readonly host: string, private readonly auth: PortalAuth) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.auth.token}`,
      ...(this.auth.repositoryId ? { 'x-origin-repository': this.auth.repositoryId } : {}),
      ...extra,
    }
  }

  private async call(path: string, options: { method?: string; json?: unknown; body?: NonNullable<RequestInit['body']>; headers?: Record<string, string>; timeoutMs?: number }, failure: 'upload_failed' | 'publish_failed'): Promise<HttpResponse> {
    let last: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await request(`${this.host}${path}`, { ...options, headers: this.headers(options.headers), timeoutMs: options.timeoutMs ?? 120_000 })
        if (response.status === 503 || response.status === 502 || response.status === 504) { last = new Error(describe(response)); await sleep(1000 * 2 ** attempt); continue }
        return response
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        last = error
        await sleep(1000 * 2 ** attempt)
      }
    }
    throw new WizardError(failure, `${path}: ${(last as Error)?.message ?? 'unreachable'}`)
  }

  /** Uploads only the files Portal does not already hold (by sha256) and returns the finalized upload id. */
  async upload(manifest: Manifest, ui: Ui): Promise<{ sourceUploadId: string; uploaded: number; reused: number }> {
    const prepared = await this.call('/api/deploy/source-uploads', { method: 'POST', json: { files: manifest.entries } }, 'upload_failed')
    if (prepared.status === 401) throw new WizardError(this.auth.repositoryId ? 'upload_failed' : 'not_logged_in', `Portal refused the credential for uploads (${describe(prepared)})`)
    if (!prepared.ok || typeof prepared.json?.sourceUploadId !== 'string' || !Array.isArray(prepared.json?.missing)) {
      throw new WizardError('upload_failed', `could not start the upload: ${describe(prepared)}`)
    }
    if (typeof prepared.json.manifestHash === 'string' && prepared.json.manifestHash !== manifest.hash) {
      throw new WizardError('upload_failed', 'Portal computed a different manifest hash for these files')
    }
    const id = prepared.json.sourceUploadId as string
    const missing = (prepared.json.missing as unknown[]).map(String)
    const byPath = new Map(manifest.entries.map(e => [e.path, e]))
    const s = ui.spinner(`Uploading ${missing.length} of ${manifest.entries.length} files (the rest are unchanged)`)
    let done = 0
    const queue = [...missing]
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const entry = byPath.get(next)
        const local = manifest.local.get(next)
        if (!entry || !local) throw new WizardError('upload_failed', `Portal asked for a file that was not offered: ${next}`)
        const data = fs.readFileSync(local)
        const response = await this.call(`/api/deploy/source-uploads/${encodeURIComponent(id)}/files?path=${encodeURIComponent(next)}`, {
          method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: 300_000,
        }, 'upload_failed')
        if (!response.ok) throw new WizardError('upload_failed', `${next}: ${describe(response)}`)
        done++
        s.update(`Uploading ${done}/${missing.length}`)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(3, missing.length) }, worker))
    } catch (error) {
      s.fail('Upload failed')
      throw error
    }
    const finalized = await this.call(`/api/deploy/source-uploads/${encodeURIComponent(id)}/finalize`, { method: 'POST' }, 'upload_failed')
    if (!finalized.ok) { s.fail('Upload failed'); throw new WizardError('upload_failed', `could not finalize the upload: ${describe(finalized)}`) }
    s.stop(`Uploaded ${missing.length} file${missing.length === 1 ? '' : 's'}, reused ${manifest.entries.length - missing.length}`)
    return { sourceUploadId: id, uploaded: missing.length, reused: manifest.entries.length - missing.length }
  }

  /**
   * The account's own games (`GET /api/deploy/mine`, newest first), or null
   * when Portal does not answer them to this credential.
   */
  async mine(): Promise<OwnGame[] | null> {
    const response = await this.call('/api/deploy/mine', {}, 'publish_failed').catch(() => null)
    const games = response?.ok && Array.isArray(response.json?.games) ? response.json.games : null
    if (!games) return null
    return games.flatMap((g: Record<string, unknown>) => (typeof g.id === 'string' && typeof g.title === 'string'
      ? [{ id: g.id, title: g.title, version: Number(g.version) || 0, unlisted: g.unlisted === true || g.unlisted === 1 }]
      : []))
  }

  async releases(gameId: string): Promise<HttpResponse> {
    return this.call(`/api/deploy/games/${encodeURIComponent(gameId)}/releases`, {}, 'publish_failed')
  }

  /**
   * One publication. The same `operation_id` and byte-identical form are
   * resubmitted while Portal says the operation is running or busy, which
   * Portal answers idempotently.
   */
  async publish(form: () => FormData, target: { gameId?: string }, ui: Ui): Promise<HttpResponse> {
    const path = target.gameId ? `/api/deploy/${encodeURIComponent(target.gameId)}` : '/api/deploy'
    const method = target.gameId ? 'PUT' : 'POST'
    const operationId = `release_${randomBytes(16).toString('hex')}`
    const s = ui.spinner(target.gameId ? 'Publishing a new version' : 'Publishing')
    for (let attempt = 0; attempt < 90; attempt++) {
      const body = form()
      body.set('operation_id', operationId)
      const response = await this.call(path, { method, body, timeoutMs: 300_000 }, 'publish_failed')
      const retry = response.json?.retry
      if (response.status === 202 || ((response.status === 409 || response.status === 429) && retry === 'resubmit_identical')) {
        s.update(response.status === 202 ? 'Portal is publishing' : 'Portal is busy; retrying')
        await sleep(Math.min(10, Math.max(1, Number(response.json?.retryAfterSeconds) || 2)) * 1000)
        continue
      }
      if (response.ok) s.stop('Published')
      else s.fail(response.status === 422 ? 'The game did not become ready' : 'Publishing failed')
      return response
    }
    s.fail('Publishing timed out')
    throw new WizardError('publish_failed', 'Portal did not finish the publication in time; run again (the upload is reused)')
  }

  /** The release's readiness receipt; waits while it is pending, up to `waitMs`. */
  async readiness(gameId: string, releaseId: string, waitMs: number, ui: Ui): Promise<Record<string, unknown>> {
    const deadline = Date.now() + waitMs
    let last: Record<string, unknown> = { status: 'pending' }
    const s = ui.spinner('Waiting for the readiness check')
    for (;;) {
      const response = await this.releases(gameId).catch(() => null)
      const release = response?.ok ? (response.json?.releases as any[] | undefined)?.find(r => r.releaseId === releaseId) : null
      if (release?.readiness) last = release.readiness
      const status = String(last.status ?? 'pending')
      if (status !== 'pending' || Date.now() >= deadline) {
        if (status === 'ready') s.stop('Ready in the Player')
        else if (status === 'pending') s.stop('Readiness check still running; it will appear on the release')
        else s.stop(`Readiness: ${status}`)
        return last
      }
      await sleep(3000)
    }
  }

  /** The team's AIGCC finals state (`GET /api/aigcc/entry/finals`), or null when AIGCC does not answer. */
  async aigccFinals(): Promise<AigccFinals | null> {
    const response = await this.call('/api/aigcc/entry/finals', {}, 'publish_failed').catch(() => null)
    const body = response?.ok ? response.json : null
    return body && typeof body.eligible === 'boolean' ? body as AigccFinals : null
  }

  /** Binds a live release as the team's finals game; AIGCC verifies the team, the window and ownership. */
  async aigccSubmit(gameId: string, releaseId: string): Promise<HttpResponse> {
    return this.call('/api/aigcc/entry/finals/game', { method: 'POST', json: { gameId, releaseId } }, 'publish_failed')
  }
}

export function publishError(response: HttpResponse): WizardError {
  if (response.status === 422 && response.json?.readiness) {
    return new WizardError('readiness_failed', typeof response.json.error === 'string' ? response.json.error : 'the game did not become ready in the Player', { readiness: response.json.readiness })
  }
  if (response.status === 409 && typeof response.json?.revision === 'number') {
    return new WizardError('publish_failed', 'the game changed on the platform while this run was preparing (release revision moved); run again to publish on top of it')
  }
  if (response.status === 401) return new WizardError('not_logged_in', `Portal refused the credential (${describe(response)})`)
  return new WizardError('publish_failed', `Portal refused the publication: ${describe(response)}`)
}

export interface AigccFinals {
  eligible: boolean
  open: boolean
  reason: string | null
  registration: { id: string; teamName: string; projectTitle: string; stage: string; captain: boolean } | null
  game: { gameId: string; releaseId: string; version: number; playUrl: string } | null
}
