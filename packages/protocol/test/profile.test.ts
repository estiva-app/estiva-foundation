/*
  `parseProfile` — the one reader of a kind:0, so a person has one name in
  every app. Since 0.25.0 it also reports NIP-24's `bot`, which SPEC §6.5
  reads to decide whether Edit and Delete are offered on a message (CON-5).
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
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

  /*
    PEE-79: whose agent it is comes from the owner's NIP-OA tag on the agent's
    profile, checked against the agent's own key. Signed here exactly as
    Estiva ID's computeAuthTag signs it.
  */
  describe('owner, from a NIP-OA tag on a bot profile', () => {
    const ownerSk = hexToBytes('01'.repeat(32))
    const agentSk = hexToBytes('02'.repeat(32))
    const strangerSk = hexToBytes('03'.repeat(32))
    const owner = bytesToHex(schnorr.getPublicKey(ownerSk))
    const agent = bytesToHex(schnorr.getPublicKey(agentSk))
    const stranger = bytesToHex(schnorr.getPublicKey(strangerSk))
    const sign = (sk: Uint8Array, about: string, conditions = '') =>
      bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${about}:${conditions}`)), sk))
    const bot = (tags: string[][], pubkey = agent) => ({ pubkey, tags, content: '{"name":"Claude","bot":true}' })

    it('names the owner when the tag verifies against the agent’s key', () => {
      assert.equal(parseProfile(bot([['auth', owner, '', sign(ownerSk, agent)]])).owner, owner)
    })

    it('names nobody for a tag signed by someone else, about another agent, with conditions, or vouching for itself', () => {
      assert.equal(parseProfile(bot([['auth', owner, '', sign(strangerSk, agent)]])).owner, undefined)
      assert.equal(parseProfile(bot([['auth', owner, '', sign(ownerSk, stranger)]])).owner, undefined)
      assert.equal(parseProfile(bot([['auth', owner, 'kind=1', sign(ownerSk, agent, 'kind=1')]])).owner, undefined)
      assert.equal(parseProfile(bot([['auth', agent, '', sign(agentSk, agent)]])).owner, undefined)
      assert.equal(parseProfile(bot([['auth', owner, '', 'zz']])).owner, undefined)
    })

    it('reads no owner off a profile that is not a bot’s', () => {
      const tags = [['auth', owner, '', sign(ownerSk, agent)]]
      assert.equal(parseProfile({ pubkey: agent, tags, content: '{"name":"Claude"}' }).owner, undefined)
    })
  })

  it('costs a name, never the read, when the content will not parse', () => {
    assert.deepEqual(parseProfile({ content: 'not json' }), {})
    assert.deepEqual(parseProfile(undefined), {})
  })
})
