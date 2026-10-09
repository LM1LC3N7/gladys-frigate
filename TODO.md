# TODO — Frigate integration v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone (tick the boxes, move decisions in).

## Working method (agreed with the maintainer)

- One milestone at a time, **one commit per milestone**, tests green before
  moving on. Present a short plan before coding a milestone; ask blocking
  questions instead of assuming.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm audit`, then check and update README, `docs/en.md`, `docs/fr.md`,
  `CHANGELOG.md` and this file.
- CI: if **every** job fails in under 2 seconds, the GitHub Actions quota is
  exhausted — do not change the code, tell the maintainer.
- Code, comments, README in English; user docs in English and French.

## Status

- [x] **Milestone 1 — scaffold + v1 manifest + store validation** (`dbc219a`)
- [x] TLS trust model changed to trust-on-first-use (policy + store, see below)
      (`f8a3b4b`)
- [x] Review of the above: pin store race, config and Docker fixes (see
      CHANGELOG "Fixed"); facts below re-checked in the Frigate sources
- [x] **Milestone 2 — httpClient + capabilities**, plus the three manifest
      action buttons and the real connection status (released buttons
      answered "not implemented" in 0.1.1)
- [x] **Milestone 4, part 1 — discovery + camera images**, brought forward
      at the maintainer's request (0.1.2 answered no scan: the Discover tab
      spun for minutes and showed nothing). See "Milestone 4" below.
- [x] **Milestone 3 — mqttClient (+ WebSocket fallback) + eventEngine**
- [x] **Milestone 4, part 2 — Gladys adapter: states, commands, transports**
- [x] **Milestone 5 — scene triggers and scene action**
- [x] **Milestone 6 — docs (install, security, dedicated account, MQTT ACL,
      live video via go2rtc), CHANGELOG, first release

## Decisions already taken (do not reopen)

| Topic                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Targets                | Gladys `>=5.1.0`; Frigate 0.16 → 0.18 (0.18.0 is released: tag `v0.18.0`). Detect version and features through the API, never assume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Repository             | `LM1LC3N7/gladys-frigate`, default branch `main`, image `ghcr.io/lm1lc3n7/gladys-frigate`. Must become public (store indexing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| HTTP                   | Native `fetch` + **undici 7** (v8 requires Node 22.19; engines is `>=20.18.1`). undici is also the WebSocket client of the fallback (custom headers + dispatcher), so no `ws` dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| TLS                    | **Trust on first use.** CA-valid certificate for the host name → accepted, not pinned (renewals keep working). Otherwise the first certificate seen for `host:port` is trusted and its SHA-256 pinned in `/data/tls-trust.json`; a different one is refused until the user presses **`reset_certificate`** ("Trust the new certificate"). Expert fields at the bottom of the form, optional and mutually exclusive: `tls_fingerprint` (only that certificate) or `tls_ca` (own authority, never falls back to TOFU). Same policy for the MQTT broker over TLS. Policy + store: `src/frigate/tlsTrust.js` (done, tested). |
| Score threshold        | Gladys trigger filters are equality / membership only (spec §4.2). → global `min_score` config (default 70 %) applied before firing; `score` exposed as a variable. No number filter in triggers (pinned by a test).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `review_alert` filters | Event data is flat (no arrays). → filters on the **main object** (`label`, priority from the Frigate config order) and the **main zone** (`zone`, first entered); full lists in the `objects` / `zones` variables. One event per incident.                                                                                                                                                                                                                                                                                                                                                                               |
| No MQTT                | MQTT recommended; when `mqtt_host` is empty, use the **Frigate WebSocket** (`/ws`, same messages as MQTT).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Frigate account        | Dedicated account, `viewer` (or custom) role is enough for HTTP: commands go through MQTT (`<prefix>/<cam>/<setting>/set`). Broker ACL: read `<prefix>/#`, write `<prefix>/+/+/set`. In WebSocket mode, commands need an admin Frigate role: since 0.17, `/ws` only accepts read-only topics (`onConnect`…) and `<cam>/ptz` from non-admin roles (0.16.4 checks no role there; the docs ask for admin anyway).                                                                                                                                                                                                           |
| Scene keys             | Frozen in `src/gladys/keys.js` and pinned by `test/manifest.test.js`: triggers `review_alert`, `object_detected`, `object_entered_zone`; action `attach_event_snapshot`; manifest actions `test_connection`, `refresh_cameras`, `reset_certificate`. Never rename.                                                                                                                                                                                                                                                                                                                                                       |
| Out of v1              | PTZ, faces and plates (beyond `sub_label`), classification, widgets, profiles, multi-instances, sub-containers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Milestone 2 — httpClient + capabilities (done)

Done as planned below (`src/frigate/tlsConnector.js`, `httpClient.js`,
`capabilities.js`, `mqttProbe.js`, `errors.js`; `src/gladys/frigateSession.js`,
`messages.js`). Left for later milestones: `/api/stats` health (milestone 4,
0.16 fallback of `status/<role>`), image endpoints (milestones 4-5), real
0.16 / 0.17 / 0.18 config dumps as fixtures (the tests use a small synthetic
config). Note: fetch refuses the "bad ports" of the Fetch standard (1, 9,
6000, 6665-6669…): such a Frigate port reports a generic network error.

`src/frigate/httpClient.js` (no Gladys import — ESLint enforces it):

- [x] undici `Agent` with a custom `connect` built on `tls.connect`:
      `rejectUnauthorized: false`, then on `secureConnect` compute
      `chainValid = socket.authorized` (system store, or `ca: tls_ca`),
      `hostnameValid = !tls.checkServerIdentity(host, peerCert)`,
      `fingerprint = peerCert.fingerprint256`; call `decideTrust()`; on
      `pin` → `trustStore.set(endpointKey(host, port), pin)`; when not
      trusted, destroy the socket **before** any byte of the request (the
      Bearer must never reach an untrusted peer) and surface a typed error
      (`CertificateChangedError`, `CertificateRejectedError`) so the Gladys
      side can show "certificate changed — press Trust the new certificate".
      Note: `authorized` alone does not check the host name.
  - `await trustStore.load()` before the first connection (the store throws
    otherwise); pass the **effective** port to `endpointKey()` (443 when the
    URL has none: `url.port` is `''`, and `endpointKey` throws on it).
  - No `servername` (SNI) when the host is an IP literal (`net.isIP`): RFC
    6066 forbids it and Node prints a deprecation warning.
  - `chainValid && !hostnameValid` (a Let's Encrypt certificate reached by
    IP) falls back to first use, so every renewal looks like a changed
    certificate: say it in the status ("use the host name the certificate
    covers"). The docs already warn about it.
- [x] Auth: `POST /api/login` `{ user, password }` → JWT in `Set-Cookie`
      (cookie name configurable in Frigate, default `frigate_token`; take
      the first cookie). Send `Authorization: Bearer <jwt>` (supported by
      0.16.4, 0.17, 0.18). Decode `exp` from the JWT payload (no signature
      check) and log in again ~5 min before; re-login once on 401. Login
      is rate-limited by Frigate: never loop on 401.
      **Probe before logging in:** only 0.18 answers `/api/login` with 404
      when auth is disabled; 0.16.4 and 0.17.2 have no such check (401 for
      an unknown user). So first `GET /api/config` without a token: 200 =
      no auth (port 5000 or auth disabled: no login, warn in the status),
      401 = log in. It also spares a rate-limited login attempt.
- [x] Timeout 10 s, body cap (container: 256 MB), retry with exponential
      backoff on network errors / 5xx for GET only; honor `Retry-After` on
      429; never retry 4xx. Errors sanitized: no password, token or cookie
      in messages or logs.
- [x] Endpoints: `GET /api/version` (public, text), `GET /api/config`,
      `GET /api/stats`, `GET /api/<cam>/latest.jpg?height=&quality=`,
      `GET /api/events/<id>/snapshot.jpg?bbox=1&height=&quality=` (for
      `attach_event_snapshot`), `GET /api/events/<id>` (camera of an event).

`src/frigate/capabilities.js`:

- [x] `/api/version` + `/api/config` → normalized model: per camera `name`,
      `friendly_name`, `enabled`, `detect`, `record`, `snapshots`, `audio`
      (`enabled_in_config`), `review.alerts/detections`, tracked `objects`,
      `zones` (+ their objects), `onvif`/PTZ, plus global features (face
      recognition, LPR, genai, semantic search). Refuse < 0.16.0.
- [x] Version-gated flags: `statusTopics` (`<cam>/status/<role>`, 0.17+),
      `cameraEnabledTopic` (0.16+), `reviewStatusTopic` (0.16+).
- [x] `/api/stats` → per-camera health (camera fps 0 = offline) as the 0.16
      fallback for `status/<role>`.
- [ ] Fixtures for 0.16 / 0.17 / 0.18. The HA integration (MIT) has 0.18
      `TEST_CONFIG` / `TEST_STATS` in `tests/__init__.py` → if reused, add a
      `NOTICE` with attribution. 0.16 / 0.17: rebuild from each tag's config
      schema, or use anonymized dumps from the maintainer if provided.
- [x] Tests: local HTTPS server with `test/fixtures/tls/` (CA-verified,
      first use pins, changed certificate refused, reset re-pins, expert
      fingerprint, expert CA), auth flows, retries with fake timers,
      capabilities on every fixture.

## Milestone 3 — mqttClient (+ WebSocket fallback) + eventEngine (done)

Done: `src/frigate/mqttStream.js` (stream builder shared with the probe),
`mqttClient.js`, `wsClient.js`, `topics.js`, `eventEngine.js`; the session
starts the feed once Frigate was read, routes typed messages to the engine
(`onTransition`, logged by `index.js` until milestone 5) and to `onMessage`
(hook for milestone 4 states), shows the feed state and Frigate's
`available` in the status, re-reads the config when Frigate comes back
online, and restarts a failed feed on "Test the connection". Choices:

- Subscriptions are explicit, non-overlapping filters, not `<prefix>/#`
  (the retained `<cam>/<label>/snapshot` JPEGs would come with it):
  `available`, `events`, `reviews`, `+/+`, `+/+/active`, `+/+/state`,
  `+/status/+`. A broker refusing all of them = not authorized (fatal);
  some only = ignored.
- Cooldown key: (trigger, camera, label) and (zone trigger, camera, zone,
  label); per camera for review alerts (docs updated: "per camera and
  object type"). A dropped transition is never fired later.
- Reviews have no score: `min_score` applies to events only.
- WebSocket auth: before each attempt `GET /api/profile` (logs in or renews
  the token, and tells a refused certificate/account from a down Frigate),
  then the upgrade with the Bearer through the same undici dispatcher.
- Tests: `test/helpers/testBroker.js` (mqtt-packet, dev dependency) and the
  `/ws` endpoint of the fake Frigate (`ws`, dev dependency).

Left for milestone 4 part 2: resync of the states on reconnection (retained
MQTT states arrive by themselves; the WebSocket gets `camera_activity`),
debounce of `status/<role>`, MQTT `publish` for the switches. Possible
improvement: a WebSocket watchdog (Frigate sends nothing while idle, so a
half-open connection is only noticed by TCP).

Original plan:

- [x] `mqttClient.js` (mqtt.js 5): reconnect, resubscribe on reconnect,
      `<prefix>/available` (`online` / `offline` / `stopped`; republished on
      every broker reconnection), typed topic parser with configurable
      prefix, retained messages handled (initial states). TLS through the
      same trust policy (`rejectUnauthorized: false` + verify on
      `secureConnect`, as for HTTP). mqtt.js 5 writes the CONNECT packet
      (with the broker password) as soon as its stream builder returns,
      before the handshake, and with `rejectUnauthorized: false` it never
      cuts the socket itself. So use `new MqttClient(streamBuilder, opts)`
      with our own builder: `tls.connect(...)` (no `servername` for an IP),
      register the trust check on `secureConnect` **before** returning the
      socket, and **decide synchronously**: checked on Node 22, what was
      written before the handshake reaches the peer one event-loop turn
      after `secureConnect`, so a `destroy()` after any `await` on I/O comes
      too late. `TrustStore.get()` is synchronous for that reason; only
      `set()` (trusted path) is async.
- [x] WebSocket fallback (`wss://<frigate>/ws` with undici `WebSocket`,
      Bearer header, same dispatcher): messages are JSON `{ topic, payload }`
      **without** the prefix; send `{ "topic": "onConnect", "payload": "" }`
      after opening to receive `camera_activity` (initial state of every
      camera: `config.detect/record/snapshots`, `motion`, `objects`).
      Register message listeners **before** opening: the first frame can
      arrive in the same chunk as the upgrade response.
- [x] `eventEngine.js`: `reviews` + `events` → one business transition per
      incident, cooldown per camera (`trigger_cooldown`), ignore
      `false_positive` and stationary objects, `min_score` threshold, a
      detection escalating to an alert counts once more as an alert.
- [x] Tests on replayed MQTT sequences: duplicates, false positives,
      cooldown, alert after detection, retained states, reconnect resync.

Frigate facts checked in the sources (0.16.4 / 0.17.2 / 0.18.0):

- `events` payload: `{ type: new|update|end, before, after }`; `after` has
  `id, camera, label, sub_label (null | string | [name, score]),
top_score, score, current_zones, entered_zones, stationary,
false_positive, has_snapshot`. `new` is only sent for true positives.
- `reviews` payload: `{ type, before, after }`; `after` has `id, camera,
severity (alert|detection), start_time, end_time,
data: { detections, objects, sub_labels, zones, audio }`. Labels may
  carry a `-verified` suffix.
- `<cam>/status/<role>` (`audio`, `detect`, `record`): 0.17+ only, and it
  flaps `offline`/`online` while Frigate restarts ffmpeg → debounce
  (~30 s stable) before showing `unreachable` / degraded.
- `<cam>/review_status` (NONE/DETECTION/ALERT), `<cam>/enabled/set|state`,
  `<cam>/{detect,recordings,snapshots,motion}/set|state`, `<cam>/motion`,
  `<cam>/<label>` (count), `<cam>/<label>/active`, `<zone>/<label>`.

## Milestone 4 — Gladys adapter

Part 1 done: `src/gladys/discovery.js` (one device per camera, image feature
only, `should_poll` + `poll_frequency` 60 s so the core scheduler sends
`device.poll`, which pushes an image: the dashboard widget only shows the
last pushed image, and the core refuses one older than 1 h);
`src/gladys/images.js` (Frigate resizes: `latest.jpg?height=&quality=`,
stepped down 720→240 px and quality 70→35 until the `image/jpg;base64,…`
string, prefix included, is ≤ 150 KB; the step that fitted is remembered;
captures shared per camera, reused 2 s; pushes ≤ 12/min per device);
`onScanRequest` (always answers, empty list when Frigate is down),
`onPoll`, `onDeviceCreated` (first image at once), `onGetImage`; the
discovery list is published after every successful read of Frigate
(connection, retry, buttons). `sharp` is not used: Frigate resizes; keep it
for the alert snapshot only if Frigate's resize is not enough there, else
drop the dependency (maintainer's call, saves ~30 MB of image).
Adding the other features below changes the device structure: the Discover
tab then shows "Update" on the cameras already created (documented).

Part 2 done: full features in `discovery.js`; `cameraStates.js` (typed
message → states, incl. `camera_activity`), `statePublisher.js` (dedupe,
batches ≤ 100, 250/min, latest value kept for devices created later),
`transports.js` (debounced `status/<role>`, Frigate down/offline, feed
lost), `deviceSync.js` (commands confirmed by `<cam>/<setting>/state`
within 4 s, polls, 0.16 health from `/api/stats`). Decisions: review status
is a `text` feature (none / detection / alert); presence per object =
`presence-sensor`, counts = `counter-sensor` with history off; the
recordings and audio switches only exist when enabled in the Frigate file
(Frigate refuses to turn them on otherwise); a camera turned off gets no
image pushed. Original plan:

- [x] `src/gladys/discovery.js`: the other features, only what the
      Frigate config enables. Features: `camera/image`, `camera/enabled`
      (↔ `<cam>/enabled/set`; Gladys' `CAMERA.ENABLED` also stops Gladys
      polling the image, consistent with a disabled Frigate camera), switches
      `detect` / `recordings` / `snapshots` (`/set`, confirmed by `/state`,
      `has_feedback: true`), `motion-sensor` binary, one `presence-sensor`
      binary per tracked object (count > 0), `counter-sensor` integer total + per object, review status (`text`/`text` read-only, or integer
      0/1/2 — decide), zone sensors when `zone_sensors` is on.
- [x] `states.js`: batch (≤ 100 per request), dedupe last values, stay under
      300 states/min; only for devices the user created (`gladys.devices`).
- [x] `commands.js`: `onSetValue` → MQTT/WS `set` topic.
- [x] `images.js`: `onGetImage` → `latest.jpg` under 150 KB (resized by
      Frigate, see above); ≤ 12 images/min per camera.
- [x] Push the alert image: a fresh camera image before a review alert's
      scene event (milestone 5).
- [x] `publishTransports`: `local`; `unreachable` / `degraded` from the
      debounced `status/<role>`; `setConnectionStatus` driven by
      `<prefix>/available` and the HTTP state, with the config warnings of
      `src/gladys/status.js` and the TLS errors ("certificate changed").
- [x] Status warning when the trust store cannot be saved (`/data` not
      writable): pins then live in memory only and every restart is a new
      first use. The image creates `/data` owned by `node` (a fresh Docker
      volume was root-owned before); still check how the Gladys supervisor
      mounts `/data` (a bind mount keeps the host directory's owner).
- [x] Manifest actions `test_connection` (version, cameras, TLS, account,
      broker check) and `reset_certificate` — done in milestone 2.
- [x] `refresh_cameras`: re-reads the Frigate config and re-publishes the
      discovery. Original plan:
      `test_connection` (version, cameras, broker, TLS
      reason), `refresh_cameras` (re-read config, re-publish discovery),
      `reset_certificate` (`trustStore.reset()`, then reconnect; answer with
      the newly pinned fingerprint when the reconnection succeeds).
- [x] Re-discovery when the Frigate config changes (cameras can be added
      without restart since 0.17) and full resync when `available` comes
      back `online` or MQTT reconnects. Clean shutdown, no orphan timer.

## Milestone 5 — scene triggers and action (done)

Done: `src/gladys/sceneEvents.js` (`toSceneEvent`, `createSceneEvents` with
a 250/min safety net, `createSnapshotAction`), image of the camera pushed
before an alert's event, event snapshot fitted by Frigate (thumbnail when no
snapshot). Decision: the frozen `review_alert` trigger is the manifest's
"new review" with a severity filter, so it fires for detections too, and
once more on escalation to an alert (cooldown per camera and severity).
A test pins every event key against the manifest variables.

- [x] `sceneEvents.js`: `publishSceneEvent` with flat data (≤ 30 keys,
      strings ≤ 1000 chars), `camera` = Gladys device external id, plus
      `camera_name`, `label`, `sub_label`, `zone`, `zones`, `score` (0–100),
      `event_id`, `review_id`, `severity`, `objects`; ≤ 300 events/min.
- [x] `attach_event_snapshot` (`onSceneAction`): fetch
      `/api/events/<id>/snapshot.jpg` (bbox per field), resize under 150 KB,
      `publishCameraImage` on the chosen camera or the event's camera; the
      scene then chains the core action "send the camera image".

## Milestone 6 — docs and release (done, except the maintainer's steps)

- [x] docs/en.md + docs/fr.md: quick start, connection, certificates,
      dedicated account, MQTT ACL, WebSocket mode limits, cameras, scenes
      with an example, options, live video via the core `rtsp-camera`
      service on `rtsp://<frigate>:8554/<cam>`, buttons, security,
      troubleshooting table. "In development" banners removed.
- [x] End-to-end test of `index.js` (`test/index.e2e.test.js`, fake Gladys
      in `test/helpers/fakeGladys.js`): it found the transport badges
      refused by the SDK ("message" only with "degraded"). The image was
      also run read-only against the same fakes (pin saved in `/data`,
      clean SIGTERM).
- [x] `npm run validate:manifest` passes.
- [x] Former open recommendations: quality job before the release, CHANGELOG
      section cut at release, `npm audit --omit=dev --audit-level=high` in
      CI and release, actions pinned by commit SHA, Dependabot
      (`.github/dependabot.yml`); `sharp` removed (image 321 → 264 MB).
- [ ] Maintainer: make the repository public, add the topic
      `gladys-assistant-integration`, run **Actions → Release** (minor:
      0.2.0), make the ghcr.io package public, then test on a real Gladys
      (Discover → Add to Gladys, a switch, a scene with the snapshot).

## Left for later (not blocking v1)

- [ ] Fixtures from real 0.16 / 0.17 / 0.18 config dumps (the tests use a
      small synthetic config). The HA integration (MIT) has 0.18
      `TEST_CONFIG` / `TEST_STATS`; reusing them needs a `NOTICE`.
- [ ] WebSocket watchdog: Frigate sends nothing while idle, so a half-open
      connection is only noticed by TCP.
- [ ] `npm run validate:manifest` runs the latest, unpinned
      `github:GladysAssistant/integration-store`: pin a commit if supply
      chain matters more than following rule updates.
- [ ] Out of v1 (decided): PTZ, faces and plates beyond `sub_label`,
      classification, widgets, profiles, multiple Frigate instances.

## References

- Gladys SDK: <https://github.com/GladysAssistant/integration-sdk-js>
  (v0.14.0) — template: <https://github.com/GladysAssistant/integration-template-js>
- Gladys specs: `docs/specs/external-integrations/` of the Gladys repo
  (`capabilities/scene-triggers-and-actions.md` uses Frigate as the example).
- Frigate MQTT: <https://docs.frigate.video/integrations/mqtt/> — HTTP API:
  <https://docs.frigate.video/integrations/api/frigate-http-api> — auth:
  <https://docs.frigate.video/configuration/authentication/>
- HA integration (spec only, MIT): <https://github.com/blakeblackshear/frigate-hass-integration>
  (`switch.py` existence conditions, `binary_sensor.py`, `sensor.py`).
- A first prototype (WebSocket only, Frigate 0.18 only) is kept on the
  branch `archive/v0-prototype` for reference (event mapping, snapshot
  fitting, WebSocket reconnection); it does not follow the v1 architecture.
