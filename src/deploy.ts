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
import { integrate } from './integrate.js'
import { deviceLogin, storedCredential } from './login.js'
import { ModelClient, newUsage } from './model.js'
import { Portal, publishError } from './portal.js'
import { fetchRules, type Rules } from './rules.js'
import { findSecrets } from './secrets.js'
import { issueSession, readSandboxFile, revokeSession, type PortalAuth, type Sandbox, type WizardSession } from './session.js'
import { checkPortalLimits, precheckPortalLimits, stageCopy, stageManifest } from './stage.js'
import { ADAPT_SCHEMA, analyze, mergePlan, metadataSchema, type Edit, type Metadata } from './tasks.js'
import type { Telemetry } from './telemetry.js'
import type { Ui } from './ui.js'

export interface Warning { code: string; message: string; path?: string }

export interface DeployResult {
  ok: true
  action: 'created' | 'updated'
  gameId: string
  slug: string
  version: number
  releaseId: string
  playUrl: string
  portalUrl: string
  readiness: Record<string, unknown>
  warnings: Warning[]
  engine: Engine
  stageSha256: string
  rulesVersion: string
  adaptations: string[]
  usage: { sessionId: string; quota: number; promptTokens: number; completionTokens: number; chatCalls: number; imageCalls: number; models: string[] }
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
  'Your project directory is not modified (except with --integrate, after you approve a diff); adapted files are staged in ~/.origingame/stage/.',
  'Publishing uploads the built game (not your source) and makes it playable on OriginGame (--unlisted keeps it out of the catalog).',
].join('\n')

async function confirmPlan(ui: Ui, items: PlanItem[]): Promise<PlanItem[]> {
  const optional = items.filter(i => !i.required)
  const required = items.filter(i => i.required)
  ui.note('Adaptation plan (applied to the staged copy only)', items.map(i => `${i.required ? '■' : i.recommended ? '●' : '○'} ${i.title}\n    ${i.reason}`).join('\n') || 'Nothing to adapt.')
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
    if (!(await ui.confirm('Publish anyway? (Rotate any real key that ships in a public game.)', true))) throw new WizardError('aborted', 'stopped before publishing a possible secret')
  }
  return warnings
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
  try {
    ui.intro('Origin Wizard')
    const rules = await fetchRules(host)
    ui.info(`Rules ${rules.version} from ${host}`)

    const projectDir = path.resolve(options.dir)
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new WizardError('detect_failed', `${options.dir} is not a directory`)
    const detection = detect(projectDir, rules, options.prebuilt)
    ui.step(`Detected ${detection.kind} (${detection.engine}): ${detection.reasons.join('; ')}`)
    telemetry.track('detected', { kind: detection.kind, engine: detection.engine })

    // Sign-in and session.
    let portalAuth: PortalAuth
    if (sandbox) {
      portalAuth = { token: sandbox.publish.token, repositoryId: sandbox.publish.repository_id }
      ui.step(`Sandbox session ${sandbox.session.session_id} for ${sandbox.session.account.username}`)
    } else {
      let credential = storedCredential(host)
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

    // Consent.
    if (!sandbox && !options.yes && !hasConsented()) {
      ui.note('Before anything is sent', CONSENT_TEXT(rules))
      if (!(await ui.confirm('Continue?', true))) throw new WizardError('aborted', 'consent declined')
      recordConsent()
    } else if (!sandbox && !hasConsented()) {
      ui.info(`--yes: accepted the data notice (version ${CONSENT_VERSION}); see the README for what is sent`)
    }
    if (options.withSource && !sandbox) ui.warn('--with-source is not available yet: your source is not uploaded.')

    // The game this directory publishes to.
    const portal = new Portal(host, portalAuth)
    let gameId = options.game ?? (sandbox ? undefined : rememberedGame(projectDir, host)?.gameId)
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
    const action = gameId ? 'updated' : 'created'

    // Build and stage.
    const stageDir = freshStage(projectDir)
    const site = path.join(stageDir, 'site')
    const prepare = async () => {
      const built = await buildProject(projectDir, detection, stageDir, ui, options.prebuilt)
      for (const w of built.warnings) ui.warn(w)
      const staged = stageCopy(built.outputDir, site)
      if (staged.excluded.length) ui.info(`Left out of the upload: ${staged.excluded.slice(0, 8).map(e => `${e.path} (${e.reason})`).join(', ')}${staged.excluded.length > 8 ? ` and ${staged.excluded.length - 8} more` : ''}`)
      precheckPortalLimits(site)
      return built
    }
    let built = await prepare()
    const hasSource = detection.kind === 'node-build' || detection.kind === 'godot-project'
    let findings = collectFindings(site, built.entry)
    let { digest, reader } = buildDigest({ projectDir, site, detection, findings, hasSource })
    const client = new ModelClient(host, active, usage)

    const adaptations: string[] = []
    const warnings: Warning[] = built.warnings.map(message => ({ code: 'build.note', message }))
    if (options.integrate) {
      const integration = await integrate(client, rules, ui, { projectDir, stageDir, detection, digest, reader })
      if (integration?.applied.length) {
        adaptations.push(...integration.applied.map(f => `integrated ${f}`))
        built = await prepare()
        findings = collectFindings(site, built.entry)
        ;({ digest, reader } = buildDigest({ projectDir, site, detection, findings, hasSource }))
      }
      for (const s of integration?.skipped ?? []) warnings.push({ code: 'integrate.skipped', message: s })
    }
    for (const w of digest.withheld) ui.info(`Not sent to the model: ${w.scope === 'source' ? '' : 'build/'}${w.path} (${w.reason})`)

    // Analysis and plan.
    const deep = options.integrate || digest.source_files.length > 120 || digest.build_files.length > 600
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
    const chosen = await confirmPlan(ui, merged.items)

    // Apply to the staged copy.
    const applied = applyItems(site, chosen, built.entry)
    adaptations.push(...applied.applied)
    const codeItems = chosen.filter(i => i.kind === 'code_edit')
    if (codeItems.length) {
      const s = ui.spinner('Writing code adaptations for the staged copy')
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
      const allowed = new Set(files)
      const result = applyEdits(site, answer.edits, { allow: p => (allowed.has(p.replace(/^\.?\//, '')) ? null : 'not a file named by a confirmed item') })
      s.stop(`${result.applied.length} code edit${result.applied.length === 1 ? '' : 's'} applied to the staged copy`)
      adaptations.push(...result.applied.map(a => `edited ${a}`))
      for (const skipped of result.skipped) warnings.push({ code: 'adapt.skipped', message: `code edit not applied: ${skipped}` })
    }
    const isolation = chosen.some(i => i.kind === 'cross_origin_isolation')
    if (findings.threadReasons.length && !isolation && !stageFiles.has('origingame.runtime.json')) {
      warnings.push({ code: 'isolation.declined', message: 'the build looks threaded but cross-origin isolation was not declared; it may fail to start' })
    }
    const orientation = chosen.find(i => i.kind === 'orientation')?.value ?? 'any'

    const manifest = stageManifest(site)
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
      artwork = await makeArtwork(client, rules, ui, path.join(stageDir, 'artwork'), { metadata, summary: analysis.summary, engine: detection.engine })
    } else if (ui.interactive && await ui.confirm('Draw a new cover and poster for this update?', false)) {
      const title = options.title ?? 'This game'
      artwork = await makeArtwork(client, rules, ui, path.join(stageDir, 'artwork'), {
        metadata: { title, tagline: '', description: analysis.summary, genre: 'other', tags: [], controls: '' }, summary: analysis.summary, engine: detection.engine,
      })
    }

    // Upload and publish.
    const upload = await portal.upload(manifest, ui)
    let revision: number | null = null
    if (gameId) {
      const current = await portal.releases(gameId)
      if (!current.ok || typeof current.json?.revision !== 'number') throw publishError(current)
      revision = current.json.revision
    }
    const provenance = JSON.stringify({ agent_client: AGENT_CLIENT, knowledge_packs: [`wizard-rules/${rules.version}`] })
    const form = () => {
      const f = new FormData()
      f.set('sourceUploadId', upload.sourceUploadId)
      f.set('engine', detection.engine)
      f.set('provenance', provenance)
      if (options.sourceCheckpoint) f.set('source_checkpoint', options.sourceCheckpoint)
      if (options.unlisted) f.set('unlisted', '1')
      if (revision !== null) f.set('expected_revision', String(revision))
      if (options.title && !metadata) f.set('title', options.title.trim())
      if (metadata) {
        f.set('title', metadata.title)
        f.set('license_mode', 'protected')
        f.set('orientation', orientation)
        f.set('max_players', '1')
        f.set('genre', metadata.genre)
        f.set('description', metadata.description)
        f.set('tagline', metadata.tagline)
        f.set('controls', metadata.controls)
        if (metadata.tags.length) f.set('tags', metadata.tags.join(','))
        if (metadata.languages?.length) f.set('languages', metadata.languages.join(','))
        if (metadata.aspect && (metadata.aspect === 'fill' || /^\d+:\d+$/.test(metadata.aspect))) f.set('aspect', metadata.aspect)
        if (metadata.input_hints?.length) f.set('input_hints', JSON.stringify([...new Set(metadata.input_hints)]))
      }
      if (artwork) {
        f.set('cover', new Blob([artwork.cover], { type: 'image/jpeg' }), 'cover.jpg')
        f.set('poster', new Blob([artwork.poster], { type: 'image/jpeg' }), 'poster.jpg')
      }
      return f
    }
    const response = await portal.publish(form, gameId ? { gameId } : {}, ui)
    if (!response.ok) throw publishError(response)
    const body = response.json ?? {}
    for (const w of Array.isArray(body.warnings) ? body.warnings : []) {
      if (w && typeof w.message === 'string') warnings.push({ code: String(w.code ?? 'portal'), message: w.message, ...(w.path ? { path: String(w.path) } : {}) })
    }
    const published = { gameId: String(body.gameId), slug: String(body.slug ?? ''), version: Number(body.version), releaseId: String(body.releaseId) }
    if (!sandbox) rememberGame(projectDir, { gameId: published.gameId, slug: published.slug, host })

    const waitSeconds = sandbox ? 0 : Math.max(0, Number(process.env.ORIGINGAME_READINESS_WAIT_SECONDS ?? 60) || 0)
    const readiness = await portal.readiness(published.gameId, published.releaseId, waitSeconds * 1000, ui)
    if (['failed', 'crashed', 'timeout'].includes(String(readiness.status))) {
      warnings.push({ code: 'readiness.failed', message: `the readiness check reports "${readiness.status}"; open the release in OriginGame to see why` })
    }

    const result: DeployResult = {
      ok: true, action, ...published,
      playUrl: String(body.playUrl ?? ''), portalUrl: String(body.portalUrl ?? ''),
      readiness, warnings, engine: detection.engine, stageSha256: manifest.hash, rulesVersion: rules.version, adaptations,
      usage: { sessionId: active.session_id, quota: active.budget_quota, ...usage },
    }
    telemetry.track('published', { action, engine: detection.engine })
    ui.note(action === 'created' ? 'Published' : `Updated to version ${published.version}`, `Play: ${result.playUrl}\nPage: ${result.portalUrl}`)
    return result
  } finally {
    removeHook()
    await revoke()
  }
}
