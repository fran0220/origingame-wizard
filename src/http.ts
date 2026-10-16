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

export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'user-agent': `origingame-wizard/${VERSION} node/${process.versions.node}`, ...options.headers }
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
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, ok: response.ok, headers: response.headers, text, json }
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
