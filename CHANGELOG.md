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

## [0.1.0] - 2026-08-19

### Added

- Initial release: MCP server for Rustpad, the self-hosted collaborative
  text editor. Read tools (`get_document`, `get_document_info`, `get_stats`)
  over HTTP and the collaboration WebSocket; write tools (`create_document`,
  `set_document`, `append_to_document`, `replace_in_document`,
  `set_language`) speak Rustpad's operational-transformation protocol, so
  targeted edits leave concurrent edits elsewhere in the pad intact.

<!-- #endregion changelog -->
