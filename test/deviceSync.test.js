import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readCapabilities } from '../src/frigate/capabilities.js';
import { parseMessage } from '../src/frigate/topics.js';
import { CommandError, createDeviceSync } from '../src/gladys/deviceSync.js';
import { buildDevices } from '../src/gladys/discovery.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';
import { gladysIds } from './helpers/gladysIds.js';

const known = { cameras: new Set(['front', 'garage']), zones: new Set(['porch']) };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeFeed(mode = 'mqtt') {
  const feed = new EventEmitter();
  feed.mode = mode;
  feed.status = { state: 'connected', error: null };
  feed.published = [];
  feed.publish = async (topic, payload) => {
    feed.published.push([topic, payload]);
  };
  return feed;
}

function setup({ version = '0.17.2', feed = fakeFeed(), stats, created = ['front'] } = {}) {
  const capabilities = readCapabilities(version, FRIGATE_CONFIG);
  const states = [];
  const transports = [];
  const pushed = [];
  let statsReads = 0;
  const gladys = {
    ...gladysIds,
    devices: buildDevices(gladysIds, capabilities).filter((device) =>
      created.includes(device.params[0].value),
    ),
    publishStates: async (batch) => states.push(...batch),
    publishTransports: async (batch) => transports.push(...batch),
  };
  const sync = createDeviceSync({
    gladys,
    getCapabilities: () => capabilities,
    getClient: () => ({
      getStats: async () => {
        statsReads += 1;
        return stats;
      },
    }),
    getFeed: () => feed,
    zoneSensors: () => false,
    images: { pushImage: async (device) => pushed.push(device.external_id) },
    logger: { info() {}, warn() {} },
    confirmTimeoutMs: 50,
    debounceMs: 20,
    flushMs: 5,
  });
  const message = (topic, payload) => sync.handleMessage(parseMessage(topic, payload, known));
  return { sync, gladys, feed, states, transports, pushed, message, statsReads: () => statsReads };
}

const feature = (camera, key) => ({ external_id: `ext:frigate:camera:${camera}:${key}` });

test('a switch publishes <camera>/<setting>/set and resolves on Frigate confirmation', async (t) => {
  const { sync, feed, message } = setup();
  t.after(() => sync.close());
  const command = sync.setValue({}, feature('front', 'detect'), 0);
  await wait(5);
  assert.deepEqual(feed.published, [['front/detect/set', 'OFF']]);
  message('front/detect/state', 'OFF');
  await command;
  const enable = sync.setValue({}, feature('front', 'enabled'), 1);
  await wait(5);
  assert.deepEqual(feed.published.at(-1), ['front/enabled/set', 'ON']);
  message('front/enabled/state', 'ON');
  await enable;
});

test('commands fail clearly: no confirmation, no feed, not a switch', async (t) => {
  const ws = setup({ feed: fakeFeed('websocket') });
  t.after(() => ws.sync.close());
  await assert.rejects(
    ws.sync.setValue({}, feature('front', 'snapshots'), 1),
    /admin Frigate account/,
  );
  const mqtt = setup();
  t.after(() => mqtt.sync.close());
  mqtt.message('front/snapshots/state', 'OFF'); // the opposite value does not confirm
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'snapshots'), 1), /did not confirm/);
  mqtt.feed.status = { state: 'disconnected', error: null };
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'detect'), 1), /not connected/);
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'motion'), 1), CommandError);
  const failing = setup();
  t.after(() => failing.sync.close());
  failing.feed.publish = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    failing.sync.setValue({}, feature('front', 'detect'), 1),
    /could not be sent: offline/,
  );
});

test('states of created devices are published; a new device gets the latest ones', async (t) => {
  const { sync, gladys, states, pushed, message } = setup();
  t.after(() => sync.close());
  message('front/motion', 'ON');
  message('garage/motion', 'ON');
  await wait(20);
  assert.deepEqual(states, [
    { device_feature_external_id: 'ext:frigate:camera:front:motion', state: 1 },
  ]);
  gladys.devices = buildDevices(gladysIds, readCapabilities('0.17.2', FRIGATE_CONFIG));
  await sync.deviceCreated(gladys.devices[1]);
  await wait(20);
  assert.deepEqual(states.at(-1), {
    device_feature_external_id: 'ext:frigate:camera:garage:motion',
    state: 1,
  });
  assert.deepEqual(pushed, ['ext:frigate:camera:garage'], 'first image at once');
});

test('feed and camera status drive the transport badges', async (t) => {
  const { sync, transports, message } = setup();
  t.after(() => sync.close());
  sync.frigateUp(true);
  sync.feedStatus({ state: 'connected' });
  await wait(5);
  assert.equal(transports.at(-1).transport, 'local');
  message('front/status/detect', 'offline');
  await wait(40);
  assert.equal(transports.at(-1).transport, 'unreachable');
  sync.frigateUp(true);
  message('front/status/detect', 'online');
  await wait(5);
  assert.equal(transports.at(-1).transport, 'local');
  message('available', 'offline');
  await wait(5);
  assert.equal(transports.at(-1).transport, 'unreachable');
});

test('Frigate 0.16: the camera fps of /api/stats tells a lost camera, read once for all', async (t) => {
  const stats = { cameras: { front: { camera_fps: 0 }, garage: { camera_fps: 5 } } };
  const { sync, gladys, transports, statsReads } = setup({ version: '0.16.4', stats });
  t.after(() => sync.close());
  sync.frigateUp(true);
  await sync.poll(gladys.devices[0]);
  await sync.poll(gladys.devices[0]);
  assert.equal(statsReads(), 1);
  await wait(40);
  assert.equal(transports.at(-1).transport, 'unreachable');
  // 0.17+: the status topics are used instead.
  const recent = setup({ stats });
  t.after(() => recent.sync.close());
  await recent.sync.poll(recent.gladys.devices[0]);
  assert.equal(recent.statsReads(), 0);
});

test('a camera turned off gets no image pushed on poll', async (t) => {
  const { sync, gladys, pushed, message } = setup();
  t.after(() => sync.close());
  await sync.poll(gladys.devices[0]);
  message('front/enabled/state', 'OFF');
  await sync.poll(gladys.devices[0]);
  message('front/enabled/state', 'ON');
  await sync.poll(gladys.devices[0]);
  assert.equal(pushed.length, 2);
});
