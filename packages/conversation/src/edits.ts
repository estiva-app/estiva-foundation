/**
 * Edits — SPEC §6.8.
 *
 * An edit is a new `kind:40003`, never a rewrite, and what an app shows as
 * "edited" is a fold over the message and its edits. The latest edit wins, by
 * §6.3's ordering ({@link byOrder}). An edit whose target the reader cannot see
 * is held, not dropped: the target may arrive later, and the caller looks
 * edits up by id.
 *
 * An edit changes the body and the attachments, and nothing else. Attachments
 * fold separately: the set is the `imeta` of the latest edit carrying at least
 * one, and a set replaces rather than appends. The "edited" mark is about the
 * **body**: an edit byte-identical to the body it replaces, judged against the
 * body as it then stood, does not mark the message edited.
 *
 * Nothing here checks who wrote an edit against who wrote the message. The
 * relay adjudicates writes; a `40003` it stored is one it accepted — **for
 * the `e` it checked**, which is why an edit lands only on {@link editTargetOf}.
 */
import { imetaOf, type Imeta, type SignedEvent } from '@estiva-app/protocol'
import { isConversationKind, isEventId, KIND_EDIT } from './kinds.js'
import { byOrder, orderingMs } from './order.js'

/**
 * The message a `kind:40003` edits: **the first `e` whose value is 64 hex,
 * marker ignored**, lowercased (SPEC §6.8, PEE-38). That is exactly the event
 * whose ownership the relay checked (`validate_edit_ownership`), and a reader
 * MUST NOT apply an edit to any other `e` — an edit carrying
 * `['e', <own>, '', 'mention'], ['e', <victim>]` was accepted on the writer's
 * own message before CON-21, and must not be drawn on the victim's.
 *
 * Undefined when there is none, which the relay refuses; a reader holding one
 * anyway applies it nowhere.
 */
export function editTargetOf(event: Pick<SignedEvent, 'tags'>): string | undefined {
  const tag = event.tags.find((t) => t[0] === 'e' && isEventId(t[1]))
  return tag?.[1].toLowerCase()
}

/** One message's edits, folded. */
export interface EditFold {
  /** The body to show: the latest edit's content. */
  body: string
  /**
   * Whether any edit changed the body — what a reader MUST mark. With the
   * target's body unknown the first edit counts as a change: the mark errs
   * towards showing, and settles on the next read that holds the target.
   */
  edited: boolean
  /** When the body last changed, epoch milliseconds (`ts` when trusted). Absent unless `edited`. */
  editedAt?: number
  /** Who wrote the edit that last changed the body. Absent unless `edited`. */
  editedBy?: string
  /**
   * The `imeta` set of the latest edit carrying at least one. Absent when no
   * edit carries one: the message's own attachments stand, because an edit
   * with no `imeta` means "unchanged", never "none".
   */
  attachments?: Imeta[]
}

/**
 * Every `kind:40003` in `events`, grouped by {@link editTargetOf}, oldest first
 * by §6.3. Other kinds are ignored and a repeated id is read once.
 */
export function editsByTarget(events: readonly SignedEvent[]): Map<string, SignedEvent[]> {
  const out = new Map<string, SignedEvent[]>()
  const seen = new Set<string>()
  for (const event of events) {
    if (event.kind !== KIND_EDIT || seen.has(event.id)) continue
    seen.add(event.id)
    const target = editTargetOf(event)
    if (!target) continue
    const list = out.get(target)
    if (list) list.push(event)
    else out.set(target, [event])
  }
  for (const list of out.values()) list.sort(byOrder)
  return out
}

/**
 * Fold every edit in `events` onto its target (C12, C15).
 *
 * The body each edit replaces comes from `targets` when given, else from a
 * `kind:9` or `kind:1111` with the target's id in `events` itself — so a
 * caller holding the whole stream passes it once, and one holding only the
 * edits passes the bodies beside them. A target nobody edited is absent.
 */
export function foldEdits(
  events: readonly SignedEvent[],
  targets: readonly { id: string; body: string }[] = [],
): Record<string, EditFold> {
  const bodies = new Map<string, string>()
  for (const event of events) if (isConversationKind(event.kind)) bodies.set(event.id.toLowerCase(), event.content)
  for (const t of targets) bodies.set(t.id.toLowerCase(), t.body)

  const out: Record<string, EditFold> = {}
  for (const [target, list] of editsByTarget(events)) {
    let body = bodies.get(target)
    let changed: SignedEvent | undefined
    let attachments: Imeta[] | undefined
    for (const edit of list) {
      if (body === undefined || edit.content !== body) changed = edit
      body = edit.content
      const files = imetaOf(edit)
      if (files.length > 0) attachments = files
    }
    out[target] = {
      body: list[list.length - 1].content,
      edited: changed !== undefined,
      ...(changed ? { editedAt: orderingMs(changed), editedBy: changed.pubkey } : {}),
      ...(attachments ? { attachments } : {}),
    }
  }
  return out
}

/**
 * Every message's current attachment set: its own `imeta`, replaced by the
 * latest edit carrying any (§6.8, C15). Messages with none are absent.
 */
export function foldAttachments(events: readonly SignedEvent[]): Record<string, Imeta[]> {
  const out: Record<string, Imeta[]> = {}
  for (const event of events) {
    if (!isConversationKind(event.kind)) continue
    const files = imetaOf(event)
    if (files.length > 0) out[event.id.toLowerCase()] = files
  }
  for (const [target, list] of editsByTarget(events)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const files = imetaOf(list[i])
      if (files.length === 0) continue
      out[target] = files
      break
    }
  }
  return out
}
