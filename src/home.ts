import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Everything the Wizard keeps lives under ~/.origingame; the project directory is never written. */
export function homeDir(): string {
  return path.join(os.homedir(), '.origingame')
}

function ensureHome(): string {
  const dir = homeDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Writes through a 0600 temporary file and renames it, so a crash never leaves a half file. */
function writePrivateJson(file: string, value: unknown): void {
  ensureHome()
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, file)
}

export interface Account { id: number; username: string; display_name: string }

export interface StoredCredentials {
  host: string
  access_token: string
  device_id: string | number | null
  account: Account
}

export const credentialsFile = () => path.join(homeDir(), 'credentials.json')

export function readCredentials(): StoredCredentials | null {
  const value = readJson<StoredCredentials>(credentialsFile())
  if (!value || typeof value.access_token !== 'string' || typeof value.host !== 'string' || !value.account) return null
  return value
}

export function writeCredentials(value: StoredCredentials): void {
  writePrivateJson(credentialsFile(), value)
}

export function deleteCredentials(): boolean {
  try {
    fs.rmSync(credentialsFile())
    return true
  } catch {
    return false
  }
}

/** `repositoryId`: the private source repository `--with-source` committed to. */
export interface ProjectMemory { gameId: string; slug: string; host: string; repositoryId?: string }

const projectsFile = () => path.join(homeDir(), 'projects.json')

export function projectKey(projectDir: string): string {
  return createHash('sha256').update(path.resolve(projectDir)).digest('hex')
}

export function rememberedGame(projectDir: string, host: string): ProjectMemory | null {
  const all = readJson<Record<string, ProjectMemory>>(projectsFile()) ?? {}
  const entry = all[projectKey(projectDir)]
  return entry && entry.host === host && typeof entry.gameId === 'string' ? entry : null
}

export function rememberGame(projectDir: string, memory: ProjectMemory): void {
  const all = readJson<Record<string, ProjectMemory>>(projectsFile()) ?? {}
  all[projectKey(projectDir)] = memory
  writePrivateJson(projectsFile(), all)
}

export function forgetGame(projectDir: string): void {
  const all = readJson<Record<string, ProjectMemory>>(projectsFile()) ?? {}
  delete all[projectKey(projectDir)]
  writePrivateJson(projectsFile(), all)
}

interface Settings { consent?: { version: number; at: string } }
const settingsFile = () => path.join(homeDir(), 'settings.json')
/** Bump when what is sent to the model changes in a way the person must agree to again. */
export const CONSENT_VERSION = 1

export function hasConsented(): boolean {
  return (readJson<Settings>(settingsFile())?.consent?.version ?? 0) >= CONSENT_VERSION
}

export function recordConsent(): void {
  const settings = readJson<Settings>(settingsFile()) ?? {}
  settings.consent = { version: CONSENT_VERSION, at: new Date().toISOString() }
  writePrivateJson(settingsFile(), settings)
}

/** `~/.origingame/stage/<project-hash>/`, emptied at the start of every run. */
export function freshStage(projectDir: string): string {
  const dir = path.join(ensureHome(), 'stage', projectKey(projectDir).slice(0, 32))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
