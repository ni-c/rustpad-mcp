# rustpad-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/rustpad-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/rustpad-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rustpad-mcp)](https://www.npmjs.com/package/rustpad-mcp)
[![downloads](https://img.shields.io/npm/dm/rustpad-mcp)](https://www.npmjs.com/package/rustpad-mcp)
[![container](https://img.shields.io/badge/ghcr.io-rustpad--mcp-blue?logo=docker&logoColor=white)](https://github.com/ni-c/rustpad-mcp/pkgs/container/rustpad-mcp)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![docs](https://img.shields.io/badge/docs-rustpad--mcp.ni--c.de-4f46e5)](https://rustpad-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Rustpad](https://github.com/ekzhang/rustpad), the efficient, minimal,
self-hosted collaborative text editor.

It gives an AI assistant read and write access to the pads of a Rustpad
instance. Reads go through Rustpad's HTTP API; writes speak the
operational-transformation WebSocket protocol, so targeted edits
(`append_to_document`, `replace_in_document`) merge cleanly with what human
collaborators type at the same time instead of overwriting it. While the
server edits a pad, it is visible to everyone in the pad as a collaborator
named `rustpad-mcp`.

📖 **[Full documentation at rustpad-mcp.ni-c.de](https://rustpad-mcp.ni-c.de)**

![Demo of rustpad-mcp over the MCP inspector](https://rustpad-mcp.ni-c.de/demo.gif)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://rustpad-mcp.ni-c.de/architecture-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://rustpad-mcp.ni-c.de/architecture-light.svg" />
  <img alt="Architecture: an MCP client talks to rustpad-mcp over stdio; rustpad-mcp reads pads over HTTPS and writes them over the WebSocket OT protocol" src="https://rustpad-mcp.ni-c.de/architecture.svg" />
</picture>

## Requirements

- A reachable Rustpad instance (self-hosted; the server is stateless and
  needs no credentials — Rustpad has no authentication)
- Node.js >= 22, or Docker

## Configuration

| Variable               | Required | Description                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------ |
| `RUSTPAD_URL`          | yes      | Base URL of the instance, e.g. `https://rustpad.example.net`             |
| `RUSTPAD_READ_ONLY`    | no       | `true` registers only the read tools                                     |
| `RUSTPAD_INSECURE_TLS` | no       | `true` accepts self-signed certificates (scoped to this connection only) |

The same URL serves the HTTP API, the WebSocket endpoint and the share links
returned by the tools (`<RUSTPAD_URL>/#<pad-id>`). Booleans must be exactly
`true`. The server starts and lists its tools without configuration; every
call then fails with setup instructions.

Keep in mind what Rustpad is: **pads are ephemeral** (lost on server restart
and after 24 hours of inactivity, unless the instance is run with
`SQLITE_URI`) and **anyone who knows a pad id can read and write it**. Do not
put secrets in pads.

## Installation

### Claude Code

```sh
claude mcp add rustpad --env RUSTPAD_URL=https://rustpad.example.net -- npx rustpad-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "rustpad": {
      "command": "npx",
      "args": ["rustpad-mcp"],
      "env": {
        "RUSTPAD_URL": "https://rustpad.example.net"
      }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.rustpad]
command = "npx"
args = ["-y", "rustpad-mcp"]

[mcp_servers.rustpad.env]
RUSTPAD_URL = "https://rustpad.example.net"
```

### Docker

```sh
docker run -i --rm -e RUSTPAD_URL=https://rustpad.example.net ghcr.io/ni-c/rustpad-mcp
```

## Tools

| Tool                  | Description                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| `get_document`        | Read the plain-text content of a pad                                      |
| `get_document_info`   | Content length, revision, language and the users editing right now        |
| `get_stats`           | Server statistics (uptime, number of documents)                           |
| `create_document`     | Create a pad (random or chosen id), optionally with content and language  |
| `set_document`        | Replace the entire content — non-empty pads require a confirmation token  |
| `append_to_document`  | Append text; concurrent edits elsewhere survive                           |
| `replace_in_document` | Exact search & replace via OT; unique match required unless `replace_all` |
| `set_language`        | Set the Monaco syntax-highlighting language                               |

With `RUSTPAD_READ_ONLY=true` only the first three are registered.

## Safety

- Pad content is world-writable and therefore untrusted: every read result is
  prefixed with a marker telling the model to treat it as data, never as
  instructions.
- Replacing a non-empty pad is irreversible and guarded by a single-use
  confirmation token that only ever appears in a previous tool result.
- Tool results are size-capped; upstream error bodies are sanitized before
  they reach the model.
- `RUSTPAD_INSECURE_TLS` relaxes certificate validation only for the
  configured connection, never process-wide.

## Development

```sh
npm install
npm run lint && npm run build && npm test
```

The test suite talks to an in-memory fake of rustpad-server (including OT
transformation of concurrent edits) over the real MCP protocol; no live
instance is needed. The architecture diagram and social card are generated —
edit `docs/assets/architecture.source.svg` and run `npm run assets`, never the
rendered copies.

## Releasing

Releases are tag-driven. Bump `package.json`, move the `[Unreleased]` notes in
`CHANGELOG.md` under the new version, commit, then:

```sh
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

The release workflow publishes to npm via Trusted Publishing (OIDC, with
provenance), pushes the multi-arch container image to GHCR, creates the GitHub
release from the CHANGELOG section, and updates the entry in the official MCP
registry.

## License

MIT © Willi Thiel
