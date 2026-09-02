# Tools

All eight are registered unless you say otherwise. `RUSTPAD_ALLOW_TOOLS` and
`RUSTPAD_DENY_TOOLS` narrow the list to the ones you want, and `essential` selects a
curated five — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Eight tools. `id` is always the pad id — the part after `#` in a pad's URL,
restricted to letters, digits, dot, underscore and hyphen. All results that
contain pad-derived text carry the untrusted-content marker.

With `RUSTPAD_READ_ONLY=true` only the three read tools are registered.

Every tool declares an `outputSchema` and answers with `structuredContent`
beside the text block, so a client can use a result without parsing prose — the
five write tools used to answer with a sentence, and the sentence is still in
the text block. `get_document` answers `{text}` rather than the pad itself: a
schema whose root is a string is served to a 2025-era client rewritten as
`{result: …}`, and `empty` and `truncated` need somewhere to live either way.

The two read tools that report pad content carry `untrusted: true` and
`source: "rustpad"` as fields of the object, so the marker is something a client
can check rather than prose it has to notice.

👤 marks a tool that **asks a person** before it acts, through MCP elicitation —
where the client cannot show a dialog it falls back to a two-call
`confirm_token`. `ELICITATION=false` takes that fallback deliberately. See
[Asking a person](/guide/approval).

Every tool declares all four MCP annotations — `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`. The three reads are
`readOnlyHint: true`; `set_document` and `replace_in_document` are the two
marked `destructiveHint: true`; `openWorldHint` is `false` throughout, because
this server talks to the one Rustpad it is configured for.

## Read

### get_document

Reads the current plain-text content of a pad over HTTP.

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `id`      | string | yes      | Pad id      |

An empty result is ambiguous — Rustpad reports an empty pad, a pad that never
existed and an expired pad identically, and the result says so.

### get_document_info

Connects to the collaboration socket and reports metadata.

| Parameter | Type   | Required | Description |
| --------- | ------ | -------- | ----------- |
| `id`      | string | yes      | Pad id      |

Returns the pad's URL, content length in characters, revision number, editor
language and the display names of everyone who has the pad open right now.

### get_stats

No parameters. Server statistics: start time (raw and ISO), number of documents
currently in memory, number persisted in the database (0 without `SQLITE_URI`).

## Write

### create_document

| Parameter  | Type   | Required | Description                                   |
| ---------- | ------ | -------- | --------------------------------------------- |
| `id`       | string | no       | Desired pad id; omitted → a random one        |
| `text`     | string | no       | Initial content (≤ 256 KiB)                   |
| `language` | string | no       | Monaco language id, e.g. `markdown`           |

Fails if the pad already has content — use `set_document` or
`append_to_document` for that. Returns the shareable URL.

### set_document 👤

| Parameter       | Type   | Required | Description                                    |
| --------------- | ------ | -------- | ---------------------------------------------- |
| `id`            | string | yes      | Pad id                                         |
| `text`          | string | yes      | Full replacement content (≤ 256 KiB)           |
| `confirm_token` | string | no       | Only on the fallback path, second call only    |

Replaces the entire pad. **Replacing a non-empty pad asks a person first** — a
dialog the model cannot answer on its behalf. Where the client cannot show one,
the first call returns a single-use token bound to the pad and the exact
replacement text, and the second call with that token executes. Writing an
empty pad asks nothing: there is nothing to lose.

### append_to_document

| Parameter | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `id`      | string | yes      | Pad id                      |
| `text`    | string | yes      | Text to append verbatim     |

Appends at the end; everything else — including edits other collaborators make
at the same moment — is retained. Include a leading `\n` to start a new line.

### replace_in_document 👤

| Parameter       | Type    | Required | Description                                      |
| --------------- | ------- | -------- | ------------------------------------------------ |
| `id`            | string  | yes      | Pad id                                           |
| `search`        | string  | yes      | Exact string to find (no regex)                  |
| `replace`       | string  | yes      | Replacement; may be empty to delete the match    |
| `replace_all`   | boolean | no       | Replace every occurrence (default: unique match) |
| `confirm_token` | string  | no       | Only on the fallback path, second call only      |

Only the matched ranges are edited, so concurrent edits elsewhere survive. By
default the search string must occur exactly once; otherwise the error reports
the count and suggests a longer search string or `replace_all`.

**Asks a person when it is about to change more than one place.** A single,
unique replacement goes straight through — that is what the tool is for, and a
dialog on every one of them is how people learn to tick without reading. The
line is drawn on the count rather than on the flag, because the count is the
mistake worth catching: a search string that is shorter than intended matches
where nobody looked. The number in the prompt is measured inside the open
session, so it describes the pad as it stands.

### set_language

| Parameter  | Type   | Required | Description                          |
| ---------- | ------ | -------- | ------------------------------------ |
| `id`       | string | yes      | Pad id                               |
| `language` | string | yes      | Monaco language id, e.g. `rust`      |

Sets the syntax-highlighting language for everyone; last writer wins.
