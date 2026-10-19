import { DEFAULT_LIMITS, LIMIT_BOUNDS, PORTAL_ENGINES, RULES_PATH, type Engine, type Limits } from './constants.js'
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
 * A game family: an engine or framework the Wizard names to the person
 * ("Construct 3", "Unity", "Phaser") while Portal receives `engine`, one of
 * its catalog ids. Served under `families`, a key Wizard 0.1–0.3 ignore: those
 * versions refuse the whole document when `engines` names an id they do not
 * know, so `engines` keeps only `html`, `threejs` and `godot`.
 */
export interface Family {
  id: string
  label: string
  /** The Portal engine id this family publishes as (`html` when Portal has none of its own). */
  engine: Engine
  /** Same syntax as engine markers; a part with a `/` matches a path relative to the scanned root. */
  markers: string[]
  /** The published files are an engine's generated export, not hand-written source: no score/save wiring. */
  generated: boolean
  /** A matching marker also locates the export's root directory inside a larger folder. */
  locate: boolean
}

export interface Rules {
  version: string
  models: { analyze: string; deep: string; image: string }
  images: { cover: ImageRule; poster: ImageRule }
  prompts: { system: string; analyze: string; adapt: string; metadata: string; artwork: string }
  engines: Array<{ id: Engine; markers: string[] }>
  families: Family[]
  genres: string[]
  /** Portal's upload limits and the upload concurrency (`limits`, 0.5.0; older versions ignore it). */
  limits: Limits
}

const FAMILY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * `families` is optional and read leniently, so the document can grow without
 * breaking this version: a malformed entry is skipped, and an engine this
 * version does not know publishes as `html`.
 */
export function parseFamilies(value: unknown): Family[] {
  if (!Array.isArray(value)) return []
  const out: Family[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Record<string, unknown>
    if (typeof f.id !== 'string' || !FAMILY_ID.test(f.id) || out.some(x => x.id === f.id)) continue
    if (!Array.isArray(f.markers) || !f.markers.length || f.markers.some(m => typeof m !== 'string' || !m)) continue
    const label = typeof f.label === 'string' && f.label.trim() ? f.label.trim().slice(0, 60) : f.id
    const engine = (PORTAL_ENGINES as readonly string[]).includes(f.engine as string) ? f.engine as Engine : 'html'
    out.push({ id: f.id, label, engine, markers: f.markers as string[], generated: f.generated === true, locate: f.locate === true })
  }
  return out
}

/**
 * `limits` is optional and read leniently, like `families`: a missing or
 * malformed value keeps this version's default, and a number outside
 * `LIMIT_BOUNDS` is clamped into it, so a typo in the document can neither
 * stop every run nor make the Wizard open thousands of connections.
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
  const engines = Array.isArray(value.engines) ? value.engines : fail('engines missing')
  const parsedEngines = engines.map((engine: any) => {
    if (!PORTAL_ENGINES.includes(engine?.id)) fail(`unknown engine ${engine?.id}`)
    if (!Array.isArray(engine.markers) || engine.markers.some((m: unknown) => typeof m !== 'string')) fail(`engine ${engine.id} markers`)
    return { id: engine.id as Engine, markers: engine.markers as string[] }
  })
  const genres = Array.isArray(value.genres) && value.genres.every((g: unknown) => typeof g === 'string') ? value.genres as string[] : fail('genres missing')
  return {
    version: str(value.version, 'version'),
    models: { analyze: str(value.models?.analyze, 'models.analyze'), deep: str(value.models?.deep, 'models.deep'), image: str(value.models?.image, 'models.image') },
    images: { cover: imageRule(value.images?.cover, 'cover'), poster: imageRule(value.images?.poster, 'poster') },
    prompts: {
      system: str(prompts.system, 'prompts.system'),
      analyze: str(prompts.analyze, 'prompts.analyze'),
      adapt: str(prompts.adapt, 'prompts.adapt'),
      metadata: str(prompts.metadata, 'prompts.metadata'),
      artwork: str(prompts.artwork, 'prompts.artwork'),
    },
    engines: parsedEngines,
    families: parseFamilies(value.families),
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
