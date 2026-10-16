/**
 * Telemetry hook. This version sends nothing: every call is a no-op whether
 * or not `--no-telemetry` (or `DO_NOT_TRACK=1`) is set. The hook exists so a
 * future version can report anonymous step outcomes (never paths, file
 * contents, prompts or credentials) behind the same opt-out, documented in
 * the README before it ships.
 */
export interface Telemetry { track(event: string, properties?: Record<string, string | number | boolean>): void }

export function createTelemetry(enabled: boolean): Telemetry {
  void enabled
  return { track() {} }
}
