// The public origins the CLI derives from --host. A wrong derivation sends
// model calls to the Portal site, which does not serve the /v1 relay
// (docs/public-api.md: the relay rows are on api.<host> only).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiOrigin } from '../dist/model.js'

test('the relay of an https host is api.<host>; a loopback host relays itself', () => {
  delete process.env.ORIGINGAME_API_ORIGIN
  assert.equal(apiOrigin('https://origingame.ai'), 'https://api.origingame.ai')
  assert.equal(apiOrigin('https://staging.example.com'), 'https://api.staging.example.com')
  assert.equal(apiOrigin('http://127.0.0.1:4100'), 'http://127.0.0.1:4100')
})

test('ORIGINGAME_API_ORIGIN overrides it, https or localhost only', () => {
  process.env.ORIGINGAME_API_ORIGIN = 'https://relay.example.com/'
  try {
    assert.equal(apiOrigin('https://origingame.ai'), 'https://relay.example.com')
    process.env.ORIGINGAME_API_ORIGIN = 'http://relay.example.com'
    assert.throws(() => apiOrigin('https://origingame.ai'), /ORIGINGAME_API_ORIGIN/)
  } finally {
    delete process.env.ORIGINGAME_API_ORIGIN
  }
})
