/*
  ONE-4: a refused send, edit, reaction or file says one plain reason, the same
  in Peek, Ship and Leaf, whatever said no. The inputs below are the answers
  production gave on 4 Nov (`~/estiva/ONE-4-scratch/probe`) and each app's
  own refusals, as they reach the box today.
*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { refusalReason, tooLarge, uploadRefusal } from '../dist/index.js'

describe('refusalReason', () => {
  it('says a message over the limit is too long, from the relay or the builders', () => {
    assert.equal(refusalReason('{"error":"invalid: content exceeds maximum size of 262144 bytes (got 300000)"}'), 'it is too long')
    assert.equal(refusalReason(new Error('content is 300000 bytes, max 65536')), 'it is too long')
  })

  it('says an edit or reaction on a deleted message was deleted or out of reach, as the relay does not say which', () => {
    assert.equal(refusalReason('invalid: reaction target event not found'), 'this message was deleted, or you can no longer write here')
    assert.equal(refusalReason('invalid: edit target not found or not editable by you'), 'this message was deleted, or you can no longer write here')
    assert.equal(refusalReason('invalid: deletion target not found or not deletable by you'), 'this message was deleted, or you can no longer write here')
  })

  it('says a lost membership, a guest, a ban or a channel token as no longer able to write', () => {
    for (const reason of [
      'restricted: not a channel member',
      'restricted: not a relay member',
      'restricted: only members can post in this channel',
      'restricted: token does not have access to this channel',
      'blocked: you are banned from this community',
    ]) {
      assert.equal(refusalReason(reason), 'you can no longer write here', reason)
    }
  })

  it('says an archived team, a quota, a clock and a sign-in in plain words', () => {
    assert.equal(refusalReason('invalid: channel is archived'), 'this team is archived')
    assert.equal(refusalReason('rate-limited: quota exceeded; retry in 14s'), 'too many at once, try again in a moment')
    assert.equal(refusalReason('invalid: event timestamp too far from server time'), 'your computer’s clock is wrong; set it and try again')
    assert.equal(refusalReason('restricted: insufficient scope (need messages:write)'), 'you are signed out; sign in again')
    assert.equal(refusalReason('auth-required: sign in first'), 'you are signed out; sign in again')
  })

  it('never passes on the relay’s words for a reason it does not know', () => {
    assert.equal(refusalReason('invalid: something new'), 'something went wrong, try again')
    assert.equal(refusalReason(new TypeError('Failed to fetch')), 'something went wrong, try again')
    assert.equal(refusalReason(undefined), 'something went wrong, try again')
  })

  it('takes an app’s own cause as it is', () => {
    assert.equal(refusalReason({ cause: 'gone' }), 'this message was deleted, or you can no longer write here')
    assert.equal(refusalReason({ cause: 'empty' }), 'a message needs words or a file; Delete removes it')
  })
})

describe('tooLarge', () => {
  it('stops a file over its type’s limit before it uploads, and names the limit', () => {
    assert.equal(tooLarge({ size: 15 * 1024 * 1024, type: 'image/gif' }), 'Too large: the most is 10 MB')
    assert.equal(tooLarge({ size: 60 * 1024 * 1024, type: 'image/png' }), 'Too large: the most is 50 MB')
    assert.equal(tooLarge({ size: 140 * 1024 * 1024, type: 'video/mp4' }), 'Too large: the most is 100 MB')
  })

  it('lets a file at or under its limit through', () => {
    assert.equal(tooLarge({ size: 10 * 1024 * 1024, type: 'image/gif' }), undefined)
    assert.equal(tooLarge({ size: 40 * 1024 * 1024, type: 'video/mp4' }), undefined)
  })
})

describe('uploadRefusal', () => {
  it('names the limit the relay gave for a file too large, said once', () => {
    assert.equal(uploadRefusal(new Error('upload failed: 413 {"error":"file too large: 11535366 bytes (max 10485760)"}')), 'Too large: the most is 10 MB')
    assert.equal(uploadRefusal('Upload failed — upload failed: 413 {"error":"file too large: 120000000 bytes (max 104857600)"}'), 'Too large: the most is 100 MB')
  })

  it('names the type’s limit when Cloudflare answered with a page and no number', () => {
    assert.equal(uploadRefusal(new Error('upload failed: 413 <html><title>413 Payload Too Large</title></html>'), { type: 'video/mp4' }), 'Too large: the most is 100 MB')
  })

  it('says a refused type, an unreadable file, a quota and a sign-in in the card’s words', () => {
    assert.equal(uploadRefusal(new Error('upload failed: 415 {"error":"disallowed content type: application/x-msdownload"}')), 'This type of file can’t be added')
    assert.equal(uploadRefusal(new Error('upload failed: 422 {"error":"media contains metadata"}')), 'This file could not be read')
    assert.equal(uploadRefusal(new Error('upload failed: 429 {"error":"upload concurrency limit reached"}')), 'Too many at once, try again in a moment')
    assert.equal(uploadRefusal(new Error('upload failed: 401 {"error":"authentication failed"}')), 'Sign in again')
    assert.equal(uploadRefusal(new TypeError('Failed to fetch')), 'Could not upload, try again')
  })
})
