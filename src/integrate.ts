import fs from 'node:fs'
import path from 'node:path'
import { applyEdits, inside, integrationRefusal, unifiedDiff } from './adapt.js'
import type { Detection } from './detect.js'
import type { ContextReader, Digest } from './digest.js'
import { WizardError } from './errors.js'
import type { ModelClient } from './model.js'
import type { Rules } from './rules.js'
import { INTEGRATE_SCHEMA, type Integration } from './tasks.js'
import type { Ui } from './ui.js'

/**
 * Score and save integration: the model proposes exact edits that wire scores
 * and saves to Player protocol 2 `call`s, applied to the run's workspace (the
 * `origingame/publish` worktree or a copy), never the person's checkout. The
 * diff is shown; `undo` restores the workspace files it changed.
 */
export interface IntegrationResult { applied: string[]; skipped: string[]; summary: string; undo: Array<{ file: string; before: string | null }> }

export async function integrate(client: ModelClient, rules: Rules, ui: Ui, input: { projectDir: string; stageDir: string; detection: Detection; digest: Digest; reader: ContextReader; where: string }): Promise<IntegrationResult | { refused: string }> {
  const { projectDir, detection } = input
  if (detection.engine === 'godot' || detection.kind === 'godot-export' || detection.kind === 'prebuilt') {
    return { refused: 'the project has no web source code (HTML or JavaScript/TypeScript) to wire' }
  }
  const s = ui.spinner('Planning the score and save integration')
  const plan = await client.json<Integration>({
    model: client.textModel(rules.models.deep), system: rules.prompts.system, task: 'integrate', instructions: rules.prompts.adapt,
    input: { mode: 'integrate', digest: input.digest }, schema: INTEGRATE_SCHEMA, failure: 'adapt_failed', maxTokens: 8192,
  })
  s.stop('Integration planned')

  const previews: Array<{ file: string; before: string; after: string }> = []
  const scratch = path.join(input.stageDir, 'integrate-preview')
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.mkdirSync(scratch, { recursive: true })
  try {
    // Preview on copies of the touched files only.
    const touched = new Set(plan.edits.map(e => e.path))
    for (const file of touched) {
      const from = inside(projectDir, file)
      const to = inside(scratch, file)
      if (from && to && fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
    }
    const result = applyEdits(scratch, plan.edits, { allow: integrationRefusal })
    for (const file of touched) {
      const from = inside(projectDir, file)
      const to = inside(scratch, file)
      if (!from || !to || !fs.existsSync(to)) continue
      const before = fs.readFileSync(from, 'utf8')
      const after = fs.readFileSync(to, 'utf8')
      if (before !== after) previews.push({ file, before, after })
    }
    const created = (plan.new_files ?? []).filter(f => {
      const target = inside(projectDir, f.path)
      if (!target || integrationRefusal(f.path) || fs.existsSync(target)) { result.skipped.push(`${f.path}: new file refused (exists, outside the project or not source)`); return false }
      return true
    })
    if (!previews.length && !created.length) {
      return { refused: `no integration edit could be applied${result.skipped.length ? `: ${result.skipped.join('; ')}` : ''}` }
    }
    ui.note(`Score and save integration (${input.where})`, [
      plan.summary,
      ...previews.map(p => unifiedDiff(p.file, p.before, p.after)),
      ...created.map(f => `+++ new file ${f.path}\n${f.content.split('\n').slice(0, 40).map(l => `+${l}`).join('\n')}`),
    ].join('\n\n'))
    if (result.skipped.length) ui.warn(`Skipped: ${result.skipped.join('; ')}`)
    const undo: IntegrationResult['undo'] = []
    for (const p of previews) {
      const target = inside(projectDir, p.file)!
      undo.push({ file: target, before: p.before })
      fs.writeFileSync(target, p.after)
    }
    for (const f of created) {
      const target = inside(projectDir, f.path)!
      undo.push({ file: target, before: null })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.content)
    }
    const applied = [...previews.map(p => p.file), ...created.map(f => `${f.path} (new)`)]
    ui.success(`Integrated in ${applied.join(', ')}`)
    return { applied, skipped: result.skipped, summary: plan.summary, undo }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
