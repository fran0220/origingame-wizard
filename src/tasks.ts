import type { ContextReader, Digest, FileContent, Scope } from './digest.js'
import { ITEM_KINDS, type Findings, type PlanItem } from './findings.js'
import type { ModelClient } from './model.js'
import type { Rules } from './rules.js'
import type { Schema } from './schema.js'

const str = (maxLength: number): Schema => ({ type: 'string', maxLength })
const list = (items: Schema, maxItems: number): Schema => ({ type: 'array', items, maxItems })

export const ANALYZE_SCHEMA: Schema = {
  type: 'object',
  required: ['summary', 'orientation', 'items'],
  properties: {
    summary: str(800),
    orientation: { type: 'string', enum: ['landscape', 'portrait', 'any'] },
    orientation_reason: str(400),
    items: list({
      type: 'object',
      required: ['id', 'kind', 'title', 'reason', 'recommended'],
      properties: {
        id: str(64), kind: { type: 'string', enum: ITEM_KINDS }, title: str(160), reason: str(600),
        recommended: { type: 'boolean' }, paths: list(str(300), 20),
      },
    }, 20),
    read: list({ type: 'object', required: ['scope', 'path'], properties: { scope: { type: 'string', enum: ['build', 'source'] }, path: str(300) } }, 8),
    risks: list(str(400), 10),
  },
}

const EDIT: Schema = {
  type: 'object',
  required: ['path', 'find', 'replace'],
  properties: { item: str(64), path: str(300), find: str(4000), replace: str(12000), why: str(400) },
}

export const ADAPT_SCHEMA: Schema = {
  type: 'object', required: ['edits'],
  properties: { edits: list(EDIT, 40), notes: list(str(400), 10) },
}

export const INTEGRATE_METHODS = ['player.name', 'leaderboard.submit', 'leaderboard.top', 'save.get', 'save.set'] as const

export const INTEGRATE_SCHEMA: Schema = {
  type: 'object', required: ['summary', 'edits'],
  properties: {
    summary: str(800),
    edits: list(EDIT, 40),
    new_files: list({ type: 'object', required: ['path', 'content'], properties: { path: str(300), content: str(20000), why: str(400) } }, 3),
    methods: list({ type: 'string', enum: INTEGRATE_METHODS }, 5),
    notes: list(str(400), 10),
  },
}

export function metadataSchema(genres: string[]): Schema {
  return {
    type: 'object',
    required: ['title', 'tagline', 'description', 'genre', 'tags', 'controls'],
    properties: {
      title: str(60), tagline: str(120), description: str(2000),
      genre: { type: 'string', enum: genres }, tags: list(str(24), 8), controls: str(600),
      languages: list(str(8), 8),
      input_hints: list({ type: 'string', enum: ['touch', 'keyboard', 'gamepad'] }, 3),
      aspect: str(9), art_direction: str(800),
    },
  }
}

export const ARTWORK_SCHEMA: Schema = {
  type: 'object', required: ['cover', 'poster'],
  properties: { cover: list(str(1500), 3), poster: list(str(1500), 3) },
}

export interface Analysis { summary: string; orientation: 'landscape' | 'portrait' | 'any'; orientation_reason?: string; items: Array<Omit<PlanItem, 'source'>>; read?: Array<{ scope: Scope; path: string }>; risks?: string[] }
export interface Edit { item?: string; path: string; find: string; replace: string; why?: string }
export interface Integration { summary: string; edits: Edit[]; new_files?: Array<{ path: string; content: string; why?: string }>; methods?: string[]; notes?: string[] }
export interface Metadata { title: string; tagline: string; description: string; genre: string; tags: string[]; controls: string; languages?: string[]; input_hints?: string[]; aspect?: string; art_direction?: string }

/** Analysis: at most two rounds; the second only when the model asks to read named files. */
export async function analyze(client: ModelClient, rules: Rules, digest: Digest, reader: ContextReader, deep: boolean): Promise<Analysis> {
  const model = client.textModel(deep ? rules.models.deep : rules.models.analyze)
  const input: { digest: Digest; requested?: FileContent[] } = { digest }
  let answer = await client.json<Analysis>({ model, system: rules.prompts.system, task: 'analyze', instructions: rules.prompts.analyze, input, schema: ANALYZE_SCHEMA, failure: 'adapt_failed' })
  const requested = (answer.read ?? []).map(r => reader.read(r.scope, r.path, 16 * 1024)).filter((c): c is FileContent => c !== null)
  if (requested.length) {
    input.requested = requested
    answer = await client.json<Analysis>({ model, system: rules.prompts.system, task: 'analyze', instructions: `${rules.prompts.analyze}\n\nThe files you asked to read are in INPUT.requested. Do not ask to read again; give the final plan.`, input, schema: ANALYZE_SCHEMA, failure: 'adapt_failed' })
  }
  return answer
}

const SINGULAR = new Set(['entry_index', 'strip_platform_config', 'relative_paths', 'cross_origin_isolation', 'remove_service_worker', 'orientation'])

/**
 * The plan the person confirms: every deterministic finding (the model cannot
 * remove a fact), then the model's own items that the Wizard can apply.
 */
export function mergePlan(findings: Findings, analysis: Analysis, stageFiles: Set<string>): { items: PlanItem[]; dropped: string[] } {
  const items: PlanItem[] = [...findings.items]
  const dropped: string[] = []
  const kinds = new Set(items.map(i => i.kind))
  const ids = new Set(items.map(i => i.id))
  for (const raw of analysis.items) {
    const item: PlanItem = { ...raw, source: 'model', paths: (raw.paths ?? []).map(p => p.replace(/^\.?\//, '')) }
    if (SINGULAR.has(item.kind) && kinds.has(item.kind)) continue
    if (['entry_index', 'strip_platform_config', 'relative_paths', 'remove_service_worker', 'orientation'].includes(item.kind)) {
      dropped.push(`${item.title} (${item.kind} is decided by the Wizard's own checks)`)
      continue
    }
    if (item.kind === 'exclude_files' || item.kind === 'code_edit') {
      const paths = item.paths!.filter(p => stageFiles.has(p) && !(item.kind === 'exclude_files' && p === 'index.html'))
      if (!paths.length) { dropped.push(`${item.title} (names no file in the build)`); continue }
      item.paths = paths
    }
    if (item.kind === 'cross_origin_isolation' && stageFiles.has('origingame.runtime.json')) continue
    let id = item.id.replace(/[^A-Za-z0-9_-]/g, '-') || item.kind
    while (ids.has(id)) id = `${id}-x`
    item.id = id
    ids.add(id)
    kinds.add(item.kind)
    items.push(item)
  }
  if (analysis.orientation !== 'any') {
    items.push({ id: 'orientation', kind: 'orientation', value: analysis.orientation, title: `List the game as ${analysis.orientation}`, reason: analysis.orientation_reason ?? 'from the analysis', recommended: true, source: 'model' })
  }
  return { items, dropped }
}
