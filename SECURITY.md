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
is prefixed with an explicit untrusted-content marker. Confirmation prompts quote
pad ids and character counts only, never pad content or user names.

`RUSTPAD_READ_ONLY=true` narrows the server to the three read tools; the write tools
are not registered at all.

## Hostile-server hardening

`RUSTPAD_URL` decides what sits on the other end of the WebSocket, so the session
layer treats the server itself as untrusted input: every network wait has a
wall-clock deadline, message queue, frame size, tracked-user count and inbound
document size are all capped, History messages are structurally validated before
they are folded in, and a connection that fails mid-handshake is closed rather than
leaked. `RUSTPAD_INSECURE_TLS=true` relaxes certificate validation only for the
configured connection via a scoped dispatcher, never process-wide.

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
