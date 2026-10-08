# Frigate integration for Gladys Assistant

External integration that brings [Frigate NVR](https://frigate.video) cameras
into [Gladys Assistant](https://gladysassistant.com). Goal: more reliable and
safer than the Home Assistant integration, built on the official Gladys
integration SDK.

> **Status: in development (milestone 1 — scaffold).** The manifest and the
> configuration are final for v1; the Frigate connection lands in the next
> milestones. See the [CHANGELOG](./CHANGELOG.md).

| Compatibility    | Versions                                             |
| ---------------- | ---------------------------------------------------- |
| Gladys Assistant | 5.1 or later (`>=5.1.0`)                             |
| Frigate          | 0.16, 0.17, 0.18 (version and features read via API) |
| Node.js          | 20.18.1 or later (the image ships Node 24)           |

User documentation: [`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md)
(re-hosted by the Gladys store, linked from the Configuration screen).

Work in progress, decisions and next steps: [`TODO.md`](./TODO.md).

## v1 scope

- **One device per Frigate camera**, discovering only what the Frigate
  configuration enables: image (on demand and alert snapshots, under 150 KB),
  camera enabled, detect / recordings / snapshots switches, motion, one
  presence sensor and one counter per tracked object, a total counter, the
  review status, optional zone sensors.
- **Scene triggers** (keys final, never renamed): `review_alert`,
  `object_detected`, `object_entered_zone`. **Scene action**:
  `attach_event_snapshot`.
- **Real-time feed** from the Frigate MQTT broker, or from the Frigate
  WebSocket when no broker is configured.
- **Security**: authenticated port 8971 with a dedicated (viewer) account,
  certificates verified by a CA or, when self-signed, trusted on first use and
  pinned (with a "Trust the new certificate" button); expert pinned
  fingerprint or custom CA; no secret
  in logs or URLs.

Out of v1: PTZ, faces and plates, classification, widgets, profiles,
multiple Frigate instances, sub-containers.

## Architecture

```
index.js          wiring only
src/config.js     configuration defaults, normalization, validation, warnings
src/frigate/      Frigate client — NO Gladys dependency (enforced by ESLint)
  tlsTrust.js       trust-on-first-use policy + pin store (/data/tls-trust.json)
  httpClient.js     (milestone 2) JWT auth on port 8971, TLS connector (undici), timeouts, retries
  mqttClient.js     (milestone 3) MQTT connection, LWT frigate/available, typed topics
  capabilities.js   (milestone 2) /api/version + /api/config -> normalized cameras & features
  eventEngine.js    (milestone 3) reviews + events -> deduplicated business transitions
src/gladys/       thin adapter to the Gladys SDK
  keys.js           frozen manifest keys (scene triggers / actions)
  status.js         connection status message (errors and security warnings)
```

Runtime dependencies: `@gladysassistant/integration-sdk`, `mqtt`, `sharp`
(image resizing) and `undici` (custom CA and certificate pinning for `fetch`
and the WebSocket fallback; v7, the last line supporting Node 20).

## Development

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint (includes the layering rule)
npm test               # node --test
npm run validate:manifest   # store admission rules (image must be published)
```

Run against a Gladys instance in developer mode:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="frigate" \
LOG_LEVEL=debug npm start
```

`test/fixtures/tls/` holds test-only certificates (a test CA and a
`localhost` certificate); they are never used outside the test suite.

## Publishing

1. Make the repository public and add the GitHub topic
   `gladys-assistant-integration`.
2. Run **Actions → Release** (patch / minor / major): it bumps the version in
   `package.json` and the manifest, tags `vX.Y.Z` and pushes the multi-arch
   image (`linux/amd64`, `linux/arm64`) to `ghcr.io`.
3. Make the `ghcr.io` package public (first release only).

## License

[Apache-2.0](./LICENSE). Test fixtures derived from
[frigate-hass-integration](https://github.com/blakeblackshear/frigate-hass-integration)
(MIT), if any, are credited in `NOTICE`.
