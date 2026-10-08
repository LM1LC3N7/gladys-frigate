# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project scaffold from the official Gladys integration template (CI with a
  Docker build, multi-architecture build and release workflows).
- Complete v1 manifest: Frigate connection (TLS verify / custom CA / pinned
  fingerprint), MQTT broker with WebSocket fallback, options, `test_connection`
  and `refresh_cameras` actions, `review_alert`, `object_detected` and
  `object_entered_zone` scene triggers, `attach_event_snapshot` scene action.
- Configuration normalization and validation, with security warnings
  (unauthenticated port 5000, clear-text passwords) in the connection status.
- Layering rule enforced by ESLint: `src/frigate/` never imports the Gladys SDK.
