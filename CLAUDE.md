# CLAUDE.md

Frigate NVR external integration for Gladys Assistant (Docker container, JS
SDK). Read **[TODO.md](./TODO.md) first**: status, decisions already taken
and the detailed plan of the next milestones.

## Rules

- Node.js >= 20.18.1, JavaScript ESM with JSDoc, no TypeScript build.
- Layering: `src/frigate/` never imports the Gladys SDK nor `src/gladys/`
  (ESLint enforces it); `src/gladys/` is a thin adapter; `index.js` only
  wires.
- Runtime dependencies are limited to `@gladysassistant/integration-sdk`,
  `mqtt`, `sharp`, `undici`. Ask before adding one.
- Container limits: 256 MB RAM, 0.5 CPU, read-only rootfs, only `/data`
  writable, bridge network (unicast to the LAN only).
- Gladys rate limits: 300 states/min, 300 scene events/min, 12 images/min per
  camera, images <= 150 KB.
- Never log or put in URLs a password, token, cookie or secret config value.
- Scene trigger / action keys in `src/gladys/keys.js` are frozen: never
  rename or remove one.
- Code, comments and README in English; `docs/en.md` and `docs/fr.md`
  (>= 300 characters, required by the store).

## Workflow

- One milestone at a time, a short plan first, blocking questions asked
  rather than assumed, one commit per milestone with green tests.
- Before committing, run the checks below, then update README, docs,
  CHANGELOG and TODO.md:
  `npm run format:check && npm run lint && npm test && npm audit`
- CI failing on every job in under 2 seconds = Actions quota exhausted, not a
  bug: report it, do not change the code.
- Store check: `npm run validate:manifest` (the image error is expected until
  the first release).
