# Asking a person

Two operations in this server can take out content that nobody can get back:
replacing a non-empty pad, and search-replacing across more than one match. Both
of them **ask a person first**.

Not a `confirm: true` argument the model can set. Not a token the model reads out
of its own previous result. A dialog, raised through [MCP
elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
that goes to the client and is shown to whoever is sitting there.

The specification says a client _should_ keep a human in the loop:

> there **SHOULD** always be a human in the loop with the ability to deny tool
> invocations

This server does not rely on that. It raises the question itself, and until an
answer comes back, nothing happens.

## What asks, and when

| Tool                  | When it asks                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `set_document`         | whenever the pad is **not empty** — an empty pad has nothing to lose |
| `replace_in_document`  | when `replace_all` changes **more than one** occurrence            |
| everything else        | never                                                              |

`append_to_document`, `create_document` and `set_language` are not asked about
on purpose. They add or set without taking anything away, and a dialog on every
one of them is how people learn to tick without reading.

The `replace_in_document` line is drawn on the **count**, not on the flag,
because the count is the mistake worth catching: a search string that is shorter
than intended matches in places nobody looked at, and the number is the only
place that shows. It is measured inside the open session — what the person is
told is the pad as it stands, not as it stood when the model decided.

## What the dialog contains

Pad ids, character counts, and the search/replace pair on their own labelled
lines under a heading that says the values below were chosen by the caller.

Never the pad's content. Pads are world-writable, and a dialog raised by
whoever last edited the pad is not the place to render what they wrote.

```
This will replace 3 occurrences in pad "notes".

What is replaced cannot be restored, and a search string that is shorter than
intended matches in places nobody looked at.

Values below are supplied by the caller, not by this server:
  Search: a
  Replace with: z
```

The approval is bound to the pad, the exact pair **and** the number of matches.
An approval for two occurrences will not execute against a pad that has since
grown a third.

## Clients that cannot show a dialog

Not every MCP client implements elicitation, and a stateless gateway may not be
able to speak for the one it is currently serving. Rather than refuse to work —
which pushes people towards switching the guard off entirely — the tool falls
back to a **two-call token**: the first call returns a random string, the second
has to quote it back.

Be clear about what that proves, because this server is:

> the token proves the call was made twice with the same arguments, and nothing
> more.

A model can read the token out of the first result and call again in the same
turn without anybody seeing it. It catches a widened target set; it does not
catch a model that was talked into the whole thing. The fallback text says so
rather than implying somebody approved.

## Switching the dialog off

```sh
ELICITATION=false
```

Default is `true`. `false` does **not** remove the guard — it takes the fallback
path above, which means the token. There is no setting in which a guarded call
goes unannounced.

Use it where a dialog is the wrong shape rather than an unwanted one: a
scheduled job, a test harness, a client whose dialog interrupts something else.

::: warning It is deliberately not prefixed
`ELICITATION` has no `RUSTPAD_` in front of it, so one `export ELICITATION=false`
— or one `-e ELICITATION=false` in a compose file — reaches **every** MCP server
in that environment, not just this one. That is the point of it and also its
risk.

Two things make it visible rather than silent:

- a server started with it off prints one line at startup, in the log of every
  server it actually reached:

  ```
  rustpad-mcp: ELICITATION=false — guarded tools fall back to the two-call token
  ```

- the fallback text names the server that did not ask, instead of blaming a
  client that was working fine.
  :::

Anything other than `true` or `false` — `1`, `off`, `yes` — **stops the server**
with exit code 1 and a message naming both valid values. This is the only
variable in this family that defaults to _on_: a typo that fell back to the
default would leave the dialog running while the operator believed it was off,
and there would be nothing to tell them.

## Annotations are the other half, and they are only a hint

Every tool of this server declares all four MCP tool annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a
client can tell before it calls what a call would do. See
[Tools](/reference/tools).

They are advice, and the specification says so:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is something a client may ignore. The dialog is not: it is
enforced here, on the server side, and no answer means no change. The two are
different claims — the annotation says what a call _does_, the dialog decides
whether it _happens_ — which is why a tool can be marked destructive without
being guarded, and guarded without being destructive.

## Behind a gateway

Both protocol revisions are handled from one code path. On `2025-11-25` the
question is pushed to the client; on `2026-07-28` there is no server→client
channel at all, so the call returns `input_required`, ends, and the client
retries carrying the answer.

That answer arrives as ordinary request content, which the SDK does not
validate — so the state that ties an answer to its question is sealed (HMAC).
A reply whose seal does not open, or opens onto a different pad or a different
replacement, counts as **no answer** and produces a fresh question rather than
an error. The likeliest cause is not an attack: it is a gateway that put the
server to sleep while the person was reading.

If you run this behind [mcp-hub](https://github.com/ni-c/mcp-hub), the hub
passes elicitation through in both directions; see its
[elicitation guide](https://ni-c.github.io/mcp-hub/guide/elicitation).
