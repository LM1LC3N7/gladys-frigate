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
- [ ] **Milestone 2 — httpClient + capabilities** (next)
- [ ] Milestone 3 — mqttClient (+ WebSocket fallback) + eventEngine
- [ ] Milestone 4 — Gladys adapter: discovery, states, commands, images
- [ ] Milestone 5 — scene triggers and scene action
- [ ] Milestone 6 — docs (install, security, dedicated account, MQTT ACL,
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

## Milestone 2 — httpClient + capabilities (next)

`src/frigate/httpClient.js` (no Gladys import — ESLint enforces it):

- [ ] undici `Agent` with a custom `connect` built on `tls.connect`:
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
- [ ] Auth: `POST /api/login` `{ user, password }` → JWT in `Set-Cookie`
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
- [ ] Timeout 10 s, body cap (container: 256 MB), retry with exponential
      backoff on network errors / 5xx for GET only; honor `Retry-After` on
      429; never retry 4xx. Errors sanitized: no password, token or cookie
      in messages or logs.
- [ ] Endpoints: `GET /api/version` (public, text), `GET /api/config`,
      `GET /api/stats`, `GET /api/<cam>/latest.jpg?height=&quality=`,
      `GET /api/events/<id>/snapshot.jpg?bbox=1&height=&quality=` (for
      `attach_event_snapshot`), `GET /api/events/<id>` (camera of an event).

`src/frigate/capabilities.js`:

- [ ] `/api/version` + `/api/config` → normalized model: per camera `name`,
      `friendly_name`, `enabled`, `detect`, `record`, `snapshots`, `audio`
      (`enabled_in_config`), `review.alerts/detections`, tracked `objects`,
      `zones` (+ their objects), `onvif`/PTZ, plus global features (face
      recognition, LPR, genai, semantic search). Refuse < 0.16.0.
- [ ] Version-gated flags: `statusTopics` (`<cam>/status/<role>`, 0.17+),
      `cameraEnabledTopic` (0.16+), `reviewStatusTopic` (0.16+).
- [ ] `/api/stats` → per-camera health (camera fps 0 = offline) as the 0.16
      fallback for `status/<role>`.
- [ ] Fixtures for 0.16 / 0.17 / 0.18. The HA integration (MIT) has 0.18
      `TEST_CONFIG` / `TEST_STATS` in `tests/__init__.py` → if reused, add a
      `NOTICE` with attribution. 0.16 / 0.17: rebuild from each tag's config
      schema, or use anonymized dumps from the maintainer if provided.
- [ ] Tests: local HTTPS server with `test/fixtures/tls/` (CA-verified,
      first use pins, changed certificate refused, reset re-pins, expert
      fingerprint, expert CA), auth flows, retries with fake timers,
      capabilities on every fixture.

## Milestone 3 — mqttClient (+ WebSocket fallback) + eventEngine

- [ ] `mqttClient.js` (mqtt.js 5): reconnect, resubscribe on reconnect,
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
- [ ] WebSocket fallback (`wss://<frigate>/ws` with undici `WebSocket`,
      Bearer header, same dispatcher): messages are JSON `{ topic, payload }`
      **without** the prefix; send `{ "topic": "onConnect", "payload": "" }`
      after opening to receive `camera_activity` (initial state of every
      camera: `config.detect/record/snapshots`, `motion`, `objects`).
      Register message listeners **before** opening: the first frame can
      arrive in the same chunk as the upgrade response.
- [ ] `eventEngine.js`: `reviews` + `events` → one business transition per
      incident, cooldown per camera (`trigger_cooldown`), ignore
      `false_positive` and stationary objects, `min_score` threshold, a
      detection escalating to an alert counts once more as an alert.
- [ ] Tests on replayed MQTT sequences: duplicates, false positives,
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

- [ ] `src/gladys/discovery.js`: one device per camera, only what the
      Frigate config enables. Features: `camera/image`, `camera/enabled`
      (↔ `<cam>/enabled/set`; Gladys' `CAMERA.ENABLED` also stops Gladys
      polling the image, consistent with a disabled Frigate camera), switches
      `detect` / `recordings` / `snapshots` (`/set`, confirmed by `/state`,
      `has_feedback: true`), `motion-sensor` binary, one `presence-sensor`
      binary per tracked object (count > 0), `counter-sensor` integer total + per object, review status (`text`/`text` read-only, or integer
      0/1/2 — decide), zone sensors when `zone_sensors` is on.
- [ ] `states.js`: batch (≤ 100 per request), dedupe last values, stay under
      300 states/min; only for devices the user created (`gladys.devices`).
- [ ] `commands.js`: `onSetValue` → MQTT/WS `set` topic.
- [ ] `images.js`: `onGetImage` → `latest.jpg`, resized with **sharp**
      (`sharp.cache(false)`, `concurrency(1)`) under 150 KB, as
      `image/jpg;base64,…`; ≤ 12 images/min per camera; push the alert
      snapshot.
- [ ] `publishTransports`: `local`; `unreachable` / `degraded` from the
      debounced `status/<role>`; `setConnectionStatus` driven by
      `<prefix>/available` and the HTTP state, with the config warnings of
      `src/gladys/status.js` and the TLS errors ("certificate changed").
- [ ] Status warning when the trust store cannot be saved (`/data` not
      writable): pins then live in memory only and every restart is a new
      first use. The image creates `/data` owned by `node` (a fresh Docker
      volume was root-owned before); still check how the Gladys supervisor
      mounts `/data` (a bind mount keeps the host directory's owner).
- [ ] Manifest actions: `test_connection` (version, cameras, broker, TLS
      reason), `refresh_cameras` (re-read config, re-publish discovery),
      `reset_certificate` (`trustStore.reset()`, then reconnect; answer with
      the newly pinned fingerprint when the reconnection succeeds).
- [ ] Re-discovery when the Frigate config changes (cameras can be added
      without restart since 0.17) and full resync when `available` comes
      back `online` or MQTT reconnects. Clean shutdown, no orphan timer.

## Milestone 5 — scene triggers and action

- [ ] `sceneEvents.js`: `publishSceneEvent` with flat data (≤ 30 keys,
      strings ≤ 1000 chars), `camera` = Gladys device external id, plus
      `camera_name`, `label`, `sub_label`, `zone`, `zones`, `score` (0–100),
      `event_id`, `review_id`, `severity`, `objects`; ≤ 300 events/min.
- [ ] `attach_event_snapshot` (`onSceneAction`): fetch
      `/api/events/<id>/snapshot.jpg` (bbox per field), resize under 150 KB,
      `publishCameraImage` on the chosen camera or the event's camera; the
      scene then chains the core action "send the camera image".

## Milestone 6 — docs and release

- [ ] docs/en.md + docs/fr.md: install, security model (TOFU, expert TLS),
      dedicated Frigate account, MQTT ACL, WebSocket mode limits, live video
      via the core `rtsp-camera` service on
      `rtsp://<frigate>:8554/<cam>` (go2rtc restream), troubleshooting.
- [ ] Remove the "in development" banners and the `NOT_WIRED` status of
      `index.js`; CHANGELOG `0.1.0`; make the repo public, add the topic
      `gladys-assistant-integration`, run the Release workflow, make the
      ghcr.io package public, `npm run validate:manifest` must pass.

## Open recommendations (maintainer's call, not done)

- Release workflow: it bumps, tags and publishes without running lint and
  tests; add a quality job before `prepare`.
- CI: add `npm audit --omit=dev --audit-level=high`; pin the GitHub Actions
  by commit SHA (with Dependabot for updates); arm64 is only built at
  release time (the musl arm64 `sharp` binaries are in the lockfile).
- `npm run validate:manifest` runs the latest, unpinned
  `github:GladysAssistant/integration-store` through `npx --yes`: pin a
  commit if supply chain matters more than following rule updates.

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
