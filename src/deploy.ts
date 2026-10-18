import fs from 'node:fs'
import path from 'node:path'
import { applyEdits, applyItems } from './adapt.js'
import type { Options } from './args.js'
import { normalizeHost } from './args.js'
import { makeArtwork } from './artwork.js'
import { buildProject } from './build.js'
import { onCleanup } from './cleanup.js'
import { AGENT_CLIENT, DEFAULT_HOST, type Engine } from './constants.js'
import { classifyEngine, detectProject, type Detection } from './detect.js'
import { buildDigest, ContextReader } from './digest.js'
import { WizardError } from './errors.js'
import { isTextFile, listFiles, readText } from './files.js'
import { collectFindings, type PlanItem } from './findings.js'
import { CONSENT_VERSION, forgetGame, freshStage, hasConsented, projectKey, recordConsent, rememberedGame, rememberGame } from './home.js'
import { integrate, type IntegrationResult } from './integrate.js'
import { deviceLogin, logout, storedCredential } from './login.js'
import { ModelClient, apiOrigin, newUsage } from './model.js'
import { openInBrowser } from './open.js'
import { describe } from './http.js'
import { Portal, publishError, type AigccFinals, type OwnGame } from './portal.js'
import { fetchRules, type Rules } from './rules.js'
import { findSecrets } from './secrets.js'
import { planSource, uploadSource, type SourcePlan, type SourceReport } from './source.js'
import { issueSession, readSandboxFile, revokeSession, type PortalAuth, type Sandbox, type WizardSession } from './session.js'
import { checkPortalLimits, precheckPortalLimits, stageCopy, stageManifest } from './stage.js'
import { ADAPT_SCHEMA, analyze, mergePlan, metadataSchema, type Edit, type Metadata } from './tasks.js'
import type { Telemetry } from './telemetry.js'
import { automatic, type Ui } from './ui.js'
import { commitWorkspace, headOf, prepareWorkspace, PUBLISH_BRANCH, resetWorkspace, type Commit } from './workspace.js'

export interface Warning { code: string; message: string; path?: string }

export interface DeployResult {
  ok: true
  action: 'created' | 'updated'
  gameId: string
  slug: string
  version: number
  releaseId: string
  /** The listing title sent with this publication, or null when an update kept the existing one. */
  title: string | null
  playUrl: string
  portalUrl: string
  readiness: Record<string, unknown>
  warnings: Warning[]
  engine: Engine
  stageSha256: string
  rulesVersion: string
  adaptations: string[]
  usage: { sessionId: string; quota: number; promptTokens: number; completionTokens: number; chatCalls: number; imageCalls: number; models: string[] }
  /** The private source repository and checkpoint (saved by default; null with `--no-source`, in a sandbox, or when declined). */
  source: SourceReport | null
  /** Where the changes are: the origingame/publish worktree (Git) or the adapted copy. */
  workspace: { kind: 'worktree'; path: string; branch: string; base: string; commits: Commit[]; review: string; merge: string } | { kind: 'copy'; path: string }
  /** Score and save wiring: applied, or why not (declined, no web source, or dropped after a failed readiness check). */
  integration: { applied: boolean; files?: string[]; reason?: string }
  /** The AIGCC finals submission of this release; null when it was not requested. */
  aigcc: { submitted: true; team: string; version: number; playUrl: string } | { submitted: false; reason: string } | null
}

const SKIP_SCAN = new Set(['node_modules', '.git', '.godot', '.import', '.svn', '.hg', '.cache', '.vite', '.next'])

function detect(projectDir: string, rules: Rules, prebuilt: string | undefined): Detection {
  const projectFiles = fs.existsSync(projectDir) ? listFiles(projectDir, SKIP_SCAN) : []
  const readFrom = (root: string) => (file: string) => readText(path.join(root, file), 512 * 1024)
  const project = detectProject({ files: projectFiles, read: readFrom(projectDir), engines: rules.engines })
  if (!prebuilt) {
    if (!project) {
      throw new WizardError('detect_failed', `no web game found in ${projectDir}: expected an index.html, a package.json with a build script, a Godot project or a Godot Web export (or pass --prebuilt <dir>)`)
    }
    return project
  }
  const dir = path.resolve(prebuilt)
  const files = listFiles(dir, SKIP_SCAN)
  const fromBuild = classifyEngine(files, readFrom(dir), rules.engines)
  const engine: Engine = project && project.engine !== 'html' ? project.engine : fromBuild.engine
  const pages = files.filter(f => !f.includes('/') && /\.html?$/i.test(f))
  const entry = files.includes('index.html') ? 'index.html' : pages.length === 1 ? pages[0]! : 'index.html'
  return { kind: 'prebuilt', engine, root: '', entry, outputs: [], reasons: [`--prebuilt ${prebuilt}`, ...(project?.reasons ?? [])] }
}

const CONSENT_TEXT = (rules: Rules) => [
  `Analysis: ${rules.models.analyze} (DeepSeek) through the OriginGame AI Gateway reads the list of your build's`,
  'file names and sizes, your entry HTML and up to ~120 KB of source text (package.json, configs, main scripts).',
  'Credential files (.env*, *.pem, *.key, id_*, …) and any file with a key-like line are never sent.',
  `Artwork: ${rules.models.image} draws a cover and a poster from a text description only (no screenshots).`,
  'Cost: OriginGame pays. The run uses a platform-funded session (≤ 30 minutes, capped budget); your wallet is not charged.',
  'Your folder is never modified. In a Git repository the adaptations and the score/save wiring are committed to a branch',
  'origingame/publish in a separate worktree (~/.origingame/worktrees/) for you to review and merge; otherwise they stay in a copy (~/.origingame/stage/).',
  'Publishing uploads the built game and makes it playable on OriginGame; you choose whether it is listed in the catalog.',
  'Your source (the files Git would track; credential files and key-like lines left out) is saved by default to a private',
  'repository that only you can open, so you can keep working on it in Origin. You can say no when asked (or pass --no-source).',
].join('\n')

/** Copies what the adaptations added or changed in the staged copy back into the workspace's published folder (never deletions). */
function mirror(site: string, outputDir: string): void {
  for (const file of listFiles(site)) {
    const from = path.join(site, file)
    const to = path.join(outputDir, file)
    const data = fs.readFileSync(from)
    if (fs.existsSync(to) && fs.readFileSync(to).equals(data)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, data)
  }
}

async function confirmPlan(ui: Ui, items: PlanItem[]): Promise<PlanItem[]> {
  const optional = items.filter(i => !i.required)
  const required = items.filter(i => i.required)
  ui.note('Adaptation plan (on the origingame/publish branch or a copy, never your folder)', items.map(i => `${i.required ? '■' : i.recommended ? '●' : '○'} ${i.title}\n    ${i.reason}`).join('\n') || 'Nothing to adapt.')
  const chosen = await ui.multiselect<string>('Apply which adaptations?', optional.map(i => ({ value: i.id, label: i.title, hint: i.source === 'model' ? 'suggested by the analysis' : 'found by a check' })), optional.filter(i => i.recommended).map(i => i.id))
  return [...required, ...optional.filter(i => chosen.includes(i.id))]
}

async function secretWarnings(site: string, ui: Ui): Promise<Warning[]> {
  const warnings: Warning[] = []
  for (const file of listFiles(site)) {
    if (!isTextFile(file)) continue
    const hits = findSecrets(readText(path.join(site, file), 16 * 1024 * 1024) ?? '')
    if (hits.length) warnings.push({ code: 'secret.possible', path: file, message: `${file} line ${hits[0]!.line} matches the ${hits[0]!.kind} pattern; it is part of the build and will be public. It was not sent to the model.` })
  }
  if (warnings.length) {
    for (const w of warnings) ui.warn(w.message)
    if (!(await ui.confirmRequired('Publish anyway? (Rotate any real key that ships in a public game.)', true))) throw new WizardError('aborted', 'stopped before publishing a possible secret')
  }
  return warnings
}

const INTRO = [
  'Origin Wizard publishes the game in this folder to OriginGame. It finds the game, signs you in, adapts it and',
  'wires leaderboards and cloud saves on a branch origingame/publish (your folder is never changed), saves the source',
  'to your private repository, writes the listing, draws a cover and a poster, and publishes it. The platform pays for the models.',
].join('\n')

const ENGINE_NAMES: Record<Engine, string> = { html: 'HTML', threejs: 'three.js', godot: 'Godot' }

/** What was found, in words: "Vite + three.js project", "HTML game", "Godot Web export". */
function kindLabel(d: Detection): string {
  const engine = ENGINE_NAMES[d.engine]
  switch (d.kind) {
    case 'node-build': {
      const script = d.build?.script ?? ''
      const bundler = /\bvite\b/.test(script) ? 'Vite' : /\bwebpack\b/.test(script) ? 'webpack' : /\bparcel\b/.test(script) ? 'Parcel' : 'Node'
      return `${bundler}${d.engine === 'html' ? '' : ` + ${engine}`} project`
    }
    case 'godot-project': return 'Godot project'
    case 'godot-export': return 'Godot Web export'
    case 'prebuilt': return `built ${engine} game`
    default: return `${engine} game`
  }
}

const MiB = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`

/**
 * Step 1: the folder and what to publish from it. Interactive runs confirm
 * the detection, may point at another folder, and choose between building and
 * an output that is already there; other runs take the detection as is.
 */
async function chooseProject(options: Options, ui: Ui, rules: Rules): Promise<{ projectDir: string; detection: Detection; prebuilt: string | undefined }> {
  let dir = path.resolve(options.dir)
  let prebuilt = options.prebuilt
  for (;;) {
    let detection: Detection | null = null
    let failure: WizardError | null = null
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) failure = new WizardError('detect_failed', `${dir} is not a directory`)
    else {
      try { detection = detect(dir, rules, prebuilt) } catch (error) {
        if (!(error instanceof WizardError)) throw error
        failure = error
      }
    }
    if (!ui.interactive) {
      if (!detection) throw failure!
      ui.step(`Detected ${detection.kind} (${detection.engine}): ${detection.reasons.join('; ')}`)
      return { projectDir: dir, detection, prebuilt }
    }
    if (detection) {
      ui.info(`Detected ${detection.reasons.join('; ')}`)
      const where = dir === process.cwd() ? 'this folder' : dir
      if (await ui.confirm(`Found a ${kindLabel(detection)} in ${where}. Publish this project?`, true)) {
        const ready = detection.kind === 'node-build' && !prebuilt ? detection.outputs.find(o => fs.existsSync(path.join(dir, o, 'index.html'))) : undefined
        if (ready) {
          const how = await ui.select<string>('It is already built. What should be published?', [
            { value: '', label: `Build it again first with ${detection.build?.packageManager ?? 'npm'} run build (Recommended)` },
            { value: ready, label: `Publish ${ready}/ as it is` },
          ], '')
          if (how) {
            prebuilt = path.join(dir, how)
            detection = detect(dir, rules, prebuilt)
          }
        }
        return { projectDir: dir, detection, prebuilt }
      }
    } else {
      ui.warn(failure!.message)
    }
    const next = await ui.text('Path to your game folder', dir, v => (fs.existsSync(path.resolve(v.trim())) && fs.statSync(path.resolve(v.trim())).isDirectory() ? undefined : 'not a folder'))
    dir = path.resolve(next.trim())
    prebuilt = undefined
  }
}

/**
 * Step 4: which game this publishes to. `--game` decides; else the game this
 * folder published before, which an interactive run may swap for a new game or
 * one of the account's other games.
 */
async function chooseTarget(options: Options, ui: Ui, portal: Portal, projectDir: string, host: string, sandbox: boolean, preferred?: string): Promise<{ gameId: string | undefined; current: OwnGame | null }> {
  let gameId = options.game ?? (sandbox ? undefined : rememberedGame(projectDir, host)?.gameId ?? preferred)
  if (gameId) {
    const existing = await portal.releases(gameId)
    if (existing.status === 404 && !options.game) {
      ui.warn(`The remembered game ${gameId} is gone or not yours; publishing a new game`)
      forgetGame(projectDir)
      gameId = undefined
    } else if (!existing.ok) {
      throw publishError(existing)
    }
  }
  if (!ui.interactive || options.game || sandbox) return { gameId, current: null }
  const mine = await portal.mine()
  if (gameId) {
    const current = mine?.find(g => g.id === gameId) ?? null
    const choice = await ui.select<string>('Which game is this?', [
      { value: 'update', label: current ? `Update "${current.title}" (version ${current.version}) (Recommended)` : `Update the game this folder published (${gameId}) (Recommended)` },
      { value: 'new', label: 'Publish as a new game' },
    ], 'update')
    return choice === 'update' ? { gameId, current } : { gameId: undefined, current: null }
  }
  if (!mine?.length) return { gameId: undefined, current: null }
  const choice = await ui.select<string>('Which game is this?', [
    { value: 'new', label: 'Publish as a new game (Recommended)' },
    { value: 'existing', label: 'Update one of your games' },
  ], 'new')
  if (choice === 'new') return { gameId: undefined, current: null }
  const picked = await ui.select<string>('Which of your games?', mine.slice(0, 30).map(g => ({ value: g.id, label: `${g.title} (version ${g.version})`, hint: g.unlisted ? 'unlisted' : g.id })), mine[0]!.id)
  const current = mine.find(g => g.id === picked) ?? null
  const existing = await portal.releases(picked)
  if (!existing.ok) throw publishError(existing)
  return { gameId: picked, current }
}

export async function deploy(options: Options, ui: Ui, telemetry: Telemetry): Promise<DeployResult> {
  let sandbox: Sandbox | null = null
  if (options.credentialsFile) sandbox = readSandboxFile(options.credentialsFile)
  const host = normalizeHost(options.host ?? sandbox?.host ?? process.env.OG_HOST ?? DEFAULT_HOST)
  let session: WizardSession | null = sandbox?.session ?? null
  const usage = newUsage()
  const revoke = async () => {
    if (!session) return
    const current = session
    session = null
    await revokeSession(host, current)
  }
  const removeHook = onCleanup(revoke)
  // A person answering questions; Automatic keeps this while taking every default.
  const guided = ui.interactive
  try {
    ui.intro('Origin Wizard')
    if (ui.interactive) {
      ui.note('What happens', INTRO)
      const mode = await ui.select<string>('How do you want to publish?', [
        { value: 'automatic', label: 'Automatic: publish with the recommended settings (Recommended)' },
        { value: 'manual', label: 'Manual: choose each setting' },
      ], 'automatic')
      if (mode === 'automatic') {
        const remembered = options.game ?? rememberedGame(path.resolve(options.dir), host)?.gameId
        ui.note('Automatic', [
          remembered ? `Updating the game this folder published (${remembered})` : 'Publishing as a new game',
          options.source ? 'source saved to your private repository' : 'source not saved (--no-source)',
          options.unlisted ? 'unlisted (only people with the link)' : (remembered ? 'visibility kept' : 'public in the catalog'),
          `adapted${options.integrate ? ', with leaderboards and cloud saves wired,' : ''} on a ${PUBLISH_BRANCH} branch or a copy (your folder is unchanged)`,
          remembered ? 'listing and artwork kept' : 'title, genre and description written for you, a generated cover and poster',
        ].join(' · '))
        // Every setting takes its default from here on, as with --yes.
        ui = automatic(ui)
      }
    }
    const rules = await fetchRules(host)
    ui.info(`Rules ${rules.version} from ${host}`)

    // 1. The project.
    const { projectDir, detection, prebuilt } = await chooseProject(options, ui, rules)
    telemetry.track('detected', { kind: detection.kind, engine: detection.engine })

    // 2. Sign-in and session.
    let portalAuth: PortalAuth
    if (sandbox) {
      portalAuth = { token: sandbox.publish.token, repositoryId: sandbox.publish.repository_id }
      ui.step(`Sandbox session ${sandbox.session.session_id} for ${sandbox.session.account.username}`)
    } else {
      let credential = storedCredential(host)
      if (credential && ui.interactive && credential.source === 'stored') {
        const name = credential.account ? `${credential.account.display_name || credential.account.username} (@${credential.account.username})` : 'the saved account'
        const who = await ui.select<string>('Sign in to OriginGame', [
          { value: 'continue', label: `Continue as ${name} (Recommended)` },
          { value: 'switch', label: 'Use another account' },
        ], 'continue')
        if (who === 'switch') {
          // The saved device sign-in is revoked, not left behind.
          await logout(host)
          credential = null
        }
      }
      if (!credential) {
        if (process.env.CI) throw new WizardError('not_logged_in', 'not signed in; run `npx origingame login` first or set OG_API_KEY to an og- account key')
        const signedIn = await deviceLogin(host, ui)
        credential = { token: signedIn.access_token, account: signedIn.account, source: 'stored' }
      }
      session = await issueSession(host, credential.token, projectKey(projectDir))
      portalAuth = { token: credential.token }
      ui.step(`Signed in as ${session.account.display_name || session.account.username}; session ${session.session_id} (platform-funded, until ${session.expires_at})`)
    }
    const active = session!

    // 3. The data notice, once.
    if (!sandbox && !options.yes && !hasConsented()) {
      ui.note('Before anything is sent', CONSENT_TEXT(rules))
      if (!(await ui.confirmRequired('Continue?', true))) throw new WizardError('aborted', 'consent declined')
      recordConsent()
    } else if (!sandbox && !hasConsented()) {
      ui.info(`--yes: accepted the data notice (version ${CONSENT_VERSION}); see the README for what is sent`)
    }

    // 4. The game this folder publishes to.
    const portal = new Portal(host, portalAuth)
    const finals = sandbox || options.aigcc === false ? null : await aigccFinals(options, ui, portal, guided)
    let preferred: string | undefined
    if (finals?.game && !options.game) preferred = (await portal.mine())?.some(g => g.id === finals.game!.gameId) ? finals.game.gameId : undefined
    const { gameId, current } = await chooseTarget(options, ui, portal, projectDir, host, Boolean(sandbox), preferred)
    const action = gameId ? 'updated' : 'created'

    // 5. The source: saved by default, checked before any model spend.
    let sourcePlan: SourcePlan | null = null
    if (options.source && !sandbox) {
      const plan = planSource(projectDir)
      if (!plan.files.length) {
        ui.info('No source files to save; only the built game is uploaded.')
      } else {
        const withheld = plan.withheld.slice(0, 6).map(w => `  ${w.path} (${w.reason})`)
        ui.note('Your source', [
          `${plan.files.length} files (${MiB(plan.totalBytes)}) as Git would track them; .gitignore applies.`,
          ...(withheld.length ? ['Left out:', ...withheld, ...(plan.withheld.length > 6 ? [`  and ${plan.withheld.length - 6} more`] : [])] : []),
          'They go to a private repository on OriginGame that only you can open, linked to this game.',
        ].join('\n'))
        if (await ui.confirm('Save your source to a private OriginGame repository? (Recommended: lets you keep working on it in Origin)', true)) sourcePlan = plan
        else ui.info('Your source is not saved; only the built game is uploaded.')
      }
    }

    // 6. Score and save integration: on by default, since it only ever lands on the workspace.
    const canIntegrate = detection.engine !== 'godot' && detection.kind !== 'godot-export' && detection.kind !== 'prebuilt'
    let integrating = options.integrate && canIntegrate
    if (integrating && ui.interactive) {
      integrating = await ui.confirm(`Wire leaderboards and cloud saves into the code? It happens on the ${PUBLISH_BRANCH} branch (or a copy), never in your folder; you will see the diff.`, true)
    }

    // The workspace: a worktree on origingame/publish, or a copy; the person's folder is never written.
    const stageDir = freshStage(projectDir)
    const ws = prepareWorkspace(projectDir, stageDir, { git: !sandbox })
    const where = ws.kind === 'worktree' ? `the ${PUBLISH_BRANCH} branch` : 'a copy of your folder'
    ui.step(ws.kind === 'worktree' ? `Working on branch ${PUBLISH_BRANCH} in ${ws.root} (your checkout is not touched)` : `Working on a copy of your folder in ${ws.dir} (not a Git repository)`)
    for (const n of ws.notes) ui.info(n)
    const work = ws.dir
    const prebuiltIn = prebuilt ? path.join(work, path.relative(projectDir, path.resolve(prebuilt))) : undefined
    const prebuiltDir = prebuiltIn && !path.relative(work, prebuiltIn).startsWith('..') && fs.existsSync(prebuiltIn) ? prebuiltIn : prebuilt

    // Build and stage from the workspace; `replay` re-applies the chosen adaptations to a fresh staged copy.
    const site = path.join(stageDir, 'site')
    const warnings: Warning[] = []
    let chosen: PlanItem[] = []
    let codeEdits: Edit[] = []
    let codeFiles = new Set<string>()
    const prepare = async () => {
      const built = await buildProject(work, detection, stageDir, ui, prebuiltDir)
      for (const w of built.warnings) ui.warn(w)
      const staged = stageCopy(built.outputDir, site)
      if (staged.excluded.length) ui.info(`Left out of the upload: ${staged.excluded.slice(0, 8).map(e => `${e.path} (${e.reason})`).join(', ')}${staged.excluded.length > 8 ? ` and ${staged.excluded.length - 8} more` : ''}`)
      precheckPortalLimits(site)
      return built
    }
    const replay = (built: Awaited<ReturnType<typeof prepare>>) => {
      applyItems(site, chosen, built.entry)
      if (codeEdits.length) applyEdits(site, codeEdits, { allow: p => (codeFiles.has(p.replace(/^\.?\//, '')) ? null : 'not a file named by a confirmed item') })
    }
    let built = await prepare()
    for (const message of built.warnings) warnings.push({ code: 'build.note', message })
    const hasSource = detection.kind === 'node-build' || detection.kind === 'godot-project'
    let findings = collectFindings(site, built.entry)
    let { digest, reader } = buildDigest({ projectDir: work, site, detection, findings, hasSource })
    const client = new ModelClient(apiOrigin(host), active, usage)
    const adaptations: string[] = []
    for (const w of digest.withheld) ui.info(`Not sent to the model: ${w.scope === 'source' ? '' : 'build/'}${w.path} (${w.reason})`)

    // 7. Analysis and adaptation: always done (Manual may leave out optional items).
    const deep = integrating || digest.source_files.length > 120 || digest.build_files.length > 600
    const analyzing = ui.spinner('Analyzing the game')
    let analysis
    try {
      analysis = await analyze(client, rules, digest, reader, deep)
    } catch (error) {
      analyzing.fail('Analysis failed')
      throw error
    }
    analyzing.stop(analysis.summary.split('\n')[0]!.slice(0, 140))
    const stageFiles = new Set(listFiles(site))
    const merged = mergePlan(findings, analysis, stageFiles)
    for (const d of merged.dropped) warnings.push({ code: 'adapt.dropped', message: `plan item not applicable: ${d}` })
    chosen = await confirmPlan(ui, merged.items)
    const applied = applyItems(site, chosen, built.entry)
    adaptations.push(...applied.applied)
    const codeItems = chosen.filter(i => i.kind === 'code_edit')
    if (codeItems.length) {
      const s = ui.spinner('Writing code adaptations')
      const files = [...new Set(codeItems.flatMap(i => i.paths ?? []))].slice(0, 12)
      const editReader = new ContextReader({ build: site, source: null })
      const contents = files.flatMap(file => {
        const c = editReader.read('build', file, 120 * 1024)
        return c ? [c] : []
      })
      const answer = await client.json<{ edits: Edit[]; notes?: string[] }>({
        model: client.textModel(rules.models.analyze), system: rules.prompts.system, task: 'adapt', instructions: rules.prompts.adapt,
        input: { mode: 'stage', items: codeItems.map(i => ({ id: i.id, title: i.title, reason: i.reason, paths: i.paths })), files: contents, findings: { scriptAbsolute: findings.scriptAbsolute, localhostRefs: findings.localhostRefs, serviceWorkerRegistrations: findings.serviceWorkerRegistrations } },
        schema: ADAPT_SCHEMA, failure: 'adapt_failed', maxTokens: 8192,
      })
      codeFiles = new Set(files)
      const result = applyEdits(site, answer.edits, { allow: p => (codeFiles.has(p.replace(/^\.?\//, '')) ? null : 'not a file named by a confirmed item') })
      codeEdits = answer.edits
      s.stop(`${result.applied.length} code edit${result.applied.length === 1 ? '' : 's'} applied`)
      adaptations.push(...result.applied.map(a => `edited ${a}`))
      for (const skipped of result.skipped) warnings.push({ code: 'adapt.skipped', message: `code edit not applied: ${skipped}` })
    }
    // Where the published files are the project's own files, the adaptations become commits on the branch.
    const inTree = !built.built && !path.relative(work, built.outputDir).startsWith('..')
    if (inTree) {
      mirror(site, built.outputDir)
      // What the integration reads is the adapted workspace.
      ;({ digest, reader } = buildDigest({ projectDir: work, site, detection, findings, hasSource }))
    }
    const adapted = commitWorkspace(ws, `origingame: adapt for OriginGame\n\n${adaptations.map(a => `- ${a}`).join('\n') || '- no file changes'}\n\nOrigin Wizard ${AGENT_CLIENT}, rules ${rules.version}.`)
    if (adapted) ui.success(`Committed the adaptations to ${PUBLISH_BRANCH} (${adapted.sha.slice(0, 12)})`)
    const adaptedHead = headOf(ws)

    // 8. Integration on the workspace, committed on its own so it can be dropped.
    let integration: DeployResult['integration'] = { applied: false, reason: canIntegrate ? (options.integrate ? 'declined' : 'turned off with --no-integrate') : 'the project has no web source code to wire' }
    let undo: IntegrationResult['undo'] = []
    if (integrating) {
      const result = await integrate(client, rules, ui, { projectDir: work, stageDir, detection, digest, reader, where })
      if ('refused' in result) {
        integration = { applied: false, reason: result.refused }
        ui.info(`No score and save integration: ${result.refused}`)
      } else {
        undo = result.undo
        for (const s of result.skipped) warnings.push({ code: 'integrate.skipped', message: s })
        const committed = commitWorkspace(ws, `origingame: wire leaderboards and cloud saves\n\n${result.summary}\n\n${result.applied.map(f => `- ${f}`).join('\n')}`)
        if (committed) ui.success(`Committed the integration to ${PUBLISH_BRANCH} (${committed.sha.slice(0, 12)})`)
        integration = { applied: true, files: result.applied }
        adaptations.push(...result.applied.map(f => `integrated ${f}`))
        built = await prepare()
        replay(built)
        findings = collectFindings(site, built.entry)
      }
    }
    const isolation = chosen.some(i => i.kind === 'cross_origin_isolation')
    if (findings.threadReasons.length && !isolation && !stageFiles.has('origingame.runtime.json')) {
      warnings.push({ code: 'isolation.declined', message: 'the build looks threaded but cross-origin isolation was not declared; it may fail to start' })
    }
    const orientation = chosen.find(i => i.kind === 'orientation')?.value ?? 'any'

    let manifest = stageManifest(site)
    checkPortalLimits(manifest)
    warnings.push(...await secretWarnings(site, ui))
    ui.step(`Staged ${manifest.entries.length} files (${(manifest.totalBytes / 1048576).toFixed(1)} MiB), sha256 ${manifest.hash.slice(0, 16)}`)

    // Listing and artwork (a new game only; an update keeps its listing).
    let metadata: Metadata | null = null
    let artwork: Awaited<ReturnType<typeof makeArtwork>> | null = null
    if (action === 'created') {
      const s = ui.spinner('Writing the listing')
      metadata = await client.json<Metadata>({
        model: client.textModel(rules.models.analyze), system: rules.prompts.system, task: 'metadata', instructions: rules.prompts.metadata, schema: metadataSchema(rules.genres), failure: 'adapt_failed',
        input: { summary: analysis.summary, engine: detection.engine, orientation, title_hint: options.title ?? null, genres: rules.genres, digest: { project: digest.project, build_files: digest.build_files.slice(0, 80), contents: digest.contents.slice(0, 6) } },
      })
      if (options.title) metadata.title = options.title.trim().slice(0, 60)
      s.stop(`Listing: ${metadata.title} (${metadata.genre})`)
      metadata.title = (await ui.text('Title', metadata.title, v => (v.trim() ? undefined : 'a title is required'))).trim().slice(0, 60)
      if (ui.interactive) {
        metadata.genre = await ui.select<string>('Genre', rules.genres.map(g => ({ value: g, label: g })), metadata.genre)
        ui.note('Description', metadata.description)
        if ((await ui.select<string>('Description', [{ value: 'keep', label: 'Keep this description (Recommended)' }, { value: 'edit', label: 'Edit it' }], 'keep')) === 'edit') {
          metadata.description = (await ui.text('Description', metadata.description, v => (v.trim() ? undefined : 'a description is required'))).trim()
        }
      }
      artwork = await makeArtwork(client, rules, ui, path.join(stageDir, 'artwork'), { metadata, summary: analysis.summary, engine: detection.engine })
    } else if (ui.interactive && await ui.confirm('Draw a new cover and poster for this update?', false)) {
      const title = options.title ?? 'This game'
      artwork = await makeArtwork(client, rules, ui, path.join(stageDir, 'artwork'), {
        metadata: { title, tagline: '', description: analysis.summary, genre: 'other', tags: [], controls: '' }, summary: analysis.summary, engine: detection.engine,
      })
    }

    // 7. Who can find it: an update keeps its visibility unless it is changed here.
    let unlisted = options.unlisted || (current?.unlisted ?? false)
    if (ui.interactive) {
      unlisted = await ui.select<boolean>('Who can find it?', [
        { value: false, label: 'Public in the catalog (Recommended)' },
        { value: true, label: 'Unlisted: only people with the link' },
      ], unlisted)
    }
    const visibility: '1' | '0' | null = action === 'created'
      ? (unlisted ? '1' : null)
      : current ? (unlisted !== current.unlisted ? (unlisted ? '1' : '0') : null) : (unlisted ? '1' : null)

    // 8. Review.
    if (ui.interactive) {
      ui.note('Ready to publish', [
        `Game:        ${action === 'created' ? 'a new game' : `an update of "${current?.title ?? gameId}"${current ? ` to version ${current.version + 1}` : ''}`}`,
        ...(metadata ? [`Title:       ${metadata.title}`, `Genre:       ${metadata.genre}`] : []),
        `Visibility:  ${unlisted ? 'unlisted (only people with the link)' : 'public in the catalog'}`,
        `Build:       ${manifest.entries.length} files, ${MiB(manifest.totalBytes)} from ${where} (your folder is unchanged)`,
        `Changes:     ${ws.commits.length ? ws.commits.map(c => `${c.sha.slice(0, 8)} ${c.message}`).join('; ') : (ws.kind === 'copy' ? `in the copy at ${ws.dir}` : 'none')}`,
        `Integration: ${integration.applied ? 'scores and saves wired (dropped automatically if the build does not become ready)' : `none (${integration.reason})`}`,
        `Source:      ${sourcePlan ? 'saved to your private repository' : 'not saved'}`,
        `Artwork:     ${artwork ? 'a new cover and poster' : 'kept'}`,
      ].join('\n'))
      if (!(await ui.confirm('Publish now?', true))) throw new WizardError('aborted', 'stopped before publishing; nothing was uploaded')
    }

    // Source, then upload and publish: a failed source upload publishes nothing.
    const memory = sandbox ? null : rememberedGame(projectDir, host)
    let repositoryId = memory?.repositoryId
    const provenance = JSON.stringify({ agent_client: AGENT_CLIENT, knowledge_packs: [`wizard-rules/${rules.version}`] })
    const waitSeconds = sandbox ? 0 : Math.max(0, Number(process.env.ORIGINGAME_READINESS_WAIT_SECONDS ?? 60) || 0)
    /** One publication of the current staged build: a new game when `target` is undefined. */
    const publishOnce = async (target: string | undefined) => {
      let source: SourceReport | null = null
      if (sourcePlan) {
        ui.step('Uploading your source to a private repository')
        // What is uploaded is the workspace: the branch's tree (plus carried files the rules allow).
        source = await uploadSource({
          host, token: portalAuth.token, plan: planSource(work), name: metadata?.title ?? options.title ?? path.basename(projectDir),
          gameId: target, remembered: repositoryId, ui,
        })
        repositoryId = source.repositoryId
        ui.success(`Source checkpoint ${source.checkpointId} (${source.committed} changed, ${source.deleted} removed${source.lfsObjects ? `, ${source.lfsObjects} with Git LFS` : ''})`)
      }
      const upload = await portal.upload(manifest, ui)
      let revision: number | null = null
      if (target) {
        const releases = await portal.releases(target)
        if (!releases.ok || typeof releases.json?.revision !== 'number') throw publishError(releases)
        revision = releases.json.revision
      }
      const listing = target ? null : metadata
      const form = () => {
        const f = new FormData()
        f.set('sourceUploadId', upload.sourceUploadId)
        f.set('engine', detection.engine)
        f.set('provenance', provenance)
        const checkpoint = options.sourceCheckpoint ?? source?.checkpointId
        if (checkpoint) f.set('source_checkpoint', checkpoint)
        if (visibility) f.set('unlisted', visibility)
        if (revision !== null) f.set('expected_revision', String(revision))
        if (options.title && !listing) f.set('title', options.title.trim())
        if (listing) {
          f.set('title', listing.title)
          f.set('license_mode', 'protected')
          f.set('orientation', orientation)
          f.set('max_players', '1')
          f.set('genre', listing.genre)
          f.set('description', listing.description)
          f.set('tagline', listing.tagline)
          f.set('controls', listing.controls)
          if (listing.tags.length) f.set('tags', listing.tags.join(','))
          if (listing.languages?.length) f.set('languages', listing.languages.join(','))
          if (listing.aspect && (listing.aspect === 'fill' || /^\d+:\d+$/.test(listing.aspect))) f.set('aspect', listing.aspect)
          if (listing.input_hints?.length) f.set('input_hints', JSON.stringify([...new Set(listing.input_hints)]))
        }
        if (artwork && (!target || target === gameId)) {
          f.set('cover', new Blob([artwork.cover], { type: 'image/jpeg' }), 'cover.jpg')
          f.set('poster', new Blob([artwork.poster], { type: 'image/jpeg' }), 'poster.jpg')
        }
        return f
      }
      const response = await portal.publish(form, target ? { gameId: target } : {}, ui)
      if (!response.ok) throw publishError(response)
      const body = response.json ?? {}
      const published = { gameId: String(body.gameId), slug: String(body.slug ?? ''), version: Number(body.version), releaseId: String(body.releaseId) }
      const readiness = await portal.readiness(published.gameId, published.releaseId, waitSeconds * 1000, ui)
      return { body, published, readiness, source }
    }
    const failed = (readiness: Record<string, unknown>) => ['failed', 'crashed', 'timeout'].includes(String(readiness.status))

    let outcome: Awaited<ReturnType<typeof publishOnce>> | null = null
    let dropped: string | null = null
    try {
      outcome = await publishOnce(gameId)
      if (integration.applied && failed(outcome.readiness)) dropped = `the integrated build's readiness check reports "${outcome.readiness.status}"`
    } catch (error) {
      if (!(integration.applied && error instanceof WizardError && error.code === 'readiness_failed')) throw error
      dropped = `the integrated build did not become ready: ${error.message}`
    }
    if (dropped) {
      // The integration never costs the publication: drop its commit and publish the adaptation-only build.
      ui.warn(`${dropped}; publishing without the score and save integration`)
      if (ws.kind === 'worktree' && adaptedHead) resetWorkspace(ws, adaptedHead, projectDir)
      else for (const u of [...undo].reverse()) { if (u.before === null) fs.rmSync(u.file, { force: true }); else fs.writeFileSync(u.file, u.before) }
      built = await prepare()
      replay(built)
      manifest = stageManifest(site)
      checkPortalLimits(manifest)
      outcome = await publishOnce(outcome ? outcome.published.gameId : gameId)
      integration = { applied: false, reason: dropped }
      warnings.push({ code: 'integration.dropped', message: dropped })
      for (let i = adaptations.length - 1; i >= 0; i--) if (adaptations[i]!.startsWith('integrated ')) adaptations.splice(i, 1)
    }
    const { body, published, readiness, source } = outcome!
    for (const w of Array.isArray(body.warnings) ? body.warnings : []) {
      if (w && typeof w.message === 'string') warnings.push({ code: String(w.code ?? 'portal'), message: w.message, ...(w.path ? { path: String(w.path) } : {}) })
    }
    if (failed(readiness)) {
      warnings.push({ code: 'readiness.failed', message: `the readiness check reports "${readiness.status}"; open the release in OriginGame to see why` })
    }
    if (!sandbox) rememberGame(projectDir, { gameId: published.gameId, slug: published.slug, host, ...(repositoryId ? { repositoryId } : {}) })
    const aigcc = finals ? await submitFinals(portal, finals, published, ui, warnings) : null

    const workspace: DeployResult['workspace'] = ws.kind === 'worktree'
      ? { kind: 'worktree', path: ws.root, branch: ws.branch!, base: ws.base!, commits: ws.commits, review: `git diff HEAD...${PUBLISH_BRANCH}`, merge: `git merge ${PUBLISH_BRANCH}` }
      : { kind: 'copy', path: ws.dir }
    const result: DeployResult = {
      ok: true, action, ...published,
      title: metadata?.title ?? options.title?.trim() ?? null,
      playUrl: String(body.playUrl ?? ''), portalUrl: String(body.portalUrl ?? ''),
      readiness, warnings, engine: detection.engine, stageSha256: manifest.hash, rulesVersion: rules.version, adaptations,
      usage: { sessionId: active.session_id, quota: active.budget_quota, ...usage },
      source, workspace, integration, aigcc,
    }
    telemetry.track('published', { action, engine: detection.engine })
    ui.note(action === 'created' ? 'Published' : `Updated to version ${published.version}`, [
      `Play: ${result.playUrl}`,
      `Page: ${result.portalUrl}`,
      '',
      ...(workspace.kind === 'worktree'
        ? [
            `The changes are on branch ${workspace.branch} (worktree ${workspace.path}):`,
            ...(workspace.commits.length ? workspace.commits.map(c => `  ${c.sha.slice(0, 12)} ${c.message}`) : ['  no commits: nothing needed changing']),
            `Review them: ${workspace.review}`,
            `Keep them:   ${workspace.merge}`,
          ]
        : [`The adapted copy is in ${workspace.path} (your folder was not changed).`]),
      ...(integration.applied ? [] : [`Scores and saves: not wired (${integration.reason})`]),
      ...(aigcc?.submitted ? [`AIGCC finals: submitted for ${aigcc.team} (version ${aigcc.version}); it is in the AIGCC games channel`] : []),
      ...(aigcc && !aigcc.submitted ? [`AIGCC finals: NOT submitted (${aigcc.reason}); run npx origingame --aigcc again`] : []),
    ].join('\n'))
    if (ui.interactive && result.playUrl && (await ui.confirm('Open the game in your browser?', true))) openInBrowser(result.playUrl)
    return result
  } finally {
    removeHook()
    await revoke()
  }
}

/**
 * Step 4a: whether this release becomes the team's AIGCC finals game. Checked
 * before any model spend. `--aigcc` requires it; a guided run asks when the
 * team is in the finals; a script without `--aigcc` only learns that it could.
 */
async function aigccFinals(options: Options, ui: Ui, portal: Portal, guided: boolean): Promise<AigccFinals | null> {
  const state = await portal.aigccFinals()
  if (options.aigcc) {
    if (!state?.eligible || !state.open || !state.registration) {
      throw new WizardError('aigcc_refused', `cannot submit to AIGCC: ${state?.reason ?? 'the AIGCC service did not answer'}`)
    }
    ui.step(`AIGCC finals: this release will be submitted for ${state.registration.teamName}`)
    return state
  }
  if (!state?.eligible || !state.open || !state.registration) return null
  const team = state.registration
  if (!guided) {
    ui.info(`${team.teamName} is in the AIGCC finals; pass --aigcc to submit this release as its finals game`)
    return null
  }
  const yes = await ui.confirm(`Submit this as ${team.teamName}'s AIGCC finals game ("${team.projectTitle}")? (Recommended)`, true)
  if (yes) ui.step(`AIGCC finals: this release will be submitted for ${team.teamName}`)
  return yes ? state : null
}

/** Step 9: the published release becomes the finals game; the publication stands even if this is refused. */
async function submitFinals(portal: Portal, finals: AigccFinals, published: { gameId: string; releaseId: string }, ui: Ui, warnings: Warning[]): Promise<DeployResult['aigcc']> {
  const s = ui.spinner('Submitting to AIGCC')
  const response = await portal.aigccSubmit(published.gameId, published.releaseId).catch((error: Error) => error)
  if (!(response instanceof Error) && response.ok && response.json?.game) {
    const game = response.json.game
    s.stop(`Submitted as ${finals.registration!.teamName}'s AIGCC finals game (version ${game.version})`)
    return { submitted: true, team: finals.registration!.teamName, version: Number(game.version), playUrl: String(game.playUrl ?? '') }
  }
  const reason = response instanceof Error ? response.message : describe(response)
  s.fail('AIGCC did not accept the submission')
  warnings.push({ code: 'aigcc.failed', message: `the game is published but not submitted to AIGCC (${reason}); run npx origingame --aigcc again` })
  return { submitted: false, reason }
}
