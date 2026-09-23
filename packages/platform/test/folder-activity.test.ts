/**
 * `createFolderActivity` — a factory, on purpose.
 *
 * Came from Peek's `foreignActivity.ts`, which was already written this way and
 * said why: "A module-level emitter is what `liveTopics.ts` did, and SHA-7 is
 * the bill for it." So this file inherits a suite that already ran with no app,
 * and the move cost it nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFolderActivity } from '../dist/index.js'

const FOLDER = '9f1c7c1e-0b8a-4f3d-9c2e-5a6b7c8d9e0f'
const OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

test('notifies the folder that changed, and only that one', () => {
  const activity = createFolderActivity()
  let mine = 0
  let theirs = 0
  activity.watch(FOLDER, () => mine++)
  activity.watch(OTHER, () => theirs++)
  activity.notify(FOLDER)
  assert.equal(mine, 1)
  assert.equal(theirs, 0)
})

test('carries the event when there is one, and none when there is not', () => {
  const activity = createFolderActivity()
  const got: (string | undefined)[] = []
  activity.watch(FOLDER, (event) => got.push(event?.id))
  activity.notify(FOLDER, { id: 'e1', kind: 9, pubkey: 'p', created_at: 1, tags: [['h', FOLDER]], content: '', sig: '' })
  activity.notify(FOLDER)
  assert.deepEqual(got, ['e1', undefined])
})

test('notifying a folder nobody watches is not an error', () => {
  const activity = createFolderActivity()
  assert.doesNotThrow(() => activity.notify(FOLDER))
})

test('two watchers of one folder both hear it', () => {
  const activity = createFolderActivity()
  const seen: string[] = []
  activity.watch(FOLDER, () => seen.push('first'))
  activity.watch(FOLDER, () => seen.push('second'))
  activity.notify(FOLDER)
  assert.deepEqual(seen, ['first', 'second'])
})

test('a listener that throws does not stop the others', () => {
  const activity = createFolderActivity()
  let reached = false
  activity.watch(FOLDER, () => {
    throw new Error('mine')
  })
  activity.watch(FOLDER, () => {
    reached = true
  })
  activity.notify(FOLDER)
  assert.equal(reached, true, 'the second listener must still run')
})

test('unsubscribing stops one listener without touching the other', () => {
  const activity = createFolderActivity()
  let kept = 0
  let dropped = 0
  const release = activity.watch(FOLDER, () => dropped++)
  activity.watch(FOLDER, () => kept++)
  release()
  activity.notify(FOLDER)
  assert.equal(dropped, 0)
  assert.equal(kept, 1)
})

test('unsubscribing twice is harmless', () => {
  const activity = createFolderActivity()
  const release = activity.watch(FOLDER, () => {})
  release()
  assert.doesNotThrow(release)
})

test('forgets a folder once its last listener leaves', () => {
  const activity = createFolderActivity()
  const release = activity.watch(FOLDER, () => {})
  assert.deepEqual(activity.watched(), [FOLDER])
  release()
  assert.deepEqual(activity.watched(), [], 'an empty set left behind is a slow leak')
})

test('two instances share nothing', () => {
  // The whole point of a factory over a module singleton: a second app, or a
  // second test, gets its own.
  const a = createFolderActivity()
  const b = createFolderActivity()
  let heard = 0
  a.watch(FOLDER, () => heard++)
  b.notify(FOLDER)
  assert.equal(heard, 0)
})
