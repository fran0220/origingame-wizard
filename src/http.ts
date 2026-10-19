import fs from 'node:fs'
import path from 'node:path'
import { VERSION } from './constants.js'
import { redact } from './redact.js'

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Headers
  text: string
  /** Parsed JSON body, or null when the body is not JSON. */
  json: any
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  json?: unknown
  body?: NonNullable<RequestInit['body']>
  timeoutMs?: number
}

export class NetworkError extends Error {}

const USER_AGENT = `origingame-wizard/${VERSION} node/${process.versions.node}`

async function read(response: Response): Promise<HttpResponse> {
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, ok: response.ok, headers: response.headers, text, json }
}

export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...options.headers }
  let body = options.body
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      redirect: 'error',
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    throw new NetworkError(redact(`${new URL(url).origin}: ${(error as Error).name === 'TimeoutError' ? 'timed out' : cause ?? (error as Error).message}`))
  }
  return read(response)
}

export interface SendFileOptions {
  method?: string
  headers?: Record<string, string>
  /** The file's size as offered (the manifest's or the LFS batch's): sent as Content-Length and checked against what is read. */
  size: number
  /** Fails when no byte has been sent for this long. */
  idleMs?: number
  /** Fails when the answer takes this long after the last byte (the server is verifying and storing). */
  answerMs?: number
  /** Cancels the request (another upload of the same run failed). */
  signal?: AbortSignal
}

/**
 * Sends a file as the request body, streamed from disk with its exact
 * Content-Length (Portal answers 411 without one, and presigned object-store
 * URLs refuse chunked bodies), so memory stays bounded whatever the file's
 * size. There is no overall deadline: a slow upload that keeps moving is never
 * cut off; one where nothing moves for `idleMs`, or whose answer does not come
 * within `answerMs` of the last byte, fails with a NetworkError.
 */
export async function sendFile(url: string, file: string, options: SendFileOptions): Promise<HttpResponse> {
  const idleMs = options.idleMs ?? 120_000
  const answerMs = options.answerMs ?? 300_000
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let stalled: string | null = null
  let settled = false
  // The body may still be pulled to its end after the answer arrived: a settled request arms nothing.
  const arm = (ms: number, why: string) => {
    clearTimeout(timer)
    if (!settled) timer = setTimeout(() => { stalled = why; controller.abort() }, ms)
  }
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
  let sent = 0
  let changed = false
  async function* body(): AsyncGenerator<Buffer> {
    for await (const chunk of stream) {
      sent += (chunk as Buffer).length
      if (sent > options.size) { changed = true; throw new Error('file grew') }
      arm(idleMs, `no upload progress for ${Math.round(idleMs / 1000)} s`)
      yield chunk as Buffer
    }
    if (sent !== options.size) { changed = true; throw new Error('file shrank') }
    arm(answerMs, `no answer ${Math.round(answerMs / 1000)} s after the upload`)
  }
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) controller.abort()
  arm(idleMs, `no upload progress for ${Math.round(idleMs / 1000)} s`)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'PUT',
      headers: { 'user-agent': USER_AGENT, ...options.headers, 'content-length': String(options.size) },
      body: body() as unknown as ReadableStream,
      duplex: 'half',
      signal: controller.signal,
      redirect: 'error',
    } as RequestInit & { duplex: 'half' })
    arm(answerMs, `no answer ${Math.round(answerMs / 1000)} s after the upload`)
    return await read(response)
  } catch (error) {
    if (changed) throw new Error(`${path.basename(file)} changed on disk while it was being uploaded`)
    const cause = (error as { cause?: { code?: string } }).cause?.code
    throw new NetworkError(redact(`${new URL(url).origin}: ${stalled ?? cause ?? (error as Error).message}`))
  } finally {
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    stream.destroy()
  }
}

/**
 * How long a 429 or 503 asks the client to wait: `Retry-After` in seconds or
 * as an HTTP date, else a JSON `retryAfterSeconds`; null when it does not say.
 */
export function retryAfterMs(response: HttpResponse): number | null {
  const header = response.headers.get('retry-after')
  if (header) {
    if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000
    const at = Date.parse(header)
    if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  }
  const seconds = Number(response.json?.retryAfterSeconds)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/** A short, credential-free description of a failed response for error messages. */
export function describe(response: HttpResponse): string {
  const error = response.json?.error
  const message = typeof error === 'string' ? error
    : typeof error?.message === 'string' ? `${error.code ? `${error.code}: ` : ''}${error.message}`
      : typeof response.json?.message === 'string' ? response.json.message
        : response.text.slice(0, 200)
  return redact(`HTTP ${response.status}${message ? ` ${message}` : ''}`)
}

export function errorCode(response: HttpResponse): string | undefined {
  const error = response.json?.error
  if (typeof error?.code === 'string') return error.code
  if (typeof response.json?.code === 'string') return response.json.code
  if (typeof error === 'string' && /^[a-z_]+$/.test(error)) return error
  return undefined
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
