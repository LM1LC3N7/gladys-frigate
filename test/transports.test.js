import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysIntegration } from '@gladysassistant/integration-sdk';
import { createTransportTracker } from '../src/gladys/transports.js';
import { gladysIds } from './helpers/gladysIds.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(t, { cameras = ['front', 'garage'], debounceMs = 30 } = {}) {
  const published = [];
  const errors = [];
  // The SDK's own validation (it refuses, e.g., a message without "degraded").
  const validate = (batch) =>
    GladysIntegration.prototype.publishTransports.call(
      { httpClient: { post: async () => {} } },
      batch,
    );
  const tracker = createTransportTracker({
    gladys: {
      ...gladysIds,
      publishTransports: async (batch) => {
        await validate(batch);
        published.push(...batch);
      },
    },
    createdCameras: () => cameras,
    logger: { warn: (message) => errors.push(message) },
    debounceMs,
  });
  // Every batch must have passed the SDK's validation.
  t.after(() => assert.deepEqual(errors, []));
  const last = (camera) =>
    published.filter((t) => t.external_id === `ext:frigate:camera:${camera}`).at(-1);
  return { tracker, published, last };
}

test('nothing before Frigate was read; then local, and only changes are sent', async (t) => {
  const { tracker, published, last } = setup(t);
  t.after(() => tracker.close());
  tracker.setFeed('connecting');
  await settle();
  assert.equal(published.length, 0);
  tracker.setFrigateUp(true);
  await settle();
  assert.equal(published.length, 2, 'a feed still connecting is not degraded');
  tracker.setFeed('connected');
  await settle();
  assert.deepEqual(last('front'), { external_id: 'ext:frigate:camera:front', transport: 'local' });
  assert.equal(published.length, 2);
  tracker.setFrigateUp(true);
  await settle();
  assert.equal(published.length, 2, 'unchanged');
});

test('Frigate down or offline: every camera unreachable; a broken feed: degraded', async (t) => {
  const { tracker, last } = setup(t);
  t.after(() => tracker.close());
  tracker.setFrigateUp(true);
  tracker.setFeed('disconnected');
  await settle();
  assert.equal(last('front').transport, 'local');
  assert.equal(last('front').degraded, true);
  assert.match(last('front').message.fr, /Flux temps réel interrompu/);
  tracker.setFrigateOnline(false);
  await settle();
  // Gladys only takes a message with "degraded".
  assert.deepEqual(last('garage'), {
    external_id: 'ext:frigate:camera:garage',
    transport: 'unreachable',
  });
  tracker.setFrigateOnline(true);
  await settle();
  assert.equal(last('garage').transport, 'local');
  tracker.setFrigateUp(false);
  await settle();
  assert.equal(last('front').transport, 'unreachable');
});

test('a camera status only counts once offline for the debounce delay', async (t) => {
  const { tracker, last } = setup(t, { debounceMs: 40 });
  t.after(() => tracker.close());
  tracker.setFrigateUp(true);
  tracker.setCameraStatus('front', 'detect', 'offline');
  await settle();
  assert.equal(last('front').transport, 'local', 'ffmpeg restarts flap');
  tracker.setCameraStatus('front', 'detect', 'online');
  await wait(60);
  assert.equal(last('front').transport, 'local');
  tracker.setCameraStatus('front', 'detect', 'offline');
  tracker.setCameraStatus('garage', 'record', 'offline');
  tracker.setCameraStatus('garage', 'detect', 'disabled');
  await wait(60);
  assert.equal(last('front').transport, 'unreachable');
  assert.deepEqual(last('garage'), {
    external_id: 'ext:frigate:camera:garage',
    transport: 'local',
    degraded: true,
    message: {
      en: 'The recording stream is interrupted',
      fr: "Le flux d'enregistrement est interrompu",
    },
  });
  tracker.setCameraStatus('front', 'detect', 'online');
  await settle();
  assert.equal(last('front').transport, 'local');
});

test('forget() sends every badge again (Gladys restarted)', async (t) => {
  const { tracker, published } = setup(t, { cameras: ['front'] });
  t.after(() => tracker.close());
  tracker.setFrigateUp(true);
  await settle();
  tracker.forget();
  await settle();
  assert.equal(published.length, 2);
});
