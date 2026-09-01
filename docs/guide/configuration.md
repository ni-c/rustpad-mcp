# Configuration

Four environment variables; only the first is required.

| Variable               | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `RUSTPAD_URL`          | yes      | Base URL of the instance, e.g. `https://rustpad.example.net`             |
| `RUSTPAD_READ_ONLY`    | no       | `true` registers only the read tools                                     |
| `RUSTPAD_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection only) |
| `ELICITATION`          | no       | `false` replaces the approval dialog with the two-call token             |

## One URL for everything

`RUSTPAD_URL` serves three purposes: the HTTP API (`/api/text`, `/api/stats`),
the collaboration WebSocket (`http`/`https` is mapped to `ws`/`wss`), and the
share links the tools return (`<RUSTPAD_URL>/#<pad-id>`). If your instance sits
behind a reverse proxy, that proxy must forward WebSocket upgrades on
`/api/socket/…`.

The URL is validated on start: only `http:`/`https:`, no embedded credentials,
no query string or fragment. A plain-`http` URL to a non-loopback host starts
with a warning — everything, including full pad content, would travel
unencrypted. A malformed URL exits instead of limping along.

## Boolean semantics

`RUSTPAD_READ_ONLY` and `RUSTPAD_INSECURE_TLS` compare against exactly the
string `true`. `True`, `1` or `yes` count as **false** — deliberately strict,
and the reason the server prints a banner on start when read-only or
insecure-TLS mode is actually active.

`ELICITATION` is the exception, in both directions: it is case-insensitive, and
a value that is neither `true` nor `false` **stops the server** instead of
falling back. It is the only one of the three that defaults to *on*, so failing
open on a typo would leave the dialog running while the operator believed it
was off.

## Turning the approval dialog off

Guarded tools — `set_document` on a non-empty pad, `replace_in_document` across
more than one match — ask a person through MCP elicitation before they act.
`ELICITATION=false` takes them to the two-call token instead. It does not
remove the guard; there is no setting in which a guarded call goes
unannounced.

The variable deliberately carries no `RUSTPAD_` prefix, which means it reaches
every MCP server in the same environment. [Asking a person](/guide/approval)
explains what that costs and what makes it visible.

## Ephemerality

Rustpad keeps documents in memory; they are lost when the server restarts and
after 24 hours without an open connection. If you want pads to survive, run the
Rustpad instance itself with `SQLITE_URI` (see the
[Rustpad README](https://github.com/ekzhang/rustpad#configuration)) — nothing
changes on the rustpad-mcp side.

## Limits worth knowing

- Documents are capped at 256 KiB by Rustpad itself; the server checks before
  sending and refuses edits that would exceed it.
- Tool results are budgeted to ~200 000 characters; a larger pad is truncated
  with an explicit notice rather than silently cut.
- Every network wait has a wall-clock timeout (15–20 s); a hostile or hung
  upstream costs a failed tool call, never a hung server.

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`RUSTPAD_ALLOW_TOOLS` and `RUSTPAD_DENY_TOOLS` let you draw your own:

```sh
RUSTPAD_ALLOW_TOOLS=essential
RUSTPAD_ALLOW_TOOLS=get_document,append_to_document
RUSTPAD_DENY_TOOLS=set_document
```

Why bother, when all eight work: a model chooses the right tool far more
reliably from a handful than from a long list, and every tool it can see costs
context on every single request. If this is the only MCP server in a session,
eight is fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or
a prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_x` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset of five:

`get_document`, `get_document_info`, `create_document`, `set_document`, `append_to_document`.

It composes — naming a tool alongside it puts that one back, and
`RUSTPAD_DENY_TOOLS` takes one away.

**Both together.** `RUSTPAD_ALLOW_TOOLS` decides what is in;
`RUSTPAD_DENY_TOOLS` is then subtracted from the result. With only a deny list,
everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable.
The same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming
one explicitly in `RUSTPAD_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write
tools is fine and simply contributes nothing, and
`RUSTPAD_ALLOW_TOOLS=essential` narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike — exactly what `RUSTPAD_READ_ONLY` does to a
write tool. There is no "hidden but callable" state to reason about.
:::
