# Tools

Eight tools. `id` is always the pad id — the part after `#` in a pad's URL,
restricted to letters, digits, dot, underscore and hyphen. All results that
contain pad-derived text carry the untrusted-content marker.

With `RUSTPAD_READ_ONLY=true` only the three read tools are registered.

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

### set_document

| Parameter       | Type   | Required | Description                                  |
| --------------- | ------ | -------- | -------------------------------------------- |
| `id`            | string | yes      | Pad id                                       |
| `text`          | string | yes      | Full replacement content (≤ 256 KiB)         |
| `confirm_token` | string | no       | Token from the previous call, second call only |

Replaces the entire pad. **Replacing a non-empty pad requires confirmation**:
the first call returns a single-use token bound to the pad and the exact
replacement text; the second call with that token executes. Writing an empty
pad needs no token.

### append_to_document

| Parameter | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `id`      | string | yes      | Pad id                      |
| `text`    | string | yes      | Text to append verbatim     |

Appends at the end; everything else — including edits other collaborators make
at the same moment — is retained. Include a leading `\n` to start a new line.

### replace_in_document

| Parameter     | Type    | Required | Description                                       |
| ------------- | ------- | -------- | ------------------------------------------------- |
| `id`          | string  | yes      | Pad id                                            |
| `search`      | string  | yes      | Exact string to find (no regex)                   |
| `replace`     | string  | yes      | Replacement; may be empty to delete the match     |
| `replace_all` | boolean | no       | Replace every occurrence (default: unique match)  |

Only the matched ranges are edited, so concurrent edits elsewhere survive. By
default the search string must occur exactly once; otherwise the error reports
the count and suggests a longer search string or `replace_all`.

### set_language

| Parameter  | Type   | Required | Description                          |
| ---------- | ------ | -------- | ------------------------------------ |
| `id`       | string | yes      | Pad id                               |
| `language` | string | yes      | Monaco language id, e.g. `rust`      |

Sets the syntax-highlighting language for everyone; last writer wins.
