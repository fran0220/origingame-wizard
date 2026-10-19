import { DEFAULT_LIMITS, LIMIT_BOUNDS, RULES_PATH, type Limits } from './constants.js'
import { WizardError } from './errors.js'
import { request } from './http.js'

export interface ImageRule {
  /** Size requested from the image model, `WxH`. */
  size: string
  /** Size retried when the model refuses `size`. */
  fallback: string
  /** Size the Wizard crops and scales every candidate to before upload. */
  output: string
  candidates: number
}

/**
 * What this version reads from the platform's rules document: the models,
 * the goal prompt, the artwork prompt, genres and Portal's limits. The
 * document also carries keys older Wizards need (`engines`, `families`, the
 * 0.5 task prompts); this version ignores them.
 */
export interface Rules {
  version: string
  /** `agent` drives the publishing loop; `analyze` writes artwork prompts; `image` draws. */
  models: { agent: string; analyze: string; image: string }
  images: { cover: ImageRule; poster: ImageRule }
  prompts: { agent: string; system: string; artwork: string }
  genres: string[]
  limits: Limits
}

/**
 * `limits` is read leniently: a missing or malformed value keeps this
 * version's default, and a number outside `LIMIT_BOUNDS` is clamped into it,
 * so a typo in the document can neither stop every run nor make the Wizard
 * open thousands of connections.
 */
export function parseLimits(value: unknown): Limits {
  const section = <K extends keyof Limits>(key: K): Limits[K] => {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
    const defaults = DEFAULT_LIMITS[key] as Record<string, number>
    const bounds = LIMIT_BOUNDS[key] as Record<string, readonly [number, number]>
    const out: Record<string, number> = {}
    for (const name of Object.keys(defaults)) {
      const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[name] : undefined
      const [min, max] = bounds[name]!
      out[name] = typeof given === 'number' && Number.isFinite(given) ? Math.min(max, Math.max(min, Math.floor(given))) : defaults[name]!
    }
    return out as Limits[K]
  }
  return { portal: section('portal'), upload: section('upload') }
}

const SIZE = /^(\d{2,5})x(\d{2,5})$/

export function parseSize(value: string): { width: number; height: number } {
  const match = SIZE.exec(value)
  if (!match) throw new Error(`invalid size ${value}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function fail(reason: string): never {
  throw new WizardError('rules_unavailable', `the platform's Wizard rules are invalid (${reason}); try again later or update origingame`)
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} missing`)
  return value
}

function imageRule(value: any, name: string): ImageRule {
  if (!value || typeof value !== 'object') fail(`images.${name} missing`)
  const size = str(value.size, `images.${name}.size`)
  const fallback = str(value.fallback, `images.${name}.fallback`)
  const output = typeof value.output === 'string' ? value.output : fallback
  for (const s of [size, fallback, output]) if (!SIZE.test(s)) fail(`images.${name} size ${s}`)
  const candidates = Number.isInteger(value.candidates) ? Math.min(3, Math.max(1, value.candidates)) : 2
  return { size, fallback, output, candidates }
}

export function validateRules(value: any): Rules {
  if (!value || typeof value !== 'object') fail('not an object')
  const prompts = value.prompts ?? {}
  const genres = Array.isArray(value.genres) && value.genres.every((g: unknown) => typeof g === 'string') && value.genres.length ? value.genres as string[] : fail('genres missing')
  const analyze = str(value.models?.analyze, 'models.analyze')
  return {
    version: str(value.version, 'version'),
    models: {
      // A document from before 0.6 has no `agent` model: its `deep` model drives the loop.
      agent: typeof value.models?.agent === 'string' && value.models.agent.trim() ? value.models.agent : typeof value.models?.deep === 'string' ? value.models.deep : analyze,
      analyze,
      image: str(value.models?.image, 'models.image'),
    },
    images: { cover: imageRule(value.images?.cover, 'cover'), poster: imageRule(value.images?.poster, 'poster') },
    prompts: {
      agent: str(prompts.agent, 'prompts.agent (this platform does not serve Origin Wizard 0.6 yet; use npx origingame@0.5)'),
      system: str(prompts.system, 'prompts.system'),
      artwork: str(prompts.artwork, 'prompts.artwork'),
    },
    genres,
    limits: parseLimits(value.limits),
  }
}

/** Downloads the rules; there is no bundled fallback (single source, contracts §4). */
export async function fetchRules(host: string): Promise<Rules> {
  let response
  try {
    response = await request(`${host}${RULES_PATH}`, { timeoutMs: 20_000 })
  } catch (error) {
    throw new WizardError('rules_unavailable', `could not download the Wizard rules from ${host}${RULES_PATH}: ${(error as Error).message}`)
  }
  if (!response.ok || !response.json) {
    throw new WizardError('rules_unavailable', `could not download the Wizard rules from ${host}${RULES_PATH} (HTTP ${response.status})`)
  }
  return validateRules(response.json)
}
