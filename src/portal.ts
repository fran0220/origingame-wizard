import { randomBytes } from 'node:crypto'
import { DEFAULT_LIMITS, type Limits } from './constants.js'
import { WizardError } from './errors.js'
import { describe, request, retryAfterMs, sendFile, sleep, NetworkError, type HttpResponse } from './http.js'
import type { Manifest } from './stage.js'
import type { PortalAuth } from './session.js'
import type { Ui } from './ui.js'

/**
 * Portal's publication API (contracts §5): content-addressed source uploads,
 * then one multipart create (POST /api/deploy) or update (PUT /api/deploy/:id).
 */
/** One of the account's games as `GET /api/deploy/mine` lists it. */
export interface OwnGame { id: string; title: string; version: number; unlisted: boolean }

/** Answers worth sending the same request again for: throttling, a busy or restarting server, a gateway in between. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504])
/** How often an upload starts over with a fresh upload id after Portal reports the open one expired or gone. */
const MAX_RESUMES = 3

/** The wait before attempt `attempt + 1`: what the server asked for (capped), else exponential. */
function backoff(attempt: number, response?: HttpResponse): number {
  const asked = response ? retryAfterMs(response) : null
  if (asked !== null) return Math.min(60_000, Math.max(250, asked))
  return Math.min(30_000, 1000 * 2 ** attempt)
}

const MiB = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`

export class Portal {
  constructor(readonly host: string, private readonly auth: PortalAuth, private readonly limits: Limits = DEFAULT_LIMITS) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.auth.token}`,
      ...(this.auth.repositoryId ? { 'x-origin-repository': this.auth.repositoryId } : {}),
      ...extra,
    }
  }

  /**
   * One Portal request, sent again on a network error or a gateway answer. With
   * `throttle` (the upload routes) a 429, 408 or 500 is retried as well, after
   * the Retry-After the server asks for.
   */
  private async call(path: string, options: { method?: string; json?: unknown; body?: NonNullable<RequestInit['body']>; headers?: Record<string, string>; timeoutMs?: number; throttle?: boolean }, failure: 'upload_failed' | 'publish_failed'): Promise<HttpResponse> {
    let last: unknown
    const attempts = options.throttle ? 6 : 4
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await request(`${this.host}${path}`, { ...options, headers: this.headers(options.headers), timeoutMs: options.timeoutMs ?? 120_000 })
        const retry = options.throttle ? TRANSIENT.has(response.status) : (response.status === 503 || response.status === 502 || response.status === 504)
        if (retry && attempt < attempts - 1) { last = new Error(describe(response)); await sleep(backoff(attempt, response)); continue }
        if (retry) throw new WizardError(failure, `${path}: ${describe(response)}`)
        return response
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        last = error
        if (attempt < attempts - 1) await sleep(backoff(attempt))
      }
    }
    throw new WizardError(failure, `${path}: ${(last as Error)?.message ?? 'unreachable'}`)
  }

  /**
   * One file's bytes, streamed from disk. Transient answers and network
   * failures are retried (the route is idempotent: the content is addressed by
   * its sha256); the answer is returned otherwise, including 404 and 410.
   */
  private async putFile(id: string, file: string, local: string, size: number, signal: AbortSignal): Promise<HttpResponse> {
    const url = `${this.host}/api/deploy/source-uploads/${encodeURIComponent(id)}/files?path=${encodeURIComponent(file)}`
    let last: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal.aborted) throw signal.reason
      try {
        const response = await sendFile(url, local, { method: 'PUT', size, signal, headers: this.headers({ 'content-type': 'application/octet-stream' }) })
        if (!TRANSIENT.has(response.status)) return response
        last = new Error(describe(response))
        if (attempt < 5) await sleep(backoff(attempt, response))
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (!(error instanceof NetworkError)) throw new WizardError('upload_failed', `${file}: ${(error as Error).message}`)
        last = error
        if (attempt < 5) await sleep(backoff(attempt))
      }
    }
    throw new WizardError('upload_failed', `${file}: ${(last as Error)?.message ?? 'unreachable'}`)
  }

  /** Offers the manifest; Portal answers the upload id and which files it does not already hold. */
  private async prepare(manifest: Manifest): Promise<{ id: string; missing: string[] }> {
    const prepared = await this.call('/api/deploy/source-uploads', { method: 'POST', json: { files: manifest.entries }, throttle: true }, 'upload_failed')
    if (prepared.status === 401) throw new WizardError(this.auth.repositoryId ? 'upload_failed' : 'not_logged_in', `Portal refused the credential for uploads (${describe(prepared)})`)
    if (!prepared.ok || typeof prepared.json?.sourceUploadId !== 'string' || !Array.isArray(prepared.json?.missing)) {
      throw new WizardError('upload_failed', `could not start the upload: ${describe(prepared)}`)
    }
    if (typeof prepared.json.manifestHash === 'string' && prepared.json.manifestHash !== manifest.hash) {
      throw new WizardError('upload_failed', 'Portal computed a different manifest hash for these files')
    }
    return { id: prepared.json.sourceUploadId as string, missing: (prepared.json.missing as unknown[]).map(String) }
  }

  /**
   * Uploads only the files Portal does not already hold (by sha256),
   * `limits.upload.concurrency` at a time, and returns the finalized upload
   * id. An upload that expired (410) or is gone (404) is prepared again and
   * continues with what the new one is missing: the files already sent are
   * content-addressed and are not sent twice.
   */
  async upload(manifest: Manifest, ui: Ui): Promise<{ sourceUploadId: string; uploaded: number; reused: number }> {
    const byPath = new Map(manifest.entries.map(e => [e.path, e]))
    const sent = new Set<string>()
    let s: ReturnType<Ui['spinner']> | null = null
    try {
      for (let round = 0; ; round++) {
        const { id, missing } = await this.prepare(manifest)
        const bytes = missing.reduce((n, p) => n + (byPath.get(p)?.sizeBytes ?? 0), 0)
        const workers = Math.max(1, Math.min(this.limits.upload.concurrency, missing.length))
        s = round === 0
          ? ui.spinner(`Uploading ${missing.length} of ${manifest.entries.length} files, ${MiB(bytes)} (the rest are unchanged)${missing.length > 1 ? `, ${workers} at a time` : ''}`)
          : ui.spinner(`Resuming the upload: ${missing.length} files, ${MiB(bytes)} left`)
        const gone = await this.sendMissing(id, missing, manifest, workers, (done, doneBytes) => s!.update(`Uploading ${done}/${missing.length} (${MiB(doneBytes)} of ${MiB(bytes)})`), sent)
        if (gone) s.stop(`Portal ended the open upload (HTTP ${gone}); preparing it again`)
        else {
          const finalized = await this.call(`/api/deploy/source-uploads/${encodeURIComponent(id)}/finalize`, { method: 'POST', throttle: true }, 'upload_failed')
          if (finalized.ok) {
            const reused = manifest.entries.length - sent.size
            s.stop(`Uploaded ${sent.size} file${sent.size === 1 ? '' : 's'}, reused ${reused}`)
            return { sourceUploadId: id, uploaded: sent.size, reused }
          }
          // Expired or gone since the last file, or Portal no longer holds a file: prepare again.
          if (!(finalized.status === 404 || finalized.status === 410 || (finalized.status === 409 && Array.isArray(finalized.json?.missing)))) {
            throw new WizardError('upload_failed', `could not finalize the upload: ${describe(finalized)}`)
          }
          s.stop(`Portal did not finalize the upload (${describe(finalized)}); preparing it again`)
        }
        if (round >= MAX_RESUMES) throw new WizardError('upload_failed', `the upload kept expiring on Portal (${round + 1} attempts); run again (files already sent are reused)`)
      }
    } catch (error) {
      s?.fail('Upload failed')
      throw error
    }
  }

  /** Sends `missing` to upload `id`; the status (410 or 404) when Portal reported the upload expired or gone partway, else null. */
  private async sendMissing(id: string, missing: string[], manifest: Manifest, workers: number, progress: (done: number, bytes: number) => void, sent: Set<string>): Promise<number | null> {
    const byPath = new Map(manifest.entries.map(e => [e.path, e]))
    const stop = new AbortController()
    const queue = [...missing]
    let gone: number | null = null
    let failure: unknown = null
    let done = 0
    let doneBytes = 0
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined && !stop.signal.aborted; next = queue.shift()) {
        const entry = byPath.get(next)
        const local = manifest.local.get(next)
        if (!entry || !local) throw new WizardError('upload_failed', `Portal asked for a file that was not offered: ${next}`)
        const response = await this.putFile(id, next, local, entry.sizeBytes, stop.signal)
        if (response.status === 404 || response.status === 410) { gone ??= response.status; stop.abort(new Error('upload gone')); return }
        if (!response.ok) throw new WizardError('upload_failed', `${next}: ${describe(response)}`)
        sent.add(next)
        done++
        doneBytes += entry.sizeBytes
        progress(done, doneBytes)
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker().catch(error => {
      if (stop.signal.aborted) return
      failure ??= error
      stop.abort(error)
    })))
    if (failure) throw failure
    return gone
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
