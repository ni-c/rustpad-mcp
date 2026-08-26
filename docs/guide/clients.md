# Connecting clients

All snippets assume the instance at `https://rustpad.example.net`.

## Claude Code

```sh
claude mcp add rustpad --env RUSTPAD_URL=https://rustpad.example.net -- npx -y rustpad-mcp
```

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rustpad": {
      "command": "npx",
      "args": ["-y", "rustpad-mcp"],
      "env": {
        "RUSTPAD_URL": "https://rustpad.example.net"
      }
    }
  }
}
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.rustpad]
command = "npx"
args = ["-y", "rustpad-mcp"]

[mcp_servers.rustpad.env]
RUSTPAD_URL = "https://rustpad.example.net"
```

## Docker

```sh
docker run -i --rm -e RUSTPAD_URL=https://rustpad.example.net ghcr.io/ni-c/rustpad-mcp
```

As an MCP client entry:

```json
{
  "mcpServers": {
    "rustpad": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "RUSTPAD_URL=https://rustpad.example.net",
        "ghcr.io/ni-c/rustpad-mcp"
      ]
    }
  }
}
```

## A read-only connection

Append `RUSTPAD_READ_ONLY=true` to any of the above and only `get_document`,
`get_document_info` and `get_stats` are registered — the write tools do not
exist for that connection, rather than being refused at call time.

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so rustpad-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have, with the hub's own filter alongside:

```json
{
  "mcpServers": {
    "rustpad": {
      "command": "npx",
      "args": ["-y", "rustpad-mcp"],
      "env": { "RUSTPAD_ALLOW_TOOLS": "essential" },
      "denyTools": ["set_document"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is a rustpad-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/rustpad/mcp` as a connector and you
get this server alone. Register the hub's `/hub` endpoint instead and you reach
_every_ server behind it through six meta-tools, which is the answer worth having
once you run several of these at once.
