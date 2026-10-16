import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Detection } from './detect.js'
import { WizardError } from './errors.js'
import { readText } from './files.js'
import { redact } from './redact.js'
import type { Ui } from './ui.js'

export interface BuildResult {
  /** Absolute directory holding the built game. */
  outputDir: string
  /** Entry page inside `outputDir`. */
  entry: string
  built: boolean
  warnings: string[]
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const NEVER_COPY = new Set(['node_modules', '.git', '.hg', '.svn'])

function run(command: string, args: string[], cwd: string, log: string): Promise<number> {
  return new Promise(resolve => {
    const env = { ...process.env }
    delete env.OG_API_KEY
    const out = fs.openSync(log, 'a')
    fs.writeSync(out, `$ ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, out], shell: process.platform === 'win32' })
    const timer = setTimeout(() => child.kill('SIGTERM'), BUILD_TIMEOUT_MS)
    child.on('error', error => { fs.writeSync(out, `\n${error.message}\n`); clearTimeout(timer); fs.closeSync(out); resolve(127) })
    child.on('close', code => { clearTimeout(timer); fs.closeSync(out); resolve(code ?? 1) })
  })
}

function tail(log: string): string {
  const text = readText(log, 4 * 1024 * 1024) ?? ''
  return redact(text.split('\n').slice(-25).join('\n'))
}

/**
 * Copies the project into a scratch workspace, so the build writes its output
 * (and caches, lockfile updates, tsbuildinfo …) there and never in the project.
 * `node_modules` is linked, not copied.
 */
function workspaceCopy(projectDir: string, workspace: string, exclude: string[]): void {
  fs.mkdirSync(workspace, { recursive: true })
  for (const entry of fs.readdirSync(projectDir)) {
    if (NEVER_COPY.has(entry) || exclude.includes(entry)) continue
    fs.cpSync(path.join(projectDir, entry), path.join(workspace, entry), { recursive: true, verbatimSymlinks: true, dereference: false })
  }
  const modules = path.join(projectDir, 'node_modules')
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}

function findGodot(): string | null {
  const candidates = [process.env.GODOT, 'godot', 'godot4', '/Applications/Godot.app/Contents/MacOS/Godot']
  for (const candidate of candidates) {
    if (!candidate) continue
    if (candidate.includes('/')) { if (fs.existsSync(candidate)) return candidate; continue }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const full = path.join(dir, candidate)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}

export function webPreset(cfg: string): string | null {
  const blocks = cfg.split(/^\[preset\.\d+\]\s*$/m).slice(1)
  for (const block of blocks) {
    const name = /^name="([^"]+)"/m.exec(block)?.[1]
    if (name && /^platform="Web"/m.test(block)) return name
  }
  return null
}

async function nodeBuild(projectDir: string, detection: Detection, stageDir: string, ui: Ui): Promise<BuildResult> {
  const plan = detection.build!
  const workspace = path.join(stageDir, 'work')
  const out = path.join(stageDir, 'build-output')
  const log = path.join(stageDir, 'build.log')
  workspaceCopy(projectDir, workspace, detection.outputs.filter(o => o !== 'public' && !o.includes('/')).slice(0, 1))
  const pm = plan.packageManager
  if (!fs.existsSync(path.join(projectDir, 'node_modules'))) {
    const s = ui.spinner(`Installing dependencies with ${pm} (in a scratch copy)`)
    const code = await run(pm, ['install'], workspace, log)
    if (code !== 0) { s.fail('Install failed'); throw new WizardError('build_failed', `${pm} install failed (exit ${code}):\n${tail(log)}`) }
    s.stop('Dependencies installed')
  }
  const extra = plan.viteLast ? ['--base', './', '--outDir', out, '--emptyOutDir'] : []
  const args = ['run', 'build', ...(extra.length && pm === 'npm' ? ['--'] : []), ...extra]
  const started = Date.now() - 1000
  const s = ui.spinner(`Building with \`${pm} run build\` (in a scratch copy; your project is not touched)`)
  const code = await run(pm, args, workspace, log)
  if (code !== 0) { s.fail('Build failed'); throw new WizardError('build_failed', `\`${pm} run build\` failed (exit ${code}):\n${tail(log)}`) }
  let outputDir: string | null = plan.viteLast && fs.existsSync(path.join(out, 'index.html')) ? out : null
  if (!outputDir) {
    for (const candidate of detection.outputs) {
      const index = path.join(workspace, candidate, 'index.html')
      if (fs.existsSync(index) && fs.statSync(index).mtimeMs >= started) { outputDir = path.join(workspace, candidate); break }
    }
  }
  if (!outputDir) {
    s.fail('No build output found')
    throw new WizardError('build_failed', `the build finished but produced no index.html in ${detection.outputs.join('/, ')}/; pass --prebuilt <dir> to name the output`)
  }
  s.stop('Built')
  return { outputDir, entry: 'index.html', built: true, warnings: [] }
}

async function godotBuild(projectDir: string, detection: Detection, stageDir: string, ui: Ui): Promise<BuildResult> {
  const godot = findGodot()
  const preset = webPreset(readText(path.join(projectDir, 'export_presets.cfg')) ?? '')
  const existing = detection.existingExport
  if (!godot || !preset) {
    const missing = !godot ? 'no Godot editor was found (set GODOT=/path/to/godot)' : 'export_presets.cfg has no Web preset'
    if (existing) {
      return { outputDir: path.join(projectDir, existing.root), entry: existing.entry, built: false,
        warnings: [`${missing}; publishing the existing export in ${existing.root}/, which may be older than the project`] }
    }
    throw new WizardError('build_failed', `cannot export this Godot project: ${missing}. Export it for Web in the editor, then run again (or pass --prebuilt <dir>).`)
  }
  const workspace = path.join(stageDir, 'work')
  const out = path.join(stageDir, 'build-output')
  const log = path.join(stageDir, 'build.log')
  workspaceCopy(projectDir, workspace, existing?.root ? [existing.root.split('/')[0]!] : [])
  fs.mkdirSync(out, { recursive: true })
  const s = ui.spinner(`Exporting with Godot preset "${preset}" (in a scratch copy)`)
  await run(godot, ['--headless', '--path', workspace, '--import'], workspace, log)
  const code = await run(godot, ['--headless', '--path', workspace, '--export-release', preset, path.join(out, 'index.html')], workspace, log)
  if (code !== 0 || !fs.existsSync(path.join(out, 'index.html'))) {
    s.fail('Godot export failed')
    throw new WizardError('build_failed', `Godot export failed (exit ${code}):\n${tail(log)}`)
  }
  s.stop('Exported')
  return { outputDir: out, entry: 'index.html', built: true, warnings: [] }
}

export async function buildProject(projectDir: string, detection: Detection, stageDir: string, ui: Ui, prebuilt?: string): Promise<BuildResult> {
  if (prebuilt) {
    const outputDir = path.resolve(prebuilt)
    if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) throw new WizardError('detect_failed', `--prebuilt ${prebuilt} is not a directory`)
    return { outputDir, entry: 'index.html', built: false, warnings: [] }
  }
  switch (detection.kind) {
    case 'node-build': return nodeBuild(projectDir, detection, stageDir, ui)
    case 'godot-project': return godotBuild(projectDir, detection, stageDir, ui)
    default: return { outputDir: path.join(projectDir, detection.root), entry: detection.entry, built: false, warnings: [] }
  }
}
