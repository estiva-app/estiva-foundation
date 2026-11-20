# What a document's trip through text cannot carry

`document.property.test.ts` checks that a document comes back as it went in:
through a message's text (SPEC §13.2), through a description's text (§13.3,
"A description as text"), and through the editor. The editor's trip carries
everything. Text cannot carry what is listed here, so the made-up documents for
the two text trips leave it out (`EDITOR_ONLY` and the divider in
`src/testing.ts`). Each line says why, and what happens to it today.

Found by the test on 20 Nov 2026 (TES-3), on 10,000 documents a rule.

| What | In | Why text cannot carry it | What happens today |
| --- | --- | --- | --- |
| A divider | message, description | Neither §13.2 nor a description's text has a divider. The writer prints `---`, and the reader reads that as a paragraph of the text `---`. | Every comment box draws a divider when you type `---`, and the message is sent as the text `---`, so readers see the characters (filed in Ship, "A divider typed in a comment box arrives as ---"). In a description the agent keeps the divider block whole and refuses an edit around it. A markdown paste reads `---` as text. |
| A marker character meant as a character: `*`, `**`, `_`, `__`, `` ` ``, `x*`, `*not*`, `` `not` `` | message, description | §13.2 has no escape for an inline marker. A `*` written as text pairs with the next `*`, or with a real bold's markers, and reads as a mark: `*** plan **plan**` reads back as one bold run. | An editor turns typed markers into marks as you type, so a document rarely holds them. The agent keeps a block that would not read back whole and refuses an edit to it. |
| A mark on a marker-like word: a bold `*`, a link on `[a](b)` | message, description | The same: `***` around a `*` reads as an empty bold. | As above. |
| A paragraph line that starts with `# `, `## `, `- `, `1. ` or `> ` | message, description | §13.2 reads the prefix as a heading, an item or a quote, and has no escape for it. (A description escapes a box and a callout line only.) | An editor turns the prefix into that block as you type it, so a paragraph rarely starts with one. |
| A heading of level 3 | message, description | §13.2 has `# ` and `## ` only; `###` is text. | Only an editor makes one; the agent keeps it whole. |
| An empty paragraph (an empty line an editor keeps) | message, description | Text separates blocks by blank lines, so an empty one has no spelling. | The agent keeps it as it was while the text around it is unchanged. |
| A picture or file, a block from a later version | message, description | No spelling (§13.3, "A description as text": "No spelling"). | The agent keeps the block whole and refuses an edit around it. |

Three differences nobody can see are not counted as a change (`documentShape`):
which runs a line of text is split into, the marks on a line break, and the
order a run's marks are listed in.

Fixed rather than listed: a description read back over itself gave every list
item a new id (protocol 0.63.0).
