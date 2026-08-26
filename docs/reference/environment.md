# Environment variables

| Variable               | Required | Default | Description                                              |
| ---------------------- | -------- | ------- | -------------------------------------------------------- |
| `RUSTPAD_URL`          | yes      | —       | Base URL of the Rustpad instance                         |
| `RUSTPAD_READ_ONLY`    | no       | `false` | `true` registers only the read tools                     |
| `RUSTPAD_INSECURE_TLS` | no       | `false` | `true` accepts self-signed certificates, scoped          |

## RUSTPAD_URL

One URL for the HTTP API, the WebSocket endpoint and the share links in tool
results. Validated on start: `http:`/`https:` only, no embedded credentials, no
query or fragment; trailing slashes are stripped. Plain `http` to a non-local
host logs a warning — pad content would travel unencrypted. Without the
variable the server still starts, lists its tools, and fails every call with
setup instructions (so registries and inspectors can introspect it).

## RUSTPAD_READ_ONLY

Compared against exactly the string `true`. When active, the five write tools
are not registered at all — the connection never advertises them.

## RUSTPAD_INSECURE_TLS

Compared against exactly the string `true`. Disables certificate validation for
the configured connection only, via a dedicated dispatcher — never process-wide.
The server prints a banner on start when this is active.

There are no secrets: Rustpad has no authentication, and this server therefore
handles no tokens or passwords at all.

## Narrowing the tool list

| Variable | Required | Description |
| --- | --- | --- |
| `RUSTPAD_ALLOW_TOOLS` | no | Tool names, `list_*` prefixes or `essential`; only these register |
| `RUSTPAD_DENY_TOOLS` | no | Same syntax; subtracted from whatever the allow list left |

Both are comma-separated. Each entry is either an exact tool name or a prefix with
a single trailing `*`. Entries are trimmed and matched case-insensitively; empty
entries are ignored, and a value that is empty or only whitespace counts as unset —
`RUSTPAD_ALLOW_TOOLS=` in a compose file does not mean "allow nothing".
`essential` is recognised only in the allow list, and selects `get_document`, `get_document_info`, `create_document`, `set_document`, `append_to_document`.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_x` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `RUSTPAD_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive
list is written.
