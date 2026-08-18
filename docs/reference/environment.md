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
