import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConfig } from '../src/config.js';
import {
  AuthError,
  CertificateError,
  HttpStatusError,
  LoginMissingError,
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
  retryBaseMs = 5_000,
  retryMaxMs = 60_000,
  now,
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
    retryBaseMs,
    retryMaxMs,
    ...(now ? { now } : {}),
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
  const transient = setup({
    outcomes: [new UnreachableError('ECONNREFUSED')],
    retryBaseMs: 10,
  });
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
    const permanent = setup({ outcomes: [error], retryBaseMs: 10 });
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

// --- Retries of the API after a failed read (issue #12) ----------------------

/** Simulated clock: setTimeout mocked, `now` follows it. */
function fakeClock(t) {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let time = 1_000_000;
  return {
    now: () => time,
    async tick(ms) {
      time += ms;
      mock.timers.tick(ms);
      for (let i = 0; i < 5; i += 1) await settle();
    },
  };
}

/** A session connected over MQTT with Frigate online; counts the version reads. */
async function onlineSession(t, outcomes, options = {}) {
  const clock = fakeClock(t);
  const ctx = setup({ outcomes, now: clock.now, ...options });
  t.after(() => ctx.session.close());
  await apply(ctx.session, { ...RAW, mqtt_host: 'broker' });
  const [feed] = ctx.feedFactory.created;
  feed.setStatus('connected');
  feed.emit('message', 'available', 'online');
  const client = ctx.clientFactory.created[0];
  const getVersion = client.getVersion;
  ctx.reads = 0;
  client.getVersion = async () => {
    ctx.reads += 1;
    return getVersion();
  };
  return Object.assign(ctx, { clock, feed, client });
}

/** Frigate restarts: "offline", then "online" while its API still answers 404. */
async function restart(feed) {
  feed.emit('message', 'available', 'offline');
  feed.emit('message', 'available', 'online');
  for (let i = 0; i < 5; i += 1) await settle();
}

const notFound = () => new HttpStatusError(404, '/api/version');

test('a 404 while Frigate starts is retried with a growing delay until it answers', async (t) => {
  // First read OK (apply), then 404 three times, then OK.
  const ctx = await onlineSession(t, [undefined, notFound(), notFound(), notFound()]);
  const { session, statuses, clock, feed, logs } = ctx;
  await restart(feed);
  assert.equal(ctx.reads, 1, 'read when Frigate came back');
  assert.equal(session.client, null);
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).message.en, /HTTP 404 on \/api\/version.*New attempt in 5 s\./);
  assert.match(statuses.at(-1).message.fr, /Nouvel essai dans 5 s\./);
  await clock.tick(4_999);
  assert.equal(ctx.reads, 1, 'not before 5 s');
  await clock.tick(1);
  assert.equal(ctx.reads, 2);
  assert.match(statuses.at(-1).message.en, /New attempt in 10 s\./);
  await clock.tick(9_999);
  assert.equal(ctx.reads, 2, 'not before 10 s');
  await clock.tick(1);
  assert.equal(ctx.reads, 3);
  await clock.tick(20_000);
  assert.equal(ctx.reads, 4);
  assert.equal(statuses.at(-1).connected, true, 'connected again');
  assert.ok(session.client, 'the API client is available again');
  await clock.tick(10 * 60_000);
  assert.equal(ctx.reads, 4, 'no read once connected');
  const failures = logs.filter(([, line]) => /not available/.test(line));
  assert.equal(failures.length, 1, 'a lasting failure is logged once');
});

test('the retry delay stops growing at its maximum, and a success resets it', async (t) => {
  const failures = Array.from({ length: 8 }, notFound);
  const ctx = await onlineSession(t, [undefined, ...failures]);
  const { statuses, clock, feed } = ctx;
  await restart(feed);
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    delays.push(Number(/New attempt in (\d+) s/.exec(statuses.at(-1).message.en)[1]));
    const before = ctx.reads;
    await clock.tick(delays.at(-1) * 1000);
    assert.equal(ctx.reads, before + 1);
  }
  assert.deepEqual(delays, [5, 10, 20, 40, 60, 60, 60]);
  await clock.tick(60_000);
  assert.equal(statuses.at(-1).connected, true);
  ctx.client.getVersion = async () => {
    ctx.reads += 1;
    throw notFound();
  };
  // Without any "offline" in between: the success alone resets the delay.
  await ctx.session.refreshCameras();
  assert.match(statuses.at(-1).message.en, /New attempt in 5 s\./, 'starts again from 5 s');
});

test('every kind of transient failure is retried; refused credentials are not', async (t) => {
  for (const error of [
    new HttpStatusError(502, '/api/version'),
    new HttpStatusError(503, '/api/config'),
    new UnreachableError('ECONNREFUSED'),
    new UnreachableError('TIMEOUT'),
  ]) {
    const ctx = await onlineSession(t, [undefined, error]);
    await restart(ctx.feed);
    await ctx.clock.tick(5_000);
    assert.equal(ctx.reads, 2, `${error.message}: retried`);
    assert.equal(ctx.statuses.at(-1).connected, true);
    await ctx.session.close();
    mock.timers.reset();
  }
  for (const error of [new AuthError('invalid_credentials'), new AuthError('forbidden')]) {
    const ctx = await onlineSession(t, [undefined, error]);
    await restart(ctx.feed);
    assert.doesNotMatch(ctx.statuses.at(-1).message.en, /New attempt/);
    await ctx.clock.tick(3_600_000);
    assert.equal(ctx.reads, 1, `${error.code}: no retry`);
    ctx.session.kick();
    await ctx.clock.tick(1);
    assert.equal(ctx.reads, 1, `${error.code}: no read on kick`);
    await ctx.session.close();
    mock.timers.reset();
  }
});

test('the retries stop when MQTT says Frigate is offline, and resume when it is back', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound(), notFound(), notFound()]);
  const { session, statuses, clock, feed } = ctx;
  await restart(feed);
  assert.equal(ctx.reads, 1);
  feed.emit('message', 'available', 'offline');
  await clock.tick(3_600_000);
  assert.equal(ctx.reads, 1, 'no read while Frigate is offline');
  // A scan while it is offline fails without announcing a retry.
  assert.equal(await session.ensureConnected(), null);
  assert.equal(ctx.reads, 2);
  assert.doesNotMatch(statuses.at(-1).message.en, /New attempt/);
  await clock.tick(3_600_000);
  assert.equal(ctx.reads, 2, 'still no retry while offline');
  feed.emit('message', 'available', 'online');
  await clock.tick(0);
  assert.equal(ctx.reads, 3, 'read again when it is back');
  assert.match(statuses.at(-1).message.en, /New attempt in 5 s\./, 'backoff restarted');
  await clock.tick(5_000);
  assert.equal(ctx.reads, 4);
  assert.equal(statuses.at(-1).connected, true);
});

test('a re-read waiting for the resync delay is dropped when Frigate goes offline', async (t) => {
  const ctx = await onlineSession(t, [undefined], { resyncDelayMs: 60_000 });
  await restart(ctx.feed);
  assert.equal(ctx.reads, 0, 'read just before: the re-read waits');
  ctx.feed.emit('message', 'available', 'offline');
  await ctx.clock.tick(3_600_000);
  assert.equal(ctx.reads, 0, 'no read while Frigate is offline');
});

test('a failure ending after "offline" schedules no retry', async (t) => {
  const ctx = await onlineSession(t, [undefined]);
  const { clock, feed, client, statuses } = ctx;
  let fail;
  client.getVersion = () => {
    ctx.reads += 1;
    return new Promise((resolve, reject) => {
      fail = reject;
    });
  };
  await restart(feed);
  assert.equal(ctx.reads, 1);
  feed.emit('message', 'available', 'offline');
  fail(notFound());
  await clock.tick(0);
  await clock.tick(3_600_000);
  assert.equal(ctx.reads, 1, '"offline" before the failure');
  // "offline" while the failure status is being published.
  feed.emit('message', 'available', 'online');
  await clock.tick(0);
  assert.equal(ctx.reads, 2);
  const push = statuses.push.bind(statuses);
  statuses.push = (status) => {
    if (/New attempt/.test(status.message?.en)) {
      feed.emit('message', 'available', 'offline');
    }
    return push(status);
  };
  fail(notFound());
  await clock.tick(0);
  await clock.tick(3_600_000);
  assert.equal(ctx.reads, 2, '"offline" during the status update');
});

test('stopping the integration during the wait cancels the retry', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound(), notFound()]);
  await restart(ctx.feed);
  await ctx.clock.tick(5_000);
  assert.equal(ctx.reads, 2, 'next attempt in 10 s');
  await ctx.clock.tick(5_000);
  await ctx.session.close();
  const published = ctx.statuses.length;
  ctx.session.kick();
  await ctx.clock.tick(0);
  assert.equal(ctx.statuses.length, published, 'no read nor status on kick after close()');
  await ctx.clock.tick(3_600_000);
  assert.equal(ctx.reads, 2, 'no read after close()');
  assert.equal(ctx.statuses.length, published, 'no status after close()');
});

test('a new configuration cancels the retry of the previous one', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound()]);
  await restart(ctx.feed);
  await apply(ctx.session, { ...RAW, mqtt_host: 'broker', username: 'other' });
  await ctx.clock.tick(3_600_000);
  assert.equal(ctx.reads, 1, 'the old client is not read again');
});

test('kick() brings a pending retry forward, one read at a time and at most every 5 s', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound(), notFound()]);
  const { session, statuses, clock, feed, client } = ctx;
  await restart(feed);
  session.kick();
  await clock.tick(0);
  assert.equal(ctx.reads, 1, 'too soon after the failed read');
  await clock.tick(5_000);
  assert.equal(ctx.reads, 2, 'second failure: next attempt in 10 s');
  assert.match(statuses.at(-1).message.en, /New attempt in 10 s\./);
  // Hold the next read open to count the concurrent ones.
  let answer;
  const getVersion = client.getVersion;
  client.getVersion = () => {
    ctx.reads += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  await clock.tick(4_999);
  session.kick();
  await clock.tick(0);
  assert.equal(ctx.reads, 2, 'still too soon');
  await clock.tick(1);
  session.kick();
  session.kick();
  await clock.tick(0);
  assert.equal(ctx.reads, 3, 'brought forward once, 5 s after the last read');
  for (let i = 0; i < 5; i += 1) session.kick();
  const scan = session.ensureConnected();
  await clock.tick(60_000);
  assert.equal(ctx.reads, 3, 'one read in flight, a scan joins it');
  client.getVersion = getVersion;
  answer('0.17.2');
  assert.ok(await scan, 'the scan gets the capabilities');
  await clock.tick(0);
  assert.equal(statuses.at(-1).connected, true);
  session.kick();
  await clock.tick(60_000);
  assert.equal(ctx.reads, 3, 'connected: kick does nothing');
});

test('a new configuration during a slow read keeps retrying (the old read is not joined)', async (t) => {
  const clock = fakeClock(t);
  const outcomes = [notFound()];
  const { session, statuses, clientFactory } = setup({ outcomes, now: clock.now });
  t.after(() => session.close());
  await apply(session);
  assert.match(statuses.at(-1).message.en, /New attempt in 5 s\./);
  // The retry of the first configuration hangs (Frigate starting, timeouts).
  clientFactory.created[0].getVersion = () => new Promise(() => {});
  await clock.tick(5_000);
  outcomes.push(notFound(), notFound(), notFound());
  await apply(session, { ...RAW, username: 'other' });
  const second = clientFactory.created[1];
  assert.ok(second);
  assert.match(statuses.at(-1).message.en, /New attempt in 5 s\./);
  let reads = 0;
  const getVersion = second.getVersion;
  second.getVersion = () => {
    reads += 1;
    return getVersion();
  };
  await clock.tick(5_000);
  assert.equal(reads, 1, 'the retry of the new configuration reads its own client');
  await clock.tick(10_000);
  assert.equal(reads, 2, 'and keeps retrying');
  await clock.tick(20_000);
  assert.equal(reads, 3);
  assert.equal(statuses.at(-1).connected, true);
});

test('a button pressed during an automatic read joins it', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound()]);
  const { session, clock, feed, client } = ctx;
  await restart(feed);
  let answer;
  const getVersion = client.getVersion;
  client.getVersion = () => {
    ctx.reads += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  await clock.tick(5_000);
  assert.equal(ctx.reads, 2, 'the retry is reading');
  const tested = session.testConnection();
  const refreshed = session.refreshCameras();
  await clock.tick(0);
  assert.equal(ctx.reads, 2, 'no second read');
  client.getVersion = getVersion;
  answer('0.17.2');
  assert.match((await tested).en, /Frigate 0\.17\.2: 2 cameras/);
  assert.match((await refreshed).en, /read again: 2 cameras/);
});

test('back online after a failed read, Frigate is read again 5 s after it at the soonest', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound(), notFound()]);
  const { clock, feed } = ctx;
  await restart(feed);
  assert.equal(ctx.reads, 1);
  await restart(feed);
  assert.equal(ctx.reads, 1, 'flapping right after a failed read: no read yet');
  await clock.tick(4_999);
  assert.equal(ctx.reads, 1);
  await clock.tick(1);
  assert.equal(ctx.reads, 2);
});

test('HTTP errors say what to check', () => {
  const login = describeError(new LoginMissingError());
  assert.match(login.en, /asks for a login but has no \/api\/login.*Check the URL/);
  assert.match(login.fr, /n'a pas de \/api\/login.*Vérifiez l'URL/);
  assert.match(describeError(new HttpStatusError(302, '/api/version')).en, /redirects elsewhere/);
  assert.match(describeError(new HttpStatusError(404, '/api/version')).fr, /démarrage de Frigate/);
  assert.match(describeError(new HttpStatusError(400, '/api/config')).en, /check the URL/);
  assert.doesNotMatch(describeError(new HttpStatusError(502, '/api/version')).en, /URL/);
});

test('"Trust the new certificate" during a read reads the new client, not the old one', async (t) => {
  const ctx = await onlineSession(t, [undefined, notFound()]);
  const { session, clock, feed, client, clientFactory } = ctx;
  await restart(feed);
  let answerOld;
  client.getVersion = () =>
    new Promise((resolve) => {
      answerOld = resolve;
    });
  await clock.tick(5_000);
  assert.ok(answerOld, 'the retry of the old client is reading');
  let answer = null;
  const reset = session.resetCertificate().then((value) => (answer = value));
  for (let i = 0; i < 10; i += 1) await settle();
  const done = answer;
  answerOld('0.17.2'); // never leave the old read (or a mutant joining it) hanging
  await reset;
  assert.equal(clientFactory.created.length, 2, 'a new client');
  assert.ok(done, 'answered without waiting for the old client');
  assert.match(done.en, /Pinned certificates forgotten\. Frigate certificate/);
});
