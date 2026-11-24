/*
  The relay's list and open reads (SPEC §6.13), over a test's own events.

  Since the close every app reads files this way: a filter saying `"fields":
  "newest"` picks first records, and the relay answers each with its fields'
  current changes, leaving out a file whose `deleted` field is set. A test's
  fake relay wraps its plain answer with `withListRead`, so the scenarios keep
  their events and the reads go the one way.
*/
import { filesOf } from '../dist/index.js'

/** Whether a plain filter picks the event: ids, kinds, authors, `#x` tags, since and until. */
export function matchesFilter(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    const held = event.tags.filter((t) => t[0] === key.slice(1)).map((t) => t[1])
    if (!held.some((v) => values.includes(v))) return false
  }
  return true
}

/**
 * The list read's answer to `filters` over `events`: each first record a
 * filter picks, with its fields' current changes; a deleted file is left out.
 */
export function listAnswer(events, filters) {
  const out = new Map()
  for (const filter of filters) {
    const { fields: _fields, text, limit, ...rest } = filter
    const roots = events.filter((e) => e.kind >= 30000 && matchesFilter(rest, e)).sort((a, b) => b.created_at - a.created_at)
    const picked = new Set(typeof limit === 'number' ? roots.slice(0, limit) : roots)
    // The open read (`text: true`) carries the current text as well.
    for (const file of filesOf(events, { withText: text === true })) {
      if (!picked.has(file.root) || file.fields.deleted?.value === 'true') continue
      for (const e of file.events) out.set(e.id, e)
    }
  }
  return [...out.values()]
}

/**
 * The relay's times read over `events` (§6.13, `"fields": "times"`): each
 * first record a filter picks, with the time and fields of each field's
 * current change, never a value. A join or leave (`member:`) is left out.
 */
export function timesOver(events) {
  const calls = []
  const roots = events.filter((e) => e.kind >= 30840 && e.kind <= 30852)
  const tag = (e, name) => e.tags.find((t) => t[0] === name)?.[1]
  const addressOf = (e) => `${e.kind}:${e.pubkey}:${tag(e, 'd')}`
  const times = async (filters) => {
    calls.push(filters)
    const picked = new Map()
    for (const f of filters) {
      if (f.fields !== 'times') throw new Error(`a times read says "fields": "times": ${JSON.stringify(f)}`)
      const { fields: _fields, limit, ...rest } = f
      const hit = roots.filter((e) => matchesFilter(rest, e)).sort((a, b) => b.created_at - a.created_at)
      for (const e of typeof limit === 'number' ? hit.slice(0, limit) : hit) picked.set(e.id, e)
    }
    return [...picked.values()].map((r) => {
      const a = addressOf(r)
      const h = tag(r, 'h') ?? null
      const heads = new Map()
      for (const c of events) {
        if (c.kind !== 1851 || tag(c, 'a') !== a) continue
        if (h && tag(c, 'h') !== h) continue
        const field = tag(c, 'field')
        if (!field || field.startsWith('member:')) continue
        const held = heads.get(field)
        if (!held || c.created_at > held.created_at) heads.set(field, c)
      }
      const changes = [...heads].map(([field, c]) => ({ id: c.id, created_at: c.created_at, fields: [field] }))
      const under = tag(r, 'a')
      return { a, created_at: r.created_at, h, ...(under ? { under } : {}), changes }
    })
  }
  return { times, calls }
}

/**
 * A query that answers every `"fields"` filter by the list read over `events`
 * and hands the rest to `plain`, in one answer.
 */
export function withListRead(plain, events) {
  return async (filters) => {
    if (process.env.LISTREAD_DEBUG) console.log('ASKED', JSON.stringify(filters))
    const listed = filters.filter((f) => f.fields === 'newest')
    const rest = filters.filter((f) => f.fields !== 'newest')
    const out = new Map()
    if (rest.length > 0) for (const e of await plain(rest)) out.set(e.id, e)
    for (const e of listAnswer(typeof events === 'function' ? events() : events, listed)) out.set(e.id, e)
    return [...out.values()]
  }
}
