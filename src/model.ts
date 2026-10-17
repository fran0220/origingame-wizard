import { WizardError, type ErrorCode } from './errors.js'
import { describe, errorCode, request, sleep, NetworkError } from './http.js'
import { validate, type Schema } from './schema.js'
import type { WizardSession } from './session.js'

export interface Usage { promptTokens: number; completionTokens: number; chatCalls: number; imageCalls: number; models: string[] }

export function newUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, chatCalls: 0, imageCalls: 0, models: [] }
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/**
 * The AI Gateway relay (`/v1/*`) of a host: `ORIGINGAME_API_ORIGIN`, else
 * `https://api.<host>`. The Portal origin does not serve the relay rows
 * (docs/public-api.md, Hosts); a loopback development ingress serves every row.
 */
export function apiOrigin(host: string): string {
  const raw = process.env.ORIGINGAME_API_ORIGIN
  if (raw) {
    let url: URL
    try { url = new URL(raw) } catch { throw new WizardError('invalid_arguments', 'ORIGINGAME_API_ORIGIN must be an origin') }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) {
      throw new WizardError('invalid_arguments', 'ORIGINGAME_API_ORIGIN must use https (http is allowed only for localhost)')
    }
    return url.origin
  }
  const url = new URL(host)
  if (url.protocol === 'http:' && LOOPBACK.includes(url.hostname)) return url.origin
  return `https://api.${url.hostname}`
}

/**
 * The model side of a run: chat completions and image generations through
 * the platform AI Gateway with the run's Wizard session (`ogp-`). The
 * Gateway enforces the model allowlist and the per-run budget.
 */
export class ModelClient {
  /** `host` is the relay origin (apiOrigin), not the Portal. */
  constructor(readonly host: string, private readonly session: WizardSession, readonly usage: Usage) {}

  /** The preferred model when this session may use it, else the first allowlisted text model. */
  textModel(preferred: string): string {
    const allowed = this.session.models
    if (allowed.includes(preferred)) return preferred
    return allowed.find(m => !/image|wan|flux|sd|dall/i.test(m)) ?? preferred
  }

  imageModel(preferred: string): string {
    if (!this.session.models.includes(preferred)) {
      throw new WizardError('artwork_failed', `this Wizard session may not use the image model ${preferred}`)
    }
    return preferred
  }

  private record(model: string) {
    if (!this.usage.models.includes(model)) this.usage.models.push(model)
  }

  private async post(path: string, body: unknown, timeoutMs: number) {
    let last: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await request(`${this.host}${path}`, {
          headers: { authorization: `Bearer ${this.session.credential}` }, json: body, timeoutMs,
        })
        if (response.status >= 500 || response.status === 429) {
          last = new Error(describe(response))
          await sleep(1500 * (attempt + 1))
          continue
        }
        return response
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        last = error
        await sleep(1500 * (attempt + 1))
      }
    }
    throw last ?? new Error('request failed')
  }

  /**
   * One structured task: the system prompt, then `TASK: <name>` and the JSON
   * input. The answer must be a JSON object matching `schema`; an invalid
   * answer is retried once with the validation errors.
   */
  async json<T>(options: { model: string; system: string; task: string; instructions: string; input: unknown; schema: Schema; failure: ErrorCode; maxTokens?: number }): Promise<T> {
    const user = `TASK: ${options.task}\n\n${options.instructions}\n\nRespond with one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(options.schema)}\n\nINPUT:\n${JSON.stringify(options.input)}`
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: options.system },
      { role: 'user', content: user },
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = {
        model: options.model, messages, stream: false, temperature: 0.2,
        max_tokens: options.maxTokens ?? 4096, response_format: { type: 'json_object' },
      }
      let response
      try {
        this.usage.chatCalls++
        this.record(options.model)
        response = await this.post('/v1/chat/completions', body, 180_000)
      } catch (error) {
        throw new WizardError(options.failure, `the ${options.task} step could not reach the model: ${(error as Error).message}`)
      }
      if (!response.ok) {
        const code = errorCode(response)
        const why = response.status === 403 && /quota/i.test(`${code ?? ''} ${response.text}`) ? 'this run used up its model budget'
          : response.status === 403 ? `the model ${options.model} is not allowed for this session`
            : response.status === 401 ? 'the Wizard session expired' : describe(response)
        throw new WizardError(options.failure, `the ${options.task} step failed: ${why}`)
      }
      const usage = response.json?.usage
      if (usage) {
        this.usage.promptTokens += Number(usage.prompt_tokens) || 0
        this.usage.completionTokens += Number(usage.completion_tokens) || 0
      }
      const content = String(response.json?.choices?.[0]?.message?.content ?? '')
      let parsed: unknown = null
      let errors: string[]
      try {
        parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
        errors = validate(parsed, options.schema)
      } catch {
        errors = ['the answer is not valid JSON']
      }
      if (!errors.length) return parsed as T
      messages.push({ role: 'assistant', content: content.slice(0, 20_000) })
      messages.push({ role: 'user', content: `That answer does not match the schema: ${errors.slice(0, 10).join('; ')}. Answer again with only the corrected JSON object.` })
    }
    throw new WizardError(options.failure, `the model's ${options.task} answer did not match its contract twice`)
  }

  /** One image; returns its bytes. Retries once at `fallbackSize` when the size is refused. */
  async image(model: string, prompt: string, size: string, fallbackSize: string): Promise<{ bytes: Buffer; size: string }> {
    for (const candidate of size === fallbackSize ? [size] : [size, fallbackSize]) {
      this.usage.imageCalls++
      this.record(model)
      let response
      try {
        response = await this.post('/v1/images/generations', { model, prompt, size: candidate, n: 1 }, 240_000)
      } catch (error) {
        throw new WizardError('artwork_failed', `image generation could not reach the model: ${(error as Error).message}`)
      }
      if (response.status === 400 && candidate !== fallbackSize) continue
      if (!response.ok) throw new WizardError('artwork_failed', `image generation failed: ${describe(response)}`)
      const item = response.json?.data?.[0]
      if (typeof item?.b64_json === 'string') return { bytes: Buffer.from(item.b64_json, 'base64'), size: candidate }
      if (typeof item?.url === 'string' && /^https?:\/\//.test(item.url)) {
        // The image URL is the provider's or the Gateway's file host: it never gets the session credential.
        const res = await fetch(item.url, { signal: AbortSignal.timeout(60_000) }).catch(() => null)
        if (!res?.ok) throw new WizardError('artwork_failed', `could not download a generated image (HTTP ${res?.status ?? 'error'})`)
        return { bytes: Buffer.from(await res.arrayBuffer()), size: candidate }
      }
      throw new WizardError('artwork_failed', 'image generation returned no image')
    }
    throw new WizardError('artwork_failed', `the image model refused both ${size} and ${fallbackSize}`)
  }
}
