// The detector decides what gets built and published, so a misreading ships the
// wrong bytes or none. Ways it can fail, each pinned below:
// - a marker inside node_modules flips the engine;
// - a stale dist/ hides a buildable project;
// - a Godot project is mistaken for its (possibly stale) export, or the export
//   is unusable when no editor is installed;
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
const { engines } = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'rules', 'rules.json'), 'utf8'))

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

test('a Godot project is detected as a project, and remembers an existing export for when no editor is installed', () => {
  const d = detect({ 'project.godot': '[application]', 'main.gd': '', 'export/web/index.html': 'GODOT_CONFIG', 'export/web/index.pck': '', 'export/web/index.wasm': '', 'export/web/index.js': '' })
  assert.equal(d.kind, 'godot-project')
  assert.equal(d.engine, 'godot')
  assert.deepEqual(d.existingExport, { root: 'export/web', entry: 'index.html' })
})

test('a Godot export in a subdirectory with an entry named after the game is found', () => {
  const d = detect({ 'README.md': '', 'build/web/Lantern.html': 'GODOT_CONFIG', 'build/web/Lantern.pck': '', 'build/web/Lantern.wasm': '', 'build/web/Lantern.js': '' })
  assert.equal(d.kind, 'godot-export')
  assert.equal(d.root, 'build/web')
  assert.equal(d.entry, 'Lantern.html')
  assert.equal(d.engine, 'godot')
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
