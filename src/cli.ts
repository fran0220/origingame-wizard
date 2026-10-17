#!/usr/bin/env node
import { normalizeHost, parseOptions, USAGE, type Options } from './args.js'
import { runCleanup } from './cleanup.js'
import { DEFAULT_HOST, VERSION } from './constants.js'
import { deploy } from './deploy.js'
import { asWizardError, exitCodeFor, WizardError } from './errors.js'
import { deviceLogin, logout, whoami } from './login.js'
import { redact } from './redact.js'
import { createTelemetry } from './telemetry.js'
import { createUi, type Ui } from './ui.js'

function emit(options: Pick<Options, 'json'> | null, value: unknown): void {
  if (options?.json) process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<number> {
  let options: Options | null = null
  let ui: Ui | null = null
  const json = process.argv.includes('--json')
  try {
    options = parseOptions(process.argv.slice(2))
    if (options.command === 'help') { process.stdout.write(`${USAGE}\n`); return 0 }
    if (options.command === 'version') { process.stdout.write(`${VERSION}\n`); return 0 }
    ui = createUi(options)
    if (!options.json && !options.yes && !ui.interactive && options.command === 'deploy') {
      throw new WizardError('invalid_arguments', 'no interactive terminal: pass --yes (or --json) to accept the defaults')
    }
    const telemetry = createTelemetry(options.telemetry)
    const host = normalizeHost(options.host ?? process.env.OG_HOST ?? DEFAULT_HOST)
    switch (options.command) {
      case 'login': {
        const credentials = await deviceLogin(host, ui)
        emit(options, { ok: true, account: credentials.account, host })
        if (!options.json) ui.outro(`Signed in to ${host}`)
        return 0
      }
      case 'logout': {
        const result = await logout(host)
        emit(options, { ok: true, ...result })
        if (!options.json) ui.outro(result.removed ? 'Signed out' : 'Not signed in')
        return 0
      }
      case 'whoami': {
        const result = await whoami(host)
        emit(options, { ok: true, ...result })
        if (!options.json) ui.outro(`${result.account.display_name || result.account.username} (@${result.account.username}) on ${host}`)
        return 0
      }
      case 'deploy': {
        const result = await deploy(options, ui, telemetry)
        emit(options, result)
        if (!options.json) ui.outro(ui.interactive
          ? `Done. To publish an update later, run npx origingame in this folder again. Manage the game: ${result.portalUrl}`
          : `Play it: ${result.playUrl}`)
        return 0
      }
      default:
        return 0
    }
  } catch (raw) {
    const error = asWizardError(raw, 'publish_failed')
    const payload = { ok: false, error: { code: error.code, message: redact(error.message), ...(error.details ?? {}) } }
    if (json || options?.json) process.stdout.write(`${JSON.stringify(payload)}\n`)
    else if (ui) ui.error(`${error.code}: ${error.message}`)
    else process.stderr.write(`${error.code}: ${redact(error.message)}\n`)
    return exitCodeFor(error)
  } finally {
    await runCleanup()
  }
}

let interrupted = false
process.on('SIGINT', () => {
  if (interrupted) process.exit(130)
  interrupted = true
  process.stderr.write('\nCancelled; ending the session…\n')
  void runCleanup().finally(() => {
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'aborted', message: 'cancelled' } })}\n`)
    process.exit(130)
  })
})

main().then(code => { process.exitCode = code }, error => {
  process.stderr.write(`${redact(String((error as Error)?.stack ?? error))}\n`)
  process.exitCode = 1
})
