import path from 'node:path'

/**
 * The secret scanner. It decides what never reaches the model and what is
 * never published:
 *
 * - `isSecretFile`: files that are credentials by name (`.env*`, `*.pem`,
 *   `*.key`, `id_*` SSH keys, package-registry and netrc files, keystores).
 *   They are left out of the staged copy and out of the model context.
 * - `findSecrets`: lines that look like credentials (provider key formats,
 *   private key blocks, `api_key = "…"` style assignments). A file with a hit
 *   is withheld from the model; if it is part of the game it is still
 *   published, and the run warns, because dropping it could break the game.
 */
const SECRET_NAMES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_[a-z0-9_]+$/i,
  /^id_[a-z0-9_]+\.pub$/i,
  /^\.(npmrc|yarnrc\.yml|pypirc|netrc|htpasswd|git-credentials|dockercfg)$/i,
  /^(credentials|secrets?)\.(json|ya?ml|toml|ini)$/i,
  /^service[-_]?account.*\.json$/i,
  /^firebase-adminsdk.*\.json$/i,
]

export function isSecretFile(file: string): boolean {
  const name = path.posix.basename(file.split(path.sep).join('/'))
  return SECRET_NAMES.some(pattern => pattern.test(name))
}

const PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['openai-style-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['origingame-credential', /\bog[pdw]?-[A-Za-z0-9_-]{16,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['connection-string', /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i],
  ['assigned-secret', /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/i],
]

export interface SecretHit { kind: string; line: number }

export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Minified bundles are one long line: scan it in overlapping windows.
    const windows: string[] = []
    for (let at = 0; at < line.length || at === 0; at += 16_000) {
      windows.push(line.slice(Math.max(0, at - 256), at + 16_000))
      if (at + 16_000 >= line.length) break
    }
    found: for (const window of windows) {
      for (const [kind, pattern] of PATTERNS) {
        if (pattern.test(window)) { hits.push({ kind, line: i + 1 }); break found }
      }
    }
  }
  return hits
}
