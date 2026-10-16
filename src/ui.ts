import * as clack from '@clack/prompts'
import pc from 'picocolors'
import { WizardError } from './errors.js'
import { redact } from './redact.js'

export interface Choice<T> { value: T; label: string; hint?: string }

export interface Spinner { stop(message?: string): void; fail(message?: string): void; update(message: string): void }

/**
 * The person-facing surface. `interactive` asks; otherwise every question
 * takes its default. In `--json` mode nothing but the final result is written
 * to stdout: progress goes to stderr as plain lines.
 */
export interface Ui {
  readonly interactive: boolean
  readonly json: boolean
  intro(title: string): void
  outro(message: string): void
  info(message: string): void
  step(message: string): void
  success(message: string): void
  warn(message: string): void
  error(message: string): void
  note(title: string, body: string): void
  spinner(message: string): Spinner
  confirm(message: string, initial: boolean): Promise<boolean>
  multiselect<T>(message: string, choices: Choice<T>[], initial: T[]): Promise<T[]>
  select<T>(message: string, choices: Choice<T>[], initial: T): Promise<T>
  text(message: string, initial: string, validate?: (value: string) => string | undefined): Promise<string>
}

function cancelled<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new WizardError('aborted', 'cancelled')
  return value as Exclude<T, symbol>
}

class JsonUi implements Ui {
  readonly interactive = false
  readonly json = true
  private line(prefix: string, message: string) { process.stderr.write(`${prefix}${redact(message)}\n`) }
  intro(title: string) { this.line('', title) }
  outro(message: string) { this.line('', message) }
  info(message: string) { this.line('  ', message) }
  step(message: string) { this.line('> ', message) }
  success(message: string) { this.line('ok ', message) }
  warn(message: string) { this.line('warning: ', message) }
  error(message: string) { this.line('error: ', message) }
  note(title: string, body: string) { this.line('', `${title}\n${body.split('\n').map(l => `  ${l}`).join('\n')}`) }
  spinner(message: string): Spinner {
    this.step(message)
    return { stop: m => m && this.success(m), fail: m => m && this.error(m), update: () => {} }
  }
  async confirm(_message: string, initial: boolean) { return initial }
  async multiselect<T>(_message: string, _choices: Choice<T>[], initial: T[]) { return initial }
  async select<T>(_message: string, _choices: Choice<T>[], initial: T) { return initial }
  async text(_message: string, initial: string) { return initial }
}

class ClackUi implements Ui {
  readonly json = false
  constructor(readonly interactive: boolean) {}
  intro(title: string) { clack.intro(pc.bgCyan(pc.black(` ${title} `))) }
  outro(message: string) { clack.outro(message) }
  info(message: string) { clack.log.info(redact(message)) }
  step(message: string) { clack.log.step(redact(message)) }
  success(message: string) { clack.log.success(redact(message)) }
  warn(message: string) { clack.log.warn(redact(message)) }
  error(message: string) { clack.log.error(redact(message)) }
  note(title: string, body: string) { clack.note(redact(body), title) }
  spinner(message: string): Spinner {
    const s = clack.spinner()
    s.start(message)
    return { stop: m => s.stop(m), fail: m => s.error(m), update: m => s.message(m) }
  }
  async confirm(message: string, initial: boolean) {
    if (!this.interactive) return initial
    return cancelled(await clack.confirm({ message, initialValue: initial }))
  }
  async multiselect<T>(message: string, choices: Choice<T>[], initial: T[]) {
    if (!this.interactive || !choices.length) return initial
    const options = choices.map(c => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) })) as Parameters<typeof clack.multiselect<T>>[0]['options']
    return cancelled<T[] | symbol>(await clack.multiselect<T>({ message, options, initialValues: initial, required: false }))
  }
  async select<T>(message: string, choices: Choice<T>[], initial: T) {
    if (!this.interactive) return initial
    const options = choices.map(c => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) })) as Parameters<typeof clack.select<T>>[0]['options']
    return cancelled<T | symbol>(await clack.select<T>({ message, options, initialValue: initial }))
  }
  async text(message: string, initial: string, validate?: (value: string) => string | undefined) {
    if (!this.interactive) return initial
    return cancelled(await clack.text({ message, initialValue: initial, ...(validate ? { validate: (v: string | undefined) => validate(v ?? '') } : {}) }))
  }
}

export function createUi(options: { json: boolean; yes: boolean }): Ui {
  if (options.json) return new JsonUi()
  return new ClackUi(!options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY))
}
