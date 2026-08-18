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
