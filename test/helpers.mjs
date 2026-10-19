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
  const dir = path.join(tempDir(path.basename(name)), path.basename(name))
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

/** treeHash, leaving out one top-level entry (a checkout's `.git`). */
export function treeHashExcept(dir, skip) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'og-wizard-hash-'))
  try {
    for (const name of fs.readdirSync(dir)) if (name !== skip) fs.cpSync(path.join(dir, name), path.join(copy, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    return treeHash(copy)
  } finally {
    fs.rmSync(copy, { recursive: true, force: true })
  }
}

export const sha256 = data => createHash('sha256').update(data).digest('hex')

/** Runs the built CLI as a subprocess; resolves with its exit code, stdout, stderr and the parsed JSON line. */
export function runCli(args, { home, env = {}, cwd = ROOT, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { PATH: process.env.PATH, HOME: home, ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}), USERPROFILE: home, ORIGINGAME_NO_BROWSER: '1', ORIGINGAME_READINESS_WAIT_SECONDS: '20', npm_config_update_notifier: 'false', ...env }
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

export const KEY = { enter: '\r', down: '\x1b[B', up: '\x1b[A', right: '\x1b[C', left: '\x1b[D' }

/**
 * Runs the built CLI in a real pseudo-terminal (test/pty-driver.py) and
 * answers its prompts in order: each step waits for `expect` (a regex source
 * matched against the output without ANSI codes) and then types `send`.
 * Resolves with the exit code, the transcript and how many steps were answered.
 */
export function runPty(args, steps, { home, env = {}, cwd = ROOT, timeoutSeconds = 90 } = {}) {
  const spec = path.join(tempDir('pty'), 'spec.json')
  const childEnv = { PATH: process.env.PATH, HOME: home, ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}), USERPROFILE: home, TERM: 'xterm-256color', ORIGINGAME_NO_BROWSER: '1', ORIGINGAME_READINESS_WAIT_SECONDS: '20', npm_config_update_notifier: 'false', ...env }
  fs.writeFileSync(spec, JSON.stringify({ argv: [process.execPath, CLI, ...args], env: childEnv, cwd, steps, timeoutSeconds }))
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', path.join(ROOT, 'test', 'pty-driver.py'), spec], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`pty driver failed: ${stderr || stdout}`)) }
    })
  })
}
