// End-to-end: the built CLI (dist/cli.js) runs as a subprocess against a fake
// platform that implements the Wizard contracts. Every assertion is on what the
// CLI observably did: its JSON result and exit code, the requests and bytes the
// platform received, and the state of the project and ~/.origingame afterwards.
// The run ends by writing test-artifacts/e2e-report.json (+ the chosen artwork).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { ACCOUNT, DEVICE_TOKEN, MODELS, imageDims, portalAccepts, startPlatform } from './fake-platform.mjs'
import { ROOT, cleanTemp, copyFixture, runCli, sha256, signedInHome, tempDir, treeHash } from './helpers.mjs'

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

function scriptFor(name) {
  return ({ task, attempt }) => {
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
          { path: 'index.html', find: '  <script src="/game.js"></script>', replace: '  <script src="og-player.js"></script>\n  <script src="/game.js"></script>' },
        ],
        new_files: [{ path: 'og-player.js', content: '// og-player.js (fixture)\nwindow.OriginPlayer = { call: () => Promise.reject(new Error(\'no player\')), ready() {} }\n' }],
        methods: ['leaderboard.submit'],
      }
    }
    if (name === 'integrate' && task === 'analyze') return { summary: 'Star Catcher with scores wired.', orientation: 'landscape', items: [] }
    if (task === 'analyze') return { summary: 'A game.', orientation: 'any', items: [] }
    if (task === 'adapt') return { edits: [] }
    throw new Error(`unscripted task ${task}`)
  }
}

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
    assert.equal(r.source, null)
    assert.equal(run.requests.filter(q => q.path.startsWith('/v1/repositories') || q.path.startsWith('/v1/memberships') || q.path.startsWith('/v1/checkpoints') || q.path.startsWith('/git/')).length, 0, 'without --with-source nothing reaches Agent Service')

    const deploy = run.deploys.at(-1)
    assert.equal(deploy.method, 'POST')
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
    assert.deepEqual(run.images.map(i => i.size).sort(), ['1140x1472', '1140x1472', '1664x928', '1664x928', '1664x928'])
    assert.equal(run.sessions.length, 1)
    assert.equal(run.sessions[0].revoked, true, 'session revoked at the end')
    assert.equal(run.sessions[0].request.client_version.length > 0, true)
    const projects = JSON.parse(fs.readFileSync(path.join(home, '.origingame', 'projects.json'), 'utf8'))
    assert.deepEqual(Object.values(projects), [{ gameId: r.gameId, slug: r.slug, host: platform.origin }])

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

  test('a build Portal would refuse fails with upload_failed before any model call', async () => {
    platform.state.script = scriptFor('plain-html')
    const project = copyFixture('plain-html')
    fs.writeFileSync(path.join(project, 'assets', 'huge.bin'), Buffer.alloc(51 * 1024 * 1024))
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    report.scenarios.overLimit = { exitCode: cli.code, result: cli.result, chatCalls: run.chat.length }
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'upload_failed')
    assert.match(cli.result.error.message, /assets\/huge\.bin/)
    assert.equal(run.chat.length, 0, 'no model spend')
    assert.equal(run.sessions[0].revoked, true)
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

describe('--integrate', () => {
  function gitProject() {
    const project = copyFixture('plain-html')
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString()
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    return { project, git }
  }

  test('writes only the approved source edits, then publishes the integrated build', async () => {
    platform.state.script = scriptFor('integrate')
    const { project, git } = gitProject()
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--integrate', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    report.scenarios.integrate = { exitCode: cli.code, adaptations: cli.result?.adaptations, changed: git('status', '--porcelain').split('\n').filter(Boolean) }
    assert.equal(cli.code, 0, cli.stderr)
    assert.deepEqual(git('status', '--porcelain').split('\n').filter(Boolean).sort(), [' M game.js', ' M index.html', '?? og-player.js'])
    assert.match(fs.readFileSync(path.join(project, 'game.js'), 'utf8'), /leaderboard\.submit/)
    const deploy = run.deploys.at(-1)
    assert.ok(deploy.files['og-player.js'])
    assert.match(deploy.files['index.html'].toString(), /<script src="og-player\.js"><\/script>\n {2}<script src="game\.js"><\/script>/)
    assert.ok(run.chat.filter(c => taskOf(c) === 'integrate').every(c => c.model === 'deepseek-v4-pro'))
    assert.equal(run.sessions[0].revoked, true)
  })

  test('with --yes and uncommitted changes it refuses to edit the source', async () => {
    platform.state.script = scriptFor('integrate')
    const { project } = gitProject()
    fs.appendFileSync(path.join(project, 'README.md'), '\nlocal change\n')
    const beforeHash = treeHash(project)
    const cli = await runCli(['deploy', '--dir', project, '--integrate', '--json', '--host', platform.origin], { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'adapt_failed')
    assert.equal(treeHash(project), beforeHash)
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
    for (const file of expected.filter(f => !['.gitattributes', '.origin/wizard-source.json', 'assets/music.ogg'].includes(f))) {
      assert.equal(sha256(tree.get(file)), sha256(fs.readFileSync(path.join(project, file))), `${file} is committed byte for byte`)
    }
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
    assert.equal(tree2.get('game.js').toString(), fs.readFileSync(path.join(project, 'game.js'), 'utf8'))
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

  test('--with-source with --source-checkpoint is invalid_arguments', async () => {
    const cli = await runCli(['deploy', '--json', '--with-source', '--source-checkpoint', 'ckpt_x', '--host', platform.origin], { home: tempDir('home') })
    assert.equal(cli.code, 1)
    assert.equal(cli.result.error.code, 'invalid_arguments')
  })
})
