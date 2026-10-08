import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CertificateError, MqttRefusedError } from '../src/frigate/errors.js';
import { SUBSCRIPTIONS, createMqttFeed } from '../src/frigate/mqttClient.js';
import { TrustStore, endpointKey } from '../src/frigate/tlsTrust.js';
import { startTestBroker } from './helpers/testBroker.js';
import { waitFor } from './helpers/waitFor.js';

async function trustStoreIn(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-mqtt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new TrustStore({ filePath: join(dir, 'tls-trust.json') }).load();
}

function feedFor(t, broker, options = {}) {
  const feed = createMqttFeed({
    host: '127.0.0.1',
    port: broker.port,
    prefix: 'frigate',
    reconnectPeriodMs: 50,
    ...options,
  });
  const messages = [];
  const statuses = [];
  feed.on('message', (topic, payload) => messages.push([topic, String(payload)]));
  feed.on('status', (status) => statuses.push(status.state));
  t.after(() => feed.close());
  return { feed, messages, statuses };
}

test('subscribes to the known topics only, gets retained states, strips the prefix', async (t) => {
  const broker = await startTestBroker({ account: { username: 'gladys', password: 'pw' } });
  t.after(() => broker.close());
  broker.publish('frigate/available', 'online', { retain: true });
  broker.publish('frigate/front/detect/state', 'ON', { retain: true });
  broker.publish('frigate/front/person/snapshot', 'JPEG', { retain: true });
  const { feed, messages } = feedFor(t, broker, { username: 'gladys', password: 'pw' });
  await waitFor(() => feed.status.state === 'connected' && messages.length >= 2, {
    what: 'retained states',
  });
  assert.deepEqual(
    broker.stats.subscribes,
    SUBSCRIPTIONS.map((filter) => `frigate/${filter}`),
  );
  broker.publish('frigate/front/motion', 'ON');
  broker.publish('frigate/events', '{"type":"new"}');
  broker.publish('other/front/motion', 'ON');
  await waitFor(() => messages.length >= 4, { what: 'live messages' });
  assert.deepEqual(messages.sort(), [
    ['available', 'online'],
    ['events', '{"type":"new"}'],
    ['front/detect/state', 'ON'],
    ['front/motion', 'ON'],
  ]);
});

test('reconnects and subscribes again after the connection drops', async (t) => {
  const broker = await startTestBroker();
  t.after(() => broker.close());
  const { feed, messages, statuses } = feedFor(t, broker);
  await waitFor(() => feed.status.state === 'connected');
  broker.dropClients();
  await waitFor(() => statuses.includes('disconnected'), { what: 'disconnection' });
  await waitFor(() => feed.status.state === 'connected' && broker.clientCount === 1, {
    what: 'reconnection',
  });
  // CONNACK comes before the SUBSCRIBE reaches the broker.
  await waitFor(() => broker.stats.subscribes.length === SUBSCRIPTIONS.length * 2, {
    what: 'the subscriptions renewed',
  });
  broker.publish('frigate/front/motion', 'OFF');
  await waitFor(() => messages.length === 1);
});

test('refused credentials stop the feed: no reconnection loop', async (t) => {
  const broker = await startTestBroker({ account: { username: 'gladys', password: 'pw' } });
  t.after(() => broker.close());
  const { feed } = feedFor(t, broker, { username: 'gladys', password: 'wrong' });
  await waitFor(() => feed.status.state === 'failed');
  assert.ok(feed.status.error instanceof MqttRefusedError);
  assert.equal(feed.status.error.code, 'invalid_credentials');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(broker.stats.connects, 1);
});

test('a broker ACL refusing every topic is reported as not authorized', async (t) => {
  const broker = await startTestBroker({ denySubscribe: () => true });
  t.after(() => broker.close());
  const { feed } = feedFor(t, broker);
  await waitFor(() => feed.status.state === 'failed');
  assert.equal(feed.status.error.code, 'not_authorized');
});

test('TLS: trusted on first use, then a changed certificate never gets the password', async (t) => {
  const broker = await startTestBroker({ secure: true });
  t.after(() => broker.close());
  const trustStore = await trustStoreIn(t);
  const first = feedFor(t, broker, { tls: true, trustStore, password: 'pw', username: 'u' });
  await waitFor(() => first.feed.status.state === 'connected');
  await first.feed.close();
  assert.equal(trustStore.list().length, 1);
  assert.equal(broker.stats.connects, 1);

  await trustStore.set(endpointKey('127.0.0.1', broker.port), Array(32).fill('AA').join(':'));
  const second = feedFor(t, broker, { tls: true, trustStore, password: 'pw', username: 'u' });
  await waitFor(() => second.feed.status.state === 'failed');
  assert.ok(second.feed.status.error instanceof CertificateError);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(broker.stats.connects, 1, 'no CONNECT (and password) reached the broker');
});

test('publish goes to <prefix>/<topic>', async (t) => {
  const broker = await startTestBroker();
  t.after(() => broker.close());
  const { feed } = feedFor(t, broker);
  await waitFor(() => feed.status.state === 'connected');
  await feed.publish('front/detect/set', 'OFF');
  await waitFor(() => broker.published.length === 1);
  assert.deepEqual(broker.published, [{ topic: 'frigate/front/detect/set', payload: 'OFF' }]);
});
