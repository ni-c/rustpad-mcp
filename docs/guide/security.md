# Security

The [SECURITY.md](https://github.com/ni-c/rustpad-mcp/blob/main/SECURITY.md) in
the repository is the authoritative policy (and the place to report
vulnerabilities — privately, please). This page explains the model.

## Start from what Rustpad is

**Rustpad has no authentication.** Anyone who can reach the instance and knows
or guesses a pad id can read and rewrite that pad. rustpad-mcp adds no access
control on top, because there is none to enforce. Consequences:

- Point the server only at an instance whose pads you consider public within
  their network.
- Never store secrets in pads.
- Treat every pad as attacker-controlled text — including text this server
  wrote earlier, which may have been edited since.

## Untrusted content marking

Every tool result that can contain pad-derived text is prefixed with an
explicit marker telling the model it is data to report on, never instructions
to follow. That covers `get_document`, `get_document_info` (user names and the
editor language are chosen by arbitrary clients) and even surviving upstream
error bodies. Confirmation prompts quote pad ids and character counts only.

## Confirmation tokens

`set_document` on a non-empty pad is the destructive operation here — the old
content is unrecoverable. It requires a server-generated, single-use token that
only ever appears in a *previous* tool result and is bound to the pad id
**and** a fingerprint of the replacement text. A confirmation obtained for one
replacement cannot execute a different one.

## The server is untrusted too

`RUSTPAD_URL` decides what sits at the other end of the WebSocket, so the
session layer treats the upstream itself as hostile input: every wait has a
wall-clock deadline, the message queue, frame size, tracked-user count and
inbound document size are capped, History messages are structurally validated,
and a connection that fails mid-handshake is closed, not leaked.

## TLS

`RUSTPAD_INSECURE_TLS=true` disables certificate validation **only** for the
configured connection, via a scoped dispatcher — never process-wide, and
`NODE_TLS_REJECT_UNAUTHORIZED` is never touched.

## Read-only mode

`RUSTPAD_READ_ONLY=true` does not "block" the write tools — it does not
register them, so the connection never advertises capabilities it would refuse.
