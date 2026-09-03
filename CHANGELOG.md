# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.3.0] - 2026-09-03

### Added

- Replacing a non-empty pad now **asks the user**, on clients that can show a
  prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice.

  The dialog names the pad and the character counts on both sides. It never
  carries pad content: pads are world-writable, and the text would otherwise be
  written by whoever edited the pad last and read by whoever is deciding.

- `replace_in_document` now asks too, but only when `replace_all` is about to
  change **more than one** occurrence. It carries `destructiveHint: true` and
  with a broad enough search string can take out as much of a pad as
  `set_document` does — which asks. A single, unique replacement still goes
  straight through: that is what the tool is for, and a dialog on every one of
  them is how people learn to tick without reading.

  The line is drawn on the count rather than on the flag, because the count is
  the mistake worth catching. The number comes from the same pass that builds
  the operations, so it is measured **inside** the open session: what the person
  is told is the pad as it stands, not as it stood when the model decided.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**: it is the only variable here that defaults to _on_, so
  failing open on a typo would leave the dialog running while the operator
  believed it was off.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did. The change is the package layout behind it, and it is what makes
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.
- The linter is **oxlint** instead of eslint plus typescript-eslint, which lifts
  the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1, so this
  repository was held on TypeScript 6 by its linter rather than by its code.
- The tool filter, the confirmation store, the host classifier and the
  documentation-asset generator now come from **`mcp-tool-allowlist`**,
  **`mcp-approval`**, **`mcp-internal-hosts`** and **`svg-asset-set`** rather
  than from copies kept here — 850 fewer lines, and one place to fix each.

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- The message after an unacknowledged edit no longer claims **"the pad was left
  unchanged"**. The History echo is the only acknowledgement this protocol has,
  and its absence says nothing about whether the server applied the operation —
  it may have, and only the echo missed the deadline. The old wording invited
  exactly the retry that turns one `append_to_document` into two; the new one
  says the outcome is unknown, points at `get_document`, and names the tool that
  must not simply be repeated.

- `RUSTPAD_READ_ONLY` now accepts `1` and `yes` as well as `true`, in any casing
  and with surrounding whitespace. A switch that _protects_ something is read
  leniently: `RUSTPAD_READ_ONLY=1` used to register all five write tools against
  an instance the operator meant to protect, silently. `RUSTPAD_INSECURE_TLS` is
  unchanged and still compares against exactly `true`, because it removes a
  protection and a typo there has to fail the safe way.

- A `confirm_token` that does not match is now refused with the reason —
  invalid, expired, or issued for different arguments — instead of being
  answered with a fresh prompt. The second is self-healing when a token merely
  expired and silent when the token was issued for a different pad or a
  different replacement, which is the case the binding exists to catch.

- Confirmation tokens are compared with a **constant-time** comparison. The
  copy in this repository used `!==`, which leaks through timing how much of a
  guess was right. Reaching a token still requires having received it in a
  previous tool result, so this closes a margin rather than a hole.
- An entry in `RUSTPAD_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back, so a value pasted into the
  wrong variable is not echoed into the client's log.

### Security

- An **empty pad is now established rather than assumed**. Rustpad sends no
  History message at all for a pad that was never written, so on the socket
  "this pad is empty" and "the history has not arrived yet" are the same
  silence — and the session stopped waiting after 300 ms of it. A slow instance,
  a database restore, a buffering proxy or round-trip time plus a TLS handshake
  was enough to make every tool see `text: ''` for a full pad.

  Which is the one state the write tools treat as safe. `set_document` skipped
  its confirmation entirely — no dialog, no token, the two-step guard on the
  only destructive tool simply absent — and then wrote at revision 0, which the
  server transforms to sit _beside_ the existing content rather than replacing
  it, while the reply said "0 → N characters". `create_document` had nothing to
  refuse, `append_to_document` put its text at the **top** of the pad, and
  `get_document_info` reported `length_characters: 0`. A guard that is present
  in every test and absent whenever the network is slow is worse than one that
  is missing, because nothing ever reports its absence.

  Every tool that acts on an empty pad now confirms it over `GET /api/text/{id}`
  first — the same document, read over a channel that does not depend on the
  timing of a burst. On disagreement the call fails instead of writing. Only
  when no History arrived at all, so an ordinary concurrent edit, which the
  operational transform handles correctly, is still not a failure.

- The confirmation for `replace_in_document` **no longer sorts `search` and
  `replace`**. The shared `setResourceKey` hashes its targets sorted, which is
  right for a set and wrong for this: the two strings come from the same
  vocabulary, so `[pad, "DEV", "PROD", "2"]` and `[pad, "PROD", "DEV", "2"]`
  produced the same key. A person who read "Search: DEV / Replace with: PROD"
  and ticked the box had also approved the exact reverse, and on a pad where
  both strings occur equally often the match count agreed as well — arrangeable
  by anyone, since pads are world-writable. An order-preserving key lives in
  `src/resource-key.ts`; the library is unchanged, because it does what its name
  says.

- The confirmation for `set_document` now binds **the content it destroys**, not
  only the replacement. The key was the pad plus a fingerprint of the new text,
  so the state the approval was given about did not enter it at all. Up to five
  minutes pass between the dialog and the second call against an instance with
  no authentication: a pad that read "TODO: buy milk" when the person approved
  "(14 characters)" could have grown by 40 kB before the token was quoted back,
  and the token was still accepted. Now it is refused and the question is asked
  again with the real numbers.

- A single History message can no longer **hold the event loop indefinitely**.
  `operations.length` is chosen upstream and applying one operation costs
  O(document length), so a 1 MiB frame of 35 000 minimal entries against a full
  256 KiB document measured at **84 seconds** of synchronous work — during which
  the settle deadline, which is only checked _around_ message handling, was
  never reached. The same run now ends at the deadline — 20 s by default,
  configurable — because that deadline is checked **inside** the folding loop.

  Not only adversarial: Rustpad replays a pad's whole operation history in one
  message on connect and never compacts it, so a heavily edited pad ran the
  same loop by accident. Which is also why the second guard, a cap on
  operations per message, sits above what a 1 MiB frame can carry rather than
  at a tighter, more satisfying number: a low count would refuse ordinary pads
  that work today, to save an adversary twenty seconds it can spend once per
  tool call either way.

## [0.2.0] - 2026-08-27

### Added

- `RUSTPAD_ALLOW_TOOLS` and `RUSTPAD_DENY_TOOLS` choose which of the 8
  tools are registered. Both take comma-separated tool names or a prefix with a
  trailing `*`, the allow list decides what is in and the deny list is subtracted
  from it, and `RUSTPAD_ALLOW_TOOLS=essential` selects a curated five —
  `get_document`, `get_document_info`, `create_document`, `set_document`, `append_to_document`. A model picks the right tool far more reliably from five than
  from eight, and every visible tool costs context on every request. Nothing
  changes for an installation that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list`
  and answers `tools/call` with "tool not found" — the same cut
  `RUSTPAD_READ_ONLY` already makes, not a second, weaker one.

  An entry that matches no tool **stops the server at startup**, naming the
  entry and listing the real names, rather than being ignored: an ignored typo
  leaves a tool missing from `tools/list` with nothing pointing at the cause.

### Changed

- The README now carries the same eight badges, in the same order, as every other
  MCP server in this family, all of them reading from npm rather than hard-coded;
  the opening follows one shape; and the standalone "Full documentation" line is
  gone, because the docs badge three lines above it points at the same page.

### Fixed

- The container image no longer ships OpenSSL 3.5.7-r0, which carries
  **CVE-2026-14456** (denial of service via unbounded memory growth). The pinned
  `node:24-alpine` digest is already the newest one; Alpine's fixed 3.5.8-r0 has
  simply not been rebuilt into it yet, so the runtime stage now upgrades
  `libcrypto3` and `libssl3` by name. Upgrading those two rather than running a
  blanket `apk upgrade` keeps the rest of the image exactly as the digest pins
  it. The step can go once the base image ships the fix.

## [0.1.2] - 2026-08-26

### Changed

- The check that decides whether `RUSTPAD_URL` points somewhere local — and
  therefore whether sending a credential over plain `http` is worth warning
  about — now uses the same host classifier as the other MCP servers in this
  family, in `src/hosts.ts`. The string comparison it replaces missed several
  spellings of the same address: `http://[::ffff:127.0.0.1]`, which `URL`
  canonicalises to `[::ffff:7f00:1]` before any check sees it, and `localhost.`
  with its root label. It also treated `127.example.com` as loopback, because it
  matched on the `127.` prefix, and so stayed quiet about a plain-http URL to a
  public host.

Nothing else changes: this server has no tool that takes a URL, so there is no
request whose target a caller can choose.

## [0.1.1] - 2026-08-19

### Changed

- First release published through the tag-driven pipeline (npm Trusted
  Publishing with provenance, GHCR multi-arch image, MCP registry entry).
  Functionally identical to 0.1.0.

## [0.1.0] - 2026-08-19

### Added

- Initial release: MCP server for Rustpad, the self-hosted collaborative
  text editor. Read tools (`get_document`, `get_document_info`, `get_stats`)
  over HTTP and the collaboration WebSocket; write tools (`create_document`,
  `set_document`, `append_to_document`, `replace_in_document`,
  `set_language`) speak Rustpad's operational-transformation protocol, so
  targeted edits leave concurrent edits elsewhere in the pad intact.

<!-- #endregion changelog -->
