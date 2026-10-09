import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, CertificateError } from '../src/frigate/errors.js';
import { createFrigateClient } from '../src/frigate/httpClient.js';
import { TrustStore, endpointKey } from '../src/frigate/tlsTrust.js';
import { createWsFeed } from '../src/frigate/wsClient.js';
import { startFakeFrigate } from './helpers/fakeFrigate.js';
import { waitFor } from './helpers/waitFor.js';

async function trustStoreIn(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return new TrustStore({ filePath: join(dir, 'tls-trust.json') }).load();
}

function feedFor(t, frigate, { password = 'pw', trustStore } = {}) {
  const client = createFrigateClient({
    url: frigate.url,
    username: 'gladys',
    password,
    trustStore,
    retryDelayMs: 1,
  });
  const feed = createWsFeed({ client, minDelayMs: 20, maxDelayMs: 50 });
  const messages = [];
  const statuses = [];
  feed.on('message', (topic, payload) => messages.push([topic, payload]));
  feed.on('status', (status) => statuses.push(status.state));
  t.after(async () => {
    await feed.close();
    await client.close();
  });
  return { feed, messages, statuses };
}

const logins = (frigate) => frigate.calls.filter((call) => call.url === '/api/login').length;

test('logs in, opens /ws with the Bearer token, asks for the camera activity', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const { feed, messages } = feedFor(t, frigate);
  await waitFor(() => feed.status.state === 'connected' && messages.length === 1);
  const upgrade = frigate.calls.find((call) => call.method === 'UPGRADE');
  assert.match(upgrade.authorization, /^Bearer /);
  assert.deepEqual(frigate.wsReceived, [{ topic: 'onConnect', payload: '' }]);
  assert.equal(messages[0][0], 'camera_activity');
  frigate.wsSend('front/motion', 'ON');
  frigate.wsSend('front/person', 1);
  await waitFor(() => messages.length === 3);
  assert.deepEqual(messages.slice(1), [
    ['front/motion', 'ON'],
    ['front/person', 1],
  ]);
  assert.equal(feed.mode, 'websocket');
  assert.match(feed.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
});

test('reconnects after a drop, logging in again when the token was revoked', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const { feed, statuses } = feedFor(t, frigate);
  await waitFor(() => feed.status.state === 'connected' && frigate.wsReceived.length === 1);
  assert.equal(logins(frigate), 1);
  frigate.revokeTokens();
  frigate.wsDrop();
  await waitFor(() => statuses.includes('disconnected'));
  await waitFor(() => feed.status.state === 'connected' && frigate.wsClientCount === 1, {
    what: 'reconnection',
  });
  assert.equal(logins(frigate), 2);
  await waitFor(() => frigate.wsReceived.filter((m) => m.topic === 'onConnect').length === 2, {
    what: 'onConnect on the new connection',
  });
});

test('a refused WebSocket is retried with a backoff, and says why', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const { feed } = feedFor(t, frigate);
  await waitFor(() => feed.status.state === 'connected');
  frigate.wsDrop({ refuse: true });
  await waitFor(() => feed.status.error?.code === 'WEBSOCKET_REFUSED');
  assert.equal(feed.status.state, 'disconnected');
  frigate.wsDrop({ refuse: false });
  await waitFor(() => feed.status.state === 'connected', { what: 'recovery' });
});

test('refused credentials stop the feed (Frigate rate-limits logins)', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const { feed } = feedFor(t, frigate, { password: 'wrong' });
  await waitFor(() => feed.status.state === 'failed');
  assert.ok(feed.status.error instanceof AuthError);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(logins(frigate), 1);
});

test('https: a changed certificate stops the feed before any token is sent', async (t) => {
  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const trustStore = await trustStoreIn(t);
  await trustStore.set(endpointKey('127.0.0.1', frigate.port), Array(32).fill('AA').join(':'));
  const { feed } = feedFor(t, frigate, { trustStore });
  await waitFor(() => feed.status.state === 'failed');
  assert.ok(feed.status.error instanceof CertificateError);
  assert.deepEqual(frigate.calls, [], 'nothing reached Frigate');
});

test('https: the WebSocket goes through the trusted connection', async (t) => {
  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const trustStore = await trustStoreIn(t);
  const { feed, messages } = feedFor(t, frigate, { trustStore });
  await waitFor(() => feed.status.state === 'connected' && messages.length === 1);
  assert.match(feed.endpoint, /^wss:/);
  assert.equal(trustStore.list().length, 1);
});
