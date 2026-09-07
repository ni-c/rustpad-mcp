# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/rustpad-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, internal hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

**Rustpad has no authentication.** Anyone who can reach the instance and knows (or
guesses) a pad id can read and rewrite that pad — this server adds no access control
on top, because there is none to enforce. Point it only at an instance whose pads
you consider public within their network, and never store secrets in pads.

Pads are therefore **attacker-controlled text by definition**, including text this
server wrote earlier, which may have been edited since. Every tool result that can
contain pad content — reads, document info, even surviving upstream error bodies —
is prefixed with an explicit untrusted-content marker, and control characters are
stripped from everything the instance wrote — pad text, user names, the editor
language, error bodies — with tab, newline and carriage return kept, and every
string made well-formed after any cut. Confirmation prompts quote pad ids, character
counts and, for `replace_in_document`, the search and replacement strings the caller
asked for (shortened and cleaned by the library) — never pad content or user names.

`RUSTPAD_READ_ONLY=true` narrows the server to the three read tools; the write tools
are not registered at all. It is parsed leniently — `true`, `1` and `yes` all switch
it on — because it is a protection, and a typo that quietly registered five write
tools against an unauthenticated instance is not something anyone would notice.
`RUSTPAD_INSECURE_TLS` is the opposite kind of switch and is compared against exactly
`true`, so a typo there leaves certificate validation in place.

## An empty pad is a claim, not a silence

Rustpad sends **no History message at all** for a pad that has never been written, so
on the collaboration socket "this pad is empty" and "the history has not arrived yet"
are the same observation. The session ends the initial burst after 300 ms of quiet,
which a slow instance, a database restore, a buffering proxy or round-trip time plus a
TLS handshake can outlast.

That mattered more than it sounds. An empty pad is exactly the state the write tools
treat as safe: `set_document` skips its confirmation entirely, `create_document` has
nothing to refuse, and an edit built on revision 0 is transformed by the server against
operations this client never saw — so the text lands _beside_ the existing content
while the reply reports a clean replace. A guard that is present in every test and
absent whenever the network is slow is worse than one that is missing.

So an empty pad is now confirmed over a second, independent channel — `GET
/api/text/{id}`, which reads the same in-memory document without depending on the
timing of a burst — before any tool acts on it. If the two disagree, the call fails
and says so instead of writing on a state that was never established. The check runs
only when no History arrived at all, which is the one genuinely ambiguous case;
comparing both channels on every call would turn an ordinary concurrent edit, which
the operational transform handles correctly, into a failure.

## What an approval binds

A confirmation is bound to a **resource key**, and what goes into that key is the whole
of what was approved:

- `set_document` binds the pad, a hash of the content it is about to destroy, and a
  hash of the replacement. The old content is in there because the dialog quotes it —
  "(14 characters)" — and up to five minutes pass before the second call reaches an
  instance with no authentication. An approval read out over one pad must not still
  execute against the 40 kB a colleague pasted in the meantime; it fails, and the
  person is asked again with the real numbers.
- `replace_in_document` binds the pad, the search and replacement strings **in order**,
  and the number of matches. The order is why these keys come from the shared library's
  `orderedResourceKey` and not its `setResourceKey`, which sorts its targets: `search`
  and `replace` are drawn from the same vocabulary, so sorted, "DEV → PROD" and
  "PROD → DEV" are one and the same approval — and on a pad where both occur equally
  often the count agrees too. Pads are world-writable, so an attacker can arrange
  precisely that.

The key proves binding. Freshness is proved separately, and it has to be: on protocol
revision `2026-07-28`, which this server serves over stdio since 0.3.0, the dialog is
a _return value_ — the call ends with `input_required`, the sealed request state
travels through the client, and the client comes back with a second `tools/call`
carrying the answer. A seal alone would let that reply be presented again for the
state's whole lifetime. So every sealed state carries a nonce (mcp-approval ≥ 0.8.1),
and the nonce is spent the first time an answer arrives with it, accepted or declined;
a second presentation counts as no answer and the person is asked again.
`test/approval-replay.test.ts` drives the approver this server builds through exactly
that sequence. The residual is honest and small: the record of spent nonces lives in
the process, so a restart forgets it — within the state's fifteen-minute lifetime, on
a server that was restarted in between, the same reply would be honoured once more.
On `2025-11-25` the SDK answers the dialog server-side inside the same call, and there
is no state to replay. The other half of the guard, the two-call `confirm_token`, is
single-use in any case.

An earlier version of this section said the replay path was unreachable, and a test
watched a protocol-version constant to say when that changed. The constant was the
list of _legacy_ revisions, which never carries the modern one; the path had been
reachable for two releases while the test stayed green. The claim is now tested
directly, which is the only kind of claim this file should make.

## Hostile-server hardening

`RUSTPAD_URL` decides what sits on the other end of the WebSocket, so the session
layer treats the server itself as untrusted input: every network wait has a
wall-clock deadline, message queue, frame size, tracked-user count and inbound
document size are all capped, History messages are structurally validated before
they are folded in — every frame has to be a JSON object, every operation an integer
or a string, and a History that starts past the revision this client holds is a gap
and refused — and a connection that fails mid-handshake is closed rather than leaked.

Two of those caps are worth being exact about, because both were once true only on
paper. The frame limit (1 MiB) is handed to the WebSocket implementation as its
payload limit, so a frame header announcing more fails the connection before a byte
of the payload is buffered; checked only on the assembled message, as it used to be,
it ran after undici had already held up to 128 MB. And the queue is bounded in bytes
(8 MiB) as well as in messages: a count of a thousand at the frame limit is a
gigabyte, measured at 424 MB for four hundred frames, in a process that mcp-hub
allows 192 MB.

The wall-clock deadline is checked **inside** the loop that folds a History message,
not only around it. Applying one operation costs O(document length) and
`operations.length` is chosen upstream, so the two multiply: a 1 MiB frame holds about
35 000 minimal entries, which against a full 256 KiB document measured at 84 seconds of
synchronous work in which no deadline was ever reached. It is now bounded by the
deadline itself. That frame is reachable adversarially through a hostile or compromised
instance — Rustpad has no authentication and public instances are the normal case —
and something close to it happens by accident on a heavily edited pad, since Rustpad
replays a pad's entire operation history in one message on connect and never compacts
it. A second cap limits operations per message, deliberately set above what a 1 MiB
frame can carry: a tighter count would refuse ordinary pads that work today, and the
deadline is the bound that measures the thing that actually costs.

`RUSTPAD_INSECURE_TLS=true` relaxes certificate validation only for the configured
connection via a scoped dispatcher, never process-wide.

## The confirmation, honestly

Replacing the content of a non-empty pad, and search-replacing across more than one
match, **ask a person** through MCP elicitation — a dialog raised by the server and
shown by the client, which the model cannot answer on its behalf. Nothing happens
until an answer comes back, and the approval is bound to the pad and the exact edit,
so one obtained for a rename cannot execute a different replacement.

Where the client cannot show a dialog, both fall back to a server-generated token
that can be used once within five minutes and is bound the same way. That fallback
is weaker and this server says so rather than implying somebody approved: **it
proves the call was made twice with the same arguments, and nothing more.** A model
can read the token out of the first result and quote it back in the same turn.

`ELICITATION=false` moves a capable client onto that fallback deliberately, for
deployments where a dialog is the wrong shape — a scheduled job, a test harness. It
does not remove the guard, the server prints one line at startup saying it is off,
and the fallback text names the server rather than blaming the client.
