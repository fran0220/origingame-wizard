import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = path.join(ROOT, 'dist', 'cli.js')
export const FIXTURES = path.join(ROOT, 'fixtures')

const temporary = []
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `og-wizard-${prefix}-`))
  temporary.push(dir)
  return fs.realpathSync(dir)
}
export function cleanTemp() {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

/** A copy of a fixture project in a fresh directory (symbolic links kept as links). */
export function copyFixture(name) {
  const dir = path.join(tempDir(name), name)
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true, verbatimSymlinks: true })
  return dir
}

/**
 * Hash of a directory tree: every entry's relative path, type, mode bits and
 * content (or link target). Any byte written, file added or removed, or
 * directory created changes it.
 */
export function treeHash(dir) {
  const hash = createHash('sha256')
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name)
      const relative = path.relative(dir, absolute)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) hash.update(`L ${relative} -> ${fs.readlinkSync(absolute)}\n`)
      else if (stat.isDirectory()) { hash.update(`D ${relative} ${stat.mode & 0o777}\n`); visit(absolute) }
      else hash.update(`F ${relative} ${stat.mode & 0o777} ${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}\n`)
    }
  }
  visit(dir)
  return hash.digest('hex')
}

export const sha256 = data => createHash('sha256').update(data).digest('hex')

/** Runs the built CLI as a subprocess; resolves with its exit code, stdout, stderr and the parsed JSON line. */
export function runCli(args, { home, env = {}, cwd = ROOT, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ORIGINGAME_NO_BROWSER: '1', ORIGINGAME_READINESS_WAIT_SECONDS: '20', npm_config_update_notifier: 'false', ...env }
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out\n${stderr}`)) }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      const lines = stdout.trim().split('\n').filter(Boolean)
      let result = null
      try { result = lines.length === 1 ? JSON.parse(lines[0]) : null } catch { result = null }
      resolve({ code, stdout, stderr, result, lines })
    })
  })
}

/** ~/.origingame with a signed-in device credential for `host`. */
export function signedInHome(host, token) {
  const home = tempDir('home')
  const dir = path.join(home, '.origingame')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ host, access_token: token, device_id: 7, account: { id: 42, username: 'maker', display_name: 'Maker' } }), { mode: 0o600 })
  return home
}
