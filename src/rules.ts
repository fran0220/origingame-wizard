import { PORTAL_ENGINES, RULES_PATH, type Engine } from './constants.js'
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

export interface Rules {
  version: string
  models: { analyze: string; deep: string; image: string }
  images: { cover: ImageRule; poster: ImageRule }
  prompts: { system: string; analyze: string; adapt: string; metadata: string; artwork: string }
  engines: Array<{ id: Engine; markers: string[] }>
  genres: string[]
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
    genres,
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
