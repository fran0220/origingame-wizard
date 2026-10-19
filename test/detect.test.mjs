// The detector decides what gets built and published, so a misreading ships the
// wrong bytes or none. Ways it can fail, each pinned below:
// - a marker inside node_modules flips the engine;
// - a stale dist/ hides a buildable project;
// - a Godot project's own Web export in its tree is missed, or a Godot export
//   is sent to Portal as `godot` (refused for new games) instead of `html`;
// - an export in a subdirectory, or with an entry not named index.html, is missed;
// - a lone page that is not index.html is not found;
// - an empty tree is "detected";
// - the Vite flags are appended to a script whose last command is not vite;
// - the wrong package manager runs the build.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ROOT } from './helpers.mjs'

const { detectProject, viteIsLast } = await import(path.join(ROOT, 'dist', 'detect.js'))
const { parseFamilies, validateRules } = await import(path.join(ROOT, 'dist', 'rules.js'))
const rulesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'rules', 'rules.json'), 'utf8'))
// The engines as the CLI reads them (an older document's `godot` engine is not used).
const { engines } = validateRules({ ...rulesJson, version: 'x', prompts: { system: 's', analyze: 'a', adapt: 'd', metadata: 'm', artwork: 'w' } })

const detect = (tree) => detectProject({ files: Object.keys(tree), read: f => tree[f] ?? null, engines })

test('a three.js file inside node_modules does not make a static page a three.js game', () => {
  const d = detect({ 'index.html': '<canvas></canvas><script src="game.js"></script>', 'game.js': 'draw()', 'node_modules/three/build/three.module.js': 'export {}' })
  assert.equal(d.kind, 'static')
  assert.equal(d.engine, 'html')
})

test('an importmap that maps "three" makes a static page a three.js game', () => {
  const d = detect({ 'index.html': '<script type="importmap">{"imports":{"three":"https://cdn.example/three.module.js"}}</script>' })
  assert.equal(d.engine, 'threejs')
})

test('a stale dist/ does not hide a project with a build script', () => {
  const d = detect({ 'package.json': JSON.stringify({ scripts: { build: 'tsc && vite build' }, dependencies: { three: '1' } }), 'index.html': '', 'src/main.ts': '', 'dist/index.html': '', 'pnpm-lock.yaml': '' })
  assert.equal(d.kind, 'node-build')
  assert.equal(d.engine, 'threejs')
  assert.deepEqual(d.build, { packageManager: 'pnpm', script: 'tsc && vite build', viteLast: true })
  assert.equal(d.outputs[0], 'dist')
})

test('a configured Vite outDir is the first place to look for the build', () => {
  const d = detect({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }), 'vite.config.ts': "export default { build: { outDir: './public-build' } }", 'index.html': '' })
  assert.equal(d.outputs[0], 'public-build')
})

test('the Vite flags are only appended when vite build is the last command', () => {
  assert.equal(viteIsLast('vite build'), true)
  assert.equal(viteIsLast('tsc -b && vite build --mode production'), true)
  assert.equal(viteIsLast('vite build && node scripts/post.js'), false)
  assert.equal(viteIsLast('webpack --mode production'), false)
  assert.equal(viteIsLast('vite build; rm -rf /'), false)
})

test('a Godot project publishes its own Web export as html; without one it is a project the Wizard cannot publish', () => {
  const d = detect({ 'project.godot': '[application]', 'main.gd': '', 'export/web/index.html': 'GODOT_CONFIG', 'export/web/index.pck': '', 'export/web/index.wasm': '', 'export/web/index.js': '' })
  assert.equal(d.kind, 'godot-export')
  assert.equal(d.engine, 'html')
  assert.equal(d.family.id, 'godot')
  assert.equal(d.root, 'export/web')
  assert.equal(d.entry, 'index.html')
  const bare = detect({ 'project.godot': '[application]', 'main.gd': '', 'index.html': '<p>docs</p>' })
  assert.equal(bare.kind, 'godot-project')
  assert.equal(bare.engine, 'html')
})

test('a Godot export in a subdirectory with an entry named after the game is found', () => {
  const d = detect({ 'README.md': '', 'build/web/Lantern.html': 'GODOT_CONFIG', 'build/web/Lantern.pck': '', 'build/web/Lantern.wasm': '', 'build/web/Lantern.js': '' })
  assert.equal(d.kind, 'godot-export')
  assert.equal(d.root, 'build/web')
  assert.equal(d.entry, 'Lantern.html')
  assert.equal(d.engine, 'html')
})

test('a prebuilt dist/ with no build script is published as it is', () => {
  const d = detect({ 'dist/index.html': '<script src="three.min.js"></script>', 'dist/three.min.js': '' })
  assert.equal(d.kind, 'prebuilt')
  assert.equal(d.root, 'dist')
  assert.equal(d.engine, 'threejs')
})

test('a single page that is not index.html is the entry', () => {
  const d = detect({ 'game.html': '<canvas>', 'sprites.png': '' })
  assert.equal(d.kind, 'static')
  assert.equal(d.entry, 'game.html')
})

test('a tree without a page is not a game', () => {
  assert.equal(detect({ 'notes.txt': '', 'src/a.js': '' }), null)
})

test('the package manager follows the lockfile, and packageManager wins', () => {
  const base = { 'index.html': '', 'package.json': JSON.stringify({ scripts: { build: 'vite build' } }) }
  assert.equal(detect({ ...base, 'bun.lock': '' }).build.packageManager, 'bun')
  assert.equal(detect({ ...base, 'yarn.lock': '' }).build.packageManager, 'yarn')
  assert.equal(detect(base).build.packageManager, 'npm')
  assert.equal(detect({ ...base, 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { build: 'vite build' } }), 'yarn.lock': '' }).build.packageManager, 'pnpm')
})

// Engines and families. Ways the detector can fail here, each pinned below:
// - a Unity WebGL build (at the root, nested, or with a non-index page) is published as a plain page and
//   its Unity handling (compression, threads, template) never runs, or Portal is sent `html`;
// - a Unity project is mistaken for its stale WebGL build, or its Library/ cache is taken for the game;
// - an engine's Web export one or more folders down is missed or its root is wrong;
// - a family label is shown for the wrong engine, or a non-Portal family id is sent as `engine`;
// - a native build (Windows, macOS, Linux, Android, iOS) is "detected" as a Web game and uploaded,
//   or its engine is misnamed so the wrong source project is looked for;
// - the RPG Maker MV Windows deployment's www/ (a real Web game) is refused as a native build;
// - an engine source project that the Wizard cannot build is "detected" as nothing at all.
const families = parseFamilies(rulesJson.families)
const ENGINE_FIXTURES = path.join(ROOT, 'fixtures', 'engines')

function treeOf(dir) {
  const tree = {}
  const visit = (current, prefix) => {
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name)
      const relative = prefix ? `${prefix}/${name}` : name
      if (fs.statSync(absolute).isDirectory()) visit(absolute, relative)
      else tree[relative] = fs.readFileSync(absolute, 'latin1')
    }
  }
  visit(dir, '')
  return tree
}
const detectAll = (tree) => detectProject({ files: Object.keys(tree), read: f => tree[f] ?? null, engines, families })
const summary = d => d && { kind: d.kind, engine: d.engine, family: d.family?.id ?? null, root: d.root, entry: d.entry }

test('every engine family fixture is found with its root, entry, label and the Portal engine it publishes as', () => {
  const expected = {
    construct3: { kind: 'prebuilt', engine: 'html', family: 'construct3', root: 'exports/web', entry: 'index.html' },
    construct2: { kind: 'static', engine: 'html', family: 'construct2', root: '', entry: 'index.html' },
    gamemaker: { kind: 'static', engine: 'html', family: 'gamemaker', root: '', entry: 'index.html' },
    'cocos-creator': { kind: 'prebuilt', engine: 'html', family: 'cocos', root: 'build/web-mobile', entry: 'index.html' },
    defold: { kind: 'static', engine: 'html', family: 'defold', root: '', entry: 'index.html' },
    playcanvas: { kind: 'static', engine: 'html', family: 'playcanvas', root: '', entry: 'index.html' },
    phaser: { kind: 'static', engine: 'html', family: 'phaser', root: '', entry: 'index.html' },
    pixi: { kind: 'node-build', engine: 'html', family: 'pixi', root: '', entry: 'index.html' },
    babylon: { kind: 'static', engine: 'html', family: 'babylon', root: '', entry: 'index.html' },
    'rpgmaker-mv': { kind: 'prebuilt', engine: 'html', family: 'rpgmaker-mv', root: 'www', entry: 'index.html' },
    'rpgmaker-mz': { kind: 'static', engine: 'html', family: 'rpgmaker-mz', root: '', entry: 'index.html' },
    renpy: { kind: 'static', engine: 'html', family: 'renpy', root: '', entry: 'index.html' },
    twine: { kind: 'static', engine: 'html', family: 'twine', root: '', entry: 'the-cellar.html' },
    pico8: { kind: 'static', engine: 'html', family: 'pico8', root: '', entry: 'jelpi.html' },
    'wasm-bindgen': { kind: 'static', engine: 'html', family: 'wasm-bindgen', root: '', entry: 'index.html' },
    emscripten: { kind: 'prebuilt', engine: 'html', family: 'emscripten', root: 'web', entry: 'index.html' },
  }
  const got = Object.fromEntries(Object.keys(expected).map(name => [name, summary(detectAll(treeOf(path.join(ENGINE_FIXTURES, name))))]))
  assert.deepEqual(got, expected)
  // Generated exports are engine output (no score/save wiring); hand-written framework games are not.
  assert.equal(detectAll(treeOf(path.join(ENGINE_FIXTURES, 'construct3'))).family.generated, true)
  assert.equal(detectAll(treeOf(path.join(ENGINE_FIXTURES, 'phaser'))).family.generated, false)
})

test('native builds are never Web games: platform and engine come from the files beside them', () => {
  const native = name => detectAll(treeOf(path.join(ENGINE_FIXTURES, name)))
  const got = Object.fromEntries(['godot-windows', 'unity-macos', 'unity-linux', 'android', 'unity-ios', 'unreal-windows', 'gamemaker-windows', 'electron-windows']
    .map(name => { const d = native(name); return [name, { kind: d.kind, platform: d.native.platform, engine: d.native.engine, root: d.root }] }))
  assert.deepEqual(got, {
    'godot-windows': { kind: 'native', platform: 'windows', engine: 'godot', root: '' },
    'unity-macos': { kind: 'native', platform: 'macos', engine: 'unity', root: '' },
    'unity-linux': { kind: 'native', platform: 'linux', engine: 'unity', root: '' },
    android: { kind: 'native', platform: 'android', engine: null, root: 'build/outputs' },
    'unity-ios': { kind: 'native', platform: 'ios', engine: 'unity', root: '' },
    'unreal-windows': { kind: 'native', platform: 'windows', engine: 'unreal', root: '' },
    'gamemaker-windows': { kind: 'native', platform: 'windows', engine: 'gamemaker', root: '' },
    'electron-windows': { kind: 'native', platform: 'windows', engine: 'electron', root: '' },
  })
  const windows = detectAll(treeOf(path.join(ROOT, 'fixtures', 'unity-native', 'Windows')))
  assert.deepEqual({ kind: windows.kind, platform: windows.native.platform, engine: windows.native.engine, evidence: windows.native.evidence }, { kind: 'native', platform: 'windows', engine: 'unity', evidence: ['Orchard Run.exe'] })
})

test('a Unity WebGL build is unity-webgl at the root, nested, or under any page name, and publishes as engine unity', () => {
  const root = detectAll(treeOf(path.join(ROOT, 'fixtures', 'unity-webgl')))
  assert.deepEqual(summary(root), { kind: 'unity-webgl', engine: 'unity', family: 'unity', root: '', entry: 'index.html' })
  const nested = detectAll({ 'README.md': '', 'Builds/WebGL/Orchard.html': '<script>createUnityInstance(</script>', 'Builds/WebGL/Build/Orchard.loader.js': '', 'Builds/WebGL/Build/Orchard.wasm.gz': '' })
  assert.deepEqual(summary(nested), { kind: 'unity-webgl', engine: 'unity', family: 'unity', root: 'Builds/WebGL', entry: 'Orchard.html' })
  const legacy = detectAll({ 'index.html': '<script>UnityLoader.instantiate("unityContainer", "Build/web.json")</script>', 'Build/UnityLoader.js': '', 'Build/web.json': '{}', 'Build/web.data.unityweb': '' })
  assert.equal(legacy.kind, 'unity-webgl')
  // Without the families (rules served to an older Wizard), a Unity build still publishes as unity.
  assert.equal(detectProject({ files: ['index.html', 'Build/G.loader.js'], read: () => '', engines }).engine, 'unity')
})

test('a Unity project is a project (its Library/ and Temp/ are not the game) and remembers a WebGL build in its tree', () => {
  const tree = treeOf(path.join(ROOT, 'fixtures', 'unity-project'))
  tree['Library/PackageCache/com.unity.ugui/Documentation~/index.html'] = '<html></html>'
  tree['Builds/WebGL/index.html'] = ''
  tree['Builds/WebGL/Build/Orchard.loader.js'] = ''
  const d = detectAll(tree)
  assert.deepEqual(summary(d), { kind: 'unity-project', engine: 'unity', family: 'unity', root: '', entry: 'index.html' })
  assert.deepEqual(d.existingExport, { root: 'Builds/WebGL', entry: 'index.html' })
  assert.deepEqual(d.unity, { version: '2022.3.10f1', revision: 'ff3792e53c62', productName: 'Orchard Run', webCanvas: { width: 960, height: 600 }, compression: 'brotli', decompressionFallback: false, threads: false, template: 'APPLICATION:Default', scenes: 1 })
})

test('an engine project the Wizard cannot build says what it is instead of finding nothing', () => {
  const d = detectAll({ 'Sky Hopper.c3p': 'PK' })
  assert.deepEqual({ kind: d.kind, platform: d.native.platform, engine: d.native.engine }, { kind: 'native', platform: 'project', engine: 'construct' })
  assert.equal(detectAll({ 'game.project': '[project]', 'main/main.collection': '' }).native.engine, 'defold')
})

test('rules: families are optional and lenient; engines still refuse an id Portal does not know', () => {
  const base = { ...rulesJson, version: 'x', prompts: { system: 's', analyze: 'a', adapt: 'd', metadata: 'm', artwork: 'w' } }
  const { families: _drop, ...withoutFamilies } = base
  assert.deepEqual(validateRules(withoutFamilies).families, [])
  const lenient = validateRules({ ...base, families: [{ id: 'future', label: 'Future Engine', engine: 'future-engine', markers: ['future.js'] }, { id: 'BAD ID', markers: ['x'] }, { id: 'nomarkers', markers: [] }, 7] }).families
  assert.deepEqual(lenient, [{ id: 'future', label: 'Future Engine', engine: 'html', markers: ['future.js'], generated: false, locate: false }])
  assert.throws(() => validateRules({ ...base, engines: [...base.engines, { id: 'construct', markers: [] }] }), /unknown engine construct/)
})

// Origin Engine. Ways the detector can fail here, each pinned below:
// - an Origin Engine project (project.ogt) with the template's package.json `build: og build .` is taken
//   for a node build, so `npm run build` makes a dev build that is published as html;
// - an og build output (at the root, in dist/ or wherever project.ogt's publish.out says) is published as
//   a plain page or a wasm-bindgen export, so Portal gets `html` and strips the build's sw.js and manifest;
// - an og build is missed when it has only some of its markers (the manifest, the meta, the web host);
// - a dev build (`og build` without --publish) is offered as the existing build of a project;
// - another wasm-bindgen game (`*_bg.wasm`) is taken for Origin Engine.
const OG_DIST = path.join(ROOT, 'fixtures', 'origin-engine-dist')

test('an Origin Engine project is built with og, whatever its package.json says, and remembers its publish build', () => {
  const tree = treeOf(path.join(ROOT, 'fixtures', 'origin-engine-project'))
  const d = detectAll(tree)
  assert.deepEqual(summary(d), { kind: 'origin-engine', engine: 'origin-engine', family: 'origin-engine', root: '', entry: 'index.html' })
  assert.equal(d.outputs[0], 'dist')
  assert.equal(d.build, undefined)
  assert.equal(d.existingExport, undefined)
  // A publish build in dist/ is remembered; a dev build there is not.
  const built = { ...tree, ...Object.fromEntries(Object.entries(treeOf(OG_DIST)).map(([f, t]) => [`dist/${f}`, t])) }
  assert.deepEqual(detectAll(built).existingExport, { root: 'dist', entry: 'index.html' })
  const dev = { ...built, 'dist/og-build.json': built['dist/og-build.json'].replace('"build": "publish"', '"build": "dev"') }
  assert.equal(detectAll(dev).existingExport, undefined)
  // project.ogt's publish.out names where the build goes.
  const out = { ...tree, 'project.ogt': tree['project.ogt'].replace('out "dist"', 'out "build/web"') }
  assert.deepEqual(detectAll(out).outputs, ['build/web', 'dist'])
})

test('an og build output is origin-engine-build at the root or nested, by its manifest, its meta or its web host', () => {
  const dist = treeOf(OG_DIST)
  const root = detectAll(dist)
  assert.deepEqual(summary(root), { kind: 'origin-engine-build', engine: 'origin-engine', family: 'origin-engine', root: '', entry: 'index.html' })
  assert.equal(root.ogBuild, 'publish')
  const nested = detectAll({ 'README.md': '', ...Object.fromEntries(Object.entries(dist).map(([f, t]) => [`dist/${f}`, t])) })
  assert.deepEqual(summary(nested), { kind: 'origin-engine-build', engine: 'origin-engine', family: 'origin-engine', root: 'dist', entry: 'index.html' })
  // Each marker alone is enough.
  const { 'og-build.json': _manifest, ...withoutManifest } = dist
  assert.equal(detectAll(withoutManifest).kind, 'origin-engine-build')
  assert.equal(detectAll(withoutManifest).ogBuild, 'publish', 'the og-build meta says which build it is')
  assert.equal(detectAll({ 'index.html': '<meta name="og-profile" content="3d"><script type="module" src="./play.js"></script>', 'play.js': '' }).engine, 'origin-engine')
  assert.equal(detectAll({ 'index.html': '<canvas></canvas>', 'origin-engine.js': '', 'origin-engine_bg.wasm': '' }).kind, 'origin-engine-build')
  // Without the families (rules served to an older Wizard), the build itself still says what it is.
  assert.equal(detectProject({ files: Object.keys(dist), read: f => dist[f] ?? null, engines }).engine, 'origin-engine')
  // Another wasm-bindgen game is not Origin Engine.
  const bevy = detectAll({ 'index.html': '<script type="module">import init from "./game.js"; init()</script>', 'game.js': 'wasm.__wbindgen_start()', 'game_bg.wasm': '' })
  assert.deepEqual({ engine: bevy.engine, family: bevy.family.id }, { engine: 'html', family: 'wasm-bindgen' })
})
