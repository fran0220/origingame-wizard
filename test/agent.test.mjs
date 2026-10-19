// The 0.6 publishing loop end to end: the built CLI against the fake platform,
// with a scripted model that answers each turn with tool calls. Each test
// asserts what reached the platform (uploads, publications, AIGCC), what the
// model was shown, and that the person's folder is unchanged.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DEVICE_TOKEN, startPlatform } from './fake-platform.mjs'
import { ROOT, cleanTemp, copyFixture, runCli, signedInHome, tempDir, treeHash, treeHashExcept } from './helpers.mjs'

let platform
before(async () => { platform = await startPlatform({ rulesDir: path.join(ROOT, 'test', 'rules') }) })
after(async () => { await platform?.close(); cleanTemp() })

const LISTING = { title: 'Star Catcher', genre: 'arcade', tagline: 'Catch the stars.', description: 'Move the basket and catch falling stars.', controls: 'Arrow keys', tags: ['retro'], languages: ['en'], orientation: 'landscape', input_hints: ['keyboard'] }
const ARTWORK = () => ({ cover: ['a night sky with falling stars'], poster: ['a basket under falling stars'] })

/** A scripted agent: `steps[i]` answers turn i+1 (a function gets the conversation); the tool results it saw are kept. */
function agent(steps) {
  const seen = []
  platform.state.script = ({ task }) => (task === 'artwork' ? ARTWORK() : (() => { throw new Error(`unexpected task ${task}`) })())
  platform.state.agentScript = ({ turn, messages }) => {
    seen.push(...messages.filter(m => m.role === 'tool').slice(seen.length ? -1 : 0).map(m => m.content))
    const step = steps[turn - 1]
    if (!step) return { calls: [{ name: 'give_up', args: { reason: 'script ended' } }] }
    return typeof step === 'function' ? step(messages) : step
  }
  return seen
}
const call = (name, args = {}) => ({ calls: [{ name, args }] })
const lastTool = messages => messages.filter(m => m.role === 'tool').at(-1)?.content ?? ''

function mark() {
  const s = platform.state
  return { requests: s.requests.length, chat: s.chat.length, deploys: s.deploys.length, sessions: s.sessions.size, images: s.images.length }
}
function since(m) {
  const s = platform.state
  return { requests: s.requests.slice(m.requests), chat: s.chat.slice(m.chat), deploys: s.deploys.slice(m.deploys), sessions: [...s.sessions.values()].slice(m.sessions), images: s.images.slice(m.images) }
}
const deployArgs = (project, extra = []) => ['deploy', '--dir', project, '--json', '--no-source', '--host', platform.origin, ...extra]

describe('the publishing loop', () => {
  test('a refusal and a failed readiness check are observations: the agent fixes the copy and publishes again', async () => {
    const project = copyFixture('plain-html')
    platform.state.readinessSequence = [{ status: 'failed', failure: { code: 'resource_404', message: '/style.css and /game.js were not found' } }]
    platform.state.rulesPatch = { limits: { portal: { maxFiles: 20000, maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxImageBytes: 5242880 } } }
    fs.writeFileSync(path.join(project, 'trailer.mp4'), Buffer.alloc(2 * 1024 * 1024, 1))
    const before = treeHash(project)
    let sawRefusal = ''
    let sawReadiness = ''
    let sawEnv = ''
    let sawPreview = ''
    agent([
      call('list_files', { path: '.' }),
      call('read_file', { path: 'analytics.js' }),
      call('publish', { dir: '.', engine: 'html', ...LISTING }),
      messages => { sawRefusal = lastTool(messages); return call('delete_path', { path: 'trailer.mp4' }) },
      call('publish', { dir: '.', engine: 'html', ...LISTING }),
      messages => { sawReadiness = lastTool(messages); return call('preview', { dir: '.', wait_seconds: 2 }) },
      messages => { sawPreview = lastTool(messages); return call('edit_file', { path: 'index.html', old_text: 'href="/style.css"', new_text: 'href="style.css"' }) },
      call('edit_file', { path: 'index.html', old_text: 'src="/game.js"', new_text: 'src="game.js"' }),
      call('run', { command: 'node -e "console.log(\'key:\' + (process.env.OG_API_KEY || \'none\'))"' }),
      messages => { sawEnv = lastTool(messages); return call('publish', { dir: '.', engine: 'html' }) },
      call('finish', { summary: 'Made the page paths relative and left the trailer out.' }),
    ])
    const m = mark()
    const cli = await runCli(deployArgs(project), { home: signedInHome(platform.origin, DEVICE_TOKEN), env: { OG_API_KEY: DEVICE_TOKEN } })
    const run = since(m)
    platform.state.rulesPatch = null
    platform.state.readinessSequence = null
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.ok, true)

    // Portal's refusal came back to the model as it was, and the over-limit file was then left out.
    assert.match(sawRefusal, /trailer\.mp4/)
    assert.match(sawReadiness, /readiness check reports "failed"/)
    assert.match(sawReadiness, /resource_404/)
    assert.match(sawPreview, /style\.css \(outside the release folder/)
    assert.match(sawEnv, /exit code 0/)
    assert.match(sawEnv, /key:none/, 'commands never get the account credential')

    // Two publications of the same game: created, then updated with the fixed page.
    assert.equal(run.deploys.length, 2)
    const [created, updated] = run.deploys
    assert.equal(created.method, 'POST')
    assert.equal(created.fields.title, 'Star Catcher')
    assert.equal(created.fields.engine, 'html')
    assert.ok(created.images.cover && created.images.poster, 'a new game gets a cover and a poster')
    assert.equal(updated.method, 'PUT')
    assert.equal(updated.path, `/api/deploy/${cli.result.gameId}`)
    assert.match(updated.files['index.html'].toString(), /href="style\.css"/)
    assert.match(updated.files['index.html'].toString(), /src="game\.js"/)
    assert.equal(updated.files['trailer.mp4'], undefined)
    assert.equal(updated.files.id_ed25519, undefined, 'credential files are never uploaded')
    assert.equal(cli.result.version, 2)
    assert.equal(cli.result.action, 'created')
    assert.equal(cli.result.readiness.status, 'ready')
    assert.match(cli.result.summary, /relative/)

    // The model never saw a credential, and the person's folder is unchanged.
    const sent = JSON.stringify(run.chat.map(c => c.body.messages))
    assert.doesNotMatch(sent, /AKIAIOSFODNN7EXAMPLE/)
    assert.doesNotMatch(sent, /fixture-not-a-real-key/)
    assert.doesNotMatch(sent, new RegExp(DEVICE_TOKEN))
    assert.match(sent, /line withheld: it looks like a credential/)
    assert.equal(treeHash(project), before)
    assert.equal(fs.readFileSync(path.join(cli.result.workspace.path, 'index.html'), 'utf8').includes('href="style.css"'), true)
    assert.equal(run.sessions.at(-1).revoked, true)
  })

  test('a Git project: the changes are a commit on origingame/publish, the checkout is untouched', async () => {
    const project = copyFixture('plain-html')
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: project, encoding: 'utf8' })
    fs.rmSync(path.join(project, 'id_ed25519'))
    fs.rmSync(path.join(project, 'analytics.js'))
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'fixture')
    const head = git('rev-parse', 'HEAD').trim()
    const before = treeHashExcept(project, '.git')
    agent([
      call('edit_file', { path: 'index.html', old_text: '<script src="analytics.js"></script>\n', new_text: '' }),
      call('edit_file', { path: 'index.html', old_text: '/game.js', new_text: 'game.js' }),
      call('edit_file', { path: 'index.html', old_text: '/style.css', new_text: 'style.css' }),
      call('publish', { dir: '.', engine: 'html', ...LISTING }),
      call('finish', { summary: 'Relative paths.' }),
    ])
    const cli = await runCli(deployArgs(project), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.workspace.kind, 'worktree')
    assert.equal(cli.result.workspace.commits.length, 1)
    assert.match(git('show', 'origingame/publish:index.html'), /src="game\.js"/)
    assert.equal(git('rev-parse', 'HEAD').trim(), head)
    assert.equal(git('status', '--porcelain'), '')
    assert.equal(treeHashExcept(project, '.git'), before)
  })

  test('give_up without a publication fails with the reason; nothing is published and the session ends', async () => {
    const project = copyFixture('plain-html')
    agent([call('give_up', { reason: 'this is a Windows build; export it for the Web' })])
    const m = mark()
    const cli = await runCli(deployArgs(project), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    const run = since(m)
    assert.equal(cli.code, 1)
    assert.equal(cli.result.ok, false)
    assert.equal(cli.result.error.code, 'agent_stopped')
    assert.match(cli.result.error.message, /export it for the Web/)
    assert.equal(run.deploys.length, 0)
    assert.equal(run.sessions.at(-1).revoked, true)
  })

  test('finish before anything is published is refused, and the loop goes on', async () => {
    const project = copyFixture('plain-html')
    let refusal = ''
    agent([
      call('finish', { summary: 'done' }),
      messages => { refusal = messages.at(-1).content; return call('publish', { dir: '.', engine: 'html', ...LISTING }) },
      call('finish', { summary: 'published' }),
    ])
    const cli = await runCli(deployArgs(project), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.equal(cli.code, 0, cli.stderr)
    assert.match(refusal, /Nothing is published yet/)
  })

  test('paths outside the workspace are refused', async () => {
    const project = copyFixture('plain-html')
    const outside = path.join(tempDir('outside'), 'secret.txt')
    fs.writeFileSync(outside, 'outside content')
    let answer = ''
    agent([
      call('read_file', { path: outside }),
      messages => { answer = lastTool(messages); return call('give_up', { reason: 'test' }) },
    ])
    await runCli(deployArgs(project), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    assert.match(answer, /outside the workspace/)
  })
})

describe('sandbox mode', () => {
  test('publishes with the delegation, the repository header and the source checkpoint; the credentials file is deleted', async () => {
    const project = copyFixture('origin-engine-dist')
    const session = platform.sandboxSession()
    const file = path.join(tempDir('sandbox'), 'creds.json')
    fs.writeFileSync(file, JSON.stringify({ host: platform.origin, session, publish: { token: 'ogd-publish-fixture-0123456789abcdef', repository_id: 'repo_fixture_1' } }), { mode: 0o600 })
    agent([
      call('publish', { dir: '.', engine: 'origin-engine', ...LISTING }),
      call('finish', { summary: 'Published the og build as it is.' }),
    ])
    const m = mark()
    const cli = await runCli(['deploy', '--dir', project, '--prebuilt', project, '--yes', '--json', '--credentials-file', file, '--source-checkpoint', 'ckpt_fixture_7'], { home: tempDir('home') })
    const run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(fs.existsSync(file), false)
    const deploy = run.deploys.at(-1)
    assert.equal(deploy.authorization, 'Bearer ogd-publish-fixture-0123456789abcdef')
    assert.equal(deploy.repository, 'repo_fixture_1')
    assert.equal(deploy.fields.source_checkpoint, 'ckpt_fixture_7')
    assert.equal(deploy.fields.engine, 'origin-engine')
    // An og build is published as og wrote it: its service worker, manifest and hidden cook manifest included.
    for (const f of ['sw.js', 'manifest.webmanifest', 'cooked/.cook.ogt']) assert.ok(deploy.files[f], `${f} uploaded`)
    assert.equal(run.requests.filter(q => q.path === '/identity/v1/wizard/sessions').length, 0)
  })
})

describe('AIGCC finals (--aigcc)', () => {
  const TEAM = { id: 'aigcc-fixture', teamName: 'Flower Team', projectTitle: 'Playable Garden', track: 'culture', stage: 'finalist', captain: false }
  test('a finalist\'s published release is submitted exactly; a team outside the finals is refused before any model call', async () => {
    Object.assign(platform.state.aigcc, { team: null, open: true, refuseBind: false, submissions: [] })
    agent([call('give_up', { reason: 'unreachable' })])
    let m = mark()
    let cli = await runCli(deployArgs(copyFixture('plain-html'), ['--aigcc']), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    let run = since(m)
    assert.equal(cli.result.error.code, 'aigcc_refused')
    assert.equal(run.chat.length + run.deploys.length, 0)

    Object.assign(platform.state.aigcc, { team: TEAM })
    agent([call('publish', { dir: '.', engine: 'html', ...LISTING }), call('finish', { summary: 'ok' })])
    m = mark()
    cli = await runCli(deployArgs(copyFixture('plain-html'), ['--aigcc']), { home: signedInHome(platform.origin, DEVICE_TOKEN) })
    run = since(m)
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.result.aigcc.submitted, true)
    assert.deepEqual(platform.state.aigcc.submissions.at(-1), { gameId: cli.result.gameId, releaseId: cli.result.releaseId, version: 1 })
    platform.state.aigcc.team = null
  })
})
