# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

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
