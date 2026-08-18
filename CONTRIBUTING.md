# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/rustpad-mcp.git && cd rustpad-mcp
npm install
npm test          # 111 unit tests, no network and no Rustpad instance needed
npm run build
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change. The
  suite talks to an in-memory fake of rustpad-server (`test/fake-rustpad.ts`,
  including OT transformation of concurrent edits) over the real MCP protocol, and
  `test/session.test.ts` plays a hostile server. CI runs lint, build and tests on
  Node 22 and 24, plus `npm audit`, CodeQL and a Trivy scan of the container image
  on amd64 and arm64.
- **Comments** explain constraints the code cannot show — not what the next line
  does. Most comments in `src/` document a wire-protocol behaviour of
  rustpad-server; keep that going.
- **Code-point discipline.** Rustpad's OT operations count Unicode code points,
  never UTF-16 units. Anything that computes an offset or length for an operation
  goes through the helpers in `src/ot.ts`.
- **Security-sensitive areas** (config parsing, confirmation tokens, the session
  limits, anything that builds a URL): please describe the attack you are defending
  against, or the one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both eslint and prettier, and
  prettier also validates the YAML, JSON and Markdown files.

## Verifying against a real Rustpad

The unit tests mock both `fetch` and the WebSocket, so they cannot catch a change in
Rustpad's own behaviour. A disposable instance is one command:

```sh
docker run --rm -dp 127.0.0.1:3030:3030 --name rustpad-test ekzhang/rustpad
```

Then exercise the built server over stdio against a throwaway pad:

```sh
npm run build
RUSTPAD_URL=http://127.0.0.1:3030 npx @modelcontextprotocol/inspector node dist/index.js
```

Documents in that instance are in-memory only; `docker stop rustpad-test` removes
everything.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/rustpad-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/rustpad-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/rustpad-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
