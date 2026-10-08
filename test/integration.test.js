import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrigateIntegration, describeStartError } from '../src/integration.js';
import { FrigateAuthError } from '../src/frigate/client.js';
import { UnsupportedFrigateVersionError } from '../src/frigate/version.js';
import { buildDiscoveredDevices } from '../src/devices.js';
import {
  FRIGATE_CONFIG,
  FakeClient,
  FakeStream,
  createFakeGladys,
  createdDevice,
  flush,
  silentLogger,
} from './helpers/fakes.js';

const CONFIG = { frigate_url: 'http://frigate:5000', snapshot_interval: 0 };

/** Build an integration with fakes; `created` lists the cameras the user added. */
function setup({ created = ['front_door'], client = new FakeClient(), config = CONFIG } = {}) {
  const gladys = createFakeGladys({ config });
  gladys.devices = buildDiscoveredDevices(gladys, FRIGATE_CONFIG)
    .filter((d) => created.some((c) => d.external_id.endsWith(`:${c}`)))
    .map((d) => createdDevice(gladys, d));
  const streams = [];
  const integration = new FrigateIntegration({
    gladys,
    logger: silentLogger,
    createClient: () => client,
    createStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  });
  integration.register();
  return { gladys, integration, client, streams };
}

test('start publishes the cameras and opens the stream', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  assert.equal(gladys.discovered.length, 1);
  assert.equal(gladys.discovered[0].length, 2);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].started, true);

  streams[0].open();
  await flush();
  assert.deepEqual(gladys.statuses.at(-1), { connected: true, message: undefined });
  assert.deepEqual(gladys.transports, [
    { external_id: 'ext:frigate:camera:front_door', transport: 'local' },
  ]);
});

test('an invalid configuration reports a status and opens nothing', async () => {
  const { gladys, integration, streams } = setup();
  await integration.start({ frigate_url: '' });
  assert.equal(streams.length, 0);
  assert.equal(gladys.statuses.at(-1).connected, false);
  assert.match(gladys.statuses.at(-1).message.en, /URL/);
});

test('an unsupported Frigate version is refused without retry', async () => {
  const { gladys, integration, streams } = setup({ client: new FakeClient({ version: '0.17.2' }) });
  await integration.start(CONFIG);
  assert.equal(streams.length, 0);
  assert.match(gladys.statuses.at(-1).message.en, /0\.17\.2 is not supported/);
  assert.equal(integration.retryTimer, null);
});

test('an unreachable Frigate is retried', async (t) => {
  const client = new FakeClient();
  client.checkVersion = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  };
  const { gladys, integration } = setup({ client });
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  assert.match(gladys.statuses.at(-1).message.en, /Cannot reach Frigate/);
  assert.notEqual(integration.retryTimer, null);
});

test('Frigate states are published once, only for created devices', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  const stream = streams[0];
  stream.open();
  stream.receive('front_door/motion', 'ON');
  stream.receive('front_door/motion', 'ON');
  stream.receive('garden/motion', 'ON');
  await flush();
  assert.deepEqual(gladys.states, [
    { device_feature_external_id: 'ext:frigate:camera:front_door:motion', state: 1 },
  ]);
});

test('scene events carry the camera device id and skip cameras not created', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  const after = { id: 'e1', camera: 'front_door', label: 'car', top_score: 0.5, entered_zones: [] };
  streams[0].receive('events', JSON.stringify({ type: 'new', before: after, after }));
  streams[0].receive(
    'events',
    JSON.stringify({ type: 'new', before: after, after: { ...after, camera: 'garden' } }),
  );
  await flush();
  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, 'object_detected');
  assert.equal(gladys.sceneEvents[0].data.camera, 'ext:frigate:camera:front_door');
  assert.equal(gladys.sceneEvents[0].data.label, 'car');
});

test('a switch command is sent to Frigate as a set topic', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  const feature = { external_id: 'ext:frigate:camera:front_door:recordings' };
  await gladys.handlers.setValue({}, feature, 0);
  await gladys.handlers.setValue({}, feature, 1);
  assert.deepEqual(streams[0].sent, [
    { topic: 'front_door/recordings/set', payload: 'OFF' },
    { topic: 'front_door/recordings/set', payload: 'ON' },
  ]);
  await assert.rejects(
    gladys.handlers.setValue({}, { external_id: 'ext:frigate:camera:front_door:motion' }, 1),
    /cannot be controlled/,
  );
});

test('onGetImage returns a Gladys image of the camera', async (t) => {
  const { gladys, integration, client } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  const image = await gladys.handlers.getImage(gladys.devices[0]);
  assert.match(image, /^image\/jpg;base64,/);
  assert.equal(client.imageRequests[0].camera, 'front_door');
  assert.equal(client.imageRequests[0].height, 480);
});

test('periodic snapshots push one image per created camera, rate-limited', async (t) => {
  const { gladys, integration } = setup({ created: ['front_door', 'garden'] });
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  await integration.pushSnapshots();
  await integration.pushSnapshots();
  assert.deepEqual(
    gladys.images.map((i) => i.externalId),
    ['ext:frigate:camera:front_door', 'ext:frigate:camera:garden'],
  );
});

test('an alert refreshes the image of the camera', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  const after = { id: 'r1', camera: 'front_door', severity: 'alert', data: {} };
  streams[0].receive('reviews', JSON.stringify({ type: 'new', before: after, after }));
  await flush();
  await flush();
  assert.equal(gladys.images.length, 1);
  assert.equal(gladys.sceneEvents[0].key, 'review_started');
});

test('a newly created device asks Frigate for a fresh state', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  streams[0].open();
  await gladys.handlers.deviceCreated(gladys.devices[0]);
  assert.deepEqual(streams[0].sent.at(-1), { topic: 'onConnect', payload: '' });
});

test('a configuration update restarts on a new stream', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  await gladys.handlers.configUpdated({ ...CONFIG, snapshot_height: 720 });
  assert.equal(streams.length, 2);
  assert.equal(streams[0].stopped, true);
  assert.equal(integration.config.snapshot_height, 720);
});

test('losing the stream reports a degraded status and unreachable devices', async (t) => {
  const { gladys, integration, streams } = setup();
  t.after(() => integration.stop());
  await integration.start(CONFIG);
  streams[0].open();
  streams[0].connected = false;
  streams[0].emit('disconnected');
  await flush();
  assert.equal(gladys.statuses.at(-1).connected, false);
  assert.equal(gladys.transports.at(-1).transport, 'unreachable');
});

test('the test_connection action reports the version and the cameras', async () => {
  const { gladys } = setup();
  const message = await gladys.actions.test_connection({});
  assert.match(message.en, /Frigate 0\.18\.0-abc1234: 2 camera/);
  assert.ok(message.fr);
});

test('describeStartError explains the common failures', () => {
  const config = { frigate_url: 'https://f:8971' };
  assert.match(describeStartError(new FrigateAuthError('x'), config).en, /username/);
  assert.match(
    describeStartError(new UnsupportedFrigateVersionError('0.16.0'), config).en,
    /0\.18/,
  );
  assert.match(
    describeStartError(Object.assign(new Error('self-signed certificate'), {}), config).en,
    /self-signed/,
  );
});
