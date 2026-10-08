# Frigate integration for Gladys Assistant

External integration that brings [Frigate NVR](https://frigate.video) cameras
into [Gladys Assistant](https://gladysassistant.com): snapshots, motion,
object counters, detection / recordings / snapshots switches, and scene
triggers on detected objects, zones and review alerts.

| Compatibility    | Version                                |
| ---------------- | -------------------------------------- |
| Gladys Assistant | **5.1 or later** (`>=5.1.0`)           |
| Frigate          | **0.18 or later** (checked at startup) |

Only the latest release lines are supported, on purpose: the integration
relies on the Gladys 5.1 scene triggers and on the Frigate 0.18 API, and
refuses older versions with an explicit message.

User documentation: [`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md)
(re-hosted by the Gladys store and linked from the Configuration screen).

## How it works

```
Frigate 0.18                                       Gladys 5.1
┌──────────────────────┐   HTTP  /api/version      ┌─────────────────────────┐
│ :5000 (internal)     │◀──────  /api/config  ─────│ this container          │
│ :8971 (auth, JWT)    │◀──────  /api/<cam>/latest.jpg   (SDK 0.14)         │
│                      │                           │                         │
│ /ws (MQTT mirror)    │──── events, reviews ─────▶│ scene triggers          │
│                      │──── motion, counts, ─────▶│ device states           │
│                      │     <cam>/<x>/state       │                         │
│                      │◀─── <cam>/<x>/set ────────│ switch commands         │
└──────────────────────┘                           └─────────────────────────┘
```

- **No MQTT broker needed**: Frigate's WebSocket (`/ws`) relays every message
  it publishes on MQTT and accepts the same `set` commands.
- **Authentication**: port 5000 needs none; on port 8971 the integration logs
  in (`POST /api/login`) and sends the JWT as a bearer token, renewing it on
  a 401. Self-signed certificates are only accepted on explicit opt-in.
- **Images** are re-encoded by Frigate (`height`, `quality`) and stepped down
  until they fit the 150 KB limit of Gladys. They are pushed periodically,
  on each Frigate alert, and served on demand (`onGetImage`).
- **States are deduplicated** before publishing (Gladys accepts 300 states per
  minute) and only sent for the devices the user created.

### Devices

One Gladys device per Frigate camera (`ext:<selector>:camera:<camera_name>`):

| Feature                                 | Category / type              | Source                                                 |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| Image                                   | `camera` / `image`           | `GET /api/<cam>/latest.jpg`                            |
| Motion                                  | `motion-sensor` / `binary`   | `<cam>/motion`                                         |
| One counter per tracked label           | `counter-sensor` / `integer` | `<cam>/<label>`                                        |
| Object detection, Recordings, Snapshots | `switch` / `binary`          | `<cam>/{detect,recordings,snapshots}/state` and `/set` |

### Scene triggers

| Key               | Fires on                                             | Filters             |
| ----------------- | ---------------------------------------------------- | ------------------- |
| `object_detected` | `events` of type `new` (true positives only)         | camera, label       |
| `zone_entered`    | each zone newly entered by a tracked object          | camera, zone, label |
| `review_started`  | a new review item, or a detection escalated to alert | camera, severity    |

## Project structure

```
.
├─ index.js                     # SDK bootstrap (no logic)
├─ src/
│  ├─ integration.js            # lifecycle + SDK handlers (start/stop, states, scenes, images)
│  ├─ devices.js                # Frigate cameras -> Gladys discovery payload
│  ├─ messages.js               # Frigate WebSocket messages -> states / scene events (pure)
│  ├─ snapshot.js               # fit Frigate frames under 150 KB
│  ├─ config.js                 # defaults, normalization, validation
│  └─ frigate/
│     ├─ client.js              # HTTP API client (login, version, config, latest.jpg)
│     ├─ http.js                # node:http(s) wrapper (timeouts, body cap, TLS opt-in)
│     ├─ stream.js              # WebSocket with reconnection + heartbeat
│     └─ version.js             # Frigate >= 0.18 gate
├─ test/                        # node:test suites (fakes + a real local ws server)
├─ docs/{en,fr}.md              # user documentation (mandatory for the store)
├─ gladys-assistant-integration.json  # manifest
├─ Dockerfile                   # Node 24 Alpine, non-root, read-only rootfs ready
└─ .github/workflows/           # ci (lint, test, docker build), build, release
```

## Development

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

Run against a real Gladys instance (developer mode gives you a token and a
selector):

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="frigate" \
LOG_LEVEL=debug \
npm start
```

Or build the image and install it from **Integrations → Developer mode:
install from a Docker image** (Gladys 4.86+ installs straight from the local
Docker daemon):

```bash
docker build -t ghcr.io/lm1lc3n7/gladys-integration-frigate:dev .
```

## Publishing

1. Make the repository **public** and add the GitHub topic
   `gladys-assistant-integration`.
2. Run **Actions → Release → Run workflow** (patch / minor / major). It bumps
   `package.json` and the manifest, tags `vX.Y.Z`, and pushes a multi-arch
   image (`linux/amd64`, `linux/arm64`) to `ghcr.io`.
3. Make the `ghcr.io` package **public** (first release only).
4. Check the manifest with the store validator:
   `npm run validate:manifest`.

The Gladys store indexer picks the integration up within the hour.

## License

[Apache-2.0](./LICENSE)
