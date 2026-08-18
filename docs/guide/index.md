# What is rustpad-mcp?

rustpad-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server
for [Rustpad](https://github.com/ekzhang/rustpad), the efficient, minimal,
self-hosted collaborative text editor. It lets an AI assistant read pads, create
them, append to them, search-and-replace inside them, and set their editor
language — against your own instance.

## Why it exists

Rustpad's HTTP surface is read-only: `GET /api/text/{id}` and `GET /api/stats`.
Everything that changes a pad happens over a WebSocket speaking an
operational-transformation (OT) protocol. rustpad-mcp implements enough of that
protocol to act as a well-behaved client:

- **Edits are operations, not overwrites.** `append_to_document` and
  `replace_in_document` retain every character they do not touch. If a human is
  typing in the same pad at the same moment, the Rustpad server transforms the
  two edits against each other and both land.
- **Positions are Unicode code points.** Rustpad counts characters the way Rust
  does, not the way JavaScript strings do — the server gets this right, emoji
  and all, and rejects text that cannot survive the trip (unpaired surrogates).
- **The model is a visible collaborator.** While editing, the server announces
  itself as `rustpad-mcp`, so anyone with the pad open sees who is typing.

## What Rustpad is — and is not

Two properties of Rustpad shape everything this server does:

- **Pads are ephemeral.** Documents live in the Rustpad server's memory and are
  lost on restart and after 24 hours without an open connection (unless the
  instance runs with `SQLITE_URI` persistence). The tools say so in their
  results; treat pads as shared scratch space, not storage.
- **There is no authentication.** Anyone who can reach the instance and knows a
  pad id can read and write it. That makes every pad untrusted input — see
  [Security](/guide/security) for what the server does about it.

## The tool set

Eight tools: three read (`get_document`, `get_document_info`, `get_stats`) and
five write (`create_document`, `set_document`, `append_to_document`,
`replace_in_document`, `set_language`). The full list with parameters is in the
[tools reference](/reference/tools).
