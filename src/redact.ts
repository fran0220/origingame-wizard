/**
 * Removes credentials from any text before it is printed, logged or put in a
 * JSON result. Covers OriginGame account (`og-`), platform session (`ogp-`),
 * delegation (`ogd-`) and legacy (`sk-`) keys, and any `Bearer <token>`.
 */
const TOKEN = /\b(og[pdw]?-|sk-)(?=[A-Za-z0-9_-]*[A-Za-z0-9]{12})[A-Za-z0-9_-]{16,}/g
const BEARER = /(Bearer\s+)[^\s"',]+/gi

export function redact(text: string): string {
  return text.replace(BEARER, '$1[redacted]').replace(TOKEN, '$1[redacted]')
}
