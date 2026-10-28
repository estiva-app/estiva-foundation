# @estiva-app/protocol

Every entry answers the wire question explicitly, including when the answer is
nothing (ADR 0002 §4b). A change to the bytes an app publishes is a MAJOR — in
`0.x`, a MINOR — even when no TypeScript signature moved.

## 0.45.1 — 2026-10-28

**Wire behaviour: nothing changes** (APP-6). `Relay.queryAll` keeps a pooled
first page it used to throw away. When every filter of the batch is a plain
NIP-01 filter and every two ask disjoint values of some field, each event is
put in the run of the one filter it matches; a run that came back short is
settled, a full one pages on from where it ended. Before, a batch whose filters
named no Folder and shared a kind (a Folder listing's changes, in groups of ten
addresses) could not be split: its whole answer, 23.8 MB on production 27 Oct,
was discarded and every filter asked again. An event matching two filters still
leaves the batch unsplit, read the old way.

## 0.45.0 — 2026-10-27

**Wire behaviour: nothing changes** (PEEKM-7). `linksOnWordsOf(text)` reads
each link on words in one marker text, `[words](https://…)`, with where it
starts and ends, its words and its URL, by the same alternation `urlRunsIn`
and `valuesIn` read. conversation's composer used to repeat that pattern; it
now takes this one, so a box and a reader cannot disagree on which bracket
starts a link.

## 0.44.0 — 2026-10-26

**Wire behaviour: a re-listed file keeps every field; nothing else changes**
(SPEC §6.8, §13.3; 8de3e4b4). `imetaOf` now reads, and `imetaTag` writes back,
the rest of the relay's `imeta` allowlist: `blurhash`, `duration`, `bitrate`
and `image`, as the strings the tag held, and `fallback` as a list, since it is
the one key the relay lets repeat. Since an edit carries
every file the message keeps (§6.8, amended 2026-10-26), each writer re-lists
a message's files by reading them and writing them back, and before this an
edit of a file Buzz desktop sent (it writes `blurhash` and `duration`) dropped
both. `imetaFromAttrs`, and so `attachmentsInDocument`, stay at the eight the
editor's `attachment` block holds: a description is re-saved under whoever
saves it, so an attr the editor never wrote must not become their signed tag.
`fallback` is unchecked by the relay (any scheme, any host): carry it, never
draw it as a link or a source without checking. An `Imeta` read off a file without them
has the shape it had, with no new keys. A tag the app writes itself is
byte-for-byte unchanged; the order is `url m x size dim blurhash alt thumb
fallback duration bitrate image filename`. No message on production carried
any of the five on 2026-10-26 (0 of 153).

## 0.43.0 — 2026-10-26

**Wire behaviour: a description written from text changes; a message
unchanged** (SPEC §13.1, §13.3 "A description as text"; e0e3e907). A
description's text reads `[words](url)` as §13.1 has it: the words marked
`{"type":"link","attrs":{"href":url}}`, the shape the editors save a link on
words in (46 of 46 such runs on production, 2026-10-26). Before, it stayed
plain text, so a page the agent wrote, or a markdown paste into an editor that
spells blocks (a paste of paragraphs only does not reach this reader), stored
the brackets and the URL as words. The URL grammar is the one readers already
find links by (`http`, `https`, `mailto`, no space or `)`); a link in `code`,
any other scheme, a picture's `![alt](url)` and a URL with an unclosed `(`
stay text, and a `*` or `__` in a URL is never a marker. Words in backticks
inside a link are the link without `code`, which §13.1 lets combine with no
other mark. `blockDocumentToMarkerText(…, { description: true })` and
`tableToDescriptionText` print such a link back as `[words](url)`, so the text
reads back to the same document; a card's link (`embed`) still prints as its
URL, which §13.3 gives no spelling. `markersToInlineNodes` and
`inlineNodesToMarkers` take `{ links: true }` for this; without it, as in a
message, `[words](url)` stays text for its readers to find.

## 0.42.0 — 2026-10-20

**Wire behaviour: reading changed; writing unchanged** (SPEC §13.2; PEE-57;
Miky, 2026-10-20). A message's indented list item nests under the item above,
as a description's text already reads it (d98a5636): two spaces a level,
relative to the item above, a tab counting four. `toRenderTree(…, 'marker')`
gives such an item its `indent`, which `RichText` already draws, and
`markerTextToBlockDocument` without `description` gives it `attrs.indent`, so
an edit opens the list nested. Before, `  - b` under `- a` read as a line of
text that split the list in two. The writer has always spelled the indent
(`blockDocumentToMarkerText`), so nothing published changes; 0 of 1,017
messages on the relay carried one. A box, a callout and the `\` escape stay a
description's only.

## 0.41.0 — 2026-10-20

**Wire behaviour: reading changed; writing changed only for an editor that
opts in** (SPEC §13.3 "A reference's card", C22, C24; WBD-1; records
a-link-on-words-counts-toward-the-card, a-lone-links-chip-menu-offers-row-or-card,
every-app-edits-a-document-with-one-shared-editor). A block document now draws
its links by the line rule a message uses: `documentLineDrawOf(line, block)`
says, per line (`linesOf`), whether it is a sentence, a lone link's row, or —
when the link's mark carries `embed` `detailed` — its `card` in the row's
place. Every other `embed` value draws the row, and in a sentence any value
draws the chip only, so an old document that chose a card for a link in a
sentence stops drawing it (Miky, 15 Oct). A heading, a quote, a callout and a
table cell (`inTableCell`) are sentences; a checklist item is a line. A `link`
mark whose text is exactly its `href` is the bare URL in `isOnlyReferenceLine`
too (messages have no such mark, so they read as before); a link on words is a
sentence, and its `embed` draws nothing. `blockCards` is deprecated (Ship's and
Peek's readers still call it). `toEditorDocument(doc, { links: true })` keeps a
link on words as a `link` mark (`href`, the rest in `extra`) and
`fromEditorDocument` writes it back, `embed` included; without the option the
words stay and the link does not, as before — TipTap loads a document holding
a mark its schema lacks as empty, so only an editor with that mark opts in.
A `link` whose `href` is not `http`, `https`, `mailto` or `nostr` (§13.1,
`isAllowedHref`, tabs and spaces stripped as a URL parser does) is now no mark
for every reader and the editor, both ways: its words stay, as text, and a save
never writes it.

## 0.40.0 — 2026-10-17

**Wire behaviour: reading changed, nothing new written** (SPEC §13.6.2, C20,
C25, C26, C27; WBM-10; record a-link-on-words-counts-toward-the-card). A link
on words, `[these words](<app URL>)`, now names its file: `valuesIn` counts its
target, so `cardsIn` draws the card a message chose for it and `defaultCardOf`
gives it the default when it is the message's only file. Its words stay a link
(`linksAsReferences` and `lineDrawOf` unchanged), a URL in its words still
names nothing, and a web link that resolves to nothing still does not count.
A link on words whose words carry a mark (`[**words**](url)`, split across
runs) counts too, and a URL in such words now names nothing, as in plain words.
`[](url)` is not a link on words and names nothing. A block document's link run
counts its `href` whatever its words, code-styled words included. Old messages that chose a card on words draw it again (Miky, 17 Oct).

## 0.39.0 — 2026-10-16

**Wire behaviour: changed, on edits only** (SPEC §13.6.2; Widgets 2). An edit
now carries an `embed` layout this writer does not know as it was written
(`Embed.written`, from `embedsOf`), where 0.38.0 rewrote it as `compact`.
`defaultCardOf` loses the `embeds` option: a link taken out of a message and
put back gets its default card again, whichever ✕ removed it (Miky, 16 Oct).
Reading: `lineDrawOf`'s `row` and `nothing` carry `url` when the line is a URL,
so a reader that cannot read the file draws the URL, not an empty row. A URL
right after a letter outside the BMP (`𝑎https://…`) is stuck to that word, as
after any other Unicode letter or number.

## 0.38.0 — 2026-10-16

**Wire behaviour: changed — where a link sits decides how it draws in a
message** (SPEC §13.2, §13.6.2, C21, C26, C27; Widgets 2; record
where-a-link-sits-decides-how-it-draws). No new tag. Reading: a line that is
only a reference draws the file's row in place, and draws nothing when that
file has a card or a part under the message: `lineDrawOf` answers it per line
(`linesOf`), so Peek and Ship draw by one rule (`isOnlyReferenceLine` and
`isFolderValue` are its parts; a person or a Folder stays a chip).
Writing: `defaultCardOf` picks the one file that takes the default
`["embed", V, "detailed"]` at send or on an edit that names it first; the
file whose conversation the message is in does not count (Miky, 16 Oct), and
a value that already has an entry keeps it, so a ✕ after sending holds;
`withCard` sets one value in a folded set, for ✕ (`none`) or an edit's default;
`buildEdit` takes `embeds` and `mediaTags`, so an edit can carry the whole
set, written by `embedTagsOf` (normalised, once per value; a value that is not
an address or event id throws). Also exported: `valuesIn` (what a body names,
the count `cardsIn` uses) and `valueOfReference`, which Peek and Ship each
copied. **Changed:** a bare URL stuck to the end of a word (`seehttps://…`)
is no longer a link, in `urlRunsIn`, `linksAsReferences` and `cardsIn`, so it
names nothing and takes no `a`; and `cardsIn` now finds a URL by the same
rules `linksAsReferences` turns it by, run by run, so the target of a link on
words (`[the plan](https://…)`) names nothing and draws no card.

## 0.37.0 — 2026-10-15

**Wire behaviour: new — a comment can anchor to a run of blocks and the words
where its selection starts and ends** (SPEC §13.3 "A run of blocks", §13.6;
LEAF-7; record a-comment-remembers-where-its-selection-starts-and-ends). The
`block` tag lists every selected id, `["block", id1, …]`, read as a span (the
rule COM-2 decided for `part`); one id is today's tag unchanged. A new `quote`
tag carries the words: exact inside one block, the words at each end across
blocks or past 1,000 characters, and the text around them only when they
repeat. A selection of whole blocks carries none. New `selectionAnchorTags`
writes both; `resolveCommentAnchor` reads one into five states, the new one
`reworded` (the blocks are there, the words are not), which a reader must not
draw as `detached`. Also `blockRunTag`, `blockRunOf`, `readRunIds`,
`resolveBlockRun`, `quoteTag`, `quoteOf`. Nothing writes these yet; a reader on
`blockAnchorOf` still sees the run's first block, so Peek moves to
`resolveCommentAnchor` before any app writes a run.

## 0.36.0 — 2026-10-15

**Wire behaviour: none — the agent already published this; now an editor can
too** (SPEC §13.3 "A description as text", LEAF-10). New
`descriptionTextToBlockDocument(text, previous?)` reads a description's text
whole, as §13.3 has it: `markerTextToBlockDocument` with `{ description: true }`
plus a GFM pipe table as a `table` block, its ids carried from `previous`. And
`tableToDescriptionText(block)` prints a table back as GFM, or `undefined` for
a table §13.3 gives no spelling. Both moved here from the agent CLI (RIC-20,
estiva-agent#75), so the agent's `edit-issue` and an editor's markdown paste
read the same text the same way. One fix on the way: text that already held
the private-use character standing in for a table, spelling table 0's place,
became a second copy of that table; the stand-in is now a character the text
does not hold. A message's text is untouched: §13.2 has no table.

## 0.35.0 — 2026-10-14

**Wire behaviour: none for any app's editor; a description written as text can
now carry a nested list** (SPEC §13.3 "A description as text", d98a5636). With
`{ description: true }`, `markerTextToBlockDocument` reads an indented list item
as `attrs.indent` — relative to the item above, so two, three or four spaces
all mean one level under it, capped at `MAX_LIST_DEPTH` — and an indented item
of the other marker as an item of its list. `blockDocumentToMarkerText` escapes
a plain item whose text would read as a checklist box, and a plain quote whose
first line would read as a callout, with one more `\`, which reading takes off.
So the same text now publishes an indented item where 0.34.0 published a
paragraph, which is why this is a MINOR. A message's text, and an untagged
description's (§13.4), read exactly as before; `parseBodySegments` reads
indentation only with the new `{ indentedItems: true }`.

## 0.34.0 — 2026-10-14

**Wire behaviour: a new kind, `kind:30842`, the document** (SPEC, decided by
Miky 2026-10-14). The bare file's shape and tag order — `d`, `title`, `h`
(required; the relay refuses one without it), then `a` naming a parent of any
kind — under a kind an app owns through its `kind:31990`, as Ship owns an
issue. Leaf is the first owner. New `KIND.DOCUMENT` and `buildDocument`. Nothing
an app already publishes changes: a topic stays a `30840`, and no event
converts between the two.

## 0.33.0 — 2026-10-14

**Wire behaviour: a block document's reference mark may carry `attrs.embed`**,
the card its writer chose (Widgets, SPEC §13.3 "A reference's card"):
`compact` or `detailed`, with `none` written as no attribute. Nothing else
changes on the wire, and a reader on 0.32.0 draws the chip.

- `toRenderTree` puts it on the run as `embed` (`compact` | `detailed`), an
  unknown string read as `compact`. New `blockCards(block)` lists the cards to
  draw after one block, one per occurrence, in order; `cardLayout(raw)` reads
  one value.
- The editor translation carries `embed` onto the `reference` node, and any
  other key of the mark in the node's `extra`, and writes both back, so a save
  through an editor drops neither. An editor's `ReferenceNode` must declare
  `embed` and `extra` (`@estiva-app/ui/editor`), or ProseMirror drops them:
  take this release and that one together.
- `standaloneReference` is deprecated. A reference reads as its chip wherever
  it sits, in a description too.

**Wire behaviour: a URL in a block document can carry a card too.** It stays a
URL: plain text with no card, and with one a run whose text is the URL carries
`{"type":"link","attrs":{"href":<the URL>,"embed":…}}`. Never a URL rewritten
into a `nostr:` reference.

- `toRenderTree` reads a `link` mark onto the run as `href` (and `embed`), and no
  longer lets a mark it does not know into `marks`.
- `linksAsReferences` reads a block document's links as well: a plain URL, or a
  `link` run whose text is its `href`, becomes the reference it names, keeping
  its `embed`, so `blockCards` lists its card. A link on other words stays a link.
- The editor translation turns a `link` run whose text is its `href` into the
  `reference` node with `href` (a URL chip, `uri` empty until the editor
  resolves it) and writes it back as the same run; a URL chip with no card is
  plain text, merged with its neighbours — unless it came with a `link` mark
  (kept, so the bytes stay), or what follows would read as more of the URL (a
  word typed right after it, another URL chip), when a `link` mark keeps its
  end. An `embed` that is not a string rides through a save in `extra`, and
  `""` reads as no card, in the reader and the editor alike. A link on other words keeps its words
  and loses the link, as before.
- A `reference` or `link` mark whose `attrs` is not an object holding its
  string target (`uri`, `href`) is read as no mark, by `toRenderTree` and by
  the editor translation. A `reference` with `"attrs": null` used to throw
  for every reader of the document.
- New `referenceOfLink(url, resolveLink)` and `urlRunsIn(text)`, for an editor
  that turns an app's URLs into chips (`@estiva-app/ui/editor`'s `LinkChips`).

## 0.32.0 — 2026-10-13

**Wire behaviour: none.** A reader reads a message's links as references (OPT-18,
SPEC §13.6.2). New `linksAsReferences(blocks, resolveLink)` returns a message's
render tree with each bare app link that the caller's `LinkResolver` resolves (§7.7)
turned into a `reference` run for what it names. The run's text stays the URL.
A reader then draws it as that object's chip, the same as a `nostr:` reference.
These are left as they are: a link on words (`[words](url)`), a URL in code, and a link
nothing resolves. `cardsIn` names the same card for the tree before and after.
`standaloneReference` is now documented as for block documents only. In a
message, every reference is a chip and a card comes only from `embed`.

## 0.31.0 — 2026-10-13

**Wire behaviour: a message can ask for a reference's card** (OPT-16, SPEC
§13.6.2). New tag `["embed", <address or event id>, "compact" | "detailed" |
"none"]` on a `kind:9`, a `kind:1111` and their `40003` edits. `embedsOf` reads
it (first per value, an unknown layout as `compact`), `embedTag` writes it, and
`cardsIn` says which cards a message draws: the values its folded body still
names — by `nostr:` reference, or by an app link the caller's `LinkResolver`
resolves by §7.7 (without one, a link names nothing) — in body order, with a
`part` winning over an `embed`.
There is no `a`/`q` match, so an edit can give a card to a reference it added.
Nothing this package publishes changes: nothing writes `embed` yet, and a
reader on 0.30 ignores the tag and draws the reference as before.
`standaloneReference` is unchanged.

## 0.30.0 — 2026-10-13

**Wire behaviour: a block document can hold a checklist item and a callout**
(RIC-19, SPEC §13.3). Both are an attribute on a block that already exists, so a
reader on 0.29 still draws a plain list item and a plain quote with all their
text; its editor's save drops the attribute but no text and no id.

- A `listItem`'s `attrs.checked` is `true` or `false` on a checklist item —
  per item, on either list type, independent of `indent`. Absent, or any other
  value, is a plain item and never a reason to reject the document.
  `listItemChecked(item)` reads it; `toEditorDocument` drops a non-boolean one.
- A `blockquote`'s `attrs.tone` makes it a callout. `CALLOUT_TONES` are
  GitHub's alert names — `note`, `tip`, `important`, `warning`, `caution` (Miky,
  2026-10-13). `calloutTone(block)` reads it: not a string is a plain quote, and
  a string it does not know is a `note`; an editor keeps the string as written.
- `RenderBlock.checked` and `RenderBlock.tone`, from those two readers.
- `blockDocumentToMarkerText(doc, { description: true })` spells a checklist
  item `- [ ] ` / `- [x] ` and a callout as a quote whose first line is
  `[!WARNING]`; `markerTextToBlockDocument(text, previous, { description: true })`
  reads them back. Without the option nothing changes: a message stays §13.2's
  dialect, where `[x]` is text (Miky, 2026-10-13).

## 0.29.0 — 2026-10-12

**Wire behaviour: a block document can hold an indented list item** (MAN-13,
SPEC §13.3). An editor's save used to drop an item indented with Tab, text and
all; it now writes it.

- A list stays flat on the wire, and an indented `listItem` carries
  `attrs.indent` (a whole number, absent means 0). A reader on 0.28 still draws
  every item, level, and its editor's save drops the depth but no text and no id.
- `listItemDepths(items)` is how a reader must read it: anything but a whole
  number ≥ 0 is 0, and no item sits more than one level below the item before
  it, so the first is at 0 and the children of a deleted parent hang from the
  item above. None is deeper than `MAX_LIST_DEPTH` (8, SPEC's MUST; Miky,
  2026-10-12): a list one level deeper per item fits ~4,300 levels in 256 KiB
  and overflowed the stack on save.
- `toEditorDocument` nests indented items the way ProseMirror's Tab does, each
  inner list taking the outer list's type and no id; `fromEditorDocument` flattens
  them back, keeping every item's id. An inner list of the other type saves as
  the outer list's (Miky, 2026-10-12).
- `RenderBlock.indent` on a list item, from `listItemDepths`; a list's items stay
  its flat `children`.
- `blockDocumentToMarkerText` spells an indented item two spaces a level, each
  level numbered from 1. §13.2 has no nesting, so it reads back level.

## 0.28.1 — 2026-10-07

**Wire behaviour: no builder's bytes changed.** `absenceOf` was too trusting
(COM-2 security review).

- A `kind:5` now counts only when its signer is the address's author (NIP-09),
  or when it is the shape Buzz checks: no `e` tag, and the address is its first
  `a`. Buzz validates only the `e` targets, or only the first `a`, and stores
  every tag; a member could add somebody's address as an extra `a` and make a
  hidden object read "deleted". `deletions` items need `pubkey` again.

## 0.28.0 — 2026-10-07

**Wire behaviour: no builder's bytes changed; one tag is new and one is read
more narrowly** (COM-2, SPEC §13.6.1).

- New: a message points at one block of another object with
  `["part", <address>, <block id>]`. `partTag`, `partsOf` (one per address,
  first wins), `resolvePart` (five states: `resolved`, `unaddressable`,
  `detached`, `deleted`, `unreadable`) and `absenceOf`, which tells a deleted
  object from one you cannot read by a `kind:5` naming the address. The signer
  is not compared with the author: the relay accepts the author's owner too
  (§6.5), which no client can check. A part's block id must match
  `[A-Za-z0-9_-]{1,64}`; any other is dropped, because it ends up in a URL
  fragment and a selector.
- **Narrower:** `blockAnchorOf` returns `undefined` for an event whose `kind`
  is given and is not 1111. A `kind:9` has no `A` to say whose block it names;
  Ship read one against the page it was drawn on. Callers that pass only
  `{ tags }` behave as before.

## 0.27.0 — 2026-10-06

**Wire behaviour: no builder's bytes changed.** One builder removed (COM-3).

- **Breaking:** `buildComponent` and `KIND.COMPONENT` are gone. Kind 30841
  (NIP-FC Component) is retired: production never held one, no app published or
  read one, Estiva ID grants it to no app, and the relay refuses it. Never
  reallocate the number (KINDS.md).

## 0.26.2 — 2026-10-03

**Wire behaviour: unchanged.** One error message (MAN-17).

- `buildBareFile` without a channel now throws "a bare file must name the
  Folder it lives in (h)" — "Folder", never "team".

## 0.26.1 — 2026-10-01

**Wire behaviour: unchanged.** Same document shape; a different block keeps a
repeated id (MAN-10).

- **Fixed: Enter at the start of an anchored block moved its id to the new
  empty block.** Tiptap copies a split node's attrs to both halves, and
  `fromEditorDocument` kept a repeated id on the first in document order — the
  empty line above — so the comment anchored there (§13.6) pointed at nothing.
  A repeated id now stays on the first copy that holds text (a line break
  counts), and falls back to the first only when none does. A split in the
  middle or at the end keeps the id where it did; so does a pasted copy,
  unless the original has since been emptied, when the id follows the text.
- **Fixed: an ordinary block before an unknown block with the same id** kept
  it too, and the document went out with the id twice. An unknown block's id
  is now reserved wherever it sits, and the ordinary block is re-minted.

## 0.26.0 — 2026-09-30

**Wire behaviour: unchanged.** A block document's translation to and from an
editor, moved down from Ship so a second editor of one gets it (MAN-9).

- **New: `toEditorDocument` / `fromEditorDocument`** — a §13.3 document as
  ProseMirror's JSON and back, with every block id riding in
  `attrs.blockId`. An unknown block is parked as an `unknownBlock` atom
  carrying its source and its inline text, and handed back untouched; a
  duplicated id is re-minted on the way out; a `null` attribute is dropped.
  Ship's `src/lib/blockEditor.ts` (RIC-14) had the only copy, and Peek's
  editor for a declared prose field (`format: estiva-blocks-1`) needs the
  same one, or an edit there re-mints ids and detaches anchored comments.
- **New: `documentForEditing(value, format)`** — the document a stored value
  is edited as: parsed when tagged `blocks`, bridged from marker text
  otherwise, including a `blocks` value that does not parse.
- **New: `publishableFromEditor(doc)`** — what a save writes: the serialised
  document and `contentFormat: 'estiva-blocks-1'`, or `{ value: '' }` for an
  empty one.
- **New: `EDITOR_BLOCK_TYPES`, `UNKNOWN_BLOCK_NODE`, `REFERENCE_NODE`** — the
  node names the editor schema must supply; `@estiva-app/ui/editor` does.

## 0.25.0 — 2026-09-30

**Wire behaviour: unchanged.** One field read that was dropped before.

- **`Profile.bot`** (CON-5): `parseProfile` reports NIP-24's `bot: true`
  (present only when true; any other value is absent). SPEC §6.5, decided
  2026-09-29, offers Edit and Delete on a `bot: true` author's messages,
  because the viewer may be the agent's NIP-OA owner, and Peek reads its
  people through this parser. Estiva ID sets it on every agent's profile.

## 0.24.0 — 2026-09-29

**Wire behaviour: unchanged for every existing builder.** Two readers of a
block document, moved down from Ship so a second writer of one gets them.

- **New: `attachmentsInDocument(value, contentFormat?)`** (MAN-1) — every
  `attachment` block in a block document, depth-first, as the `imeta` set
  SPEC §13.3 requires the carrying event to hold. Empty unless
  `contentFormat` is `estiva-blocks-1`, and for a value that is not JSON.
  Ship's `src/nostr/attachments.ts` had the only copy; interop 0.36.0's prose
  writes need the same rule.
- **New: `imetaFromAttrs(attrs)`** — one block's `attrs` as an `Imeta`, or
  `undefined` when `url`, `m`, `x` or `size` is missing. The renderer's rule
  too: a block this declines to name is one not to draw as a file.

## 0.23.0 — 2026-09-24

**Wire behaviour: unchanged for every existing builder.** One new builder for
a kind Peek was already sending from its own hand-rolled copy.

- **New: `buildFolderCommand` (`kind:1852`), `KIND.FOLDER_COMMAND` and
  `type FolderOp`** (FOL-4). Tags `h`, `op`, one `a` per address in the order
  given, then an optional `name` — the shape buzz's `handle_folder_command`
  reads (`nfb-demo-kinds`; buzz `main` has no handler). Three of the four new
  wire vectors are **Peek's bytes**: rebuilt from its private `folderCommand`
  in `src/nostr/foreign.ts`, the only 1852 writer in the suite, with matching
  ids.
- **One deliberate difference from Peek's copy: the name is canonicalised**
  (`canonicalChannelName`), as `buildCreateChannel` and
  `buildEditChannelMetadata` already do. A Folder's state name shadows its
  channel's, so a name with a leading `#` or trailing space used to show one
  spelling in the listing and another on the channel. Plain names produce
  identical bytes; the `folderCommand-set-canonical-name` vector pins the
  difference.
- **Refused before a round trip:** an unknown `op` (the relay refuses rather
  than defaulting), an empty folder, an empty address, and a name that
  canonicalises to nothing.

## 0.22.0 — 2026-09-18

**Wire behaviour: unchanged for every kind that was already published.** One
new builder for a kind nothing in the suite had sent, and one constant for a
kind nothing in the suite may ever sign.

- **New: `buildDmHide` (`kind:41012`) and `KIND.DM_HIDE`.** One `h` naming the
  DM channel, empty content — mirroring `build_dm_hide`
  (`desktop/src-tauri/src/events.rs`), buzz's only builder for it. The relay
  sets the signer's own `hidden_at` on their membership row and nothing else:
  the DM, its participants and its history survive, and nobody else is told.
  The wire vector is this package's own computation, since the agent that
  wrote it holds no `41012` grant; Peek's DMS-6 live check publishes it as a
  signed-in person and reads the relay's echoed id.

- **New: `KIND.DM_VISIBILITY = 30622`, deliberately without a builder.** The
  relay's per-viewer hidden-DM snapshot: parameterized replaceable on
  `d` = viewer, one `h` per hidden channel, relay-signed and result-gated on
  its `p`. It is read with `{ kinds: [30622], '#p': [me], limit: 1 }` and
  never merged — the newest event is the whole set. An app that built one
  would be forging the relay's answer, and `ingest.rs` refuses it anyway.

- **Recorded on the constants, because it decides a client's design:** there
  is no unhide kind. `open_dm` clears the caller's `hidden_at` when the DM
  already exists, so a second `buildDmOpen` is the unhide; and a message
  arriving in a hidden DM does not resurface it.

## 0.21.0 — 2026-09-17

> **Corrected after publication (2026-09-17).** The entry below said a DM
> channel's uuid was *derived* from `compute_participant_hash`. It is not:
> `create_dm` mints `Uuid::new_v4()` and the hash is only the key the lookup
> resolves. Nothing in the package behaved on the wrong reading — it never
> tries to compute a uuid, it reads the one the relay answers with — so no
> code changed and 0.21.0 is not republished. Corrected because the wrong
> reading invites a client to compute a channel id offline, and the npm copy
> of this file still carries the old sentence until the next release.

**Wire behaviour: unchanged for every kind that was already published.** The
one new builder, `buildDmOpen`, emits a kind nothing in the suite had ever
sent; its bytes were checked against the relay before this was written, not
after (see below).

- **New: `buildDmOpen` (`kind:41010`) and `KIND.DM_OPEN`.** One `p` per *other*
  participant, no `h`, empty content — mirroring `build_dm_open`
  (`buzz-sdk/src/builders.rs:1544`). A DM channel's uuid is **minted by the
  relay** — randomly, and keyed by the participant set rather than computed
  from it — so unlike a topic the client cannot mint it, cannot pass one, and
  only learns it from the answer. `MAX_DM_OTHERS` (8) is enforced here so a
  tenth participant fails where a caller can say something about it.

- **`PublishResult.message`, and `commandPayload` to read it.** The relay's
  `message` was kept only on the `accepted:false` branch, where it becomes
  `reason`; on the accepted branch it was dropped. For an ordinary event that
  costs nothing, but a **command kind answers there** — `41010` replies
  `response:{"channel_id":…,"created":…}`, and that uuid exists nowhere else.
  Until now a caller could open a DM through `Relay.publish` and not learn what
  it had opened (found by DMS-2, `estiva-agent#47`).

- **`duplicate` is now set on the accepted branch too**, when the message says
  so. Measured against production on 2026-09-17: a *byte-identical* replay of a
  command event is answered `accepted:true`, `"duplicate: already processed"`,
  **and no payload** — `persist_command_event` keys on the event id, so the
  relay never re-runs the handler and has nothing to report. That is not a
  corner case: two clients opening the same DM in the same wall-clock second
  sign identical bytes. A caller that could not see `duplicate` there would read
  the missing payload as a command that simply answered nothing.

  Both duplicate shapes now report the same two fields, which is the point:
  `accepted:false` `"duplicate: channel already exists"` (a `9007` losing a
  race) and `accepted:true` `"duplicate: already processed"` (a command event
  replayed) mean the same thing to a caller.

## 0.20.0 — 2026-09-11

**Wire behaviour: the shape of `kind:30840` changes, and nothing already
published can disagree** — production held zero of them when the shape changed
(measured 2026-09-10), and no consumer called the old builder.

- **New: `buildBareFile`, replacing `buildFile`.** `kind:30840` is now the
  **bare file** — SPEC §6.7, decided in RFC 0.5 §10.7: a file no app owns,
  which a Peek topic now is. Tag order is normative: `d`, `title`, `h`, then at
  most one `a` naming the file it sits under, **of any kind**. `h` is required
  by the builder even though the relay only says SHOULD, for the reason issues
  already give: several apps write these and one forgetting it puts an
  unreachable object in the shared space. Content is a §13.3 block document or
  empty — not NIP-FC's component list, which blocks having ids (RIC-5) and
  attachments being blocks (RFC 0.6 §3) made redundant.
- **Deprecated: `buildComponent`.** Nothing publishes or reads a `30841`; kept
  until COM-3 decides whether the number is retired or repurposed.
- The `file` wire vector is re-recorded as `bare-file`, with the reason in its
  note. This is the one case where re-recording is right: the guard exists to
  catch an app's bytes *drifting*, and here no app had ever produced any.

## 0.19.0 — 2026-09-10

**Wire behaviour: the bytes an upload sends change.** `uploadBlob` now strips
an image's metadata before hashing it, so the blob's sha256 — and therefore the
`x` and `url` of the `imeta` that names it — differ from what the same file
would have produced in 0.18.0. Nothing already published can disagree, because
in 0.18.0 such an upload **failed**: the relay refused it. This turns a 422 into
a blob.

- **New: `canonicalizeImage`, and `uploadBlob` applies it by default.**

  Buzz refuses media carrying metadata, structurally — `validate_image_metadata_free`
  returns `MetadataForbidden` and the upload 422s with
  `media contains metadata or a non-canonical metadata channel`. Its video path
  names the piece that was missing: *"only the canonical primary stream produced
  by the client sanitizer is permitted."* There was no client sanitizer, in
  either app, so **an unmodified screenshot was refused every time** — capture
  tools write a `pHYs` and a `tEXt` software tag, and neither is on Buzz's
  rendering allowlist. `pHYs` is excluded deliberately; the relay's comment
  calls arbitrary values an identity channel.

  PNG: keeps the critical chunks and the eleven rendering ancillaries Buzz
  allows, plus a single Buzz snapshot-manifest `tEXt` — stripping that would
  leave a `.agent.png` that still looks like an image and silently no longer
  carries its manifest. JPEG: keeps a canonical JFIF `APP0` and a 12-byte Adobe
  `APP14`, drops `APP1`–`APP13` (EXIF lives in `APP1`), `APP15` and `COM`, and
  truncates trailing bytes after `EOI`, which is where a metadata editor leaves
  them.

  **Chunks are dropped, never re-encoded.** A canvas round trip is the obvious
  implementation and it does not work: the browser's encoder adds an ICC profile
  back, which the relay refuses identically. Dropping is also lossless — every
  chunk removed is ancillary by the format's own definition.

  GIF and WebP pass through untouched. Their metadata is not a droppable chunk
  (WebP records EXIF/ICC/XMP presence in `VP8X` flags that must stay consistent
  with the chunks; GIF hides it in extension blocks) and a wrong rewrite makes a
  corrupt image, which is worse than the refusal it replaces.

  `canonicalize: false` opts out for a caller sending something it does not want
  touched. It is not a way round a refusal — the relay's answer is the same.

## Backfill — 0.16.0 through 0.18.0

These three shipped without entries, which this file's own header forbids. The
omissions were mine. Recorded now rather than left as three published versions
whose wire question nobody answered. (`0.14.0` is still missing and is not mine
to reconstruct.)

## 0.18.0 — 2026-09-09

**Wire behaviour: unchanged in shape.** It adds a request an app did not make
before — `PUT /upload` — but nothing about a published event moves.

- **New: `uploadBlob`, `imetaFor`, `sha256Of`.** CON-12's write half. The
  upload must land before the message that names it: ingest runs
  `verify_imeta_blobs` and refuses a message whose blob it does not already
  hold, so a dangling attachment cannot be published at all. `imetaFor` exists
  because `m` and `x` must be the **relay's** answers about what it stored, not
  the client's guess from a file extension — `validate_imeta_tags` compares them
  and refuses with nothing to say which field was wrong.

## 0.17.0 — 2026-09-09

**Wire behaviour: unchanged.** Read-only; nothing is published.

- **New: `fetchBlob`, `sha256FromMediaUrl`.** Media GET is unconditionally
  authenticated — `get_blob` calls `authenticate_media_read` before it touches
  storage, and the `BUZZ_REQUIRE_MEDIA_GET_AUTH` flag that reads like an opt-in
  is inert — so an `<img src>` answers 401 and every reader has to sign a `get`
  authorization. Shared because both apps have the same problem with the same
  relay, and one trap is genuinely surprising: **a thumbnail authorizes against
  its parent hash**, since the relay splits `sha256_ext` on the first dot.

## 0.16.0 — 2026-09-08

**Wire behaviour: new.** Apps begin publishing an `imeta` tag on messages, and
signing a `kind:24242` that never existed here before.

- **New: `buildBlossomAuth`, `blossomAuthHeader`, `imetaTag`, `imetaOf`, `Imeta`.**
  A `kind:24242` Blossom authorization (BUD-01/BUD-11) and the NIP-92 tag that
  references a blob. Parsing lives here rather than in each app because the
  relay refuses a malformed tag, and a second parser is a second set of refusals
  to get wrong.

## 0.15.0 — 2026-09-07

**Wire behaviour: unchanged.** Nothing about what an app publishes moves, and
`queryAll`'s answer is element-for-element what it was. This is a change to how
many HTTP requests a read costs, and to nothing else.

- **New: `queryAll` asks for every filter's first page in one request.**

  Ship's workspace read was **39 requests and 1015 ms** warm, measured against
  production 2026-09-07 — and every one of those requests was a first page:
  nothing was paging at all. Buzz meters `POST /query` per *call*
  (`enforce_http_admission` runs before the filters are parsed) at 300 a minute
  per pubkey, shared across every app one person has open, so the request count
  was the entire cost.

  The same read is now **3 requests and 568 ms**, with the folded state
  byte-identical — 2,376,942 characters either way.

  Three measured facts make this a transport change rather than a semantic one:
  `limit` clamps **per filter** (10 filters at `limit: 5` returned 48 events,
  not 5); responses **concatenate rather than dedupe** (the same filter twice in
  one POST returned 236, not 118); and runs come back **grouped in filter
  order**, element-for-element identical to reading them singly. `queryAll`'s
  contract has always been that the answer is the serial concatenation — a
  batched response simply *is* that concatenation.

- **A filter is only settled by the batch when its own run can be identified.**

  Deciding "can this filter have more?" needs that filter's run length, and a
  flat response only yields it when the events can be attributed. Two exact
  discriminators, and between them they cover every batched read in the suite:
  distinct single `#h` values (the workspace read) and pairwise-disjoint `kinds`
  (the discovery pair). Anything else pages the old way, and a batch that could
  prove nothing is not even sent — a cold read of unattributable filters costs
  exactly what it did before.

  The bar is certainty rather than likelihood: a wrong attribution would
  under-count a run, call a clamped filter complete, and silently drop the rest
  of a Folder. That is SHA-8, which this read path exists to prevent.

- **New: `MAX_FILTERS_PER_QUERY`, and it is measured.** 128 accepted, 129
  refused with `too many explicit channels`, by binary search against production.
  The relay counts filter occurrences, not distinct Folders. Batches are chunked
  below it; a refused batch **fails the read** rather than being retried one
  filter at a time, because the likeliest reason for a refusal is the quota and
  the worst answer to that is thirty-six more requests.

- **New: `QueryAllOptions.batch`.** `false` restores the pre-0.15 shape, one
  request per filter.

## 0.13.0 — 2026-09-03

**Wire behaviour: unchanged.** Two readers over the resolved tree; nothing
about what an app publishes moves.

- **New: `standaloneReference` and `referencesIn` — where a reference belongs.**

  A reference that is the whole of a paragraph is somebody **attaching** an
  object. A reference inside a sentence is somebody **naming** one mid-thought,
  and cutting it out of the prose loses the sentence. Until now every app cut
  out every pointer, because a description had no structure to put a widget
  into; §13.3 gave it one.

  **The rule is here rather than in either app because two apps disagreeing
  about it makes the same body read differently in each** — SPEC §10's test.
  `stripNaddrs` applied separately by each consumer was never going to hold
  that line.

- **`referencesIn` reads the tree, not the string.** So a pointer quoted inside
  `` `code` `` is not counted: §13.1 makes code literal, and a pointer somebody
  quoted as an example is not one they are attaching. `findNaddrs` reads the
  raw text and cannot tell the difference — it stays, because widgets below the
  text are still driven from it, but this is the one to reach for when the
  question is what the *reader* sees.

  Control: letting any block count as standalone fails 1 test.

## 0.12.0 — 2026-09-03

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This adds a codec and a mark; nothing here changes what
an app publishes.

- **New: `encodeNpub` / `decodeNpub`.** NIP-19's simplest form and the one a
  mention needs — no TLV, just the 32 bytes bech32-encoded. `decodeNpub` is
  forgiving about a `nostr:` prefix and about case, for the same reason
  `decodeNaddr` is: what arrives was pasted by a person.

- **New: SPEC §13.1's `reference` mark is now parsed.** It was specified in
  §13.1 and implemented nowhere; a `nostr:` URI in a body was plain text. Now
  `parseInlineMarks` splits it into its own run carrying `reference`, the JSON
  encoding gets `{"type":"reference","attrs":{"uri":…}}`, and `RenderInline`
  carries it through to a consumer.

  **Why this matters, and it is not presentation.** A mention written as a
  display name needs the reader to hold the writer's directory, and message
  content is immutable — so a rename desynchronises the text from the `p` tags
  **permanently**. An `npub` needs nothing and survives a rename, because it
  never said the name.

  `text` stays the URI, which is what §13.1 requires a reader that cannot
  resolve one to show: "the URI's own label or its shortened form, never
  blank."

- **A reference inside `code` is not split.** Code content is literal (§13.1),
  and a URI somebody quoted as an example is not a link to follow. A reference
  inside *bold* keeps the bold, because the reference pass runs after the
  marker scan rather than instead of it.

- **New: `findNostrUris` and `NOSTR_URI_RE`** — every `nostr:` reference in a
  body, people included. Broader than `findNaddrs`, which answers "what objects
  does this embed" and drives widgets; this answers "what does this point at
  inline".

  Control: neutering the reference pass fails 5 tests.

## 0.11.0 — 2026-09-03

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This adds a reader for a tag SPEC §13.6 defines, and
nothing here writes one.

- **New: `anchors.ts` — a comment anchored to one block, SPEC §13.6.**
  `BLOCK_ANCHOR_TAG`, `blockAnchorOf`, `resolveBlockAnchor`, and the
  `BlockAnchor` union.

  **`resolveBlockAnchor` returns which of four states an anchor is in, rather
  than a block or `undefined`**, and that shape is the point. §13.6 requires a
  reader to distinguish *unanchored*, *resolved*, *unaddressable* and
  *detached*, because the pair that matters — detached and unanchored — render
  identically and mean opposite things: a remark about a paragraph somebody
  deleted, versus a remark about the whole object. A signature that lets a
  caller collapse them is a signature that invites the defect.

  Control: making `detached` return `unanchored` fails exactly the two tests
  written to catch it.

- **`unaddressable` is its own state, not a kind of detachment.** Marker text
  has no addressable sub-unit (§13.1), so an anchor against it never resolves
  and nothing was deleted. A reader saying "that paragraph is gone" about a
  marker-text description is wrong twice over.

- **A body that claims `blocks` and does not parse is `unaddressable`, not an
  exception.** It has no parts either, and a reader that throws renders nothing
  at all.

## 0.10.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. What this adds is the bridge that lets an app with a
*text* editor publish a **block document**, which is how a description acquires
addressable blocks before anybody builds a block editor.

- **New: `markerTextToBlockDocument` and `blockDocumentToMarkerText`.** Marker
  text in, a §13.3 document out, and back again.

  **`markerTextToBlockDocument` takes the previous document and carries its ids
  across**, and that is the entire point rather than a nicety. A description is
  replaced wholesale on every save; re-parsing into fresh blocks each time
  re-mints every id, and **every comment anchored to one detaches silently** —
  a detached comment renders exactly like one that was never anchored. The
  matching rule is written down in the module header: same type and identical
  text wherever it moved to, then same type at the same index, then a fresh id.

  Its limit is documented *and asserted*: a block moved **and** edited in one
  save matches neither pass and gets a new id. There is a test that fails if
  that ever silently changes, so the header cannot drift from the behaviour.

  Control: disabling the carry-forward fails 5 tests, including the corpus one.

- **An ordered list keeps the number its author wrote.** `BodySegment` of type
  `numbered` gains `start`, `RenderBlock` gains `start`, and a block document
  carries `attrs.start` — all absent when the list begins at 1.

  This is a **pre-existing rendering defect**, not something the bridge
  introduced. A body can hold two numbered runs split by a paragraph, the
  second written `2.` to continue the first; every renderer built on
  `parseBodySegments` has drawn it as `1.` since the dialect existed. One real
  body in the 152-body corpus does exactly this, and the round trip is what
  made it visible — renumbering somebody's list is a change to what they wrote,
  and it would have been written back to the relay permanently once a
  description is re-saved as blocks.

- **A NUL byte, removed from this package's own source.** `keyOf` used a
  literal `\x00` as its separator, which makes a file *binary* to the tools
  that read source: `grep` skips it and reports nothing, so a search for a
  symbol in that file comes back empty and looks like an answer. Ship's
  `fold.ts` carries a comment about this exact trap; this hit it anyway. It is
  an escape now.

## 0.9.0 — 2026-09-02

**Wire behaviour: unchanged.** Nothing about the bytes moved. One function and
two constants moved *between packages*, and `@estiva-app/interop` re-exports
them, so **no consumer of either package has to change anything.**

- **`contentFormatOf`, `CONTENT_FORMAT_TAG` and `BLOCK_DOCUMENT_FORMAT` move
  here from `@estiva-app/interop`.** They were defined there because the
  projection layer needed them first, and reading a tag off an event looked
  like a question about a slot.

  It is not — it is a question about an event, which is this package's subject.
  **Two folds outside the projection layer now need it**: Ship's and the
  agent's, which are one fold in two repositories held to a single recorded
  state by a conformance fixture. Making either depend on the projection layer
  to read a tag is the wrong direction, and a second copy of
  `'estiva-blocks-1'` is what this package exists to prevent.

- **`ContentFormat` is the name; `RenderFormat` is now an alias for it.** 0.8.0
  shipped `RenderFormat` and `interop` shipped `ContentFormat`, and they were
  the same three-value union declared twice — a duplicate introduced by 0.8.0
  and removed by this release. The old name still exports, so 0.8.0's consumers
  keep compiling.

- `interop` is unchanged in behaviour and re-exports all three names, with its
  147 tests passing untouched. `BODY_SLOT` stays in `interop`: a *slot* is that
  layer's subject, and this package has no opinion about which one carries a
  body.

## 0.8.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a resolver, and a resolver reads what
somebody else published.

- **New: `render.ts` — one resolved tree, whichever model the body is in.**
  `toRenderTree(value, format)` and `renderTreeText`. Marker text and a block
  document both become the same `RenderBlock[]`, so a consumer writes one
  mapper instead of two, and a block document's ids survive into it while
  marker text correctly has none.

  **This is what SPEC §13.5's "safe by construction" means in practice.** The
  safety is not a component — it is that an app is never handed a string it has
  to interpret. Marks are decided, blocks are decided, and there is nothing
  left to parse, so an app that maps this tree *cannot* accidentally render
  markup. There is a corpus test asserting every character of output came from
  the input; making the resolver append four characters fails 4 tests.

- **A tree rather than a shared component, and not for the reason the ticket
  said.** RIC-6 justified it as "Ship is vanilla `h()` and Peek is React". That
  was true when the ticket was written and is no longer: Ship's UI is React +
  Vite and both apps already depend on `@estiva-app/ui`, so a shared component
  was available. It is still a tree, for a better reason — **how rich text
  looks is the consumer's**, which is RFC 0.4 §13.1's rule for projections and
  SPEC §10's line about sharing the wire and never the interpretation. A shared
  component would make Ship and Peek look alike by construction, which nobody
  asked for.

- **`'unknown'` is handled here rather than in each consumer.** A format
  declared after this code was written becomes one unmarked paragraph of the
  raw value, which §13.5 says is conformant. Leaving that to consumers is how
  one of them ends up guessing.

- **A mis-tagged body degrades instead of throwing.** A `'blocks'` value that
  is not a document renders as its own text. A reader that throws renders an
  empty field, and an empty field is indistinguishable from a description
  nobody wrote.

## 0.7.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a second content model — the one SPEC
§13.3 specifies for a rich text field — and nothing yet publishes one.

- **New: `blocks.ts` — the rich text field, SPEC §13.3.** `parseBlockDocument`,
  `serializeBlockDocument`, `validateBlockDocument`, `newBlockId`,
  `assignMissingBlockIds`, `blockIds`, `findBlock`, `inlineTextOf`,
  `documentText`.

  **`assignMissingBlockIds` mints only what is missing**, and that is the whole
  point rather than an optimisation. An editor rebuilds its document on every
  keystroke; a rebuild that re-mints ids detaches every anchored comment on the
  next edit, and nothing reports it. A block id is what RFC 0.4 §6 anchoring
  binds to, so the function makes the safe path the easy one. There is a test
  that fails if it is changed to mint unconditionally.

- **New: the inline vocabulary's second serialisation** (§13.1) —
  `markersToInlineNodes`, `inlineNodesToMarkers`, `inlineNodesToText`. Held back
  from 0.6.0 on purpose: it had no consumer until the block model existed.

  Mark order in the JSON encoding is **deterministic**, because two encoders
  disagreeing about array order produce documents that differ byte-for-byte
  while meaning the same thing, and every equality check downstream — a diff, a
  dedupe, a cache key — is then wrong about it.

- **An unknown block type is not an error anywhere in this module.** §13.3
  requires a reader to draw its inline text and forbids dropping it silently,
  the same discipline §7.5 applies to widgets and for the same reason:
  consumers upgrade at different times. `validateBlockDocument` passes it,
  round-tripping preserves it whole, and `inlineTextOf` reads its text by shape
  rather than by name.

- **The `content-format` tag is deliberately NOT defined here.** §13.4's read
  rule is `contentFormatOf` in `@estiva-app/interop`, added in #26, because it
  is a question about an event and its slot rather than about a document.
  A second copy of `'estiva-blocks-1'` in this package is precisely the
  divergence this package exists to prevent, so `blocks.ts` never names it.

- **Tests: the claim §13 makes, checked rather than asserted.** The 152 real
  published bodies from 0.6.0 now go through both encodings, and no character
  changes its marks. Two controls were run against it — dropping `code` from
  the JSON encoding fails 4 tests, re-minting ids unconditionally fails 2.

## 0.6.0 — 2026-09-02

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. This release adds a parser, and a parser reads bytes
somebody else already published.

**What it does change is what readers draw**, which is not the wire and is not
nothing: an app that upgrades starts rendering backtick spans in messages that
have been on the relay for weeks. Measured 2026-09-02, that is **200 of 548
published message bodies** — the most common construct in the corpus, more
common than bold, and until now rendered by nobody. Upgrading is visible to
users on history, not only on new messages.

- **New: `content.ts` — the message marker dialect, SPEC §13.2.** `parseInlineMarks`,
  `wrapInlineMarks`, `parseBodySegments` and `stripInlineFormatting`, moved out
  of Peek's `src/lib/textParsing.ts` rather than written fresh, so the behaviour
  that was already shipping is preserved by construction. Peek's own tests for
  them are ported verbatim into `test/content.test.ts` as the proof.

  Only the **mark** layer moved. Peek's mentions and bracket references resolve
  against its own directory and fixtures, and they stay there — a mention is
  RIC-2's, and dragging its regexes along would have imported one app's mock
  data into the shared package.

- **New in the dialect: `code` and fenced code** (SPEC §13.1, §13.2). A code
  span carries `code` and never combines with another mark, and its content is
  never parsed for further marks — so `` `**x**` `` is four literal characters
  and a name.

- **SPEC §13.2's rule 2 does not fence a backtick**, and the corpus is why.
  Rule 2 keeps `2*3*4` literal, which an asymmetric prose marker needs and a
  backtick does not — applying it anyway left `` `main`s `` unparsed, a code
  span followed by a plural or possessive. Eight such spans in six published
  messages. SPEC was amended to say so (estiva-docs#56) rather than the parser
  quietly disagreeing with it.

- **Fixed while extracting: `stripInlineFormatting` was not idempotent.** It
  removed the heading prefix before the quote prefix, so `> # Heading` — the
  shape every project brief in this workspace is written in — came back as
  `# Heading` and previews showed a stray `#`. Prefixes are now stripped until
  the line stops changing. **This bug was invisible to the tests it shipped
  with** and was found by running the function over 152 real published bodies.

- **New: `test/corpus-bodies.json`** — 152 real message bodies from production.
  A parser checked only against fixtures written beside it is checked against
  its own assumptions; both defects above came from this file and neither came
  from the unit tests.

## 0.5.0 — 2026-09-01

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. `queryAll` returns the same events; it asks for them in
half as many requests.

- **A short page no longer always costs a confirming round trip.** `queryAll`
  spent two requests on every filter, including one holding three events, and
  on Ship's `loadAll` that doubling was **33 filters → 66 requests** against a
  relay that meters `POST /query` at 300 a minute.

  The confirmation existed for a real reason: a page shorter than the requested
  `limit` is ambiguous, because the relay clamps to `min(requested, ceiling)`
  and may have clamped at exactly that many. The ambiguity dissolves
  arithmetically rather than by trusting anyone — a clamp at `n` requires the
  ceiling to *equal* `n`, the ceiling is one constant for the relay, and the
  largest page it has already handed back is a lower bound on it. So
  `n < observedPageCeiling` rules the clamp out on evidence the relay itself
  produced.

  **Deliberately not NIP-11's `limitation.max_limit`.** That number is a claim,
  and a relay advertising more than it clamps to would make every page look
  short and the first one get mistaken for the whole set — the SHA-8 bug, back.
  Buzz currently advertises 1000 and clamps at 1000, so trusting it would work
  today; the source default in `nip11.rs` is 10000 against a `buzz-db` clamp of
  1000, so it has not always been true, and being right by luck is not a
  design. Substituting a trusted 1000 for the observed bound fails the SHA-8
  regression test outright, which is the control that settles it.

  Conservative before it has evidence: the first filter through a fresh `Relay`
  still confirms, and so does the **widest** filter on every read, since it
  ties its own bound. The floor is therefore one request per filter *plus one*.

  Measured on Ship's `loadAll` against production, published client versus this
  one: **66 requests → 35 cold, 34 warm — 48% fewer — 8.8 s → 0.9 s, and the
  fold compares equal event for event** (every project and issue address with
  its status, every change id, every conversation id).

- **This still does not fit a five-second poll.** 34 requests × 12 reads a
  minute is 408 against a 300 budget; at a ten-second poll it is 204 and fits.
  The remaining half is the caller's cadence, not this package's.

Additive with no signature change, but the request pattern a caller produces
changes, so a MINOR: ADR 0002 §4b puts the break on MINOR within `0.x`.

## 0.4.0 — 2026-09-01

**Wire behaviour: unchanged.** No builder, tag layout, id computation or
signature input moved. `queryAll` returns the same array it always did — see
below, that is the property the tests are about.

- **`queryAll` runs its filters concurrently**, bounded by the new
  `DEFAULT_QUERY_CONCURRENCY` (8) and overridable per call via
  `QueryAllOptions.concurrency`. `concurrency: 1` is the old serial read
  exactly.

  Filters handed to one call are independent; only the pages *inside* a filter
  are a cursor walk, and those stay sequential because page N+1's `until` is
  not known until page N has answered. Running the filters in sequence made a
  read cost the sum of every filter's latency. Measured on Ship's `loadAll`
  against production: **33 filters, 66 round trips, median 206 ms, 100% of wall
  clock spent inside `query` one request at a time.** The same read, same relay,
  same credentials, through this build: **9.0 s → 1.68 s, and the fold compares
  equal event for event** — every project and issue address with its status,
  every change id, every conversation id.

  The concurrency is deliberately not observable in the answer. Results are
  collected per filter and concatenated in filter order, and a failure reports
  the **lowest-indexed** filter's error rather than whichever request lost the
  race — so a broken read names the same filter twice running.

- **What this does not buy you: relay budget.** Buzz meters `POST /query`
  against `human_api_calls_per_min` — a fixed 60-second window, default 300,
  applied to every bridge call whatever tier the caller is. One Ship workspace
  read is 66 of those. Concurrency changes when a read spends its requests,
  never how many, so a poller that simply reads more often now spends the same
  allowance sooner. Documented at `DEFAULT_QUERY_CONCURRENCY` because it is the
  first thing a caller will get wrong.

Additive, and behaviour under a caller's existing call changes (requests now
overlap), so a MINOR: ADR 0002 §4b puts the break on MINOR within `0.x`.

## 0.3.0 — 2026-09-01

*Backfilled 2026-09-01. This release shipped without an entry, and so did 0.2.0
below — the file's own rule is that every release answers the wire question, and
twice it went unanswered. Recorded now from the release commits rather than left
as a gap.*

**Wire behaviour: unchanged.** NIP-19 is an encoding of a pointer, not of an
event; nothing an app publishes moved.

- **`nevent`** — `EventPointer`, `encodeNevent`, `decodeNevent`. An event that
  is not addressable had no reference form at all, so a plain `kind:9` message
  could be resolved by nothing. TLV type 0 carries the event id as 32 raw
  bytes, where `naddr` carries a UTF-8 `d`; that difference is the whole of the
  codec.

## 0.2.0 — 2026-08-28

*Backfilled 2026-09-01, from the release commit — see the note under 0.3.0.*

**Wire behaviour: unchanged.** A read-path fix; no published bytes moved.

- **`RELAY_PAGE_CEILING`, and `queryAll` pages instead of truncating.** Buzz
  clamps a REQ to its advertised NIP-11 `max_limit`, which halved from 10000 to
  1000, and NIP-01 has no truncation signal — so a caller asking for 2000 got
  1000 and no indication why. `limit: 2000` was a literal at four call sites
  across two apps and the agent, none of which could know when the relay changed
  it.

## 0.1.2 — 2026-08-27

**Wire behaviour: unchanged.** One constant added. No builder, tag layout, id
computation or signature input moved, and nothing an app already publishes
changes shape.

- **`KIND.APP_DATA = 30078`.** Two things in the suite need this number —
  NIP-RS read state (SPEC §11.6) and app-private user-owned storage (SPEC §12) —
  and a kind number is a fact about the relay rather than about an app, so the
  alternative was each of them defining it separately. Added when the second
  consumer appeared (CRO-11's stars migration) rather than speculatively.

  It carries the correction that made §12 possible: **the kind is not reserved
  for read state**, despite the relay naming its own constant `KIND_READ_STATE`.
  The NIP-RS handling is a narrow predicate — kind 30078, exactly one `d`
  matching `read-state:<32 lowercase hex>`, exactly one `["t","read-state"]` —
  and ingest performs no other `d`-tag validation. Anything outside it is an
  ordinary addressable event. A `d` beginning `read-state:` brings hard-deletion
  of superseded blobs with it, which app data must not acquire by accident, and
  the doc comment says so at the point of use.

Additive, so a PATCH: ADR 0002 §4b puts the break on MINOR within `0.x`.

## 0.1.1 — 2026-08-27

**Wire behaviour: unchanged.** Nothing in `src/` changed except the version
constant. The `dist/` a consumer receives is byte-identical to 0.1.0's apart from
that string, and no builder, tag layout, id computation or signature input moved.

**This release exists to exercise the release path, and that is the honest
description of it.** ADR 0002 §4c decided that releases publish through trusted
publishing (OIDC) with no npm credential in GitHub. 0.1.0 could not test that: a
package's first publish is necessarily manual, because a trusted publisher is
configured on a package that already exists. So until this tag, §4c was a
decision nobody had executed, and the trusted publisher was configured and
unexercised — the state in which a misconfiguration is cheapest to find and most
likely to be discovered at the worst moment instead.

What it carries, for completeness rather than as a reason to upgrade:

- **`npm run typecheck` worked in CI and failed on a fresh clone.** It was
  `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json`; the second pass
  typechecks `test/**/*.ts`, which import `../dist/index.js` on purpose because
  dist is what ships, so TypeScript resolves them to `dist/index.d.ts` — which
  does not exist until something builds. CI runs `build` first, so it was green.
  A fresh clone got eleven `TS2307`s that read as a broken package. Now
  `npm run build && tsc -p tsconfig.test.json`, which is one `tsc` invocation
  fewer, since the build already typechecks `src`.

**A consumer on `^0.1.0` needs to do nothing.** The range already admits this
version, neither changed file ships in the tarball's functional surface
(`tsconfig.test.json` is not in `files`, and `scripts` do not run for a
consumer), and the only observable difference is `PROTOCOL_VERSION`.

## 0.1.0 — 2026-08-27

First release. SHA-3.

**Wire behaviour: unchanged.** This is an extraction, not a change. The bytes are
pinned to what `peek-app/convex/nostr/` and `estiva-ship/lib/nostr/` were
producing before the package existed — `test/wire-vectors.json`, recorded from
those two trees at `98d284f` and `82e048b` — and all 12 event shapes both apps
implemented had byte-identical ids in both. Nothing in this release makes an app
publish a different event than it published yesterday.

Two things arrive here as the union of what the copies had, and neither changes
an existing app's output:

- **`buildMessage` takes `about`.** Peek's builder emitted `a` tags for
  cross-app routing; Ship's had no such parameter and could not emit one at all.
  Peek's shape ships. Omitting `about` produces byte-identical output to Ship's
  old builder — the `message-*` vectors pin both arms.
- **`KIND` is the union of both apps' constants.** A kind number is a fact about
  the relay, not about an app, and a subset is how an app ends up unable to
  *read* a kind its neighbour writes. Ship gains `NIP29_EDIT_METADATA`,
  `NIP29_DELETE_GROUP`, `ASSERTION`, `COMMENT` and `RELAY_AUTH` in its type
  surface; Peek gains `HIGHLIGHT`, `FILE` and `COMPONENT`. Nothing publishes
  anything new as a result.

One deliberate API reconciliation, called out because it is the one place a call
site had to change:

- **NIP-98 exports an unsigned builder plus a signer**, which was Peek's shape.
  Ship had a combined `buildAuthEvent(args & { secretKeyHex })`. The unsigned
  form is the one that works for an app holding no keys, and the combined form is
  `signEvent(buildUnsignedAuthEvent(args), secret)` — one line. The *tags* the
  two produced were already identical; the `nip98-auth-*` vectors pin that.

Also here, moved rather than written: the **relay socket client** (`createLiveRelay`,
PEE-5) and the **refcounted per-channel subscription manager**
(`createChannelSubscriptions`, PEE-6). Both were built inside `peek-app` because
Gate 2 had not happened when they were due, and both were Peek-only until now.
The only behavioural difference is that the REQ subscription id prefix is a
`subscriptionPrefix` option instead of the hardcoded `peek-`; it appears in the
relay's logs and nowhere else.

`Relay`'s second argument now accepts either the bare headers callback it took in
Ship or an options object (`{ headers, fetch }`), so the existing call sites bind
unchanged and a test can inject a transport.

### What this release does not include

The fold, and anything that interprets events. `foldFolder` stays in Ship,
`foldResolution` and the projection stay in Peek, and each app keeps its own
conformance fixture. See the README on the line this package does not cross.
