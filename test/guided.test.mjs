// The guided run: `npx origingame` in a real terminal. Each test answers the
// prompts with keystrokes through a pseudo-terminal and asserts what the CLI
// then did on the (fake) platform: the source commits, the publication's
// fields, which game it updated, the project tree.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DEVICE_TOKEN, startPlatform } from './fake-platform.mjs'
import { KEY, ROOT, cleanTemp, copyFixture, runPty, signedInHome, treeHash, treeHashExcept } from './helpers.mjs'

const ARTIFACTS = path.join(ROOT, 'test-artifacts')
let platform
before(async () => { platform = await startPlatform({ rulesDir: path.join(ROOT, 'test', 'rules') }) })
after(async () => { await platform?.close(); cleanTemp() })

const LISTING = { title: 'Star Catcher', tagline: 'Catch the stars.', description: 'Star Catcher is a small web game.', genre: 'arcade', tags: ['retro'], controls: 'Arrow keys: move', languages: ['en'], input_hints: ['keyboard'], aspect: '16:9', art_direction: 'Flat vector night sky.' }
const ARTWORK = { cover: ['cover one, no text', 'cover two', 'cover three'], poster: ['poster one', 'poster two'] }
/** The model's answers; `wire` makes the integration answer real edits (on the adapted index.html and game.js). */
function script({ wire = false } = {}) {
  platform.state.script = ({ task }) => {
    if (task === 'integrate' && wire) {
      return {
        summary: 'Submits the final score when a run ends.',
        edits: [
          { path: 'game.js', find: '  state.over = true\n', replace: "  state.over = true\n  window.OriginPlayer?.call('leaderboard.submit', { score: state.score }).catch(() => {})\n" },
          { path: 'index.html', find: '  <script src="game.js"></script>', replace: '  <script src="og-player.js"></script>\n  <script src="game.js"></script>' },
        ],
        new_files: [{ path: 'og-player.js', content: '// og-player.js (fixture)\n' }],
        methods: ['leaderboard.submit'],
      }
    }
    if (task === 'metadata') return LISTING
    if (task === 'artwork') return ARTWORK
    if (task === 'analyze') return { summary: 'Star Catcher is a canvas arcade game.', orientation: 'landscape', items: [] }
    if (task === 'adapt') return { edits: [] }
    if (task === 'integrate') return { summary: 'Nothing to wire.', edits: [], new_files: [], methods: [] }
    throw new Error(`unscripted task ${task}`)
  }
}

function mark() {
  const s = platform.state
  return { requests: s.requests.length, deploys: s.deploys.length, images: s.images.length }
}
function since(m) {
  const s = platform.state
  return { requests: s.requests.slice(m.requests), deploys: s.deploys.slice(m.deploys), images: s.images.slice(m.images) }
}
const sourceCommits = run => run.requests.filter(q => q.method === 'POST' && /^\/v1\/repositories\/[^/]+\/commits$/.test(q.path)).length
const ownGames = () => [...platform.state.games.values()].filter(g => g.owner)
/** The questions the person answered, in order (clack draws an answered prompt as "◇  <message>" over "│  <answer>"). */
const asked = transcript => [...new Set([...transcript.matchAll(/◇ {2}([^\n─]+?) *\n│ {2}\S/g)].map(m => m[1].trim()))]

/** One prompt, answered: `expect` is matched against the terminal text after the previous answer. */
const ask = (expect, send = KEY.enter) => ({ expect, send })
const MANUAL = ask('How do you want to publish\\?', `${KEY.down}${KEY.enter}`)

/** Every Manual question of a run on plain-html in a fresh home, answered with its default unless overridden. */
function manualRun(answers = {}) {
  return [
    MANUAL,
    ask('Publish this project\\?'),
    ask('Sign in to OriginGame'),
    ask('Before anything is sent[\\s\\S]*Continue\\?'),
    ...(answers.target ?? (ownGames().length ? [ask('Which game is this\\?')] : [])),
    ask('Save your source to a private OriginGame repository\\?', answers.source ?? KEY.enter),
    ask('Wire leaderboards and cloud saves into the code\\?'),
    ask('Apply which adaptations\\?'),
    ask('Publish anyway\\?'),
    ...(answers.listing ?? [ask('Title'), ask('Genre'), ask('Keep this description')]),
    ...(answers.artwork ?? [ask('Open the artwork preview'), ask('Choose the cover'), ask('Choose the poster')]),
    ask('Who can find it\\?', answers.visibility ?? KEY.enter),
    ask('Ready to publish[\\s\\S]*Publish now\\?'),
    ask('Open the game in your browser\\?'),
  ]
}

function gitProject() {
  const project = copyFixture('plain-html')
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString()
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
  return { project, git, base: git('rev-parse', '--abbrev-ref', 'HEAD').trim() }
}
const checkoutState = (project, git) => ({ files: treeHashExcept(project, '.git'), head: git('rev-parse', 'HEAD').trim(), branch: git('symbolic-ref', 'HEAD').trim(), status: git('status', '--porcelain'), staged: git('diff', '--cached', '--name-only') })

function save(name, run) {
  fs.mkdirSync(ARTIFACTS, { recursive: true })
  fs.writeFileSync(path.join(ARTIFACTS, `guided-${name}.txt`), run.transcript)
}
function assertDone(run) {
  assert.equal(run.error, null, run.transcript.slice(-3000))
  assert.equal(run.code, 0, run.transcript.slice(-3000))
}

describe('automatic (the default first answer)', () => {
  test('one Enter, then only the unavoidable questions: adapted and wired on origingame/publish, source saved, public, one cover and poster', async () => {
    script({ wire: true })
    const { project, git, base } = gitProject()
    const before = checkoutState(project, git)
    const m = mark()
    const run = await runPty(['--host', platform.origin], [
      ask('How do you want to publish\\?'),
      ask('Before anything is sent[\\s\\S]*Continue\\?'),
      ask('Publish anyway\\?'),
    ], { home: signedInHome(platform.origin, DEVICE_TOKEN), cwd: project })
    const out = since(m)
    save('automatic', run)
    assertDone(run)
    // The plan was shown once, then nothing was asked but the data notice and the possible secret.
    assert.match(run.transcript, /Publishing as a new game · source saved to your private repository · public in the catalog/)
    assert.deepEqual(asked(run.transcript), [
      'How do you want to publish?',
      'Continue?',
      'Publish anyway? (Rotate any real key that ships in a public game.)',
    ])
    assert.match(run.transcript, /Play: http:\/\/127\.0\.0\.1:\d+\/play\//)
    assert.match(run.transcript, /Review them: git diff HEAD\.\.\.origingame\/publish/)
    assert.match(run.transcript, /Keep them: {3}git merge origingame\/publish/)
    assert.deepEqual(checkoutState(project, git), before, 'the checkout is byte-identical, same branch, HEAD, index and status')
    assert.deepEqual(git('log', '--format=%s', `${base}..origingame/publish`).split('\n').filter(Boolean), ['origingame: wire leaderboards and cloud saves', 'origingame: adapt for OriginGame'])
    assert.ok(out.deploys.at(-1).files['og-player.js'], 'the published build is the integrated one')
    assert.ok(sourceCommits(out) > 0, 'the source was saved')
    const deploy = out.deploys.at(-1)
    assert.equal(deploy.method, 'POST')
    assert.match(deploy.fields.source_checkpoint ?? '', /^[0-9a-f]{32}$/)
    assert.equal(deploy.fields.unlisted, undefined, 'public in the catalog')
    assert.equal(deploy.fields.title, 'Star Catcher')
    assert.deepEqual(out.images.map(i => i.size).sort(), ['1140x1472', '1664x928'], 'nobody chooses, so one of each is drawn')
  })

  test('the same folder again: Automatic updates the game it published, still without questions', async () => {
    script()
    const project = copyFixture('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    const first = await runPty(['--host', platform.origin], [ask('How do you want to publish\\?'), ask('Continue\\?'), ask('Publish anyway\\?')], { home, cwd: project })
    assertDone(first)
    const gameId = [...platform.state.games.values()].at(-1).id
    const m = mark()
    const again = await runPty(['--host', platform.origin], [ask('How do you want to publish\\?'), ask('Publish anyway\\?')], { home, cwd: project })
    const out = since(m)
    save('automatic-update', again)
    assertDone(again)
    assert.match(again.transcript, new RegExp(`Updating the game this folder published \\(${gameId}\\)`))
    assert.deepEqual(asked(again.transcript), ['How do you want to publish?', 'Publish anyway? (Rotate any real key that ships in a public game.)'])
    assert.equal(out.deploys.at(-1).method, 'PUT')
    assert.equal(out.deploys.at(-1).path, `/api/deploy/${gameId}`)
    assert.equal(out.images.length, 0, 'an update keeps its artwork')
  })
})

describe('manual', () => {
  test('every setting asked; Enter everywhere publishes and the rules\' candidates are offered', async () => {
    script()
    const project = copyFixture('plain-html')
    const before = treeHash(project)
    const m = mark()
    const run = await runPty(['--host', platform.origin], manualRun(), { home: signedInHome(platform.origin, DEVICE_TOKEN), cwd: project })
    const out = since(m)
    save('manual', run)
    assertDone(run)
    assert.equal(treeHash(project), before)
    assert.ok(sourceCommits(out) > 0, 'Yes is the default for the source')
    assert.match(out.deploys.at(-1).fields.source_checkpoint ?? '', /^[0-9a-f]{32}$/)
    assert.equal(out.deploys.at(-1).fields.unlisted, undefined)
    assert.equal(out.images.length, 5, 'a person chooses, so 3 covers and 2 posters are drawn')
  })

  test('declining the source and choosing Unlisted: no source commit, an unlisted publication', async () => {
    script()
    const m = mark()
    const run = await runPty(['--host', platform.origin], manualRun({ source: `${KEY.right}${KEY.enter}`, visibility: `${KEY.down}${KEY.enter}` }), { home: signedInHome(platform.origin, DEVICE_TOKEN), cwd: copyFixture('plain-html') })
    const out = since(m)
    save('manual-unlisted-no-source', run)
    assertDone(run)
    assert.equal(sourceCommits(out), 0, 'declined: nothing reaches the source repository')
    assert.equal(out.deploys.at(-1).fields.source_checkpoint, undefined)
    assert.equal(out.deploys.at(-1).fields.unlisted, '1')
  })

  test('a folder that published before: Update is offered first; choosing a new game publishes a second game', async () => {
    script()
    const project = copyFixture('plain-html')
    const home = signedInHome(platform.origin, DEVICE_TOKEN)
    assertDone(await runPty(['--host', platform.origin], manualRun(), { home, cwd: project }))
    const gameId = [...platform.state.games.values()].at(-1).id

    let m = mark()
    const update = await runPty(['--host', platform.origin], [
      MANUAL,
      ask('Publish this project\\?'),
      ask('Sign in to OriginGame'),
      ask('Which game is this\\?[\\s\\S]*Update "Star Catcher" \\(version 1\\) \\(Recommended\\)'),
      ask('Save your source'),
      ask('Wire leaderboards'),
      ask('Apply which adaptations\\?'),
      ask('Publish anyway\\?'),
      ask('Draw a new cover and poster for this update\\?'),
      ask('Who can find it\\?'),
      ask('an update of "Star Catcher" to version 2[\\s\\S]*Publish now\\?'),
      ask('Open the game in your browser\\?'),
    ], { home, cwd: project })
    let out = since(m)
    save('manual-update', update)
    assertDone(update)
    assert.equal(out.deploys.at(-1).method, 'PUT')
    assert.equal(out.deploys.at(-1).path, `/api/deploy/${gameId}`)
    assert.equal(platform.state.games.get(gameId).version, 2)

    m = mark()
    const fresh = await runPty(['--host', platform.origin], [
      MANUAL,
      ask('Publish this project\\?'),
      ask('Sign in to OriginGame'),
      ask('Which game is this\\?', `${KEY.down}${KEY.enter}`),
      ...manualRun({ target: [] }).slice(4),
    ], { home, cwd: project })
    out = since(m)
    save('manual-new-game', fresh)
    assertDone(fresh)
    assert.equal(out.deploys.at(-1).method, 'POST', 'a second game, not an update')
    assert.equal(platform.state.games.get(gameId).version, 2, 'the first game is untouched')
  })

  test('another folder with no remembered game can update one of the account\'s games', async () => {
    script()
    const newest = ownGames().at(-1)
    assert.ok(newest, 'earlier tests published games for this account')
    const m = mark()
    const run = await runPty(['--host', platform.origin], [
      MANUAL,
      ask('Publish this project\\?'),
      ask('Sign in to OriginGame'),
      ask('Before anything is sent[\\s\\S]*Continue\\?'),
      ask('Which game is this\\?[\\s\\S]*Publish as a new game \\(Recommended\\)', `${KEY.down}${KEY.enter}`),
      ask('Which of your games\\?'),
      ask('Save your source'),
      ask('Wire leaderboards'),
      ask('Apply which adaptations\\?'),
      ask('Publish anyway\\?'),
      ask('Draw a new cover and poster for this update\\?'),
      ask('Who can find it\\?'),
      ask('Publish now\\?'),
      ask('Open the game in your browser\\?'),
    ], { home: signedInHome(platform.origin, DEVICE_TOKEN), cwd: copyFixture('plain-html') })
    const out = since(m)
    save('manual-pick-own-game', run)
    assertDone(run)
    assert.equal(out.deploys.at(-1).method, 'PUT')
    assert.equal(out.deploys.at(-1).path, `/api/deploy/${newest.id}`, 'the newest of the account\'s games is the first choice')
  })
})
