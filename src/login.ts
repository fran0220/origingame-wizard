import os from 'node:os'
import { DEVICE_CLIENT } from './constants.js'
import { WizardError } from './errors.js'
import { describe, errorCode, request, sleep } from './http.js'
import { deleteCredentials, readCredentials, writeCredentials, type Account, type StoredCredentials } from './home.js'
import { openInBrowser } from './open.js'
import type { Ui } from './ui.js'

export interface AccountCredential { token: string; account: Account | null; source: 'stored' | 'env' }

/**
 * The `og-` account credential for this host: `OG_API_KEY` (never written to
 * disk) or the device credential in ~/.origingame/credentials.json.
 */
export function storedCredential(host: string): AccountCredential | null {
  const env = process.env.OG_API_KEY
  if (env && env.startsWith('og-')) return { token: env, account: null, source: 'env' }
  const stored = readCredentials()
  if (stored && stored.host === host && stored.access_token.startsWith('og-')) return { token: stored.access_token, account: stored.account, source: 'stored' }
  return null
}

/** Browser device authorization with client `wizard` (contracts §1.1). */
export async function deviceLogin(host: string, ui: Ui): Promise<StoredCredentials> {
  const started = await request(`${host}/identity/v1/connector/device/authorizations`, {
    json: { device_name: `Origin Wizard on ${os.hostname().slice(0, 50)}`, client: DEVICE_CLIENT },
  }).catch(error => { throw new WizardError('not_logged_in', `could not start sign-in: ${(error as Error).message}`) })
  if (!started.ok || typeof started.json?.device_code !== 'string') {
    throw new WizardError('not_logged_in', `could not start sign-in: ${describe(started)}`)
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = started.json
  let interval = Math.max(1, Number(started.json.interval) || 5) * 1000
  const deadline = Date.now() + Math.max(30, Number(started.json.expires_in) || 600) * 1000
  const opened = openInBrowser(complete ?? uri)
  ui.note('Sign in to OriginGame', [
    `${opened ? 'A browser window opened. If it did not, open' : 'Open'}: ${complete ?? uri}`,
    `Code: ${userCode}`,
    'Approve "Origin Wizard" there; this window continues by itself.',
  ].join('\n'))
  const wait = ui.spinner('Waiting for approval in the browser')
  while (Date.now() < deadline) {
    await sleep(interval)
    let polled
    try {
      polled = await request(`${host}/identity/v1/connector/device/token`, { json: { device_code: deviceCode } })
    } catch {
      continue
    }
    if (polled.ok && typeof polled.json?.access_token === 'string') {
      const account = polled.json.account as Account
      const credentials: StoredCredentials = { host, access_token: polled.json.access_token, device_id: polled.json.device_id ?? null, account }
      writeCredentials(credentials)
      wait.stop(`Signed in as ${account.display_name || account.username}`)
      return credentials
    }
    const code = errorCode(polled)
    if (code === 'authorization_pending') continue
    if (code === 'slow_down') { interval += 5000; continue }
    wait.fail('Sign-in did not complete')
    if (code === 'access_denied') throw new WizardError('not_logged_in', 'sign-in was declined in the browser')
    if (code === 'expired_token') throw new WizardError('not_logged_in', 'the sign-in code expired; run the command again')
    throw new WizardError('not_logged_in', `sign-in failed: ${describe(polled)}`)
  }
  wait.fail('Sign-in timed out')
  throw new WizardError('not_logged_in', 'the sign-in code expired; run the command again')
}

/** Revokes the device credential on the platform and removes it locally. */
export async function logout(host: string): Promise<{ revoked: boolean; removed: boolean }> {
  const stored = readCredentials()
  let revoked = false
  if (stored) {
    const response = await request(`${stored.host || host}/identity/v1/connector/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${stored.access_token}` },
    }).catch(() => null)
    revoked = Boolean(response && (response.ok || response.status === 401))
  }
  return { revoked, removed: deleteCredentials() }
}

/** The signed-in account, confirmed with Identity when reachable. */
export async function whoami(host: string): Promise<{ account: Account; host: string; verified: boolean }> {
  const credential = storedCredential(host)
  if (!credential) throw new WizardError('not_logged_in', `not signed in to ${host}; run \`npx origingame login\``)
  const response = await request(`${host}/identity/v1/me`, { headers: { authorization: `Bearer ${credential.token}` } }).catch(() => null)
  if (response?.status === 401) throw new WizardError('not_logged_in', 'the saved sign-in was revoked; run `npx origingame login`')
  const me = response?.ok ? response.json?.user ?? response.json : null
  const account: Account | null = me && typeof me.id === 'number'
    ? { id: me.id, username: String(me.username ?? ''), display_name: String(me.display_name ?? me.username ?? '') }
    : credential.account
  if (!account) throw new WizardError('not_logged_in', 'could not read the signed-in account')
  return { account, host, verified: Boolean(response?.ok) }
}
