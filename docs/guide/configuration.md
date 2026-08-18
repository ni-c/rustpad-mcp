# Configuration

Three environment variables; only the first is required.

| Variable               | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `RUSTPAD_URL`          | yes      | Base URL of the instance, e.g. `https://rustpad.example.net`             |
| `RUSTPAD_READ_ONLY`    | no       | `true` registers only the read tools                                     |
| `RUSTPAD_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection only) |

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

The two flags compare against exactly the string `true`. `True`, `1` or `yes`
count as **false** — deliberately strict, and the reason the server prints a
banner on start when read-only or insecure-TLS mode is actually active.

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
