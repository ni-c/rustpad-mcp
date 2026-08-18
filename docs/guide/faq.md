# FAQ & troubleshooting

## `get_document` returned "empty — or it never existed"

That is Rustpad, not the server: `GET /api/text/{id}` answers an empty string
for an empty pad, a pad that never existed, and one that expired. The three
cases are indistinguishable over the API. If you expected content, the pad has
most likely expired — documents are dropped after 24 hours without an open
connection and on every server restart, unless the instance runs with
`SQLITE_URI`.

## "the Rustpad WebSocket connection failed"

The HTTP endpoints worked but the socket did not (or vice versa) — almost
always a reverse-proxy issue. The proxy in front of Rustpad must forward
WebSocket upgrades on `/api/socket/…`. In nginx terms:
`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

## `replace_in_document` says the string occurs N times

By default the search string must match exactly once, so the model cannot
accidentally rewrite more than it looked at. Either make the search string
longer (include surrounding context) or pass `replace_all: true` deliberately.

## Why does `set_document` ask for a confirm token?

Replacing a non-empty pad destroys content that cannot be restored. The first
call returns a single-use token; calling again with it executes. This is
deliberate friction — for targeted changes `replace_in_document` and
`append_to_document` need no token, and they are also the tools that play
nicely with concurrent human edits.

## Someone saw "rustpad-mcp" in their pad

Working as intended: while editing, the server announces itself as a
collaborator named `rustpad-mcp`, so humans in the pad can see that a machine
is typing. It disconnects as soon as the tool call finishes.

## Can it list all pads?

No — Rustpad has no such API. Pads exist implicitly under every id; you have to
know the ids you care about. `get_stats` tells you how many documents the
server currently holds, but not their names.

## Text with emoji ends up mangled

It should not — positions are counted in Unicode code points end to end, and
the test suite covers astral characters explicitly. If you can reproduce a
mangling, that is a bug: please open an issue with the exact before/after text.
