import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  AuthError,
  CertificateError,
  MqttRefusedError,
  UnreachableError,
} from '../src/frigate/errors.js';
import { TRUST_REASONS } from '../src/frigate/tlsTrust.js';
import { createFrigateSession } from '../src/gladys/frigateSession.js';
import { describeError, shortFingerprint } from '../src/gladys/messages.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';

const FINGERPRINT = Array(32).fill('AB').join(':');
const RAW = { frigate_url: 'https://192.168.1.10:8971', username: 'gladys', password: 'S3cret' };

/** Fake client: `outcomes` is consumed one per getVersion() call (an Error or nothing). */
function fakeClientFactory(outcomes = []) {
  const created = [];
  const factory = (options) => {
    const client = {
      options,
      closed: false,
      authMode: 'token',
      tlsDecision: {
        trusted: true,
        reason: TRUST_REASONS.FIRST_USE,
        endpoint: '192.168.1.10:8971',
        fingerprint: FINGERPRINT,
      },
      async getVersion() {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) {
          throw outcome;
        }
        return '0.17.2';
      },
      async getConfig() {
        return FRIGATE_CONFIG;
      },
      async close() {
        client.closed = true;
      },
    };
    created.push(client);
    return client;
  };
  factory.created = created;
  return factory;
}

function setup({ outcomes, mqttCheck, retryDelayMs = 60_000 } = {}) {
  const statuses = [];
  const resets = [];
  const gladys = {
    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
    },
  };
  const trustStore = {
    async reset(key) {
      resets.push(key);
    },
  };
  const clientFactory = fakeClientFactory(outcomes);
  const session = createFrigateSession({
    gladys,
    trustStore,
    logger: { info() {}, warn() {} },
    clientFactory,
    mqttCheck: mqttCheck ?? (async () => ({ tlsDecision: null })),
    retryDelayMs,
  });
  return { session, statuses, resets, clientFactory };
}

const apply = (session, raw = RAW) => session.apply(normalizeConfig(raw), raw);

test('a reachable Frigate is reported connected, with its version and cameras', async (t) => {
  const { session, statuses, clientFactory } = setup();
  t.after(() => session.close());
  await apply(session);
  assert.equal(statuses.at(-1).connected, true);
  assert.match(
    statuses.at(-1).message.en,
    /Connected to Frigate 0\.17\.2, 2 cameras \(Front door, garage\)/,
  );
  assert.match(statuses.at(-1).message.fr, /Connecté à Frigate 0\.17\.2, 2 caméras/);
  assert.equal(clientFactory.created[0].options.password, 'S3cret');
  assert.equal(session.capabilities.cameras.length, 2);
});

test('an invalid configuration is reported and creates no client', async (t) => {
  const { session, statuses, clientFactory } = setup();
  t.after(() => session.close());
  await apply(session, { frigate_url: '' });
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).message.en, /URL/);
  assert.equal(clientFactory.created.length, 0);
  const answer = await session.testConnection();
  assert.match(answer.fr, /URL/);
});

test('a network failure is retried; a refused certificate or login is not', async (t) => {
  const transient = setup({ outcomes: [new UnreachableError('ECONNREFUSED')], retryDelayMs: 10 });
  t.after(() => transient.session.close());
  await apply(transient.session);
  assert.equal(transient.statuses.at(-1).connected, false);
  assert.match(transient.statuses.at(-1).message.en, /connection was refused/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(transient.statuses.at(-1).connected, true, 'reconnected by the retry');

  for (const error of [
    new CertificateError(TRUST_REASONS.CERTIFICATE_CHANGED, '192.168.1.10:8971', FINGERPRINT),
    new AuthError('invalid_credentials'),
  ]) {
    const permanent = setup({ outcomes: [error], retryDelayMs: 10 });
    t.after(() => permanent.session.close());
    await apply(permanent.session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(permanent.statuses.length, 1, `${error.name}: no retry`);
    assert.equal(permanent.statuses[0].connected, false);
  }
});

test('"Test the connection" reports Frigate, its certificate, the account and the broker', async (t) => {
  const { session } = setup();
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker', mqtt_tls: true });
  const answer = await session.testConnection();
  assert.match(answer.en, /Frigate 0\.17\.2: 2 cameras/);
  assert.match(answer.en, /trusted on this first connection and pinned \(SHA-256 AB:AB:AB:AB:…/);
  assert.match(answer.en, /logged in as gladys/);
  assert.match(answer.en, /MQTT broker broker:1883: connected/);
  assert.match(answer.fr, /Broker MQTT broker:1883 : connecté/);
  assert.ok(!answer.en.includes('S3cret') && !answer.fr.includes('S3cret'));
});

test('"Test the connection" still checks the broker when Frigate fails, and says why', async (t) => {
  const { session } = setup({
    mqttCheck: async () => {
      throw new MqttRefusedError('invalid_credentials');
    },
  });
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  const answer = await session.testConnection();
  assert.match(answer.en, /broker refused the username or the password/);
  const withoutBroker = setup({ outcomes: [undefined, new AuthError('invalid_credentials')] });
  t.after(() => withoutBroker.session.close());
  await apply(withoutBroker.session);
  const failed = await withoutBroker.session.testConnection();
  assert.match(failed.en, /Frigate refused the username or the password/);
  assert.match(failed.en, /Frigate WebSocket will be used/);
});

test('"Refresh the cameras" reads the Frigate configuration again', async (t) => {
  const { session } = setup();
  t.after(() => session.close());
  await apply(session);
  const answer = await session.refreshCameras();
  assert.match(answer.en, /2 cameras \(Front door, garage\)/);
  assert.match(answer.fr, /Configuration de Frigate relue/);
});

test('"Trust the new certificate" forgets the pins, reconnects and tells what is pinned now', async (t) => {
  const changed = new CertificateError(
    TRUST_REASONS.CERTIFICATE_CHANGED,
    '192.168.1.10:8971',
    FINGERPRINT,
  );
  const { session, statuses, resets, clientFactory } = setup({ outcomes: [changed] });
  t.after(() => session.close());
  await apply(session);
  assert.match(statuses.at(-1).message.en, /Trust the new certificate/);

  const answer = await session.resetCertificate();
  assert.deepEqual(resets, [undefined], 'every endpoint is forgotten');
  assert.equal(clientFactory.created.length, 2, 'a fresh client: no pooled connection reused');
  assert.ok(clientFactory.created[0].closed);
  assert.match(
    answer.en,
    /Pinned certificates forgotten\. Frigate certificate: self-signed, trusted/,
  );
  assert.equal(statuses.at(-1).connected, true);
});

test('error messages explain what to do, in both languages', () => {
  assert.equal(shortFingerprint(FINGERPRINT), 'AB:AB:AB:AB:…:AB:AB:AB:AB');
  const changed = describeError(
    new CertificateError(TRUST_REASONS.CERTIFICATE_CHANGED, 'frigate:8971', FINGERPRINT),
  );
  assert.match(changed.fr, /Faire confiance au nouveau certificat/);
  assert.match(describeError(new AuthError('rate_limited')).fr, /Trop de connexions échouées/);
  assert.match(describeError(new UnreachableError('TIMEOUT')).en, /did not answer in time/);
  assert.match(
    describeError(new MqttRefusedError('not_authorized'), { en: 'Broker', fr: 'Broker' }).fr,
    /^Broker : le broker a refusé ce compte/,
  );
});

test('end to end: real client and trust store against an https Frigate', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { TrustStore } = await import('../src/frigate/tlsTrust.js');
  const { startFakeFrigate } = await import('./helpers/fakeFrigate.js');

  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const trustStore = await new TrustStore({ filePath: join(dir, 'tls-trust.json') }).load();
  const statuses = [];
  const session = createFrigateSession({
    gladys: {
      setConnectionStatus: async (connected, message) => statuses.push({ connected, message }),
    },
    trustStore,
    logger: { info() {}, warn() {} },
  });
  t.after(() => session.close());

  const raw = { frigate_url: frigate.url, username: 'gladys', password: 'pw' };
  await session.apply(normalizeConfig(raw), raw);
  assert.equal(statuses.at(-1).connected, true);
  const answer = await session.testConnection();
  assert.match(answer.en, /Frigate 0\.17\.2-abcdef: 2 cameras/);
  assert.match(answer.en, /logged in as gladys/);
  assert.match(answer.en, /self-signed/);
  const reset = await session.resetCertificate();
  assert.match(reset.en, /trusted on this first connection and pinned/);
  assert.equal(trustStore.list().length, 1);
});
