# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Scene action "attach the event snapshot" followed by "Send a camera
  image" sent the current frame, without the bounding box: Gladys asks the
  integration for a live image instead of reading the stored one. The
  attached snapshot now answers that request for a minute (dashboard live
  view included), and the action no longer fails over the image rate limit.
- A finished event whose stored snapshot exceeds 150 KB (Frigate serves it
  as is, whatever size is asked) falls back to its thumbnail instead of
  failing after twelve identical requests.

## [0.3.0] - 2026-10-09

### Added

- End-to-end test: the real `index.js` against a fake Gladys, a fake Frigate
  and an MQTT broker stub (connection, discovery, scan, images, states,
  confirmed command, scene event, buttons, scene action, clean shutdown).
- Release workflow: runs the CI checks before tagging, and turns the
  CHANGELOG's "Unreleased" section into the released version (0.1.2 had
  none). CI audits the runtime dependencies; GitHub Actions pinned by commit
  SHA, updates proposed by Dependabot.
- Docs: quick start, security, troubleshooting table (en/fr).

- Scene triggers (milestone 5): "new review" (alert or detection, once more
  when a detection becomes an alert), "object detected" and "object enters
  a zone", with the flat data the manifest declares (camera device, Frigate
  camera name, object, sub label, zone, zones, score, objects, severity,
  event and review ids). On an alert, a fresh camera image is pushed before
  the trigger, so "Send a camera image" right after it sends the alert.
- Scene action "attach the event snapshot": the snapshot of a Frigate event
  (bounding box optional, resized by Frigate under 150 KB; its thumbnail
  when Frigate keeps no snapshot) becomes the image of the event's camera,
  or of the chosen one.

- Camera devices complete (milestone 4): camera enabled (Frigate's own
  on/off), switches for object detection, recordings, snapshots and audio
  detection (the last two only when enabled in the Frigate file), motion,
  presence and count per tracked object, total of objects, review status,
  optional zone sensors. Switches are confirmed by Frigate before the
  command succeeds, with a reason when it does not (WebSocket mode needs an
  admin account). States are deduplicated, batched and kept under the
  Gladys rate limit; a camera created later gets its current states at once.
- Transport badge per camera: unreachable when Frigate does not answer or is
  offline, or the camera stream is lost for 30 s (debounced: Frigate flaps
  while restarting ffmpeg; Frigate 0.16 uses the camera fps of /api/stats);
  degraded when recording is interrupted or the real-time feed is down.
- Connection status warning when the pinned certificates cannot be saved in
  `/data`.

- Cameras in Gladys: the Discover tab lists one camera device per Frigate
  camera (published on every connection, on **Scan** and on **Refresh the
  cameras**). Its image is pushed every minute (Gladys polls the device) and
  captured fresh on demand (chat, scenes), resized by Frigate to fit the
  150 KB Gladys accepts; concurrent captures of a camera share one request.
- Real-time feed (milestone 3): the Frigate MQTT broker, or the Frigate
  WebSocket when no broker is configured. Reconnects on its own (MQTT
  subscriptions renewed, WebSocket token renewed); over TLS the broker
  password and the Frigate token only leave once the certificate is trusted;
  a refused certificate or account stops it instead of looping. Its state and
  Frigate's own `available` announcement are part of the connection status;
  Frigate's configuration is read again when it comes back online.
- Event engine: Frigate events and reviews become one transition per
  incident (object detected, object entered a zone, review alert, including
  a detection escalated to an alert), without false positives or stationary
  objects, above the minimum confidence, with a cooldown per camera and
  object type; each incident is also written to the logs.

### Changed

- `sharp` removed: Frigate resizes every image itself (image 57 MB smaller).
- The certificate store directory can be moved with `FRIGATE_DATA_DIR`
  (development, tests); a certificate pinned just before a stop is written
  before the container exits.

### Fixed

- **Scan** in the Discover tab spun for minutes and showed nothing: the
  integration did not answer scan requests. It now always answers (an empty
  list when Frigate cannot be read, the connection status says why).
- Concurrent requests that needed a login each logged in to Frigate (whose
  login is rate-limited); they now share one login.

## [0.1.2]

### Added

- Connection to Frigate (milestone 2): TLS connector applying the trust on
  first use before any byte is sent (the Bearer token or the broker password
  never reach an untrusted peer), authentication (request without a token
  first, login on 401, Bearer, renewal 5 minutes before expiry, a refused
  login never retried), timeouts, retries with backoff for GET, response size
  cap, redirects not followed; reading of the version (0.16 or later) and of
  the cameras.
- The three Configuration buttons, which answered "not implemented": Test the
  connection (Frigate, certificate, account, MQTT broker), Refresh the
  cameras, Trust the new certificate.
- Real connection status ("Connected to Frigate 0.17.2, 3 cameras", or why
  not, in English and French), retried every minute while Frigate is
  unreachable.

### Fixed

- Release workflow: the version bump rewrote the manifest with jq, whose formatting differs
  from Prettier: the next CI run on `main` would have failed its format
  check. The manifest is now reformatted with the project's Prettier version.

## [0.1.1]

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
