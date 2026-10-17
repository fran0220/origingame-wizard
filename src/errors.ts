import { redact } from './redact.js'

/** Stable error codes of the `--json` result (contracts §7), plus `invalid_arguments`. */
export type ErrorCode =
  | 'not_logged_in'
  | 'session_refused'
  | 'detect_failed'
  | 'build_failed'
  | 'adapt_failed'
  | 'artwork_failed'
  | 'upload_failed'
  | 'source_failed'
  | 'publish_failed'
  | 'readiness_failed'
  | 'rules_unavailable'
  | 'aborted'
  | 'invalid_arguments'

export class WizardError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(redact(message))
    this.code = code
    this.details = details
  }
}

/** Exit code: 0 success, 130 the person cancelled, 1 everything else. */
export function exitCodeFor(error: unknown): number {
  return error instanceof WizardError && error.code === 'aborted' ? 130 : 1
}

export function asWizardError(error: unknown, fallback: ErrorCode): WizardError {
  if (error instanceof WizardError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new WizardError(fallback, message)
}
