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
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and
  prettier also validates the YAML, JSON and Markdown files.

## Running the integration suite

The unit tests replace both `fetch` and the WebSocket, so they check that this
server speaks Rustpad's operational-transform protocol the way its author
understood it — against `test/fake-rustpad.ts`, written to that same
understanding. Only a real Rustpad can disagree. The integration suite spawns
the built server over stdio against one in Docker and calls **every tool in the
catalogue**, reading each document back through Rustpad's own
`GET /api/text/{id}` rather than trusting the reply.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down
```

`down` rather than `down -v`: Rustpad holds documents in memory only, so
recreating the container is the whole reset. It is not optional between runs —
the suite uses fixed pad ids and Rustpad has no way to delete a pad, so
`create_document` correctly refuses the second time. The bootstrap checks
`num_documents` and says so rather than failing halfway through with a message
about the wrong thing.

The block worth keeping honest is **UTF-16 offsets**. An emoji is one code
point and two code units; a flag is four. If the server ever counts code
points, every edit after such a character lands in the wrong place and the
document corrupts silently — and a fake that shares the mistake agrees forever.
Those cases are only meaningful against a real Rustpad, which is where they now
run.

Rustpad has no authentication of any kind: a pad id is the only thing between a
document and whoever guesses it. That is why the compose file binds to
`127.0.0.1`, and why the harness refuses any backend URL that is not on this
machine.

For poking at one tool by hand, the inspector against the same stack:

```sh
docker compose -f test/integration/compose.yml up -d --wait
RUSTPAD_URL=http://127.0.0.1:3030 npx @modelcontextprotocol/inspector node dist/index.js
```

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/rustpad-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/rustpad-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/rustpad-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
