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

## Confirmation tokens

Replacing the content of a non-empty pad requires a server-generated token that is
bound to the pad id **and** a fingerprint of the replacement text, and can be used
once within five minutes. A model cannot satisfy that gate on its own, and a token
issued for one replacement cannot be replayed for a different pad or different text.
