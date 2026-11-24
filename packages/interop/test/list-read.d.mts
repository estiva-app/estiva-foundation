// Types for list-read.mjs, the tests' list, open and times reads (SPEC §6.13).
import type { FileTimes, SignedEvent } from '@estiva-app/protocol'

type Filter = Record<string, unknown>
type Query = (filters: Filter[]) => Promise<SignedEvent[]>
type Matches = (filter: Filter, event: SignedEvent) => boolean

export function matchesFilter(filter: Filter, event: SignedEvent): boolean
export function listAnswer(events: readonly SignedEvent[], filters: readonly Filter[], matches?: Matches): SignedEvent[]
export function timesOver(events: readonly SignedEvent[]): {
  times: (filters: Filter[]) => Promise<FileTimes[]>
  calls: Filter[][]
}
export function withListRead(
  plain: Query,
  events: readonly SignedEvent[] | (() => readonly SignedEvent[]),
  matches?: Matches,
): Query
