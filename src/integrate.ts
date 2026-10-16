import { execFileSync } from 'node:child_process'
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

function gitState(dir: string): 'clean' | 'dirty' | 'none' {
  try {
    const out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: dir, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() ? 'dirty' : 'clean'
  } catch {
    return 'none'
  }
}

/**
 * `--integrate`: the only step that writes to the project. The model proposes
 * exact edits that wire scores and saves to Player protocol 2 `call`s; the
 * person sees the diff first, and the working tree must be clean in git (or
 * the person confirms) so every change is reviewable and revertible.
 */
export async function integrate(client: ModelClient, rules: Rules, ui: Ui, input: { projectDir: string; stageDir: string; detection: Detection; digest: Digest; reader: ContextReader }): Promise<{ applied: string[]; skipped: string[]; summary: string } | null> {
  const { projectDir, detection } = input
  if (detection.engine === 'godot' || detection.kind === 'godot-export' || detection.kind === 'prebuilt') {
    ui.warn('--integrate needs web source code (HTML or JavaScript/TypeScript); this project has none, so nothing is wired.')
    return null
  }
  const state = gitState(projectDir)
  if (state !== 'clean') {
    const what = state === 'none' ? 'is not a git repository' : 'has uncommitted changes'
    if (!ui.interactive) throw new WizardError('adapt_failed', `--integrate edits your source, and ${projectDir} ${what}; commit or stash first (with --yes a clean git tree is required)`)
    const go = await ui.confirm(`This project ${what}, so the edits will be hard to review or undo. Continue?`, false)
    if (!go) return null
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
      ui.warn(`No integration edit could be applied${result.skipped.length ? `: ${result.skipped.join('; ')}` : ''}`)
      return { applied: [], skipped: result.skipped, summary: plan.summary }
    }
    ui.note('Integration diff (your source)', [
      plan.summary,
      ...previews.map(p => unifiedDiff(p.file, p.before, p.after)),
      ...created.map(f => `+++ new file ${f.path}\n${f.content.split('\n').slice(0, 40).map(l => `+${l}`).join('\n')}`),
    ].join('\n\n'))
    if (result.skipped.length) ui.warn(`Skipped: ${result.skipped.join('; ')}`)
    const ok = await ui.confirm('Write these changes to your project?', true)
    if (!ok) return null
    for (const p of previews) fs.writeFileSync(inside(projectDir, p.file)!, p.after)
    for (const f of created) {
      const target = inside(projectDir, f.path)!
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.content)
    }
    const applied = [...previews.map(p => p.file), ...created.map(f => `${f.path} (new)`)]
    ui.success(`Integrated in ${applied.join(', ')}`)
    return { applied, skipped: result.skipped, summary: plan.summary }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
