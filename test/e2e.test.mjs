// End-to-end: the built CLI (dist/cli.js) runs as a subprocess against a fake
// platform that implements the Wizard contracts. Every assertion is on what the
// CLI observably did: its JSON result and exit code, the requests and bytes the
// platform received, and the state of the project and ~/.origingame afterwards.
// The run ends by writing test-artifacts/e2e-report.json (+ the chosen artwork).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { after, before, describe, test } from 'node:test'
import { ACCOUNT, DEVICE_TOKEN, MODELS, imageDims, portalAccepts, startPlatform } from './fake-platform.mjs'
import { ROOT, cleanTemp, copyFixture, runCli, sha256, signedInHome, tempDir, treeHash, treeHashExcept } from './helpers.mjs'

const RULES_DIR = process.env.WIZARD_RULES_DIR ?? path.join(ROOT, 'test', 'rules')
const ARTIFACTS = path.join(ROOT, 'test-artifacts')
const report = { generatedAt: new Date().toISOString(), rulesDir: path.relative(ROOT, RULES_DIR), fixtures: {}, scenarios: {} }

let platform
before(async () => { platform = await startPlatform({ rulesDir: RULES_DIR }) })
after(async () => {
  await platform?.close()
  cleanTemp()
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.writeFileSync(path.join(ARTIFACTS, 'e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`)
})

/** Scripted model answers, per task. Each fixture gets realistic answers for its own files. */
const LISTING = title => ({
  title, tagline: `${title}: a short arcade run.`, description: `${title} is a small web game.\n\nEach run is quick.`, genre: 'arcade',
  tags: ['score-attack', 'retro'], controls: 'Arrow keys: move', languages: ['en'], input_hints: ['keyboard'], aspect: '16:9',
  art_direction: 'Flat vector night sky, warm yellow stars, cyan basket.',
})
const ARTWORK = { cover: ['cover prompt one, no text, no letters, no logo, no user interface', 'cover prompt two', 'cover prompt three'], poster: ['poster prompt one', 'poster prompt two'] }

/**
 * The edits adapt.md asks for on Unity's default template (item unity-canvas), written from the files the
 * Wizard sent, plus one edit of the Unity loader that the Wizard must refuse (Build/ is engine output).
 */
function unityCanvasEdits(input) {
  const page = input.files.find(f => f.path === 'index.html')?.text ?? ''
  const css = input.files.find(f => f.path === 'TemplateData/style.css')?.text ?? ''
  const edits = []
  const sizing = /canvas\.style\.width = "960px";\n\s*canvas\.style\.height = "600px";/.exec(page)?.[0]
  if (sizing) edits.push({ item: 'unity-canvas', path: 'index.html', find: sizing, replace: 'canvas.style.width = "100%";\n        canvas.style.height = "100%";', why: 'fill the Player frame' })
  const centred = '#unity-container.unity-desktop { left: 50%; top: 50%; transform: translate(-50%, -50%) }'
  if (css.includes(centred)) edits.push({ item: 'unity-canvas', path: 'TemplateData/style.css', find: centred, replace: 'html, body { width: 100%; height: 100%; overflow: hidden }\n#unity-container.unity-desktop { position: fixed; inset: 0; width: 100%; height: 100% }\n#unity-canvas { width: 100%; height: 100%; display: block }\n#unity-footer { display: none }', why: 'fill without scrollbars' })
  edits.push({ item: 'unity-canvas', path: 'Build/Lantern.loader.js', find: 'createUnityInstance', replace: 'createUnityInstanceX', why: 'must be refused' })
  return { edits }
}

function scriptFor(name) {
  return ({ task, attempt, input }) => {
    if (task === 'metadata') return LISTING({ 'plain-html': 'Star Catcher', 'vite-three': 'Orbit Drift', 'godot-export': 'Lantern Keep' }[name] ?? 'Fixture')
    if (task === 'artwork') return ARTWORK
    if (name === 'plain-html' && task === 'analyze') {
      return {
        summary: 'Star Catcher is a canvas arcade game: move a basket with the arrow keys and catch falling stars.',
        orientation: 'landscape', orientation_reason: 'fixed 960x540 canvas',
        items: [
          { id: 'levels-fetch', kind: 'code_edit', title: 'Load the level relative to the page', reason: "game.js fetches '/levels/1.json'", recommended: true, paths: ['game.js'] },
          { id: 'ghost', kind: 'exclude_files', title: 'Drop a file that is not there', reason: 'test: must be dropped', recommended: true, paths: ['missing.txt'] },
        ],
        risks: [],
      }
    }
    if (name === 'plain-html' && task === 'adapt') {
      return {
        edits: [
          { item: 'levels-fetch', path: 'game.js', find: "fetch('/levels/1.json')", replace: "fetch('levels/1.json')", why: 'relative to index.html' },
          { item: 'levels-fetch', path: '../../../etc/hosts', find: 'localhost', replace: 'pwned', why: 'must be refused' },
          { item: 'levels-fetch', path: 'game.js', find: 'text that is not in the file', replace: 'x', why: 'must be skipped' },
        ],
      }
    }
    if (name === 'vite-three' && task === 'analyze') {
      // The first answer is not JSON: the CLI must ask again and use the second.
      if (attempt === 1) return 'Sure! Here is the plan: nothing to change.'
      return { summary: 'Orbit Drift is a three.js toy: steer around a planet with the pointer.', orientation: 'any', items: [] }
    }
    if (name === 'godot-export' && task === 'analyze') {
      return { summary: 'Lantern Keep is a Godot 4 game exported for the Web with threads.', orientation: 'landscape', items: [], risks: ['large engine download'] }
    }
    if (name === 'integrate' && task === 'integrate') {
      return {
        summary: 'Submits the final score when a run ends.',
        edits: [
          { path: 'game.js', find: '  state.over = true\n', replace: "  state.over = true\n  window.OriginPlayer?.call('leaderboard.submit', { score: state.score }).catch(() => {})\n" },
          { path: 'index.html', find: '  <script src="game.js"></script>', replace: '  <script src="og-player.js"></script>\n  <script src="game.js"></script>' },
        ],
        new_files: [{ path: 'og-player.js', content: '// og-player.js (fixture)\nwindow.OriginPlayer = { call: () => Promise.reject(new Error(\'no player\')), ready() {} }\n' }],
        methods: ['leaderboard.submit'],
      }
    }
    if ((name === 'integrate' || name === 'integrate-again') && task === 'analyze') return { summary: 'Star Catcher with scores wired.', orientation: 'landscape', items: [] }
    if (task === 'integrate') return { summary: 'Nothing to wire.', edits: [], new_files: [], methods: [] }
    if (name === 'unity' && task === 'analyze') {
      return { summary: 'Lantern Keep is a Unity 2D platformer: carry a lantern through a dark keep.', orientation: 'landscape', orientation_reason: 'fixed 960x600 Unity canvas', items: [], risks: [] }
    }
    if (name === 'unity' && task === 'adapt') return unityCanvasEdits(input)
    if (task === 'analyze') return { summary: 'A game.', orientation: 'any', items: [] }
    if (task === 'adapt') return { edits: [] }
    throw new Error(`unscripted task ${task}`)
  }
}

/** Runs `fn` while the served rules carry `patch` (top-level keys; undefined leaves a key out); Portal enforces the served limits. */
async function withRules(patch, fn) {
  platform.state.rulesPatch = patch
  try { return await fn() } finally { platform.state.rulesPatch = null }
}
const MiB = 1024 * 1024
/** The served limits with some values replaced, as the platform would serve them. */
const limits = (portal = {}, upload = {}) => ({ limits: { portal: { maxFiles: 20000, maxFileBytes: 512 * MiB, maxTotalBytes: 1024 * MiB, maxImageBytes: 5 * MiB, ...portal }, upload: { concurrency: 8, ...upload } } })

/** Marks where this run's requests begin, so assertions see only this run. */
function mark() {
  const s = platform.state
  return { requests: s.requests.length, chat: s.chat.length, images: s.images.length, deploys: s.deploys.length, sessions: new Set(s.sessions.keys()) }
}
function since(m) {
  const s = platform.state
  return {
    requests: s.requests.slice(m.requests), chat: s.chat.slice(m.chat), images: s.images.slice(m.images), deploys: s.deploys.slice(m.deploys),
    sessions: [...s.sessions.values()].filter(x => !m.sessions.has(x.session_id)),
  }
}
const taskOf = c => /^TASK: (\w+)/.exec(c.body.messages[1].content)?.[1]

function assertAllowlistedModels(run) {
  for (const c of run.chat) assert.ok(MODELS.includes(c.model), `chat model ${c.model} is allowlisted`)
  for (const i of run.images) assert.ok(MODELS.includes(i.model), `image model ${i.model} is allowlisted`)
  assert.ok(run.images.every(i => i.model === 'qwen-image-2.1-turbo-aliyun'))
  assert.ok(run.chat.every(c => c.model.startsWith('deepseek-')))
}

function assertArtwork(deploy) {
  for (const kind of ['cover', 'poster']) {
    const bytes = deploy.images[kind]
    assert.ok(bytes, `${kind} was sent`)
    assert.ok(portalAccepts(kind, bytes), `${kind} passes Portal's rule`)
  }
  assert.deepEqual(imageDims(deploy.images.cover), { width: 1280, height: 720, type: 'jpeg' })
  assert.deepEqual(imageDims(deploy.images.poster), { width: 1080, height: 1440, type: 'jpeg' })
}

function saveArtifacts(name, deploy) {
  const dir = path.join(ARTIFACTS, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [kind, bytes] of Object.entries(deploy.images ?? {})) fs.writeFileSync(path.join(dir, `${kind}.jpg`), bytes)
}

function fixtureReport(name, cli, run, before, afterHash) {
  const deploy = run.deploys.at(-1)
  report.fixtures[name] = {
    exitCode: cli.code,
    result: cli.result,
    projectTree: { before, after: afterHash, unchanged: before === afterHash },
    uploaded: deploy ? Object.fromEntries(Object.entries(deploy.files).map(([p, b]) => [p, { bytes: b.length, sha256: sha256(b) }])) : null,
    fields: deploy ? Object.fromEntries(Object.entries(deploy.fields).filter(([k]) => k !== 'sourceUploadId' && k !== 'operation_id')) : null,
    artwork: deploy?.images ? Object.fromEntries(Object.entries(deploy.images).map(([k, b]) => [k, { ...imageDims(b), bytes: b.length, sha256: sha256(b), portalAccepts: portalAccepts(k, b) }])) : null,
    models: [...new Set([...run.chat.map(c => c.model), ...run.images.map(i => i.model)])],
    imageSizesRequested: run.images.map(i => i.size),
    sessionsRevoked: run.sessions.map(s => ({ id: s.session_id, revoked: s.revoked })),
  }
}

describe('deploy --yes --json', () => {
  test('plain HTML: adapts the staged copy, keeps secrets from the model, publishes, revokes, leaves the project untouched', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run = since(m)
    const afterHash = treeHash(project)
    fixtureReport('plain-html', cli, run, beforeHash, afterHash)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.lines.length, 1, 'stdout is exactly one JSON line')
    const r = cli.result
    assert.equal(r.ok, true)
    assert.equal(r.engine, 'html')
    assert.equal(r.action, 'created')
    assert.equal(r.version, 1)
    assert.match(r.playUrl, /\/play\//)
    assert.equal(r.readiness.status, 'ready')
    assert.match(r.rulesVersion, /^[0-9a-f]{16}$/)
    assert.equal(r.usage.sessionId, run.sessions[0].session_id)
    assert.equal(afterHash, beforeHash, 'project directory is byte-identical')
    // The source is saved by default, without the credential files or the file with a key-like line.
    assert.match(r.source?.checkpointId ?? '', /^[0-9a-f]{32}$/)
    assert.deepEqual(r.source.withheld.map(w => w.path).sort(), ['.env', 'analytics.js', 'id_ed25519'])

    const deploy = run.deploys.at(-1)
    assert.equal(deploy.method, 'POST')
    assert.equal(deploy.fields.source_checkpoint, r.source.checkpointId, 'the publication names the saved source')
    // Nobody can choose between candidates in a --yes run: exactly one cover and one poster are drawn.
    assert.deepEqual(run.images.map(i => i.size).sort(), ['1140x1472', '1664x928'])
    assert.deepEqual(Object.keys(deploy.files).sort(), ['README.md', 'analytics.js', 'assets/bg.png', 'game.js', 'index.html', 'levels/1.json', 'style.css'])
    const html = deploy.files['index.html'].toString()
    assert.match(html, /href="style\.css"/)
    assert.match(html, /src="game\.js"/)
    assert.doesNotMatch(html, /__OG_GAME|__og-game-config/, 'the Wizard does not do what Portal does at publication')
    assert.match(deploy.files['style.css'].toString(), /url\(assets\/bg\.png\)/)
    assert.match(deploy.files['game.js'].toString(), /fetch\('levels\/1\.json'\)/)
    assert.equal(deploy.files['assets/bg.png'].toString('hex'), fs.readFileSync(path.join(project, 'assets/bg.png')).toString('hex'))
    assert.equal(r.stageSha256, platform.state.uploads.get(deploy.fields.sourceUploadId).manifestHash)
    assert.equal(deploy.fields.title, 'Star Catcher')
    assert.equal(r.title, deploy.fields.title, 'the report names the title it published')
    assert.equal(deploy.fields.engine, 'html')
    assert.equal(deploy.fields.orientation, 'landscape')
    assert.equal(deploy.fields.genre, 'arcade')
    assert.equal(JSON.parse(deploy.fields.provenance).agent_client, `origingame-wizard/${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version}`)
    assert.equal(deploy.authorization, `Bearer ${DEVICE_TOKEN}`)
    assertArtwork(deploy)
    saveArtifacts('plain-html', deploy)

    // What reached the model: never the .env value, never the file with a key-like line.
    const sent = run.chat.map(c => JSON.stringify(c.body)).join('\n')
    assert.doesNotMatch(sent, /fixture-secret-value-do-not-send-0001/)
    assert.doesNotMatch(sent, /AKIAIOSFODNN7EXAMPLE/)
    assert.doesNotMatch(sent, /fixture-not-a-real-key-0002/)
    const digest = JSON.parse(run.chat.find(c => taskOf(c) === 'analyze').body.messages[1].content.split('INPUT:\n')[1]).digest
    assert.ok(digest.withheld.some(w => w.path === 'analytics.js'), 'analytics.js is listed as withheld')
    assert.ok(r.warnings.some(w => w.code === 'secret.possible' && w.path === 'analytics.js'))
    // Model edits that escape the build or do not match are refused, never guessed.
    assert.ok(r.warnings.some(w => w.code === 'adapt.skipped' && /etc\/hosts/.test(w.message)))
    assert.ok(r.warnings.some(w => w.code === 'adapt.skipped' && /occurs 0 times/.test(w.message)))
    assert.ok(r.warnings.some(w => w.code === 'adapt.dropped' && /missing\.txt|names no file/.test(w.message)))

    assertAllowlistedModels(run)
    assert.equal(run.sessions.length, 1)
    assert.equal(run.sessions[0].revoked, true, 'session revoked at the end')
    assert.equal(run.sessions[0].request.client_version.length > 0, true)
    const projects = JSON.parse(fs.readFileSync(path.join(home, '.origingame', 'projects.json'), 'utf8'))
    assert.deepEqual(Object.values(projects), [{ gameId: r.gameId, slug: r.slug, host: platform.origin, repositoryId: r.source.repositoryId }])

    // Update: the same project publishes a new version of the same game with expected_revision, uploading nothing unchanged.
    const m2 = mark()
    const update = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run2 = since(m2)
    report.scenarios.update = { exitCode: update.code, result: update.result, uploadedFiles: run2.requests.filter(q => q.method === 'PUT' && q.path.endsWith('/files')).length }
    assert.equal(update.code, 0, update.stderr)
    assert.equal(update.result.action, 'updated')
    assert.equal(update.result.gameId, r.gameId)
    assert.equal(update.result.version, 2)
    const put = run2.deploys.at(-1)
    assert.equal(put.method, 'PUT')
    assert.equal(put.path, `/api/deploy/${r.gameId}`)
    assert.equal(put.fields.expected_revision, '3', 'expected_revision is the revision read from releases')
    const releasesRead = run2.requests.findIndex(q => q.method === 'GET' && q.path === `/api/deploy/games/${r.gameId}/releases`)
    const putAt = run2.requests.findIndex(q => q.method === 'PUT' && q.path === `/api/deploy/${r.gameId}`)
    assert.ok(releasesRead !== -1 && releasesRead < putAt, 'releases are read before the PUT')
    assert.equal(run2.requests.filter(q => q.method === 'PUT' && q.path.endsWith('/files')).length, 0, 'unchanged files are not uploaded again')
    assert.equal(put.images.cover, undefined, 'an update keeps the existing cover')
    assert.equal(run2.images.length, 0)
    assert.ok(!run2.chat.some(c => taskOf(c) === 'metadata'), 'an update keeps the listing')
    assert.equal(run2.sessions[0].revoked, true)
    assert.equal(treeHash(project), beforeHash)
  })

  test('Vite + three.js: builds in a scratch copy with relative base, recovers from an invalid model answer', async () => {
    platform.state.script = scriptFor('vite-three')
    platform.state.readinessSequence = [{ status: 'pending' }, { status: 'ready', protocol: 0, source: 'publication' }]
    const project = copyFixture('vite-three')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run = since(m)
    const afterHash = treeHash(project)
    fixtureReport('vite-three', cli, run, beforeHash, afterHash)
    platform.state.readinessSequence = null
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.ok, true)
    assert.equal(cli.result.engine, 'threejs')
    assert.equal(cli.result.readiness.status, 'ready', 'waited past the pending receipt')
    assert.equal(afterHash, beforeHash, 'no dist/ or cache was written into the project')
    assert.equal(fs.existsSync(path.join(project, 'dist')), false)
    const deploy = run.deploys.at(-1)
    const names = Object.keys(deploy.files).sort()
    assert.ok(names.includes('index.html') && names.includes('favicon.png'))
    assert.ok(names.some(n => /^assets\/index-[0-9a-f]{8}\.js$/.test(n)) && names.some(n => /^assets\/three-[0-9a-f]{8}\.js$/.test(n)), names.join(','))
    assert.ok(!names.some(n => n.startsWith('src/') || n === 'package.json'), 'only the build output is published')
    const html = deploy.files['index.html'].toString()
    assert.match(html, /src="\.\/assets\/index-[0-9a-f]{8}\.js"/, 'built with --base ./')
    assert.doesNotMatch(html, /src="\/assets/)
    assert.equal(deploy.fields.engine, 'threejs')
    assert.equal(deploy.fields.orientation, 'any')
    assertArtwork(deploy)
    saveArtifacts('vite-three', deploy)
    assert.equal(run.chat.filter(c => taskOf(c) === 'analyze').length, 2, 'asked again after a non-JSON answer')
    assertAllowlistedModels(run)
    assert.equal(run.sessions[0].revoked, true)
  })

  test('Godot Web export: declares isolation for threads, turns off the service worker, keeps engine binaries byte-identical', async () => {
    platform.state.script = scriptFor('godot-export')
    const project = copyFixture('godot-export')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run = since(m)
    const afterHash = treeHash(project)
    fixtureReport('godot-export', cli, run, beforeHash, afterHash)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.engine, 'godot')
    assert.equal(afterHash, beforeHash)
    const deploy = run.deploys.at(-1)
    assert.deepEqual(JSON.parse(deploy.files['origingame.runtime.json'].toString()), { version: 1, crossOriginIsolated: true })
    assert.equal(deploy.files['index.service.worker.js'], undefined, 'the export service worker is not published')
    const html = deploy.files['index.html'].toString()
    assert.match(html, /"serviceWorker":""/)
    assert.match(html, /"ensureCrossOriginIsolationHeaders":false/)
    for (const binary of ['index.pck', 'index.wasm', 'index.js']) {
      assert.equal(sha256(deploy.files[binary]), sha256(fs.readFileSync(path.join(project, binary))), `${binary} is published unchanged`)
    }
    assert.equal(deploy.fields.engine, 'godot')
    assert.equal(deploy.fields.orientation, 'landscape')
    assertArtwork(deploy)
    saveArtifacts('godot-export', deploy)
    assertAllowlistedModels(run)
    assert.equal(run.sessions[0].revoked, true)
  })
})

describe('sandbox mode', () => {
  function sandboxFile(dir, session) {
    const file = path.join(dir, '.wizard-credentials.json')
    fs.writeFileSync(file, JSON.stringify({ host: platform.origin, session, publish: { token: 'ogd-publish-fixture-0123456789abcdef', repository_id: 'repo_fixture_1' } }), { mode: 0o600 })
    return file
  }

  test('reads and deletes the credentials file, publishes with the delegation and repository header, never touches credentials.json', async () => {
    platform.state.script = scriptFor('godot-export')
    const project = copyFixture('godot-export')
    const scratch = tempDir('sandbox')
    const session = platform.sandboxSession()
    const file = sandboxFile(scratch, session)
    const home = tempDir('home')
    fs.mkdirSync(path.join(home, '.origingame'))
    const sentinel = JSON.stringify({ host: 'https://elsewhere.example', access_token: 'og-someone-else-000000000000', device_id: 1, account: ACCOUNT })
    fs.writeFileSync(path.join(home, '.origingame', 'credentials.json'), sentinel, { mode: 0o600 })
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--prebuilt', project, '--yes', '--json', '--credentials-file', file, '--source-checkpoint', 'ckpt_fixture_7'], { home })
    const run = since(m)
    report.scenarios.sandbox = { exitCode: cli.code, result: cli.result, credentialsFileDeleted: !fs.existsSync(file), portalRequests: run.requests.filter(q => q.path.startsWith('/api/deploy')).map(q => ({ method: q.method, path: q.path, repository: q.repository, delegation: q.authorization?.startsWith('Bearer ogd-') })) }
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.ok, true)
    assert.equal(fs.existsSync(file), false, 'the credentials file is deleted')
    assert.equal(fs.readFileSync(path.join(home, '.origingame', 'credentials.json'), 'utf8'), sentinel, 'credentials.json is untouched')
    assert.equal(run.requests.filter(q => q.path === '/identity/v1/wizard/sessions').length, 0, 'no new session is issued')
    const portal = run.requests.filter(q => q.path.startsWith('/api/deploy'))
    assert.ok(portal.length >= 4)
    for (const q of portal) {
      assert.equal(q.authorization, 'Bearer ogd-publish-fixture-0123456789abcdef')
      assert.equal(q.repository, 'repo_fixture_1')
    }
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.fields.source_checkpoint, 'ckpt_fixture_7')
    assert.equal(platform.state.sessions.get(session.session_id).revoked, true, 'the handed-over session is revoked')
    assert.ok(run.chat.every(c => c.session === session.session_id))
    assert.equal(fs.existsSync(path.join(home, '.origingame', 'projects.json')), false)
  })

  test('a readiness failure (422) is ok:false readiness_failed, exit 1, and the session is still revoked', async () => {
    platform.state.script = scriptFor('godot-export')
    platform.state.readiness422 = true
    try {
      const project = copyFixture('godot-export')
      const session = platform.sandboxSession()
      const file = sandboxFile(tempDir('sandbox'), session)
      const cli = await runCli(['deploy', '--dir', project, '--prebuilt', project, '--json', '--credentials-file', file, '--source-checkpoint', 'ckpt_fixture_8'], { home: tempDir('home') })
      report.scenarios.readiness422 = { exitCode: cli.code, result: cli.result }
      assert.equal(cli.code, 1)
      assert.equal(cli.result.ok, false)
      assert.equal(cli.result.error.code, 'readiness_failed')
      assert.equal(cli.result.error.readiness.status, 'timeout')
      assert.equal(platform.state.sessions.get(session.session_id).revoked, true)
      assert.doesNotMatch(cli.stdout + cli.stderr, /ogd-publish-fixture|ogp-/, 'no credential is printed')
    } finally {
      platform.state.readiness422 = false
    }
  })

  test('model calls go to the API relay origin, never to the Portal origin', async () => {
    platform.state.script = scriptFor('plain-html')
    const relay = platform.origin.replace('127.0.0.1', 'localhost')
    const m = mark()
    const cli = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--yes', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), env: { ORIGINGAME_API_ORIGIN: relay } })
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    const relayed = run.requests.filter(q => q.path === '/v1/chat/completions' || q.path === '/v1/images/generations')
    assert.ok(relayed.length > 0, 'the run called models')
    assert.deepEqual([...new Set(relayed.map(q => q.host))], [new URL(relay).host])
    assert.ok(run.requests.filter(q => q.path.startsWith('/api/deploy')).every(q => q.host === new URL(platform.origin).host), 'publication stays on the Portal origin')
  })
})

describe('failures', () => {
  test('rules unavailable: exit 1 with rules_unavailable before any session', async () => {
    platform.state.rulesDown = true
    try {
      const m = mark()
      const cli = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
      const run = since(m)
      report.scenarios.rulesUnavailable = { exitCode: cli.code, result: cli.result }
      assert.equal(cli.code, 1)
      assert.deepEqual(Object.keys(cli.result), ['ok', 'error'])
      assert.equal(cli.result.error.code, 'rules_unavailable')
      assert.equal(run.sessions.length, 0)
    } finally {
      platform.state.rulesDown = false
    }
  })

  test('artwork failure: artwork_failed, nothing published, session revoked, project untouched', async () => {
    platform.state.script = scriptFor('plain-html')
    platform.state.imageStatus = 403
    try {
      const project = copyFixture('plain-html')
      const beforeHash = treeHash(project)
      const m = mark()
      const cli = await runCli(['deploy', '--dir', project, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
      const run = since(m)
      report.scenarios.artworkFailure = { exitCode: cli.code, result: cli.result, revoked: run.sessions.map(s => s.revoked) }
      assert.equal(cli.code, 1)
      assert.equal(cli.result.error.code, 'artwork_failed')
      assert.equal(run.deploys.length, 0)
      assert.equal(run.sessions.length, 1)
      assert.equal(run.sessions[0].revoked, true)
      assert.equal(treeHash(project), beforeHash)
    } finally {
      platform.state.imageStatus = 200
    }
  })

  test('a build over the limits the platform serves fails with upload_failed naming that limit, before any model call', async () => {
    platform.state.script = scriptFor('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const refused = async (patch, setup) => {
      const project = copyFixture('plain-html')
      setup(project)
      const m = mark()
      const cli = await withRules(patch, () => runCli(['deploy', '--dir', project, '--json', '--no-source', '--host', platform.origin], { home }))
      const run = since(m)
      assert.equal(cli.code, 1, cli.stderr)
      assert.equal(cli.result.error.code, 'upload_failed')
      assert.equal(run.chat.length, 0, 'no model spend')
      assert.equal(run.requests.filter(q => q.path.startsWith('/api/deploy/source-uploads')).length, 0, 'nothing offered to Portal')
      assert.equal(run.sessions[0].revoked, true)
      return cli.result.error.message
    }
    // Per file: a 3 MiB file against a served 2 MiB limit.
    let message = await refused(limits({ maxFileBytes: 2 * MiB }), p => fs.writeFileSync(path.join(p, 'assets', 'huge.bin'), Buffer.alloc(3 * MiB)))
    assert.match(message, /^assets\/huge\.bin is 3\.0 MiB; OriginGame accepts files up to 2 MiB$/)
    report.scenarios.overLimit = { message }
    // In total: two 2 MiB files against a served 3 MiB total.
    message = await refused(limits({ maxTotalBytes: 3 * MiB }), p => { for (const n of ['a', 'b']) fs.writeFileSync(path.join(p, 'assets', `${n}.bin`), Buffer.alloc(2 * MiB)) })
    assert.match(message, /^the build is 4\.\d MiB; OriginGame accepts at most 3 MiB in total$/)
    // File count: a served limit of 5 files.
    message = await refused(limits({ maxFiles: 5 }), () => {})
    assert.match(message, /^the build has \d+ files; OriginGame accepts at most 5$/)
  })

  test('without limits in the rules (an older platform) the defaults are Portal\'s: a 60 MiB file is published byte for byte', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    const big = Buffer.concat([randomBytes(1 * MiB), Buffer.alloc(59 * MiB, 7)])
    fs.writeFileSync(path.join(project, 'assets', 'movie.bin'), big)
    const m = mark()
    const cli = await withRules({ limits: undefined }, () => runCli(['deploy', '--dir', project, '--yes', '--json', '--no-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) }))
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    const put = run.requests.find(q => q.method === 'PUT' && q.query.includes(encodeURIComponent('assets/movie.bin')))
    assert.equal(put.contentLength, String(big.length), 'sent with its exact Content-Length')
    assert.equal(sha256(run.deploys.at(-1).files['assets/movie.bin']), sha256(big))
  })

  test('limits out of range are clamped and malformed ones ignored: the run still publishes', async () => {
    platform.state.script = scriptFor('plain-html')
    const m = mark()
    const cli = await withRules({ limits: { portal: { maxFiles: -3, maxFileBytes: 'big', maxTotalBytes: null }, upload: { concurrency: 10_000 } } }, () =>
      runCli(['deploy', '--dir', copyFixture('plain-html'), '--yes', '--json', '--no-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) }))
    const run = since(m)
    // maxFiles -3 is clamped to 1, which a plain HTML build with several files exceeds: the clamp, not a crash, decides.
    assert.equal(cli.code, 1, cli.stderr)
    assert.match(cli.result.error.message, /OriginGame accepts at most 1$/)
    assert.equal(run.chat.length, 0)
    const ok = await withRules({ limits: 'unlimited' }, () =>
      runCli(['deploy', '--dir', copyFixture('plain-html'), '--yes', '--json', '--no-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) }))
    assert.equal(ok.code, 0, ok.stderr)
  })

  test('not signed in under CI: not_logged_in, exit 1', async () => {
    const cli = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--host', platform.origin], { home: tempDir('home'), env: { CI: '1' } })
    report.scenarios.notLoggedIn = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'not_logged_in')
  })

  test('nothing to publish: detect_failed', async () => {
    const empty = tempDir('empty')
    fs.writeFileSync(path.join(empty, 'notes.txt'), 'no game here')
    const cli = await runCli(['deploy', '--dir', empty, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'detect_failed')
  })
})

describe('uploads to Portal', () => {
  /** plain-html plus `count` small files no earlier run uploaded (Portal reuses what it already holds). */
  function manyFiles(count) {
    const project = copyFixture('plain-html')
    fs.mkdirSync(path.join(project, 'levels', 'many'), { recursive: true })
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(project, 'levels', 'many', `${String(i).padStart(3, '0')}.json`), JSON.stringify({ i, seed: randomBytes(16).toString('hex') }))
    return project
  }
  const deployOnce = (project, extra = []) => runCli(['deploy', '--dir', project, '--yes', '--json', '--no-source', '--host', platform.origin, ...extra], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
  /** Every staged file reached Portal byte for byte. */
  function assertPublishedAll(cli, run, project) {
    const files = run.deploys.at(-1).files
    for (let i = 0; i < 40; i++) {
      const name = `levels/many/${String(i).padStart(3, '0')}.json`
      assert.equal(sha256(files[name]), sha256(fs.readFileSync(path.join(project, name))), `${name} is published`)
    }
  }
  const knobs = () => platform.state.upload
  const resetKnobs = () => Object.assign(platform.state.upload, { delayMs: 0, maxInFlight: 0, throttle: 0, throttled: [], expireAfter: null, dropAfter: null, puts: [], stored: [] })

  test('files go up as many at a time as the rules say (default 8), each with its exact Content-Length', async () => {
    platform.state.script = scriptFor('plain-html')
    try {
      resetKnobs()
      knobs().delayMs = 150
      let project = manyFiles(40)
      let m = mark()
      let cli = await deployOnce(project)
      let run = since(m)
      assert.equal(cli.code, 0, cli.stderr)
      assert.equal(knobs().maxInFlight, 8, 'the default concurrency is reached and never exceeded')
      assertPublishedAll(cli, run, project)
      for (const put of run.requests.filter(q => q.method === 'PUT')) assert.equal(put.contentLength, String(put.bytes), `${put.query} declares its length`)
      report.scenarios.uploadConcurrency = { default: knobs().maxInFlight }

      knobs().maxInFlight = 0
      project = manyFiles(40)
      m = mark()
      cli = await withRules(limits({}, { concurrency: 3 }), () => deployOnce(project))
      run = since(m)
      assert.equal(cli.code, 0, cli.stderr)
      assert.equal(knobs().maxInFlight, 3, 'the served concurrency is what is used')
      assertPublishedAll(cli, run, project)
      report.scenarios.uploadConcurrency.served3 = knobs().maxInFlight
    } finally {
      resetKnobs()
    }
  })

  test('an upload that expires (410) or disappears (404) partway is prepared again and continues with only what is missing', async () => {
    for (const [knob, status] of [['expireAfter', 410], ['dropAfter', 404]]) {
      platform.state.script = scriptFor('plain-html')
      try {
        resetKnobs()
        const project = manyFiles(40)
        knobs()[knob] = 10
        const m = mark()
        const cli = await deployOnce(project)
        const run = since(m)
        assert.equal(cli.code, 0, `${knob}: ${cli.stderr}`)
        const prepares = run.requests.filter(q => q.method === 'POST' && q.path === '/api/deploy/source-uploads')
        assert.equal(prepares.length, 2, `${knob}: prepared again once`)
        const ids = [...new Set(knobs().puts.map(p => p.id))]
        assert.equal(ids.length, 2, `${knob}: files went to the first upload, then to the second`)
        const [first, second] = ids.map(id => knobs().puts.filter(p => p.id === id).map(p => p.path))
        const storedFirst = knobs().stored.filter(p => p.id === ids[0]).map(p => p.path)
        assert.ok(storedFirst.length >= 10 && storedFirst.length < 40, `${knob}: ${storedFirst.length} stored before it ended`)
        for (const p of storedFirst) assert.ok(!second.includes(p), `${knob}: ${p}, stored before the upload ended, is not sent again`)
        for (let i = 0; i < 40; i++) {
          const name = `levels/many/${String(i).padStart(3, '0')}.json`
          assert.ok(storedFirst.includes(name) !== second.includes(name), `${knob}: ${name} is sent to exactly one of the uploads`)
        }
        assert.ok(run.requests.some(q => q.method === 'POST' && q.path === `/api/deploy/source-uploads/${ids[1]}/finalize`), `${knob}: the new upload is finalized`)
        assert.equal(run.deploys.at(-1).fields.sourceUploadId, ids[1])
        assertPublishedAll(cli, run, project)
        assert.ok(cli.stderr.includes(`Portal ended the open upload (HTTP ${status}); preparing it again`), `${knob}: the person is told (HTTP ${status})`)
        report.scenarios[`upload${status}`] = { prepares: prepares.length, firstUpload: first.length, secondUpload: second.length }
      } finally {
        resetKnobs()
      }
    }
  })

  test('a throttled file (429) is sent again after the Retry-After Portal asks for', async () => {
    platform.state.script = scriptFor('plain-html')
    try {
      resetKnobs()
      const project = manyFiles(40)
      knobs().throttle = 3
      const m = mark()
      const cli = await deployOnce(project)
      const run = since(m)
      assert.equal(cli.code, 0, cli.stderr)
      assert.equal(knobs().throttled.length, 3)
      for (const t of knobs().throttled) {
        const retry = knobs().puts.find(p => p.path === t.path && p.at > t.at)
        assert.ok(retry, `${t.path} was sent again`)
        assert.ok(retry.at - t.at >= 950, `${t.path} waited ${retry.at - t.at} ms (Retry-After: 1)`)
      }
      assertPublishedAll(cli, run, project)
    } finally {
      resetKnobs()
    }
  })
})

describe('accounts', () => {
  test('login through the device flow stores a 0600 credential; whoami reads it; logout revokes and removes it', async () => {
    const home = tempDir('home')
    const login = await runCli(['login', '--json', '--host', platform.origin], { home })
    assert.equal(login.code, 0, login.stderr)
    assert.deepEqual(login.result.account, ACCOUNT)
    assert.equal(platform.state.deviceStart.client, 'wizard')
    assert.match(login.stderr, /WXYZ2345/, 'the user code is shown')
    const file = path.join(home, '.origingame', 'credentials.json')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(stored.host, platform.origin)
    assert.match(stored.access_token, /^og-/)
    assert.doesNotMatch(login.stdout + login.stderr, new RegExp(stored.access_token), 'the credential is never printed')
    const who = await runCli(['whoami', '--json', '--host', platform.origin], { home })
    assert.equal(who.code, 0, who.stderr)
    assert.deepEqual(who.result.account, ACCOUNT)
    assert.equal(who.result.verified, true)
    const out = await runCli(['logout', '--json', '--host', platform.origin], { home })
    assert.equal(out.result.revoked, true)
    assert.equal(fs.existsSync(file), false)
    assert.ok(platform.state.revokedDevices.has(stored.access_token))
    const after = await runCli(['whoami', '--json', '--host', platform.origin], { home })
    assert.equal(after.result.error.code, 'not_logged_in')
  })
})

describe('the origingame/publish worktree', () => {
  function gitProject() {
    const project = copyFixture('plain-html')
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString()
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    return { project, git }
  }
  /** The checkout as the person sees it: every file outside .git, the branch, HEAD, the index and the status. */
  function checkoutState(project, git) {
    const files = treeHashExcept(project, '.git')
    return { files, branch: git('symbolic-ref', 'HEAD').trim(), head: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain'), staged: git('diff', '--cached', '--name-only') }
  }
  const subjects = (git, base) => git('log', '--format=%s', `${base}..origingame/publish`).split('\n').filter(Boolean)

  test('a Git project: adaptations and the score/save wiring are commits on origingame/publish; the checkout is untouched', async () => {
    platform.state.script = scriptFor('integrate')
    const { project, git } = gitProject()
    // Uncommitted and untracked work is built, never committed.
    fs.appendFileSync(path.join(project, 'README.md'), '\nlocal change\n')
    fs.writeFileSync(path.join(project, 'notes.txt'), 'untracked notes\n')
    const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
    const before = checkoutState(project, git)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    report.scenarios.worktree = { exitCode: cli.code, workspace: cli.result?.workspace, integration: cli.result?.integration }
    assert.equal(cli.code, 0, cli.stdout)
    assert.deepEqual(checkoutState(project, git), before, 'files, branch, HEAD, index and status of the checkout are unchanged')

    const r = cli.result
    assert.equal(r.workspace.kind, 'worktree')
    assert.equal(r.workspace.branch, 'origingame/publish')
    assert.equal(r.workspace.review, 'git diff HEAD...origingame/publish')
    assert.equal(r.workspace.merge, 'git merge origingame/publish')
    assert.ok(fs.existsSync(path.join(r.workspace.path, 'index.html')))
    assert.deepEqual(subjects(git, base), ['origingame: wire leaderboards and cloud saves', 'origingame: adapt for OriginGame'])
    assert.deepEqual(r.workspace.commits.map(c => c.message), ['origingame: adapt for OriginGame', 'origingame: wire leaderboards and cloud saves'])
    assert.deepEqual(r.integration, { applied: true, files: ['game.js', 'index.html', 'og-player.js (new)'] })
    const committed = file => git('show', `origingame/publish:${file}`)
    assert.match(committed('game.js'), /leaderboard\.submit/)
    assert.match(committed('index.html'), /<script src="og-player\.js"><\/script>\n {2}<script src="game\.js"><\/script>/, 'relative paths and the player script, on the branch')
    assert.doesNotMatch(committed('README.md'), /local change/, 'the checkout\'s uncommitted change is not committed')
    assert.throws(() => committed('notes.txt'), 'untracked files are not committed')

    const deploy = run.deploys.at(-1)
    assert.ok(deploy.files['og-player.js'], 'the integrated build is published')
    assert.match(deploy.files['README.md'].toString(), /local change/, 'built from the checkout as it is')
    assert.ok(deploy.files['notes.txt'])
    assert.ok(run.chat.filter(c => taskOf(c) === 'integrate').every(c => c.model === 'deepseek-v4-pro'))
    assert.equal(run.sessions[0].revoked, true)

    // A later run reuses the branch and adds no commit when nothing needs changing again.
    platform.state.script = scriptFor('integrate-again')
    const again = await runCli(['deploy', '--dir', project, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(again.code, 0, again.stdout)
    assert.deepEqual(checkoutState(project, git), before)
    assert.deepEqual(subjects(git, base), ['origingame: wire leaderboards and cloud saves', 'origingame: adapt for OriginGame'])
  })

  test('an integrated build that does not become ready is replaced by the adaptation-only commit; the publication still succeeds', async () => {
    platform.state.script = scriptFor('integrate')
    platform.state.readinessFails = files => Boolean(files['og-player.js'])
    try {
      const { project, git } = gitProject()
      const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
      const before = checkoutState(project, git)
      const m = mark()
      const cli = await runCli(['deploy', '--dir', project, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
      const run = since(m)
      report.scenarios.integrationDropped = { exitCode: cli.code, integration: cli.result?.integration, deploys: run.deploys.length }
      assert.equal(cli.code, 0, cli.stderr)
      assert.equal(cli.result.ok, true)
      assert.equal(cli.result.integration.applied, false)
      assert.match(cli.result.integration.reason, /did not become ready/)
      assert.ok(cli.result.warnings.some(w => w.code === 'integration.dropped'))
      assert.equal(run.deploys.length, 2, 'the integrated attempt, then the adaptation-only build')
      assert.ok(run.deploys[0].files['og-player.js'])
      assert.equal(run.deploys[1].files['og-player.js'], undefined)
      assert.deepEqual(subjects(git, base), ['origingame: adapt for OriginGame'], 'the integration commit is dropped from the branch')
      assert.deepEqual(checkoutState(project, git), before)
    } finally {
      platform.state.readinessFails = undefined
    }
  })

  test('--no-integrate and a folder outside Git: the adapted copy is reported, nothing is wired', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    const before = treeHash(project)
    const cli = await runCli(['deploy', '--dir', project, '--json', '--no-integrate', '--no-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(treeHash(project), before)
    assert.deepEqual(cli.result.integration, { applied: false, reason: 'turned off with --no-integrate' })
    assert.equal(cli.result.workspace.kind, 'copy')
    assert.match(fs.readFileSync(path.join(cli.result.workspace.path, 'game.js'), 'utf8'), /fetch\('levels\/1\.json'\)/, 'the copy holds the adaptations')
  })
})

describe('--with-source', () => {
  const AGENT = () => ({ ORIGINGAME_AGENT_ORIGIN: platform.origin })
  const agentRequests = run => run.requests.filter(q => /^\/v1\/(repositories|memberships|checkpoints)/.test(q.path) || q.path.startsWith('/git/') || q.path.startsWith('/objects/'))
  const MUSIC = Buffer.from(Array.from({ length: 300 * 1024 }, (_, i) => (i * 7919 + (i >> 8)) & 255))

  /** plain-html plus what a real project has around it: ignore rules, logs, a build directory, a large asset, a link, many small files. */
  function sourceProject() {
    const project = copyFixture('plain-html')
    const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), content) }
    write('.gitignore', '# local\n*.log\n!keep.log\n/build/\n')
    write('debug.log', 'noise\n')
    write('keep.log', 'kept on purpose\n')
    write('build/out.js', 'generated\n')
    write('notes/.gitignore', 'private.txt\n')
    write('notes/private.txt', 'not for the repository\n')
    write('notes/public.txt', 'design notes\n')
    write('assets/music.ogg', MUSIC)
    for (let i = 0; i < 150; i++) write(`levels/gen/${String(i).padStart(3, '0')}.json`, JSON.stringify({ level: i, stars: Array.from({ length: 40 }, (_, j) => j * i) }))
    fs.symlinkSync('README.md', path.join(project, 'readme-link.md'))
    return project
  }

  const repoOf = id => platform.state.agent.repos.get(id)
  const mainTree = id => platform.state.agent.commits.get(repoOf(id).branches.get('main')).tree

  test('commits the tracked source to a private repository, large files through LFS, and publishes with its checkpoint', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = sourceProject()
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const beforeHash = treeHash(project)
    const m = mark()
    const bodies = platform.state.agent.bodies.length
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--with-source', '--host', platform.origin], { home, env: AGENT() })
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    const source = cli.result.source
    assert.ok(source && /^[0-9a-f]{32}$/.test(source.repositoryId) && /^[0-9a-f]{32}$/.test(source.checkpointId), JSON.stringify(source))
    assert.equal(source.createdRepository, true)
    assert.equal(treeHash(project), beforeHash, 'the project directory is not written')

    // What main holds: exactly what Git would track, minus credentials, plus the LFS attributes and the upload manifest.
    const tree = mainTree(source.repositoryId)
    const expected = ['.gitattributes', '.gitignore', '.origin/wizard-source.json', 'README.md', 'assets/bg.png', 'assets/music.ogg', 'game.js', 'index.html', 'keep.log', 'levels/1.json',
      ...Array.from({ length: 150 }, (_, i) => `levels/gen/${String(i).padStart(3, '0')}.json`), 'notes/.gitignore', 'notes/public.txt', 'style.css'].sort()
    assert.deepEqual([...tree.keys()].sort(), expected)
    // The uploaded source is the adapted workspace (not a Git repository here: the copy), byte for byte.
    assert.equal(cli.result.workspace.kind, 'copy')
    for (const file of expected.filter(f => !['.gitattributes', '.origin/wizard-source.json', 'assets/music.ogg'].includes(f))) {
      assert.equal(sha256(tree.get(file)), sha256(fs.readFileSync(path.join(cli.result.workspace.path, file))), `${file} is committed byte for byte`)
    }
    assert.match(tree.get('game.js').toString(), /fetch\('levels\/1\.json'\)/, 'with its adaptations')
    assert.match(fs.readFileSync(path.join(project, 'game.js'), 'utf8'), /fetch\('\/levels\/1\.json'\)/, 'the folder keeps the original')
    const oid = sha256(MUSIC)
    assert.equal(tree.get('assets/music.ogg').toString(), `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${MUSIC.length}\n`)
    assert.equal(platform.state.agent.lfs.get(oid).verified, true, 'the LFS object was uploaded and verified')
    assert.equal(sha256(platform.state.agent.objects.get(oid)), oid)
    assert.match(tree.get('.gitattributes').toString(), /^\/assets\/music\.ogg filter=lfs diff=lfs merge=lfs -text$/m)

    // Withheld, and never sent anywhere on the Agent side.
    const reasons = Object.fromEntries(source.withheld.map(w => [w.path, w.reason]))
    assert.equal(reasons['id_ed25519'], 'credential file')
    assert.equal(reasons['.env'], 'credential file')
    assert.match(reasons['analytics.js'], /aws-access-key/)
    assert.equal(reasons['readme-link.md'], 'symbolic link')
    const sent = Buffer.concat(platform.state.agent.bodies.slice(bodies).map(b => b.body)).toString('latin1')
    const decodedCommits = platform.state.agent.bodies.slice(bodies).filter(b => b.path.endsWith('/commits')).flatMap(b => JSON.parse(b.body.toString()).files).map(f => (f.content_base64 ? Buffer.from(f.content_base64, 'base64').toString('latin1') : '')).join('\n')
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', fs.readFileSync(path.join(project, 'id_ed25519'), 'latin1'), fs.readFileSync(path.join(project, '.env'), 'latin1')]) {
      assert.ok(!sent.includes(secret) && !decodedCommits.includes(secret), 'a withheld file never reaches Agent Service')
    }

    // Several commits within Agent's limits, then one checkpoint at the head, named by the publication.
    const commits = run.requests.filter(q => q.method === 'POST' && q.path === `/v1/repositories/${source.repositoryId}/commits`)
    assert.ok(commits.length >= 3, `150+ files need several commits (${commits.length})`)
    assert.equal(source.commit, repoOf(source.repositoryId).branches.get('main'))
    assert.equal(platform.state.agent.checkpoints.get(source.checkpointId).commit, source.commit)
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.fields.source_checkpoint, source.checkpointId)
    assert.equal(deploy.authorization, `Bearer ${DEVICE_TOKEN}`)
    assert.ok(agentRequests(run).filter(q => q.path.startsWith('/v1/') || q.path.startsWith('/git/')).every(q => q.authorization === `Bearer ${DEVICE_TOKEN}`), 'Agent Service sees the person\'s own credential, never the session')
    assert.deepEqual(repoOf(source.repositoryId).publications.map(p => [p.game_id, p.checkpoint_id]), [[cli.result.gameId, source.checkpointId]])
    const projects = JSON.parse(fs.readFileSync(path.join(home, '.origingame', 'projects.json'), 'utf8'))
    assert.equal(Object.values(projects)[0].repositoryId, source.repositoryId)
    report.scenarios.withSource = { exitCode: cli.code, source, commits: commits.length, tree: [...tree.keys()].length }

    // Update: the same repository (remembered: Portal links releases through an outbox, so the link may still be pending);
    // only what changed is committed; a removed file is deleted; LFS is not re-sent.
    const pendingLinks = repoOf(source.repositoryId).publications.splice(0)
    fs.appendFileSync(path.join(project, 'game.js'), '\n// tuned\n')
    fs.rmSync(path.join(project, 'notes/public.txt'))
    fs.writeFileSync(path.join(project, 'levels/2.json'), '{"stars":[1,2,3]}\n')
    const m2 = mark()
    const update = await runCli(['deploy', '--dir', project, '--yes', '--json', '--with-source', '--host', platform.origin], { home, env: AGENT() })
    const run2 = since(m2)
    assert.equal(update.code, 0, update.stderr)
    assert.equal(update.result.source.repositoryId, source.repositoryId)
    assert.equal(update.result.source.createdRepository, false)
    assert.equal(run2.requests.filter(q => q.method === 'POST' && q.path === '/v1/repositories').length, 0, 'no second repository')
    const sentFiles = platform.state.agent.bodies.filter(b => b.path === `/v1/repositories/${source.repositoryId}/commits`).slice(-run2.requests.filter(q => q.path.endsWith('/commits')).length)
      .flatMap(b => JSON.parse(b.body.toString()).files.map(f => `${f.delete ? '-' : '+'}${f.path}`)).sort()
    assert.deepEqual(sentFiles, ['+.origin/wizard-source.json', '+game.js', '+levels/2.json', '-notes/public.txt'])
    assert.equal(run2.requests.filter(q => q.path.includes('/info/lfs/')).length, 0)
    const tree2 = mainTree(source.repositoryId)
    assert.equal(tree2.has('notes/public.txt'), false)
    assert.equal(tree2.get('game.js').toString(), fs.readFileSync(path.join(update.result.workspace.path, 'game.js'), 'utf8'), 'the adapted workspace version')
    assert.notEqual(update.result.source.checkpointId, source.checkpointId)
    assert.equal(run2.deploys.at(-1).fields.source_checkpoint, update.result.source.checkpointId)
    report.scenarios.withSourceUpdate = { exitCode: update.code, source: update.result.source, files: sentFiles }
    repoOf(source.repositoryId).publications.push(...pendingLinks)

    // Another machine (nothing remembered), same game: the linked repository is found through its publications.
    const m3 = mark()
    const elsewhere = await runCli(['deploy', '--dir', project, '--yes', '--json', '--with-source', '--game', cli.result.gameId, '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), env: AGENT() })
    const run3 = since(m3)
    assert.equal(elsewhere.code, 0, elsewhere.stderr)
    assert.equal(elsewhere.result.source.repositoryId, source.repositoryId)
    assert.equal(run3.requests.filter(q => q.method === 'POST' && q.path === '/v1/repositories').length, 0)
    assert.equal(run3.requests.filter(q => q.path.endsWith('/commits')).length, 0, 'nothing changed, nothing committed')
  })

  test('large files go to Git LFS several at a time, streamed, with presigned URLs renewed before they expire and store failures retried', async () => {
    const lfsPut = platform.state.agent.lfsPut
    const reset = () => Object.assign(lfsPut, { expiresIn: 900, delayMs: 0, maxInFlight: 0, fail: 0, refuseFirst: false, refused: new Set(), expired: 0, failed: 0, stored: 0 })
    /** plain-html with `count` large, never-seen files. */
    const project = count => {
      const dir = copyFixture('plain-html')
      fs.mkdirSync(path.join(dir, 'audio'), { recursive: true })
      return { dir, files: Array.from({ length: count }, (_, i) => { const bytes = randomBytes(300 * 1024 + i); fs.writeFileSync(path.join(dir, 'audio', `track-${i}.ogg`), bytes); return bytes }) }
    }
    const run = async ({ dir, files }) => {
      platform.state.script = scriptFor('plain-html')
      const m = mark()
      const cli = await runCli(['deploy', '--dir', dir, '--yes', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), env: AGENT() })
      const r = since(m)
      assert.equal(cli.code, 0, cli.stderr)
      assert.equal(cli.result.source.lfsObjects, files.length)
      for (const bytes of files) {
        const oid = sha256(bytes)
        assert.equal(platform.state.agent.lfs.get(oid)?.verified, true, `${oid} stored and verified`)
        assert.equal(sha256(platform.state.agent.objects.get(oid)), oid)
      }
      for (const put of r.requests.filter(q => q.method === 'PUT' && q.path.startsWith('/objects/lfs/'))) assert.equal(put.contentLength, String(put.bytes))
      return r
    }
    try {
      // URLs valid for 1 s and a store that takes 600 ms per object: twelve objects four at a time only fit if each URL is renewed before use.
      reset()
      Object.assign(lfsPut, { expiresIn: 1, delayMs: 600 })
      let r = await run(project(12))
      assert.equal(lfsPut.maxInFlight, 4, 'four objects at a time')
      assert.equal(lfsPut.expired, 0, 'no URL was used after it expired')
      assert.equal(lfsPut.stored, 12)
      assert.ok(r.requests.filter(q => q.path.endsWith('/info/lfs/objects/batch')).length > 1, 'URLs were requested again')
      report.scenarios.lfsRenewal = { maxInFlight: lfsPut.maxInFlight, batches: r.requests.filter(q => q.path.endsWith('/info/lfs/objects/batch')).length }

      // A URL refused as expired despite its expires_in, and two store failures (500): each object still lands once.
      reset()
      Object.assign(lfsPut, { refuseFirst: true, fail: 2 })
      r = await run(project(5))
      assert.equal(lfsPut.refused.size, 5, 'every first PUT was refused')
      assert.equal(lfsPut.failed, 2, 'two store failures were answered')
      assert.equal(lfsPut.stored, 5)
      report.scenarios.lfsRetry = { refused: lfsPut.refused.size, failed: lfsPut.failed, puts: r.requests.filter(q => q.path.startsWith('/objects/lfs/')).length }
    } finally {
      reset()
    }
  })

  test('a source over the limits fails with source_failed before any model call or publication', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(project, `f${i}.txt`), '')
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--json', '--with-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), env: AGENT() })
    const run = since(m)
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'source_failed')
    assert.match(cli.result.error.message, /5\d{3} files; the limit is 5000/)
    assert.equal(run.chat.length, 0)
    assert.equal(run.deploys.length, 0)
    assert.equal(agentRequests(run).length, 0)
    assert.equal(run.sessions[0].revoked, true)
  })

  test('another writer moving main mid-upload is source_failed, and nothing is published', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    platform.state.agent.raceNextCommit = true
    try {
      const m = mark()
      const cli = await runCli(['deploy', '--dir', project, '--json', '--with-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), env: AGENT() })
      const run = since(m)
      assert.equal(cli.code, 1)
      assert.equal(cli.result.error.code, 'source_failed')
      assert.match(cli.result.error.message, /changed while uploading/)
      assert.equal(run.deploys.length, 0)
      assert.equal(run.sessions[0].revoked, true)
    } finally {
      platform.state.agent.raceNextCommit = false
    }
  })

  test('--no-source saves nothing; the 0.1 flag --with-source is accepted and changes nothing', async () => {
    const agentRequests = run => run.requests.filter(q => /^\/v1\/(repositories|memberships|checkpoints)|^\/git\//.test(q.path)).length
    platform.state.script = scriptFor('plain-html')
    let m = mark()
    const off = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--no-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    let run = since(m)
    assert.equal(off.code, 0, off.stderr)
    assert.equal(off.result.source, null)
    assert.equal(agentRequests(run), 0, 'with --no-source nothing reaches Agent Service')
    assert.equal(run.deploys.at(-1).fields.source_checkpoint, undefined)

    platform.state.script = scriptFor('plain-html')
    m = mark()
    const legacy = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--with-source', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    run = since(m)
    assert.equal(legacy.code, 0, legacy.stderr)
    assert.ok(legacy.result.source?.checkpointId)
    assert.ok(agentRequests(run) > 0)
  })
})

describe('AIGCC finals (--aigcc)', () => {
  const TEAM = { id: 'aigcc-fixture', teamName: 'Flower Team', projectTitle: 'Playable Garden', track: 'culture', stage: 'finalist', captain: false }
  const aigccRequests = run => run.requests.filter(q => q.path.startsWith('/api/aigcc/')).map(q => `${q.method} ${q.path}`)
  const reset = (team = null) => Object.assign(platform.state.aigcc, { team, open: true, refuseBind: false, submissions: [] })

  test('a team outside the finals is refused before any model call or publication; the session is revoked', async () => {
    reset()
    platform.state.script = scriptFor('plain-html')
    const m = mark()
    const cli = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--no-source', '--aigcc', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    assert.equal(cli.code, 1)
    assert.equal(cli.result.ok, false)
    assert.equal(cli.result.error.code, 'aigcc_refused')
    assert.match(cli.result.error.message, /finalist status/)
    assert.equal(run.chat.length + run.images.length + run.deploys.length, 0)
    assert.equal(run.sessions[0].revoked, true)
  })

  test('a finalist publishes, then the exact release is submitted with the person\'s own sign-in; scripts never submit without --aigcc', async () => {
    reset(TEAM)
    platform.state.script = scriptFor('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const project = copyFixture('plain-html')
    let m = mark()
    const quiet = await runCli(['deploy', '--dir', project, '--json', '--no-source', '--host', platform.origin], { home })
    let run = since(m)
    assert.equal(quiet.code, 0, quiet.stderr)
    assert.equal(quiet.result.aigcc, null)
    assert.deepEqual(aigccRequests(run), ['GET /api/aigcc/entry/finals'], 'a script only learns that it could submit')
    assert.match(quiet.stderr, /pass --aigcc/)
    assert.equal(platform.state.aigcc.submissions.length, 0)

    platform.state.script = scriptFor('plain-html')
    m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--json', '--no-source', '--aigcc', '--host', platform.origin], { home })
    run = since(m)
    report.scenarios.aigccFinals = { exitCode: cli.code, result: cli.result, aigccRequests: aigccRequests(run) }
    assert.equal(cli.code, 0, cli.stderr)
    assert.deepEqual(cli.result.aigcc, { submitted: true, team: 'Flower Team', version: 1, playUrl: `${platform.origin}/play/${cli.result.gameId}/` })
    assert.deepEqual(platform.state.aigcc.submissions, [{ gameId: cli.result.gameId, releaseId: cli.result.releaseId, version: 1 }])
    const order = run.requests.map(q => `${q.method} ${q.path}`)
    assert.ok(order.indexOf(`PUT /api/deploy/${cli.result.gameId}`) < order.indexOf('POST /api/aigcc/entry/finals/game'), 'submitted after publication')
    for (const q of run.requests.filter(q => q.path.startsWith('/api/aigcc/'))) assert.equal(q.authorization, `Bearer ${DEVICE_TOKEN}`)
  })

  test('without a remembered game, --aigcc updates the team\'s bound finals game instead of creating another', async () => {
    reset(TEAM)
    platform.state.script = scriptFor('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const first = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--no-source', '--aigcc', '--host', platform.origin], { home })
    assert.equal(first.code, 0, first.stderr)
    fs.rmSync(path.join(home, '.origingame', 'projects.json'))
    platform.state.script = scriptFor('plain-html')
    const m = mark()
    const again = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--no-source', '--aigcc', '--host', platform.origin], { home })
    const run = since(m)
    assert.equal(again.code, 0, again.stderr)
    assert.equal(again.result.action, 'updated')
    assert.equal(again.result.gameId, first.result.gameId)
    assert.equal(run.deploys.at(-1).method, 'PUT')
    assert.deepEqual(platform.state.aigcc.submissions.map(s => s.version), [1, 2])
  })

  test('a refused submission keeps the publication and reports how to retry', async () => {
    reset(TEAM)
    platform.state.aigcc.refuseBind = true
    platform.state.script = scriptFor('plain-html')
    const cli = await runCli(['deploy', '--dir', copyFixture('plain-html'), '--json', '--no-source', '--aigcc', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.ok, true)
    assert.equal(cli.result.aigcc.submitted, false)
    assert.match(cli.result.aigcc.reason, /outside submission window/)
    assert.ok(cli.result.warnings.some(w => w.code === 'aigcc.failed' && /--aigcc again/.test(w.message)))
    assert.equal(platform.state.aigcc.submissions.length, 0)
    reset()
  })

  test('--aigcc is refused in sandbox mode', async () => {
    const cli = await runCli(['deploy', '--json', '--aigcc', '--credentials-file', '/nonexistent', '--source-checkpoint', 'ckpt_x'], { home: tempDir('home') })
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'invalid_arguments')
  })
})

/** A Unity Hub install of `version` under `home` (Linux layout), whose editor is test/fake-unity.mjs. */
function hubEditor(home, { version = '2022.3.10f1', webgl = true } = {}) {
  const editor = path.join(home, 'Unity', 'Hub', 'Editor', version, 'Editor')
  fs.mkdirSync(editor, { recursive: true })
  fs.writeFileSync(path.join(editor, 'Unity'), `#!/bin/sh\nFAKE_UNITY_VERSION=${version} exec "${process.execPath}" "${path.join(ROOT, 'test', 'fake-unity.mjs')}" "$@"\n`, { mode: 0o755 })
  if (webgl) fs.mkdirSync(path.join(editor, 'Data', 'PlaybackEngines', 'WebGLSupport'), { recursive: true })
  return path.join(editor, 'Unity')
}
const records = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const sha = buffer => sha256(buffer)
const fixtureBytes = (name, file) => fs.readFileSync(path.join(ROOT, 'fixtures', name, file))
const inputOf = (run, task) => JSON.parse(run.chat.find(c => taskOf(c) === task).body.messages[1].content.split('INPUT:\n')[1])

describe('Unity', () => {
  test('a Decompression Fallback build (.unityweb) is published unchanged, not declared precompressed, with a warning', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-webgl')
    for (const name of ['Lantern.data', 'Lantern.framework.js', 'Lantern.wasm']) fs.renameSync(path.join(project, 'Build', `${name}.br`), path.join(project, 'Build', `${name}.unityweb`))
    const page = path.join(project, 'index.html')
    fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replaceAll('.br"', '.unityweb"'))
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.fields.engine, 'unity')
    assert.deepEqual(JSON.parse(deploy.files['origingame.runtime.json'].toString()), { version: 1, crossOriginIsolated: true }, 'threads found in the .unityweb wasm; nothing for the server to decode')
    assert.equal(sha(deploy.files['Build/Lantern.wasm.unityweb']), sha(fs.readFileSync(path.join(project, 'Build', 'Lantern.wasm.unityweb'))))
    assert.match(deploy.files['index.html'].toString(), /codeUrl: buildUrl \+ "\/Lantern\.wasm\.unityweb"/)
    assert.ok(cli.result.warnings.some(w => w.code === 'unity.decompression_fallback'), JSON.stringify(cli.result.warnings))
    assert.equal(inputOf(run, 'analyze').digest.findings.unity.compression, 'fallback')
  })

  test('a Brotli, multithreaded WebGL build with the PWA template: precompressed and isolated, worker off, canvas fills, binaries untouched, no wiring', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-webgl')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    const run = since(m)
    fixtureReport('unity-webgl', cli, run, beforeHash, treeHash(project))
    assert.equal(cli.code, 0, cli.stderr)
    const r = cli.result
    assert.equal(r.engine, 'unity')
    assert.deepEqual(r.family, { id: 'unity', label: 'Unity' })
    assert.equal(treeHash(project), beforeHash, 'project directory is byte-identical')
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.fields.engine, 'unity', 'Portal receives its unity catalog engine')
    assert.deepEqual(JSON.parse(deploy.files['origingame.runtime.json'].toString()), { version: 1, crossOriginIsolated: true, precompressed: true })
    for (const binary of ['Build/Lantern.loader.js', 'Build/Lantern.data.br', 'Build/Lantern.framework.js.br', 'Build/Lantern.wasm.br', 'TemplateData/favicon.ico', 'StreamingAssets/levels.json']) {
      assert.equal(sha(deploy.files[binary]), sha(fixtureBytes('unity-webgl', binary)), `${binary} is published unchanged`)
    }
    assert.equal(deploy.files['ServiceWorker.js'], undefined, 'the PWA service worker is not published')
    assert.equal(deploy.files['manifest.webmanifest'], undefined)
    const html = deploy.files['index.html'].toString()
    assert.doesNotMatch(html, /serviceWorker\.register/)
    assert.doesNotMatch(html, /rel="manifest"/)
    assert.match(html, /canvas\.style\.width = "100%";/)
    assert.match(html, /dataUrl: buildUrl \+ "\/Lantern\.data\.br",\n\s*frameworkUrl: buildUrl \+ "\/Lantern\.framework\.js\.br",\n\s*codeUrl: buildUrl \+ "\/Lantern\.wasm\.br",/, 'the loader config is intact')
    assert.match(deploy.files['TemplateData/style.css'].toString(), /#unity-footer \{ display: none \}/)
    assert.ok(r.warnings.some(w => w.code === 'adapt.skipped' && /Build\/Lantern\.loader\.js/.test(w.message)), 'an edit of the Unity loader is refused')
    assert.equal(r.integration.applied, false)
    assert.match(r.integration.reason, /Unity build is generated by the engine/)
    assert.ok(!run.chat.some(c => taskOf(c) === 'integrate'), 'no integration model call')
    // What the analysis was told: the compressed wasm was read for shared memory, and the Unity facts.
    const digest = inputOf(run, 'analyze').digest
    assert.deepEqual(digest.project.family, 'Unity')
    assert.ok(digest.findings.threadReasons.includes('shared-memory:Build/Lantern.wasm.br'), digest.findings.threadReasons.join(','))
    assert.equal(digest.findings.unity.compression, 'brotli')
    assert.deepEqual(digest.findings.unity.fixedCanvas, { width: 960, height: 600 })
    assert.deepEqual(digest.findings.planned.map(p => p.id).sort(), ['isolation', 'precompressed', 'unity-canvas', 'unity-service-worker'])
    assert.equal(deploy.fields.orientation, 'landscape')
    assert.equal(run.sessions[0].revoked, true)
  })

  test('an uncompressed build over the served per-file limit is Brotli-compressed for publishing: loader config repointed, precompressed declared, bytes round-trip', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-webgl-raw')
    // 12 MiB of data that compresses well, as Unity asset data mostly does, against a served 8 MiB per-file limit.
    const block = randomBytes(64 * 1024)
    const data = Buffer.concat(Array.from({ length: 192 }, (_, i) => Buffer.concat([block.subarray(0, 4096), Buffer.from(`asset-${i}`.padEnd(60 * 1024, '.'))])))
    fs.writeFileSync(path.join(project, 'Build', 'Orchard.data'), data)
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await withRules(limits({ maxFileBytes: 8 * MiB, maxTotalBytes: 64 * MiB }), () => runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN), timeoutMs: 240_000 }))
    const run = since(m)
    fixtureReport('unity-webgl-raw-packed', cli, run, beforeHash, treeHash(project))
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(treeHash(project), beforeHash, 'the project keeps its uncompressed build')
    const deploy = run.deploys.at(-1)
    const names = Object.keys(deploy.files).filter(n => n.startsWith('Build/')).sort()
    assert.deepEqual(names, ['Build/Orchard.data.br', 'Build/Orchard.framework.js.br', 'Build/Orchard.loader.js', 'Build/Orchard.wasm.br'])
    assert.ok(Object.values(deploy.files).every(b => b.length <= 8 * MiB))
    assert.match(cli.stderr, /Build\/Orchard\.data is 12\.\d MiB; OriginGame accepts 8 MiB per file, 64 MiB in total/, 'the message names the served limits')
    assert.equal(sha(zlib.brotliDecompressSync(deploy.files['Build/Orchard.data.br'])), sha(data), 'the packed data decompresses to the original')
    assert.equal(sha(zlib.brotliDecompressSync(deploy.files['Build/Orchard.wasm.br'])), sha(fixtureBytes('unity-webgl-raw', 'Build/Orchard.wasm')))
    assert.equal(sha(deploy.files['Build/Orchard.loader.js']), sha(fixtureBytes('unity-webgl-raw', 'Build/Orchard.loader.js')), 'the loader itself stays plain')
    const html = deploy.files['index.html'].toString()
    assert.match(html, /dataUrl: buildUrl \+ "\/Orchard\.data\.br",/)
    assert.match(html, /frameworkUrl: buildUrl \+ "\/Orchard\.framework\.js\.br",/)
    assert.match(html, /codeUrl: buildUrl \+ "\/Orchard\.wasm\.br",/)
    assert.match(html, /canvas\.style\.width = "100%";/, 'the canvas adaptation is still there')
    assert.deepEqual(JSON.parse(deploy.files['origingame.runtime.json'].toString()), { version: 1, precompressed: true }, 'single-threaded: no isolation')
    assert.ok(cli.result.warnings.some(w => w.code === 'unity.compressed' && /Compression Format to Brotli/.test(w.message)))
  })

  test('a build that is too large even compressed fails with Unity advice before any model call', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-webgl')
    fs.writeFileSync(path.join(project, 'StreamingAssets', 'intro.mp4'), randomBytes(9 * MiB))
    const m = mark()
    const cli = await withRules(limits({ maxFileBytes: 8 * MiB, maxTotalBytes: 64 * MiB }), () => runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) }))
    const run = since(m)
    report.scenarios.unityTooLarge = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'upload_failed')
    assert.match(cli.result.error.message, /StreamingAssets\/intro\.mp4 is 9\.0 MiB; OriginGame accepts files up to 8 MiB/)
    assert.match(cli.result.error.message, /OriginGame accepts files up to 8 MiB and 64 MiB in total\.$/, 'the Unity advice names the served limits')
    assert.match(cli.result.error.message, /texture import settings/)
    assert.match(cli.result.error.message, /Addressables/)
    assert.equal(run.chat.length, 0, 'no model spend')
    assert.equal(run.deploys.length, 0)
  })

  test('a Unity project is built for WebGL by the local editor in batch mode, in a scratch copy with the build script, reusing the import cache', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-project')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    hubEditor(home, { version: '2021.3.40f1' })
    hubEditor(home)
    const record = path.join(tempDir('unity-record'), 'runs.jsonl')
    const env = { FAKE_UNITY_RECORD: record, FAKE_UNITY_OUTPUT: path.join(ROOT, 'fixtures', 'unity-webgl-raw') }
    // A real Library/ holds far more files than a source upload may (5,000): it must never count as source.
    for (let i = 0; i < 5001; i++) {
      const dir = path.join(project, 'Library', 'ShaderCache', String(i % 50))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${i}.bin`), String(i))
    }
    const beforeHash = treeHash(project)
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home, env })
    const run = since(m)
    fixtureReport('unity-project', cli, run, beforeHash, treeHash(project))
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(treeHash(project), beforeHash, 'the project (and its Library/) is byte-identical')
    const [first] = records(record)
    const stage = path.join(home, '.origingame', 'stage')
    // The exact batch-mode command line, on a scratch copy that is neither the project nor the workspace.
    const value = flag => first.argv[first.argv.indexOf(flag) + 1]
    assert.deepEqual(first.argv, ['-batchmode', '-nographics', '-quit', '-projectPath', value('-projectPath'), '-buildTarget', 'WebGL', '-executeMethod', 'OriginGameWizardBuild.BuildWebGL', '-logFile', value('-logFile'), '-originGameOutput', value('-originGameOutput')])
    assert.ok(value('-projectPath').startsWith(stage) && path.basename(value('-projectPath')) === 'unity-project', value('-projectPath'))
    assert.ok(value('-logFile').startsWith(stage) && value('-originGameOutput').startsWith(stage))
    assert.match(first.buildScript, /BuildPipeline\.BuildPlayer/)
    assert.match(first.buildScript, /EditorBuildSettings\.scenes\.Where\(s => s\.enabled/)
    assert.match(first.buildScript, /BuildTarget\.WebGL/)
    assert.equal(first.asmdef, true)
    assert.deepEqual(first.library, ['ArtifactDB', 'ShaderCache'], 'the first build starts from the project\'s own Library/')
    assert.ok(!first.topLevel.includes('Temp') && !first.topLevel.includes('Logs'), first.topLevel.join(','))
    assert.ok(!fs.existsSync(path.join(project, 'Assets', 'OriginGameWizard')), 'the build script never lands in the project')
    assert.equal(first.editorVersion, '2022.3.10f1', 'the Hub editor of the project\'s exact version runs, not another installed one')
    const r = cli.result
    assert.equal(r.engine, 'unity')
    assert.equal(run.deploys.at(-1).fields.engine, 'unity')
    const deploy = run.deploys.at(-1)
    assert.equal(sha(deploy.files['Build/Orchard.wasm']), sha(fixtureBytes('unity-webgl-raw', 'Build/Orchard.wasm')), 'the editor\'s output is what is published')
    assert.match(deploy.files['index.html'].toString(), /canvas\.style\.width = "100%";/)
    assert.equal(r.integration.applied, false)
    // The C# source is analyzed (not .meta files or the caches), and the saved source leaves the caches out.
    const digest = inputOf(run, 'analyze').digest
    assert.ok(digest.source_files.some(f => f.path === 'Assets/Scripts/PlayerController.cs'))
    assert.ok(!digest.source_files.some(f => /\.meta$|^Library\/|^Temp\//.test(f.path)), digest.source_files.map(f => f.path).join(','))
    assert.equal(digest.project.unity.version, '2022.3.10f1')
    const tree = [...platform.state.agent.commits.get(r.source.commit).tree.keys()]
    assert.ok(tree.includes('Assets/Scripts/PlayerController.cs') && tree.includes('ProjectSettings/ProjectVersion.txt'), tree.join(','))
    assert.ok(!tree.some(p => /^(Library|Temp|Logs)\//.test(p)), tree.join(','))

    // A second run brings the import cache back instead of copying Library/ again.
    const again = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin, '--no-source'], { home, env })
    assert.equal(again.code, 0, again.stderr)
    const second = records(record)[1]
    assert.equal(second.libraryMarker, 'built\n', 'the cache from the first build is in the scratch copy')
    assert.equal(treeHash(project), beforeHash)
  })

  test('without a matching editor or its WebGL module the run stops before any model call with the Unity Hub steps; an existing WebGL build is published instead', async () => {
    platform.state.script = scriptFor('unity')
    const project = copyFixture('unity-project')
    let home = signedInHome(platform.origin, DEVICE_TOKEN)
    hubEditor(home, { version: '6000.0.23f1' })
    let m = mark()
    let cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    let run = since(m)
    report.scenarios.unityNoEditor = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'build_failed')
    for (const expected of [/Unity 2022\.3\.10f1 is not installed \(Unity Hub has 6000\.0\.23f1\)/, /Installs > Install Editor > Archive/, /unityhub:\/\/2022\.3\.10f1\/ff3792e53c62/, /Web Build Support/, /UNITY=\/path\/to\/Unity/]) assert.match(cli.result.error.message, expected)
    assert.equal(run.chat.length, 0)
    assert.equal(run.sessions[0].revoked, true)

    home = signedInHome(platform.origin, DEVICE_TOKEN)
    hubEditor(home, { webgl: false })
    cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    report.scenarios.unityNoWebgl = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.result.error.code, 'build_failed')
    assert.match(cli.result.error.message, /has no WebGL Build Support module/)
    assert.match(cli.result.error.message, /Installs > 2022\.3\.10f1 > the gear \(Manage\) > Add modules/)

    home = signedInHome(platform.origin, DEVICE_TOKEN)
    hubEditor(home)
    cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home, env: { FAKE_UNITY_MODE: 'license', FAKE_UNITY_RECORD: path.join(tempDir('rec'), 'r.jsonl') } })
    assert.equal(cli.result.error.code, 'build_failed')
    assert.match(cli.result.error.message, /activated license/)

    // No editor, but a WebGL build in the tree: that build is published, with a warning.
    fs.cpSync(path.join(ROOT, 'fixtures', 'unity-webgl'), path.join(project, 'Builds', 'WebGL'), { recursive: true })
    home = signedInHome(platform.origin, DEVICE_TOKEN)
    m = mark()
    cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin], { home })
    run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    assert.ok(cli.result.warnings.some(w => w.code === 'build.note' && /existing WebGL build in Builds\/WebGL\//.test(w.message)), JSON.stringify(cli.result.warnings))
    assert.equal(sha(run.deploys.at(-1).files['Build/Lantern.wasm.br']), sha(fixtureBytes('unity-webgl', 'Build/Lantern.wasm.br')))
  })

  test('a Windows build beside its Unity project is traced back to the project and built for the Web; --prebuilt of it too', async () => {
    platform.state.script = scriptFor('unity')
    const root = copyFixture('unity-native')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    hubEditor(home)
    const record = path.join(tempDir('unity-record'), 'runs.jsonl')
    const env = { FAKE_UNITY_RECORD: record, FAKE_UNITY_OUTPUT: path.join(ROOT, 'fixtures', 'unity-webgl-raw') }
    const beforeHash = treeHash(root)
    let m = mark()
    let cli = await runCli(['deploy', '--dir', path.join(root, 'Windows'), '--yes', '--json', '--host', platform.origin, '--no-source'], { home, env })
    let run = since(m)
    report.scenarios.unityNative = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.code, 0, cli.stderr)
    assert.match(cli.stderr, /windows build \(unity\): Orchard Run\.exe; OriginGame publishes Web builds, so the Unity project it came from \(.*Project\) is built for the Web instead/)
    assert.equal(cli.result.engine, 'unity')
    assert.equal(records(record).length, 1, 'the editor ran once, on the project')
    assert.ok(!Object.keys(run.deploys.at(-1).files).some(f => /\.exe$|\.dll$|_Data\//.test(f)), 'nothing of the Windows build is uploaded')
    assert.equal(treeHash(root), beforeHash)

    m = mark()
    cli = await runCli(['deploy', '--dir', root, '--prebuilt', path.join(root, 'Windows'), '--yes', '--json', '--host', platform.origin, '--no-source'], { home, env })
    assert.equal(cli.code, 0, cli.stderr)
    assert.match(cli.stderr, /--prebuilt .*Windows: windows build \(unity\)/)
    assert.equal(records(record).length, 2)
  })

  test('a Windows build with no project near it fails before sign-in spend with what to do in Unity', async () => {
    const lone = path.join(tempDir('lone'), 'Orchard Run Windows')
    fs.cpSync(path.join(ROOT, 'fixtures', 'unity-native', 'Windows'), lone, { recursive: true })
    const m = mark()
    const cli = await runCli(['deploy', '--dir', lone, '--yes', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    report.scenarios.unityNativeAlone = { exitCode: cli.code, result: cli.result }
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'detect_failed')
    const message = cli.result.error.message
    assert.match(message, /holds a Windows build of a Unity game \(Orchard Run\.exe\)\./)
    assert.match(message, /OriginGame publishes Web builds only, so an \.exe cannot be uploaded\./)
    assert.match(message, /No Unity project was found near it/)
    assert.match(message, /File > Build Settings > WebGL/)
    assert.match(message, /run npx origingame in the Unity project folder \(the one with Assets\/ and ProjectSettings\/\)/)
    assert.equal(run.sessions.length, 0, 'no session was issued')
    assert.equal(run.deploys.length, 0)
  })
})

describe('other engines', () => {
  test('a Construct 3 export one folder down is published from its own root as engine html, labeled, without wiring', async () => {
    platform.state.script = scriptFor('construct')
    const project = copyFixture('engines/construct3')
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--yes', '--json', '--host', platform.origin, '--no-source'], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.engine, 'html')
    assert.deepEqual(cli.result.family, { id: 'construct3', label: 'Construct 3' })
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.fields.engine, 'html')
    assert.deepEqual(Object.keys(deploy.files).sort(), ['data.json', 'index.html', 'scripts/c3runtime.js', 'scripts/main.js', 'sw.js'])
    assert.match(cli.result.integration.reason, /Construct 3 export is generated by the engine/)
    assert.match(cli.stderr, /Construct 3 Web export in exports\/web/)
  })
})
