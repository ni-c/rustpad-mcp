# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.2.0] - 2026-08-27

### Added

- `RUSTPAD_ALLOW_TOOLS` and `RUSTPAD_DENY_TOOLS` choose which of the 8
  tools are registered. Both take comma-separated tool names or a prefix with a
  trailing `*`, the allow list decides what is in and the deny list is subtracted
  from it, and `RUSTPAD_ALLOW_TOOLS=essential` selects a curated five —
  `get_document`, `get_document_info`, `create_document`, `set_document`, `append_to_document`. A model picks the right tool far more reliably from five than
  from eight, and every visible tool costs context on every request. Nothing
  changes for an installation that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list`
  and answers `tools/call` with "tool not found" — the same cut
  `RUSTPAD_READ_ONLY` already makes, not a second, weaker one.

  An entry that matches no tool **stops the server at startup**, naming the
  entry and listing the real names, rather than being ignored: an ignored typo
  leaves a tool missing from `tools/list` with nothing pointing at the cause.

### Changed

- The README now carries the same eight badges, in the same order, as every other
  MCP server in this family, all of them reading from npm rather than hard-coded;
  the opening follows one shape; and the standalone "Full documentation" line is
  gone, because the docs badge three lines above it points at the same page.

### Fixed

- The container image no longer ships OpenSSL 3.5.7-r0, which carries
  **CVE-2026-14456** (denial of service via unbounded memory growth). The pinned
  `node:24-alpine` digest is already the newest one; Alpine's fixed 3.5.8-r0 has
  simply not been rebuilt into it yet, so the runtime stage now upgrades
  `libcrypto3` and `libssl3` by name. Upgrading those two rather than running a
  blanket `apk upgrade` keeps the rest of the image exactly as the digest pins
  it. The step can go once the base image ships the fix.

## [0.1.2] - 2026-08-26

### Changed

- The check that decides whether `RUSTPAD_URL` points somewhere local — and
  therefore whether sending a credential over plain `http` is worth warning
  about — now uses the same host classifier as the other MCP servers in this
  family, in `src/hosts.ts`. The string comparison it replaces missed several
  spellings of the same address: `http://[::ffff:127.0.0.1]`, which `URL`
  canonicalises to `[::ffff:7f00:1]` before any check sees it, and `localhost.`
  with its root label. It also treated `127.example.com` as loopback, because it
  matched on the `127.` prefix, and so stayed quiet about a plain-http URL to a
  public host.

Nothing else changes: this server has no tool that takes a URL, so there is no
request whose target a caller can choose.

## [0.1.1] - 2026-08-19

### Changed

- First release published through the tag-driven pipeline (npm Trusted
  Publishing with provenance, GHCR multi-arch image, MCP registry entry).
  Functionally identical to 0.1.0.

## [0.1.0] - 2026-08-19

### Added

- Initial release: MCP server for Rustpad, the self-hosted collaborative
  text editor. Read tools (`get_document`, `get_document_info`, `get_stats`)
  over HTTP and the collaboration WebSocket; write tools (`create_document`,
  `set_document`, `append_to_document`, `replace_in_document`,
  `set_language`) speak Rustpad's operational-transformation protocol, so
  targeted edits leave concurrent edits elsewhere in the pad intact.

<!-- #endregion changelog -->
