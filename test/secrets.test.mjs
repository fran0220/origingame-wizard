// The secret scanner is the only thing between a person's credentials and the
// model provider (and, for credential files, the public release). Ways it can fail:
// - a credential file name variant slips through (.env.local, SSH keys, keystores);
// - an ordinary game file is treated as a credential and silently dropped;
// - a key in a minified bundle (one very long line) is missed;
// - common credential formats are missed;
// - identifiers that merely mention "token" or "password" are flagged.
// The redactor is the last line for anything printed: it must hide tokens and
// Bearer values without mangling ordinary paths that start with "og-".
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { ROOT } from './helpers.mjs'

const { isSecretFile, findSecrets } = await import(path.join(ROOT, 'dist', 'secrets.js'))
const { redact } = await import(path.join(ROOT, 'dist', 'redact.js'))

test('credential files are recognized by name', () => {
  for (const file of ['.env', '.env.local', '.env.production', 'config/.env.development', 'id_rsa', 'id_ed25519', 'id_ed25519.pub', 'certs/server.pem', 'tls.key', 'release.keystore', 'android.jks', '.npmrc', '.netrc', 'secrets.json', 'credentials.yaml', 'service-account-prod.json']) {
    assert.equal(isSecretFile(file), true, file)
  }
})

test('ordinary game files are not credential files', () => {
  for (const file of ['index.html', 'env.js', 'keys.json', 'levels/keymap.json', 'monkey.png', 'assets/key.png', 'src/environment.ts', 'keyboard.js', 'id.png', 'README.md']) {
    assert.equal(isSecretFile(file), false, file)
  }
})

test('common credential formats are found, with their line', () => {
  const samples = {
    'aws-access-key': 'const id = "AKIAIOSFODNN7EXAMPLE"',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----',
    'github-token': `token: ${'gh' + 'p_'}aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`,
    // Provider prefixes are assembled at run time so the samples are not push-protection matches themselves.
    'stripe-key': `Stripe("${'sk_' + 'live_'}51HxxxxxxxxxxxxxxxxxxxxXX")`,
    'openai-style-key': 'apiKey: "sk-proj-abcdefghijklmnopqrstuvwx"',
    'origingame-credential': 'Authorization: og-abcdefghijklmnopqrstuv',
    'jwt': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'connection-string': 'postgres://admin:hunter2pass@db.example.com/game',
    'assigned-secret': 'const CLIENT_SECRET = "9f8e7d6c5b4a39281706"',
  }
  for (const [kind, line] of Object.entries(samples)) {
    assert.deepEqual(findSecrets(`// header\n${line}\n`), [{ kind, line: 2 }], kind)
  }
})

test('a key deep inside a minified one-line bundle is found', () => {
  const bundle = `${'a=1;'.repeat(20_000)}var k="AKIAIOSFODNN7EXAMPLE";${'b=2;'.repeat(20_000)}`
  assert.deepEqual(findSecrets(bundle), [{ kind: 'aws-access-key', line: 1 }])
})

test('identifiers that only mention secrets are not flagged', () => {
  const text = ['const tokenCount = 5', "let password = ''", 'const apiKeyLabel = "API key"', 'function resetPassword(user) {}', 'const SECRET_LEVEL = 7', 'skin-color: #fff'].join('\n')
  assert.deepEqual(findSecrets(text), [])
})

test('redaction hides tokens and Bearer values but leaves ordinary paths alone', () => {
  assert.equal(redact('Authorization: Bearer ogp-abcdefghijklmnopqrstuvwxyz012345'), 'Authorization: Bearer [redacted]')
  assert.equal(redact('key og-AbCdEfGhIjKlMnOpQrSt was refused'), 'key og-[redacted] was refused')
  assert.equal(redact('delegation ogd-publish-0123456789abcdef'), 'delegation ogd-[redacted]')
  assert.equal(redact('/tmp/og-wizard-home-x1Y2z3/.origingame/stage'), '/tmp/og-wizard-home-x1Y2z3/.origingame/stage')
})
