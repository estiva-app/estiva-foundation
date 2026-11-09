/**
 * Whether a live watch must name teams to hear them.
 *
 * A relay that lists {@link LIVE_AS_STORED_EXTENSION} in its NIP-11
 * `supported_extensions` sends a request kept open every new event that
 * asking again would return for the same reader, from inside teams too,
 * without the request naming them (SPEC §5). Ours has since 9 Nov 2026
 * (buzz 460f3d77f). Upstream Buzz delivers a team's event live only to a
 * request that names the team by `#h`.
 *
 * why: https://github.com/estiva-app/estiva-docs/blob/main/decisions/a-request-kept-open-hears-what-asking-again-would-return.md
 */
export const LIVE_AS_STORED_EXTENSION = 'buzz-live-as-stored'

/**
 * `namesTeams` for {@link watchListedConversations} and
 * {@link watchTopicActivity} on the relay whose NIP-11 document is `info`
 * (`Relay.info()`): false when it lists {@link LIVE_AS_STORED_EXTENSION},
 * true otherwise, including for a document that is missing or malformed.
 * The watches default to false, the decided shape; an app that may run
 * against another relay passes `namesTeams: namesTeamsOn(await relay.info())`.
 */
export function namesTeamsOn(info: unknown): boolean {
  const extensions = (info as { supported_extensions?: unknown } | null | undefined)?.supported_extensions
  return !(Array.isArray(extensions) && extensions.includes(LIVE_AS_STORED_EXTENSION))
}
