import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UNITY_CACHE_DIRS } from './detect.js'
import { WizardError } from './errors.js'
import { isTextFile, readText } from './files.js'
import { ensureHome, projectKey } from './home.js'
import { findSecrets, isSecretFile } from './secrets.js'

/** The branch every adaptation and integration of a Git project is committed to. */
export const PUBLISH_BRANCH = 'origingame/publish'

export interface Commit { sha: string; message: string }

/**
 * Where a run builds, adapts and integrates; never the person's checkout.
 *
 * - `worktree`: the project is in a Git repository. A worktree of the
 *   repository on `origingame/publish` (created from the checkout's HEAD,
 *   advanced to it on later runs) under ~/.origingame/worktrees/. The
 *   checkout's uncommitted changes and untracked files are carried over for
 *   the build but never committed; the Wizard's own changes are.
 * - `copy`: no Git repository. A copy of the folder under ~/.origingame/stage/.
 */
export interface Workspace {
  kind: 'worktree' | 'copy'
  /** The game folder inside the workspace (what the run treats as the project). */
  dir: string
  /** The worktree root, or the copy itself. */
  root: string
  branch: string | null
  /** The checkout commit the branch starts from or was advanced to. */
  base: string | null
  /** Paths (relative to `root`) carried from the checkout's uncommitted state: built, never committed. */
  carried: Set<string>
  commits: Commit[]
  notes: string[]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args) } catch { return null }
}

const nul = (out: string | null) => (out ?? '').split('\0').filter(Boolean)

/** `git worktree list --porcelain -z`: each worktree's path and checked-out branch ref. */
function worktrees(repo: string): Array<{ path: string; branch: string | null }> {
  const list: Array<{ path: string; branch: string | null }> = []
  for (const field of (tryGit(repo, ['worktree', 'list', '--porcelain', '-z']) ?? '').split('\0')) {
    if (field.startsWith('worktree ')) list.push({ path: field.slice('worktree '.length), branch: null })
    else if (field.startsWith('branch ') && list.length) list[list.length - 1]!.branch = field.slice('branch '.length)
  }
  return list
}

/** Commits on the Wizard's branch never wait on hooks, signing or a missing identity. */
function commitArgs(root: string): string[] {
  const named = (key: string) => Boolean(tryGit(root, ['config', key])?.trim())
  return [
    '-c', 'commit.gpgsign=false',
    ...(named('user.name') ? [] : ['-c', 'user.name=Origin Wizard']),
    ...(named('user.email') ? [] : ['-c', 'user.email=wizard@origingame.ai']),
  ]
}

/** A file the checkout has that the build may need but nobody may publish or commit: credentials, key-like lines. */
function withheld(file: string, absolute: string): boolean {
  if (isSecretFile(file)) return true
  if (!isTextFile(file)) return false
  return findSecrets(readText(absolute, 4 * 1024 * 1024) ?? '').length > 0
}

/**
 * Brings the checkout's uncommitted state into the worktree for the build:
 * changed and untracked (not ignored) files are copied, deleted ones removed,
 * and the game folder's `.env*` files and `node_modules` are made available.
 * None of it is ever committed.
 */
function carry(ws: Workspace, checkoutRoot: string, gameDir: string): void {
  ws.carried.clear()
  const changed = nul(tryGit(checkoutRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']))
  const untracked = nul(tryGit(checkoutRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
  const sub0 = path.relative(checkoutRoot, gameDir).split(path.sep).join('/')
  const unity = fs.existsSync(path.join(gameDir, 'ProjectSettings', 'ProjectVersion.txt'))
  const cache = (file: string) => unity && UNITY_CACHE_DIRS.includes((sub0 && file.startsWith(`${sub0}/`) ? file.slice(sub0.length + 1) : sub0 ? '' : file).split('/')[0]!)
  for (const file of [...new Set([...changed, ...untracked])]) {
    if (cache(file)) continue
    const from = path.join(checkoutRoot, file)
    const to = path.join(ws.root, file)
    ws.carried.add(file)
    if (!fs.existsSync(from)) { fs.rmSync(to, { force: true }); continue }
    const stat = fs.lstatSync(from)
    if (!stat.isFile()) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  }
  const sub = path.relative(checkoutRoot, gameDir)
  for (const name of fs.existsSync(gameDir) ? fs.readdirSync(gameDir) : []) {
    if (!/^\.env(\..+)?$/.test(name)) continue
    const file = path.join(sub, name).split(path.sep).join('/')
    if (ws.carried.has(file) || fs.existsSync(path.join(ws.dir, name))) continue
    fs.copyFileSync(path.join(gameDir, name), path.join(ws.dir, name))
    ws.carried.add(file)
  }
  const modules = path.join(gameDir, 'node_modules')
  const linked = path.join(ws.dir, 'node_modules')
  if (fs.existsSync(modules) && !fs.existsSync(linked)) fs.symlinkSync(modules, linked, process.platform === 'win32' ? 'junction' : 'dir')
}

/** A plain copy of a folder that is not in Git (its `node_modules` linked, not copied). */
function copyWorkspace(projectDir: string, stageDir: string): Workspace {
  const dir = path.join(stageDir, 'project')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  // A Unity project's import cache and temporary folders stay behind (the Unity build seeds its own cache from them).
  const unity = fs.existsSync(path.join(projectDir, 'ProjectSettings', 'ProjectVersion.txt'))
  for (const entry of fs.readdirSync(projectDir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    if (unity && UNITY_CACHE_DIRS.includes(entry)) continue
    fs.cpSync(path.join(projectDir, entry), path.join(dir, entry), { recursive: true, verbatimSymlinks: true, dereference: false })
  }
  const modules = path.join(projectDir, 'node_modules')
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { kind: 'copy', dir, root: dir, branch: null, base: null, carried: new Set(), commits: [], notes: [] }
}

/** `git: false` (sandbox mode, whose source is already in Agent Service) always works on a copy. */
export function prepareWorkspace(projectDir: string, stageDir: string, options: { git: boolean } = { git: true }): Workspace {
  if (!options.git) return copyWorkspace(projectDir, stageDir)
  const top = tryGit(projectDir, ['rev-parse', '--show-toplevel'])?.trim()
  const head = top ? tryGit(projectDir, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() : null
  if (!top || !head) return copyWorkspace(projectDir, stageDir)
  const checkoutRoot = fs.realpathSync(top)
  const gameDir = fs.realpathSync(projectDir)
  tryGit(checkoutRoot, ['worktree', 'prune'])
  // The worktree that already has the branch checked out is reused wherever it is; otherwise one under ~/.origingame.
  const holder = worktrees(checkoutRoot).find(w => w.branch === `refs/heads/${PUBLISH_BRANCH}` && fs.existsSync(w.path))
  const root = holder?.path ?? path.join(ensureHome(), 'worktrees', projectKey(checkoutRoot).slice(0, 32))
  const registered = Boolean(holder)
  try {
    if (registered) {
      // Last run's carried files and build leftovers go; the branch's commits stay.
      git(root, ['reset', '-q', '--hard'])
      git(root, ['clean', '-q', '-fdx'])
      git(root, ['checkout', '-q', PUBLISH_BRANCH])
    } else {
      fs.rmSync(root, { recursive: true, force: true })
      const exists = tryGit(checkoutRoot, ['rev-parse', '--verify', '-q', `refs/heads/${PUBLISH_BRANCH}`]) !== null
      fs.mkdirSync(path.dirname(root), { recursive: true })
      git(checkoutRoot, exists ? ['worktree', 'add', '-q', root, PUBLISH_BRANCH] : ['worktree', 'add', '-q', '-b', PUBLISH_BRANCH, root, head])
    }
  } catch (error) {
    const why = String((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split('\n').slice(-2).join(' ')
    throw new WizardError('adapt_failed', `could not prepare the ${PUBLISH_BRANCH} worktree in ${root}: ${why}`)
  }
  const ws: Workspace = {
    kind: 'worktree', dir: path.join(root, path.relative(checkoutRoot, gameDir)), root, branch: PUBLISH_BRANCH, base: head,
    carried: new Set(), commits: [], notes: [],
  }
  // Advance the branch to the checkout's HEAD; when that does not merge cleanly, start the branch again from it.
  if (tryGit(root, ['merge-base', '--is-ancestor', head, 'HEAD']) === null) {
    const merged = tryGit(root, [...commitArgs(root), 'merge', '-q', '--no-edit', '--no-verify', '-m', `origingame: bring in ${head.slice(0, 12)} from your checkout`, head])
    if (merged === null) {
      tryGit(root, ['merge', '--abort'])
      git(root, ['reset', '-q', '--hard', head])
      ws.notes.push(`${PUBLISH_BRANCH} did not merge your latest commit cleanly, so it was started again from it`)
    }
  }
  carry(ws, checkoutRoot, gameDir)
  if (ws.carried.size) ws.notes.push(`${ws.carried.size} uncommitted or untracked file${ws.carried.size === 1 ? '' : 's'} from your checkout ${ws.carried.size === 1 ? 'is' : 'are'} in the build but not committed`)
  return ws
}

/**
 * Commits what the Wizard changed in the worktree (never the carried files,
 * credentials or `node_modules`). Returns the commit, or null when nothing
 * changed or the workspace is a plain copy.
 */
export function commitWorkspace(ws: Workspace, message: string): Commit | null {
  if (ws.kind !== 'worktree') return null
  const entries = nul(git(ws.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
  const paths = entries.map(e => e.slice(3)).filter(p =>
    !ws.carried.has(p) && !p.split('/').includes('node_modules') && !withheld(p, path.join(ws.root, p)))
  if (!paths.length) return null
  git(ws.root, ['add', '-A', '--', ...paths])
  if (tryGit(ws.root, ['diff', '--cached', '--quiet']) !== null) return null
  git(ws.root, [...commitArgs(ws.root), 'commit', '-q', '--no-verify', '-m', message])
  const commit = { sha: git(ws.root, ['rev-parse', 'HEAD']).trim(), message: message.split('\n')[0]! }
  ws.commits.push(commit)
  return commit
}

/** Moves the branch back to `sha` (dropping later Wizard commits) and carries the checkout's state in again. */
export function resetWorkspace(ws: Workspace, sha: string, checkoutDir: string): void {
  if (ws.kind !== 'worktree') return
  git(ws.root, ['reset', '-q', '--hard', sha])
  git(ws.root, ['clean', '-q', '-fd'])
  const index = ws.commits.findIndex(c => c.sha === sha)
  ws.commits.splice(index + 1)
  const top = fs.realpathSync(git(checkoutDir, ['rev-parse', '--show-toplevel']).trim())
  carry(ws, top, fs.realpathSync(checkoutDir))
}

export function headOf(ws: Workspace): string | null {
  return ws.kind === 'worktree' ? git(ws.root, ['rev-parse', 'HEAD']).trim() : null
}
