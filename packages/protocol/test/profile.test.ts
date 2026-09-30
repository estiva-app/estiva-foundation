/*
  `parseProfile` — the one reader of a kind:0, so a person has one name in
  every app. Since 0.25.0 it also reports NIP-24's `bot`, which SPEC §6.5
  reads to decide whether Edit and Delete are offered on a message (CON-5).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseProfile } from '../dist/index.js'

describe('parseProfile', () => {
  it('reads either name key, and the picture', () => {
    assert.deepEqual(parseProfile({ content: '{"name":"Ship name","picture":"https://p/x.png"}' }), {
      displayName: 'Ship name',
      picture: 'https://p/x.png',
    })
    assert.equal(parseProfile({ content: '{"display_name":"Peek","name":"Ship"}' }).displayName, 'Peek')
  })

  it('reports bot: true, and nothing for any other value', () => {
    assert.equal(parseProfile({ content: '{"name":"Claude","bot":true}' }).bot, true)
    for (const other of ['false', '"true"', '1', 'null']) {
      assert.equal('bot' in parseProfile({ content: `{"name":"x","bot":${other}}` }), false, other)
    }
  })

  it('costs a name, never the read, when the content will not parse', () => {
    assert.deepEqual(parseProfile({ content: 'not json' }), {})
    assert.deepEqual(parseProfile(undefined), {})
  })
})
