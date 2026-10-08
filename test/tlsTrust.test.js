import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRUST_REASONS, TrustStore, decideTrust, endpointKey } from '../src/frigate/tlsTrust.js';

const FP_A = Array(32).fill('AA').join(':');
const FP_B = Array(32).fill('BB').join(':');
const selfSigned = (fingerprint) => ({ fingerprint, chainValid: false, hostnameValid: false });

test('a certificate valid for the host is trusted without pinning', () => {
  const decision = decideTrust({ fingerprint: FP_A, chainValid: true, hostnameValid: true });
  assert.deepEqual(decision, { trusted: true, reason: TRUST_REASONS.CA_VERIFIED });
});

test('a valid chain for the wrong host name is not CA-verified', () => {
  const decision = decideTrust(
    { fingerprint: FP_A, chainValid: true, hostnameValid: false },
    { pinnedFingerprint: FP_B },
  );
  assert.equal(decision.trusted, false);
});

test('the first self-signed certificate is trusted and must be pinned', () => {
  assert.deepEqual(decideTrust(selfSigned(FP_A)), {
    trusted: true,
    reason: TRUST_REASONS.FIRST_USE,
    pin: FP_A,
  });
});

test('later connections must present the pinned certificate', () => {
  assert.deepEqual(decideTrust(selfSigned(FP_A), { pinnedFingerprint: FP_A }), {
    trusted: true,
    reason: TRUST_REASONS.PINNED,
  });
  assert.deepEqual(decideTrust(selfSigned(FP_B), { pinnedFingerprint: FP_A }), {
    trusted: false,
    reason: TRUST_REASONS.CERTIFICATE_CHANGED,
  });
});

test('fingerprints compare case-insensitively', () => {
  assert.equal(
    decideTrust(selfSigned(FP_A.toLowerCase()), { pinnedFingerprint: FP_A }).trusted,
    true,
  );
});

test('an expert fingerprint replaces both CA checks and first use', () => {
  assert.equal(
    decideTrust(selfSigned(FP_A), { manualFingerprint: FP_A }).reason,
    TRUST_REASONS.MANUAL_PIN,
  );
  const valid = { fingerprint: FP_B, chainValid: true, hostnameValid: true };
  assert.deepEqual(decideTrust(valid, { manualFingerprint: FP_A }), {
    trusted: false,
    reason: TRUST_REASONS.MANUAL_PIN_MISMATCH,
  });
});

test('an expert CA never falls back to first use', () => {
  assert.deepEqual(decideTrust(selfSigned(FP_A), { customCa: true }), {
    trusted: false,
    reason: TRUST_REASONS.CA_REJECTED,
  });
  assert.equal(
    decideTrust({ fingerprint: FP_A, chainValid: true, hostnameValid: true }, { customCa: true })
      .trusted,
    true,
  );
});

test('a peer without fingerprint is never trusted on first use', () => {
  assert.equal(
    decideTrust({ fingerprint: '', chainValid: false, hostnameValid: false }).trusted,
    false,
  );
});

test('endpointKey normalizes the host', () => {
  assert.equal(endpointKey('Frigate.LAN', '8971'), 'frigate.lan:8971');
});

test('the trust store persists pins atomically and resets them', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'nested', 'tls-trust.json');
  const now = () => new Date('2026-10-08T12:00:00Z');

  const store = await new TrustStore({ filePath, now }).load();
  assert.equal(store.get('frigate:8971'), undefined);
  await store.set('frigate:8971', FP_A);
  await store.set('broker:8883', FP_B);

  const reloaded = await new TrustStore({ filePath }).load();
  assert.equal(reloaded.get('frigate:8971'), FP_A);
  assert.deepEqual(reloaded.list()[0], {
    endpoint: 'frigate:8971',
    fingerprint: FP_A,
    pinned_at: '2026-10-08T12:00:00.000Z',
  });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600, 'pins are private to the container');

  await reloaded.reset('frigate:8971');
  assert.equal((await new TrustStore({ filePath }).load()).get('frigate:8971'), undefined);
  assert.equal((await new TrustStore({ filePath }).load()).get('broker:8883'), FP_B);

  await reloaded.reset();
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), {});
});

test('an unwritable or corrupted store degrades to memory, with a warning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };

  // A directory where the file should be: reading and writing both fail.
  const store = await new TrustStore({ filePath: dir, logger }).load();
  await store.set('frigate:8971', FP_A);
  assert.equal(store.get('frigate:8971'), FP_A, 'the pin is kept in memory');
  assert.ok(warnings.length >= 2);
});
