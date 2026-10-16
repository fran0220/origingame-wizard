import fs from 'node:fs'
import { VERSION } from './constants.js'
import { WizardError } from './errors.js'
import { describe, errorCode, request } from './http.js'
import type { Account } from './home.js'

/** A Wizard session (contracts §1.2): one run, ≤ 30 minutes, platform-funded, allowlisted models. Memory only. */
export interface WizardSession {
  session_id: string
  credential: string
  channel: string
  expires_at: string
  models: string[]
  budget_quota: number
  account: Account
}

/** How this run reaches Portal: the person's `og-` credential, or a sandbox publish delegation. */
export interface PortalAuth {
  token: string
  repositoryId?: string
}

export interface Sandbox { host: string; session: WizardSession; publish: { token: string; repository_id: string } }

function validSession(value: any): value is WizardSession {
  return value && typeof value.credential === 'string' && value.credential.startsWith('ogp-')
    && typeof value.session_id === 'string' && Array.isArray(value.models) && value.account && typeof value.account.id === 'number'
}

export async function issueSession(host: string, accountToken: string, projectHash: string): Promise<WizardSession> {
  let response
  try {
    response = await request(`${host}/identity/v1/wizard/sessions`, {
      headers: { authorization: `Bearer ${accountToken}` },
      json: { client_version: VERSION.slice(0, 64), project: projectHash.slice(0, 32) },
    })
  } catch (error) {
    throw new WizardError('session_refused', `could not start a Wizard session: ${(error as Error).message}`)
  }
  if (response.status === 401) throw new WizardError('not_logged_in', 'the saved sign-in is no longer valid; run `npx origingame login`')
  if (!response.ok || !validSession(response.json)) {
    const code = errorCode(response)
    const why = code === 'risk_denied' ? 'the platform declined this session for this account'
      : code === 'risk_rate_limited' ? 'too many Wizard sessions were started recently; try again later'
        : describe(response)
    throw new WizardError('session_refused', `the platform did not start a Wizard session: ${why}`)
  }
  return response.json
}

/**
 * Sandbox mode (contracts §7): the file is read and deleted at once, before
 * its content is even validated, so a credential never outlives this call on disk.
 */
export function readSandboxFile(file: string): Sandbox {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new WizardError('not_logged_in', `could not read --credentials-file: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
  }
  let value: any
  try {
    value = JSON.parse(raw)
  } catch {
    throw new WizardError('not_logged_in', '--credentials-file is not valid JSON')
  }
  if (typeof value?.host !== 'string' || !validSession(value.session)
    || typeof value.publish?.token !== 'string' || typeof value.publish?.repository_id !== 'string') {
    throw new WizardError('not_logged_in', '--credentials-file must contain {host, session, publish: {token, repository_id}}')
  }
  return value as Sandbox
}

/** Ends the session on the platform (contracts §1.3). Never throws. */
export async function revokeSession(host: string, session: WizardSession): Promise<boolean> {
  try {
    const response = await request(`${host}/identity/v1/wizard/sessions/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${session.credential}` }, timeoutMs: 10_000,
    })
    return response.ok
  } catch {
    return false
  }
}
