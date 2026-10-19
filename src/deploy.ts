import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAgent } from './agent.js'
import type { Options } from './args.js'
import { normalizeHost } from './args.js'
import { makeArtwork, type Artwork, type Metadata } from './artwork.js'
import { onCleanup } from './cleanup.js'
import { AGENT_CLIENT, DEFAULT_HOST, formatBytes, PORTAL_ENGINES, type Engine } from './constants.js'
import { WizardError } from './errors.js'
import { isTextFile, listFiles, readText } from './files.js'
import { CONSENT_VERSION, forgetGame, freshStage, hasConsented, projectKey, recordConsent, rememberedGame, rememberGame } from './home.js'
import { describe } from './http.js'
import { deviceLogin, logout, storedCredential } from './login.js'
import { ModelClient, apiOrigin, newUsage } from './model.js'
import { openInBrowser } from './open.js'
import { Portal, publishError, type AigccFinals, type OwnGame } from './portal.js'
import { redact } from './redact.js'
import { fetchRules, type Rules } from './rules.js'
import { findSecrets } from './secrets.js'
import { issueSession, readSandboxFile, revokeSession, type PortalAuth, type Sandbox, type WizardSession } from './session.js'
import { planSource, uploadSource, type SourcePlan, type SourceReport } from './source.js'
import { stageCopy, stageManifest } from './stage.js'
import type { Telemetry } from './telemetry.js'
import { toolSpecs, type ToolHost } from './tools.js'
import { automatic, type Ui } from './ui.js'
import { commitWorkspace, prepareWorkspace, PUBLISH_BRANCH, type Commit } from './workspace.js'

export interface Warning { code: string; message: string; path?: string }

interface Publication { body: any; published: { gameId: string; slug: string; version: number; releaseId: string }; readiness: Record<string, unknown>; engine: Engine; hash: string; warnings: Warning[] }

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
  /** What the run did, in order: files written, commands run, publications. */
  steps: string[]
  /** The model's own account of what it changed and why. */
  summary: string
  usage: { sessionId: string; quota: number; promptTokens: number; completionTokens: number; chatCalls: number; imageCalls: number; models: string[] }
  /** The private source repository and checkpoint (saved by default; null with `--no-source`, in a sandbox, when declined or when it failed). */
  source: SourceReport | null
  /** Where the changes are: the origingame/publish worktree (Git) or the copy. */
  workspace: { kind: 'worktree'; path: string; branch: string; base: string; commits: Commit[]; review: string; merge: string } | { kind: 'copy'; path: string }
  /** The AIGCC finals submission of this release; null when it was not requested. */
  aigcc: { submitted: true; team: string; version: number; playUrl: string } | { submitted: false; reason: string } | null
}

const CONSENT_TEXT = (rules: Rules) => [
  `The Wizard is an AI agent (${rules.models.agent} through the OriginGame AI Gateway). To publish your game it reads the files`,
  'of a separate copy of your project, edits that copy and runs commands in it (installs and builds; in Manual you confirm each command).',
  'Credential files (.env*, *.pem, *.key, id_*, …) are never read, and any line that looks like a key is withheld from the model.',
  'Commands get your environment without variables that look like credentials.',
  `Artwork: ${rules.models.image} draws a cover and a poster from a text description only (no screenshots).`,
  'Cost: OriginGame pays. The run uses a platform-funded session (≤ 30 minutes, capped budget); your wallet is not charged.',
  'Your folder is never modified. In a Git repository the changes are committed to a branch origingame/publish in a separate',
  'worktree (~/.origingame/worktrees/) for you to review and merge; otherwise they stay in a copy (~/.origingame/stage/).',
  'Publishing uploads the built game and makes it playable on OriginGame; you choose whether it is listed in the catalog.',
  'Your source (the files Git would track; credential files and key-like lines left out) is saved by default to a private',
  'repository that only you can open, so you can keep working on it in Origin. You can say no when asked (or pass --no-source).',
].join('\n')

const INTRO = [
  'Origin Wizard publishes the game in this folder to OriginGame. An AI agent works on a separate copy (a branch',
  'origingame/publish, or a copy when the folder is not in Git; your folder is never changed): it builds the game, adapts it to',
  'the platform, publishes it, and fixes whatever the build or the platform reports until the game plays. The platform pays.',
].join('\n')

const MiB = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`

/**
 * Which game this publishes to. `--game` decides; else the game this folder
 * published before, which an interactive run may swap for a new game or one
 * of the account's other games.
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

/** Two levels of the project, for the goal: enough to start from, the agent lists the rest itself. */
function overview(dir: string): string {
  const skip = new Set(['node_modules', '.git', 'Library', 'Temp', '.godot', '.import'])
  const files = listFiles(dir, rel => skip.has(path.posix.basename(rel)) || rel.split('/').length > 2)
  const shown = files.slice(0, 120).map(f => `  ${f}  ${MiB(fs.statSync(path.join(dir, f)).size)}`)
  return [...shown, ...(files.length > shown.length ? [`  … and ${files.length - shown.length} more (two levels shown)`] : [])].join('\n') || '  (empty)'
}

function goal(input: {
  projectDir: string; work: string; scratch: string; workspace: string; prebuilt: string | null; created: boolean; current: OwnGame | null; gameId: string | undefined
  titleHint: string | undefined; integrate: boolean; manual: boolean; rules: Rules; sandbox: boolean
}): string {
  const { rules } = input
  const l = rules.limits.portal
  return [
    'Publish the game in this project to OriginGame so that it plays.',
    '',
    `Game folder (the workspace, a separate copy; relative paths start here): ${input.work}`,
    `Workspace: ${input.workspace}. The person's own folder (${input.projectDir}) is never touched.`,
    `Scratch folder for temporary files outside the project: ${input.scratch}`,
    `Machine: ${process.platform} ${os.arch()}, Node.js ${process.versions.node}.`,
    `Mode: ${input.manual ? 'Manual: the person confirms each command, and you may ask them with `ask`.' : 'Automatic: nobody answers questions; decide yourself.'}${input.sandbox ? ' Running in a platform sandbox for an Origin thread.' : ''}`,
    input.created
      ? `Target: a new game. The first publish needs the listing (title, genre, tagline, description, controls, tags, languages, orientation).${input.titleHint ? ` The person chose the title "${input.titleHint}".` : ''}`
      : `Target: an update of the existing game ${input.current ? `"${input.current.title}" (version ${input.current.version})` : input.gameId}. Its listing and artwork stay.`,
    input.prebuilt ? `Hint: the person points at an already built folder: ${input.prebuilt}. Publish it as it is unless it does not work.` : '',
    input.integrate ? 'Scores and saves: optional (see the guidance); only for hand-written Web source with a clear score or progress, never at the cost of the publication.' : 'Scores and saves: do not wire them (the person turned it off).',
    `Portal limits: at most ${l.maxFiles.toLocaleString('en-US')} files, ${formatBytes(l.maxFileBytes)} per file, ${formatBytes(l.maxTotalBytes)} in total; index.html at the root of the published folder.`,
    '',
    'Project files (two levels):',
    overview(input.work),
  ].filter(line => line !== '').join('\n')
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
}

function listingFrom(args: Record<string, unknown>, rules: Rules, titleHint: string | undefined): { listing: Metadata; orientation: string; missing: string[] } {
  const missing: string[] = []
  const title = titleHint?.trim().slice(0, 60) || str(args.title, 60)
  if (!title) missing.push('title')
  const description = str(args.description, 4000)
  if (!description) missing.push('description')
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map(x => str(x, 40)).filter(Boolean).slice(0, max) : [])
  const genre = rules.genres.includes(String(args.genre)) ? String(args.genre) : 'other'
  const orientation = ['landscape', 'portrait', 'any'].includes(String(args.orientation)) ? String(args.orientation) : 'any'
  const aspect = str(args.aspect, 10)
  return {
    listing: {
      title, genre, description,
      tagline: str(args.tagline, 120) || description.split(/[.。!！\n]/)[0]!.slice(0, 120),
      controls: str(args.controls, 500),
      tags: list(args.tags, 8),
      languages: list(args.languages, 8),
      input_hints: list(args.input_hints, 3).filter(h => ['touch', 'keyboard', 'gamepad'].includes(h)),
      ...(aspect === 'fill' || /^\d+:\d+$/.test(aspect) ? { aspect } : {}),
      art_direction: str(args.art_direction, 600),
    },
    orientation,
    missing,
  }
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
  let manual = false
  try {
    ui.intro('Origin Wizard')
    const projectDir = path.resolve(options.dir)
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new WizardError('invalid_arguments', `${projectDir} is not a directory`)
    if (ui.interactive) {
      ui.note('What happens', INTRO)
      const mode = await ui.select<string>('How do you want to publish?', [
        { value: 'automatic', label: 'Automatic: the agent decides and runs what it needs (Recommended)' },
        { value: 'manual', label: 'Manual: you confirm every command and choose each setting' },
      ], 'automatic')
      manual = mode === 'manual'
      if (!manual) {
        const remembered = options.game ?? rememberedGame(projectDir, host)?.gameId
        ui.note('Automatic', [
          remembered ? `Updating the game this folder published (${remembered})` : 'Publishing as a new game',
          options.source ? 'source saved to your private repository' : 'source not saved (--no-source)',
          options.unlisted ? 'unlisted (only people with the link)' : (remembered ? 'visibility kept' : 'public in the catalog'),
          `changes on a ${PUBLISH_BRANCH} branch or a copy (your folder is unchanged)`,
          remembered ? 'listing and artwork kept' : 'title, genre and description written for you, a generated cover and poster',
        ].join(' · '))
        // Every setting takes its default from here on, as with --yes.
        ui = automatic(ui)
      }
    }
    const rules = await fetchRules(host)
    ui.info(`Rules ${rules.version} from ${host}`)
    let prebuilt: string | null = null
    if (options.prebuilt) {
      prebuilt = path.resolve(options.prebuilt)
      if (!fs.existsSync(prebuilt) || !fs.statSync(prebuilt).isDirectory()) throw new WizardError('invalid_arguments', `--prebuilt ${options.prebuilt} is not a directory`)
    }

    // Sign-in and session.
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

    // The data notice, once.
    if (!sandbox && !options.yes && !hasConsented()) {
      ui.note('Before anything is sent', CONSENT_TEXT(rules))
      if (!(await ui.confirmRequired('Continue?', true))) throw new WizardError('aborted', 'consent declined')
      recordConsent()
    } else if (!sandbox && !hasConsented()) {
      ui.info(`--yes: accepted the data notice (version ${CONSENT_VERSION}); see the README for what is sent`)
    }

    // The game this folder publishes to, and AIGCC.
    const portal = new Portal(host, portalAuth, rules.limits)
    const finals = sandbox || options.aigcc === false ? null : await aigccFinals(options, ui, portal, guided)
    let preferred: string | undefined
    if (finals?.game && !options.game) preferred = (await portal.mine())?.some(g => g.id === finals.game!.gameId) ? finals.game.gameId : undefined
    const { gameId, current } = await chooseTarget(options, ui, portal, projectDir, host, Boolean(sandbox), preferred)
    const action = gameId ? 'updated' : 'created'

    // Who can find it: an update keeps its visibility unless it is changed here.
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

    // The source: saved by default, in the background, never in the way of the publication.
    let sourcePlan: SourcePlan | null = null
    const warnings: Warning[] = []
    if (options.source && !sandbox) {
      try {
        const plan = planSource(projectDir)
        const withheld = plan.withheld.slice(0, 6).map(w => `  ${w.path} (${w.reason})`)
        ui.note('Your source', [
          `${plan.files.length} files (${MiB(plan.totalBytes)}) as Git would track them; .gitignore applies.`,
          ...(withheld.length ? ['Left out:', ...withheld, ...(plan.withheld.length > 6 ? [`  and ${plan.withheld.length - 6} more`] : [])] : []),
          'They go to a private repository on OriginGame that only you can open, linked to this game.',
        ].join('\n'))
        if (await ui.confirm('Save your source to a private OriginGame repository? (Recommended: lets you keep working on it in Origin)', true)) sourcePlan = plan
        else ui.info('Your source is not saved; only the built game is uploaded.')
      } catch (error) {
        const why = error instanceof WizardError ? error.message : String(error)
        ui.warn(`The source will not be saved: ${why}`)
        warnings.push({ code: 'source.skipped', message: `the source was not saved: ${why}` })
      }
    }
    const memory = sandbox ? null : rememberedGame(projectDir, host)
    let repositoryId = memory?.repositoryId
    let source: SourceReport | null = null
    const sourceRun = sourcePlan
      ? uploadSource({ host, token: portalAuth.token, plan: sourcePlan, name: options.title ?? current?.title ?? path.basename(projectDir), gameId, remembered: repositoryId, ui: quiet(ui) })
        .then(report => { source = report; repositoryId = report.repositoryId; return report }, error => {
          const why = redact((error as Error).message ?? String(error))
          warnings.push({ code: 'source.failed', message: `the game is published, but the source was not saved: ${why}` })
          return null
        })
      : Promise.resolve(null)

    // The workspace: a worktree on origingame/publish, or a copy; the person's folder is never written.
    const stageDir = freshStage(projectDir)
    const ws = prepareWorkspace(projectDir, stageDir, { git: !sandbox })
    ui.step(ws.kind === 'worktree' ? `Working on branch ${PUBLISH_BRANCH} in ${ws.root} (your checkout is not touched)` : `Working on a copy of your folder in ${ws.dir}`)
    for (const n of ws.notes) ui.info(n)
    const scratch = path.join(stageDir, 'scratch')
    fs.mkdirSync(scratch, { recursive: true })
    // A prebuilt folder inside the project is in the workspace too; one outside it is copied to the scratch folder.
    let prebuiltHint: string | null = null
    if (prebuilt) {
      const inside = path.relative(projectDir, prebuilt)
      if (!inside.startsWith('..') && !path.isAbsolute(inside) && fs.existsSync(path.join(ws.dir, inside))) prebuiltHint = inside || '.'
      else {
        const copy = path.join(scratch, 'prebuilt')
        fs.cpSync(prebuilt, copy, { recursive: true })
        prebuiltHint = copy
      }
    }

    // What `publish` does: stage, upload, publish, wait for readiness, and answer the model with what happened.
    const client = new ModelClient(apiOrigin(host), active, usage)
    const site = path.join(stageDir, 'site')
    const provenance = JSON.stringify({ agent_client: AGENT_CLIENT, knowledge_packs: [`wizard-rules/${rules.version}`] })
    const waitSeconds = Math.max(0, Number(process.env.ORIGINGAME_READINESS_WAIT_SECONDS ?? 90) || 0)
    let target = gameId
    let artwork: Artwork | null = null
    let listing: Metadata | null = null
    let reviewed = false
    let attempts = 0
    let last: Publication | null = null
    const steps: string[] = []

    const publish = async (args: Record<string, unknown>): Promise<string> => {
      attempts++
      const dir = path.resolve(ws.dir, String(args.dir ?? '.'))
      const allowed = [ws.dir, scratch].some(root => { const r = path.relative(root, dir); return !r.startsWith('..') && !path.isAbsolute(r) })
      if (!allowed) return `error: ${args.dir} is outside the workspace`
      if (!fs.existsSync(path.join(dir, 'index.html'))) return `error: ${args.dir} has no index.html at its root`
      const engine = (PORTAL_ENGINES as readonly string[]).includes(String(args.engine)) ? String(args.engine) as Engine : 'html'
      steps.push(`publish ${path.relative(ws.dir, dir) || '.'} as ${engine}`)
      // The listing of a new game, written by the model, reviewed by the person in Manual.
      let orientation = 'any'
      if (!target) {
        const parsed = listingFrom(args, rules, options.title)
        if (parsed.missing.length) return `error: a new game needs ${parsed.missing.join(' and ')}; call publish again with the listing fields`
        listing = listing ? { ...listing, ...parsed.listing } : parsed.listing
        orientation = parsed.orientation
        if (ui.interactive && !reviewed) {
          listing.title = (await ui.text('Title', listing.title, v => (v.trim() ? undefined : 'a title is required'))).trim().slice(0, 60)
          listing.genre = await ui.select<string>('Genre', rules.genres.map(g => ({ value: g, label: g })), listing.genre)
          ui.note('Description', listing.description)
          if ((await ui.select<string>('Description', [{ value: 'keep', label: 'Keep this description (Recommended)' }, { value: 'edit', label: 'Edit it' }], 'keep')) === 'edit') {
            listing.description = (await ui.text('Description', listing.description, v => (v.trim() ? undefined : 'a description is required'))).trim()
          }
        }
        if (!artwork) {
          try {
            artwork = await makeArtwork(client, rules, ui, path.join(stageDir, 'artwork'), { metadata: listing, summary: listing.description, engine })
          } catch (error) {
            return `error: the cover and poster could not be drawn (${redact((error as Error).message)}); a new game needs them. Try publish again.`
          }
        }
      }
      const staged = stageCopy(dir, site, engine === 'origin-engine' ? 'hidden' : undefined)
      const found: Warning[] = []
      for (const file of staged.files) {
        if (!isTextFile(file)) continue
        const hits = findSecrets(readText(path.join(site, file), 16 * 1024 * 1024) ?? '')
        if (hits.length) found.push({ code: 'secret.possible', path: file, message: `${file} line ${hits[0]!.line} looks like a ${hits[0]!.kind}; it is part of the build and will be public` })
      }
      if (found.length && !reviewed) {
        for (const w of found) ui.warn(w.message)
        if (!(await ui.confirmRequired('Publish anyway? (Rotate any real key that ships in a public game.)', true))) return 'error: the person stopped the publication because of a possible secret in the build; remove it from the published files or give_up'
      }
      const manifest = await stageManifest(site)
      if (ui.interactive && !reviewed) {
        ui.note('Ready to publish', [
          `Game:       ${target ? `an update of "${current?.title ?? target}"` : 'a new game'}`,
          ...(listing && !target ? [`Title:      ${listing.title}`, `Genre:      ${listing.genre}`] : []),
          `Visibility: ${unlisted ? 'unlisted (only people with the link)' : 'public in the catalog'}`,
          `Build:      ${manifest.entries.length} files, ${MiB(manifest.totalBytes)} from ${path.relative(ws.dir, dir) || '.'} (engine ${engine})`,
        ].join('\n'))
        if (!(await ui.confirm('Publish now?', true))) return 'error: the person declined to publish now; ask what they want changed, or give_up'
      }
      reviewed = true
      const excluded = staged.excluded.length ? `Left out of the upload: ${staged.excluded.slice(0, 20).map(e => `${e.path} (${e.reason})`).join(', ')}${staged.excluded.length > 20 ? ` and ${staged.excluded.length - 20} more` : ''}` : ''
      if (excluded) ui.info(excluded)
      try {
        const upload = await portal.upload(manifest, ui)
        let revision: number | null = null
        if (target) {
          const releases = await portal.releases(target)
          if (!releases.ok || typeof releases.json?.revision !== 'number') return `error: reading the game's releases failed: ${describe(releases)}`
          revision = releases.json.revision
        }
        // The source checkpoint links the release when the source upload is already done; it never holds the publication up.
        const checkpoint = options.sourceCheckpoint ?? (source as SourceReport | null)?.checkpointId
        const isNew = !target
        const form = () => {
          const f = new FormData()
          f.set('sourceUploadId', upload.sourceUploadId)
          f.set('engine', engine)
          f.set('provenance', provenance)
          if (checkpoint) f.set('source_checkpoint', checkpoint)
          if (visibility && (isNew || !last)) f.set('unlisted', visibility)
          if (revision !== null) f.set('expected_revision', String(revision))
          const retitle = isNew ? '' : options.title?.trim().slice(0, 60) || str(args.title, 60)
          if (retitle) f.set('title', retitle)
          if (isNew && listing) {
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
            if (listing.aspect) f.set('aspect', listing.aspect)
            if (listing.input_hints?.length) f.set('input_hints', JSON.stringify([...new Set(listing.input_hints)]))
          }
          if (artwork && isNew) {
            f.set('cover', new Blob([new Uint8Array(artwork.cover)], { type: 'image/jpeg' }), 'cover.jpg')
            f.set('poster', new Blob([new Uint8Array(artwork.poster)], { type: 'image/jpeg' }), 'poster.jpg')
          }
          return f
        }
        const response = await portal.publish(form, target ? { gameId: target } : {}, ui)
        if (!response.ok) {
          if (response.status === 401) throw publishError(response)
          return `Portal refused the publication: HTTP ${response.status}\n${redact(response.text.slice(0, 4000))}`
        }
        const body = response.json ?? {}
        const published = { gameId: String(body.gameId), slug: String(body.slug ?? ''), version: Number(body.version), releaseId: String(body.releaseId) }
        target = published.gameId
        const readiness = await portal.readiness(published.gameId, published.releaseId, waitSeconds * 1000, ui)
        const portalWarnings: Warning[] = (Array.isArray(body.warnings) ? body.warnings : []).filter((w: any) => w && typeof w.message === 'string')
          .map((w: any) => ({ code: String(w.code ?? 'portal'), message: String(w.message), ...(w.path ? { path: String(w.path) } : {}) }))
        last = { body, published, readiness, engine, hash: manifest.hash, warnings: [...found, ...portalWarnings] }
        if (!sandbox) rememberGame(projectDir, { gameId: published.gameId, slug: published.slug, host, ...(repositoryId ? { repositoryId } : {}) })
        const status = String(readiness.status ?? 'pending')
        const verdict = status === 'ready' ? 'The readiness check passed: the game starts in the Player. Call finish unless something you know of is still broken.'
          : status === 'pending' || status === 'unavailable' ? 'The readiness check has no verdict yet. Use preview to be confident it starts, then finish.'
            : `The game is published but the readiness check reports "${status}": it does not start in the Player. Find the cause (the details below, preview), fix it and publish again; it updates the same game.`
        return [
          `Published version ${published.version} of game ${published.gameId}: ${String(body.playUrl ?? '')}`,
          `Uploaded ${upload.uploaded} files, reused ${upload.reused}; ${manifest.entries.length} files, ${MiB(manifest.totalBytes)}.`,
          excluded,
          portalWarnings.length ? `Portal warnings: ${portalWarnings.map(w => `${w.code}: ${w.message}`).join('; ')}` : '',
          `Readiness: ${redact(JSON.stringify(readiness).slice(0, 3000))}`,
          verdict,
        ].filter(Boolean).join('\n')
      } catch (error) {
        if (error instanceof WizardError && (error.code === 'not_logged_in' || error.code === 'aborted')) throw error
        return `The publication failed: ${redact((error as Error).message ?? String(error))}${error instanceof WizardError && error.details ? `\n${JSON.stringify(error.details).slice(0, 3000)}` : ''}`
      }
    }

    // The loop.
    const expires = Date.parse(active.expires_at)
    const toolHost: ToolHost = {
      root: ws.dir, extra: [scratch], ui, manual, deadline: Number.isFinite(expires) ? expires : Date.now() + 29 * 60_000,
      screenshots: path.join(stageDir, 'preview'), publish,
      finishRefusal: () => (last ? null : 'Nothing is published yet: call publish first (or give_up if it truly cannot be published).'),
    }
    const tools = toolSpecs({ manual: manual && ui.interactive, genres: rules.genres, created: action === 'created' })
    const outcome = await runAgent({
      client, model: client.textModel(rules.models.agent), system: rules.prompts.agent, tools, host: toolHost, ui,
      goal: goal({ projectDir, work: ws.dir, scratch, workspace: ws.kind === 'worktree' ? `branch ${PUBLISH_BRANCH} in a Git worktree (${ws.root}); changes are committed for the person to review` : 'a plain copy', prebuilt: prebuiltHint, created: action === 'created', current, gameId, titleHint: options.title, integrate: options.integrate, manual: manual && ui.interactive, rules, sandbox: Boolean(sandbox) }),
    })
    steps.unshift(...outcome.log.filter(l => !l.startsWith('publish ')))
    const committed = commitWorkspace(ws, `origingame: publish to OriginGame\n\n${outcome.text || 'no summary'}\n\nOrigin Wizard ${AGENT_CLIENT}, rules ${rules.version}.`)
    if (committed) ui.success(`Committed the changes to ${PUBLISH_BRANCH} (${committed.sha.slice(0, 12)})`)

    const done = last as Publication | null
    if (!done) {
      const tried = outcome.log.slice(-12).join('; ')
      throw new WizardError(outcome.ok ? 'publish_failed' : 'agent_stopped', `nothing was published: ${outcome.text || 'no reason given'}${tried ? ` (last steps: ${tried})` : ''}${ws.kind === 'copy' ? `; the work so far is in ${ws.dir}` : `; the work so far is on ${PUBLISH_BRANCH}`}`, { attempts })
    }
    if (!outcome.ok) warnings.push({ code: 'agent.stopped', message: `the run ended before the agent finished (${outcome.text}); the last publication stands` })
    const status = String(done.readiness.status ?? 'pending')
    if (['failed', 'crashed', 'timeout'].includes(status)) warnings.push({ code: 'readiness.failed', message: `the readiness check reports "${status}"; open the release in OriginGame to see why` })
    warnings.push(...done.warnings)

    // The source finishes in the background; it is waited for, but never fails the run.
    if (sourcePlan) {
      const s = ui.spinner('Finishing the source upload')
      const report = await sourceRun
      if (report) s.stop(`Source checkpoint ${report.checkpointId} (${report.committed} changed, ${report.deleted} removed${report.lfsObjects ? `, ${report.lfsObjects} with Git LFS` : ''})`)
      else s.fail('The source was not saved (the game is published)')
      if (report && !sandbox) rememberGame(projectDir, { gameId: done.published.gameId, slug: done.published.slug, host, repositoryId: report.repositoryId })
    }
    const aigcc = finals ? await submitFinals(portal, finals, done.published, ui, warnings) : null

    const workspace: DeployResult['workspace'] = ws.kind === 'worktree'
      ? { kind: 'worktree', path: ws.root, branch: ws.branch!, base: ws.base!, commits: ws.commits, review: `git diff HEAD...${PUBLISH_BRANCH}`, merge: `git merge ${PUBLISH_BRANCH}` }
      : { kind: 'copy', path: ws.dir }
    const final = listing as Metadata | null
    const result: DeployResult = {
      ok: true, action, ...done.published,
      title: action === 'created' ? final?.title ?? null : options.title?.trim() ?? null,
      playUrl: String(done.body.playUrl ?? ''), portalUrl: String(done.body.portalUrl ?? ''),
      readiness: done.readiness, warnings, engine: done.engine, stageSha256: done.hash, rulesVersion: rules.version,
      steps, summary: redact(outcome.text),
      usage: { sessionId: active.session_id, quota: active.budget_quota, ...usage },
      source, workspace, aigcc,
    }
    telemetry.track('published', { action, engine: done.engine, attempts })
    ui.note(action === 'created' ? 'Published' : `Updated to version ${done.published.version}`, [
      `Play: ${result.playUrl}`,
      `Page: ${result.portalUrl}`,
      `Readiness: ${status}`,
      '',
      ...(outcome.text ? [outcome.text, ''] : []),
      ...(workspace.kind === 'worktree'
        ? [
            `The changes are on branch ${workspace.branch} (worktree ${workspace.path}):`,
            ...(workspace.commits.length ? workspace.commits.map(c => `  ${c.sha.slice(0, 12)} ${c.message}`) : ['  no commits: nothing needed changing']),
            `Review them: ${workspace.review}`,
            `Keep them:   ${workspace.merge}`,
          ]
        : [`The working copy is in ${workspace.path} (your folder was not changed).`]),
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

/** The source upload runs beside the loop: its progress lines would interleave with the agent's, so only warnings show. */
function quiet(ui: Ui): Ui {
  const none = { stop: () => {}, fail: () => {}, update: () => {} }
  return { ...ui, info: () => {}, step: () => {}, success: () => {}, note: () => {}, spinner: () => none, warn: m => ui.warn(m), error: m => ui.error(m), intro: () => {}, outro: () => {} } as Ui
}

/**
 * Whether this release becomes the team's AIGCC finals game. Checked before
 * any model spend. `--aigcc` requires it; a guided run asks when the team is
 * in the finals; a script without `--aigcc` only learns that it could.
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

/** The published release becomes the finals game; the publication stands even if this is refused. */
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
