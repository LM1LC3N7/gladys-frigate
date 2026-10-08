# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project scaffold from the official Gladys integration template (CI with a
  Docker build, multi-architecture build and release workflows).
- Complete v1 manifest: Frigate connection, MQTT broker with WebSocket
  fallback, options, expert TLS settings (pinned fingerprint or custom CA,
  both optional, at the bottom of the form), `test_connection`,
  `refresh_cameras` and `reset_certificate` actions, `review_alert`, `object_detected` and
  `object_entered_zone` scene triggers, `attach_event_snapshot` scene action.
- Configuration normalization and validation, with security warnings
  (unauthenticated port 5000, clear-text passwords) in the connection status.
- TLS trust policy: CA-verified certificates are accepted without pinning;
  self-signed ones are trusted on first use and pinned in
  `/data/tls-trust.json`; a changed certificate is refused until the user
  presses "Trust the new certificate" (policy and store only — the TLS
  connectors come with the HTTP and MQTT clients).
- Layering rule enforced by ESLint: `src/frigate/` never imports the Gladys SDK.

### Fixed

- TLS pin store: saves are queued (two overlapping saves could leave a
  truncated `tls-trust.json` and lose every pin at the next start), the
  temporary file is removed when a save fails, and using the store before
  `load()` throws instead of treating a pinned endpoint as a first use.
  `endpointKey()` refuses a missing port and accepts IPv6 with or without
  brackets.
- Configuration: a blank number keeps its default instead of becoming 0; an
  MQTT host written as `mqtt://…`, `host:port` or with a path is refused with
  a clear message.
- Docker image: `/data` belongs to the runtime user (on a fresh Docker volume
  it belonged to root, so pins could not be saved), dependencies are
  installed strictly from the lockfile, and the npm cache is no longer
  shipped (image 40 MB smaller).

### Security

- CI runs with a read-only `GITHUB_TOKEN`; the test-only TLS material stays
  out of the Docker build context.
