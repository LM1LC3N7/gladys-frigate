import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

/** Fake real-time feeds: drive their status and messages from the test. */
function fakeFeedFactory() {
  const created = [];
  const factory = ({ config }) => {
    const feed = new EventEmitter();
    feed.mode = config.mqtt_host ? 'mqtt' : 'websocket';
    feed.endpoint = config.mqtt_host ? `${config.mqtt_host}:${config.mqtt_port}` : 'wss://x/ws';
    feed.status = { state: 'connecting', error: null };
    feed.closed = false;
    feed.close = async () => {
      feed.closed = true;
    };
    feed.setStatus = (state, error = null) => {
      feed.status = { state, error };
      feed.emit('status', feed.status);
    };
    created.push(feed);
    return feed;
  };
  factory.created = created;
  return factory;
}

function setup({
  outcomes,
  mqttCheck,
  retryDelayMs = 60_000,
  onConnected,
  onTransition,
  onMessage,
  onFeedStatus,
  onFrigateStatus,
  onFrigateFlapping,
  activityReader = async () => ({}),
  resyncDelayMs = 0,
} = {}) {
  const statuses = [];
  const logs = [];
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
  const feedFactory = fakeFeedFactory();
  const session = createFrigateSession({
    gladys,
    trustStore,
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    clientFactory,
    mqttCheck: mqttCheck ?? (async () => ({ tlsDecision: null })),
    retryDelayMs,
    onConnected,
    feedFactory,
    onTransition,
    onMessage,
    onFeedStatus,
    onFrigateStatus,
    onFrigateFlapping,
    activityReader,
    resyncDelayMs,
  });
  return { session, statuses, resets, clientFactory, feedFactory, trustStore, logs };
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
  assert.match(answer.en, /listed in the Discover tab/);
});

test('every successful read hands the cameras over (discovery), a failure does not', async (t) => {
  const handed = [];
  const { session } = setup({
    outcomes: [undefined, new UnreachableError('ECONNREFUSED')],
    onConnected: async (capabilities) => handed.push(capabilities.cameras.length),
  });
  t.after(() => session.close());
  await apply(session);
  assert.deepEqual(handed, [2]);
  assert.ok(session.client, 'the client is exposed while connected');
  await session.refreshCameras();
  assert.deepEqual(handed, [2], 'not on a failure');
  assert.equal(session.client, null, 'no client while Frigate is down');
  assert.equal((await session.ensureConnected()).cameras.length, 2, 'reads Frigate again');
  assert.deepEqual(handed, [2, 2]);
});

test('a failing discovery publication does not mark Frigate as down', async (t) => {
  const { session, statuses } = setup({
    onConnected: async () => {
      throw new Error('Gladys answered 400');
    },
  });
  t.after(() => session.close());
  await apply(session);
  assert.equal(statuses.at(-1).connected, true);
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
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
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

  const { createCameraImages } = await import('../src/gladys/images.js');
  const images = createCameraImages({ getClient: () => session.client, publish: async () => {} });
  const image = await images.capture('front');
  assert.ok(image.startsWith('image/jpg;base64,/9'), 'a JPEG (FF D8)');
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the real-time feed starts once Frigate is read; its state is in the status', async (t) => {
  const { session, statuses, feedFactory } = setup();
  t.after(() => session.close());
  await apply(session);
  assert.equal(feedFactory.created.length, 1);
  const [feed] = feedFactory.created;
  assert.equal(feed.mode, 'websocket');
  assert.match(statuses.at(-1).message.en, /Real-time feed: connecting to the Frigate WebSocket/);
  feed.setStatus('connected');
  await settle();
  assert.match(
    statuses.at(-1).message.en,
    /2 cameras \(Front door, garage\)\. Real-time feed: Frigate WebSocket connected\./,
  );
  assert.match(statuses.at(-1).message.fr, /Flux temps réel : WebSocket de Frigate connecté\./);
  const count = statuses.length;
  feed.setStatus('connected');
  await settle();
  assert.equal(statuses.length, count, 'an unchanged status is not sent again');
});

test('a broker feed that gives up marks the integration disconnected until fixed', async (t) => {
  const { session, statuses, feedFactory } = setup();
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  const [feed] = feedFactory.created;
  assert.equal(feed.mode, 'mqtt');
  feed.setStatus('disconnected', new UnreachableError('ECONNREFUSED'));
  await settle();
  assert.equal(statuses.at(-1).connected, true, 'a transient failure is retried by the feed');
  assert.match(
    statuses.at(-1).message.en,
    /Real-time feed interrupted, retrying\. Cannot reach MQTT broker broker:1883/,
  );
  feed.setStatus('failed', new MqttRefusedError('invalid_credentials'));
  await settle();
  assert.equal(statuses.at(-1).connected, false);
  assert.match(
    statuses.at(-1).message.fr,
    /Flux temps réel arrêté\. Broker MQTT broker:1883 : le broker a refusé/,
  );
  // "Test the connection" gives the feed another chance.
  await session.testConnection();
  assert.ok(feed.closed);
  assert.equal(feedFactory.created.length, 2);
});

test('Frigate announcing it is offline shows; back online, its configuration is read again', async (t) => {
  const { session, statuses, feedFactory, clientFactory } = setup();
  t.after(() => session.close());
  await apply(session);
  const [feed] = feedFactory.created;
  feed.setStatus('connected');
  feed.emit('message', 'available', 'online');
  await settle();
  let configReads = 0;
  const client = clientFactory.created[0];
  const getConfig = client.getConfig;
  client.getConfig = async () => {
    configReads += 1;
    return getConfig();
  };
  feed.emit('message', 'available', 'offline');
  await settle();
  assert.match(statuses.at(-1).message.en, /Frigate announces it is offline/);
  assert.equal(configReads, 0);
  feed.emit('message', 'available', 'online');
  await settle();
  await settle();
  assert.equal(configReads, 1, 'configuration read again after the restart');
  assert.doesNotMatch(statuses.at(-1).message.en, /offline/);
});

test('back online, Frigate is read again at most once per resync delay', async (t) => {
  const { session, feedFactory, clientFactory } = setup({ resyncDelayMs: 80 });
  t.after(() => session.close());
  await apply(session);
  const [feed] = feedFactory.created;
  feed.setStatus('connected');
  let configReads = 0;
  const client = clientFactory.created[0];
  const getConfig = client.getConfig;
  client.getConfig = async () => {
    configReads += 1;
    return getConfig();
  };
  for (let i = 0; i < 3; i += 1) {
    feed.emit('message', 'available', 'offline');
    feed.emit('message', 'available', 'online');
  }
  await settle();
  assert.equal(configReads, 0, 'read just before: the re-read waits');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(configReads, 1, 'one re-read for the three announcements');
});

test('a Frigate dropping its broker connection again and again is reported', async (t) => {
  const flaps = [];
  const { session, statuses, feedFactory, logs } = setup({
    onFrigateFlapping: (flapping) => flaps.push(flapping),
  });
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  const [feed] = feedFactory.created;
  feed.setStatus('connected');
  feed.emit('message', 'available', 'online');
  for (let i = 0; i < 2; i += 1) {
    feed.emit('message', 'available', 'offline');
    feed.emit('message', 'available', 'online');
  }
  await settle();
  assert.deepEqual(flaps, [], 'two drops are not flapping yet');
  feed.emit('message', 'available', 'stopped');
  feed.emit('message', 'available', 'online');
  assert.deepEqual(flaps, [], 'a clean stop (0.18) is not a drop');
  feed.emit('message', 'available', 'offline');
  await settle();
  assert.deepEqual(flaps, [true]);
  const { message } = statuses.at(-1);
  assert.match(message.en, /Frigate keeps dropping its MQTT connection.*client_id/);
  assert.match(message.fr, /Frigate perd sans cesse sa connexion MQTT/);
  assert.doesNotMatch(message.en, /announces it is offline/, 'no status change at every drop');
  const statusCount = statuses.length;
  feed.emit('message', 'available', 'online');
  feed.emit('message', 'available', 'offline');
  await settle();
  assert.equal(statuses.length, statusCount, 'the status stays the same while it flaps');
  assert.equal(logs.filter(([level]) => level === 'warn').length, 1, 'one warning');
  // A new configuration starts afresh.
  await apply(session);
  assert.deepEqual(flaps, [true, false]);
  assert.doesNotMatch(statuses.at(-1).message.en, /keeps dropping/);
});

test('MQTT retains no count: the current objects are read when the feed connects', async (t) => {
  const reads = [];
  const messages = [];
  const { session, feedFactory, clientFactory } = setup({
    activityReader: async ({ client }) => {
      reads.push(client);
      return { front: { motion: false, objects: [{ label: 'person' }] } };
    },
    onMessage: (message) => messages.push(message),
  });
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  const [feed] = feedFactory.created;
  feed.setStatus('connected');
  await settle();
  assert.deepEqual(reads, [clientFactory.created[0]]);
  assert.equal(messages.at(-1).type, 'cameraActivity');
  assert.deepEqual(messages.at(-1).cameras.front.objects, [{ label: 'person' }]);
  // And again when Frigate is back online.
  feed.emit('message', 'available', 'offline');
  feed.emit('message', 'available', 'online');
  await settle();
  await settle();
  await settle();
  assert.equal(reads.length, 2);
});

test('the WebSocket feed gets the current objects on its own: no extra read', async (t) => {
  const reads = [];
  const { session, feedFactory } = setup({
    activityReader: async () => {
      reads.push(1);
      return {};
    },
  });
  t.after(() => session.close());
  await apply(session);
  feedFactory.created[0].setStatus('connected');
  await settle();
  assert.deepEqual(reads, []);
});

test('a failing read of the current objects is logged once', async (t) => {
  const { session, feedFactory, logs } = setup({
    activityReader: async () => {
      throw new UnreachableError('TIMEOUT');
    },
  });
  t.after(() => session.close());
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  const [feed] = feedFactory.created;
  feed.setStatus('connected');
  await settle();
  feed.setStatus('disconnected', new UnreachableError('ECONNRESET'));
  feed.setStatus('connected');
  await settle();
  const warnings = logs.filter(([, message]) => /current objects/.test(message));
  assert.equal(warnings.length, 1);
});

test('messages are typed and their transitions handed over, per the configured score', async (t) => {
  const transitions = [];
  const messages = [];
  const { session, feedFactory } = setup({
    onTransition: (transition) => transitions.push(transition),
    onMessage: (message) => messages.push(message.type),
  });
  t.after(() => session.close());
  await apply(session, { ...RAW, min_score: 90 });
  const [feed] = feedFactory.created;
  const event = (id, score) =>
    JSON.stringify({
      type: 'new',
      before: {},
      after: { id, camera: 'front', label: 'person', top_score: score, entered_zones: [] },
    });
  feed.emit('message', 'events', event('low', 0.8));
  feed.emit('message', 'events', event('high', 0.95));
  feed.emit('message', 'front/motion', 'ON');
  feed.emit('message', 'unknown_camera/motion', 'ON');
  assert.deepEqual(
    transitions.map((t) => [t.kind, t.eventId]),
    [['object_detected', 'high']],
  );
  assert.deepEqual(messages, ['event', 'event', 'motion']);
});

test('a new configuration, a certificate reset or close() stop the running feed', async (t) => {
  const { session, feedFactory } = setup();
  t.after(() => session.close());
  await apply(session);
  await apply(session, { ...RAW, mqtt_host: 'broker' });
  assert.ok(feedFactory.created[0].closed);
  assert.equal(feedFactory.created[1].mode, 'mqtt');
  await session.resetCertificate();
  assert.ok(feedFactory.created[1].closed);
  assert.equal(feedFactory.created.length, 3);
  const old = feedFactory.created[2];
  old.setStatus('connected');
  await session.close();
  assert.ok(old.closed);
  assert.equal(session.feed, null);
});

test('the device side hears about Frigate and the feed', async (t) => {
  const frigate = [];
  const feeds = [];
  const { session, feedFactory } = setup({
    outcomes: [undefined, new UnreachableError('ECONNREFUSED')],
    onFrigateStatus: (up) => frigate.push(up),
    onFeedStatus: (status) => feeds.push(status.state),
  });
  t.after(() => session.close());
  await apply(session);
  feedFactory.created[0].setStatus('connected');
  await session.refreshCameras();
  await session.close();
  assert.deepEqual(frigate, [true, false]);
  assert.deepEqual(feeds, ['connecting', 'connected', null]);
});

test('pins that cannot be saved are reported in the status', async (t) => {
  const { session, statuses, trustStore } = setup();
  t.after(() => session.close());
  trustStore.saveError = new Error('EACCES');
  await apply(session);
  assert.match(statuses.at(-1).message.en, /cannot be saved in \/data/);
  assert.match(statuses.at(-1).message.fr, /ne peuvent pas être enregistrés dans \/data/);
});
