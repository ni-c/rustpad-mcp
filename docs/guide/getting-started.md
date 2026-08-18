# Getting started

## Requirements

- A reachable [Rustpad](https://github.com/ekzhang/rustpad) instance. A
  disposable one is a single command:

  ```sh
  docker run --rm -dp 127.0.0.1:3030:3030 ekzhang/rustpad
  ```

- Node.js ≥ 22, or Docker.

No credentials are needed — Rustpad has no authentication.

## Run it

```sh
RUSTPAD_URL=https://rustpad.example.net npx -y rustpad-mcp
```

The server speaks MCP over stdio. On start it logs (to stderr) which instance it
targets; without `RUSTPAD_URL` it still starts and lists its tools, and every
call returns setup instructions instead.

## First calls

With the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx -y @modelcontextprotocol/inspector --cli \
  -e RUSTPAD_URL=http://127.0.0.1:3030 \
  npx -y rustpad-mcp --method tools/list
```

Create a pad and read it back:

```sh
npx -y @modelcontextprotocol/inspector --cli \
  -e RUSTPAD_URL=http://127.0.0.1:3030 \
  npx -y rustpad-mcp --method tools/call \
  --tool-name create_document --tool-arg text='Hello from MCP'
```

The result contains the pad's id and its shareable URL
(`<RUSTPAD_URL>/#<id>`) — open it in a browser and watch the next edits arrive
live.

## Next steps

- [Connect a client](/guide/clients) — Claude Code, Claude Desktop, Codex, Docker
- [Configuration](/guide/configuration) — the three environment variables
- [Security](/guide/security) — what "no authentication" means for you
