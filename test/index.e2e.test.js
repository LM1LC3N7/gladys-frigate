// End to end: the real index.js, in a child process, against a fake Gladys,
// a fake Frigate (HTTP API) and a real MQTT broker stub. Catches the wiring
// mistakes the unit tests cannot see (a handler not registered, a hook not
// connected): 0.1.1 shipped buttons answering "not implemented", 0.1.2 a
// scan nobody answered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeFrigate } from './helpers/fakeFrigate.js';
import { startFakeGladys } from './helpers/fakeGladys.js';
import { startTestBroker } from './helpers/testBroker.js';
import { waitFor } from './helpers/waitFor.js';

const WAIT = { timeoutMs: 8000 };

test('index.js: connection, discovery, images, states, commands, scenes, actions', async (t) => {
  const frigate = await startFakeFrigate({
    account: { user: 'gladys', password: 'S3cret-Frigate' },
  });
  t.after(() => frigate.close());
  // The broker plays Frigate for the commands: a `set` is confirmed by `state`.
  const broker = await startTestBroker({
    onPublish: (topic, payload) => {
      if (topic.endsWith('/set')) broker.publish(topic.replace(/\/set$/, '/state'), payload);
    },
  });
  t.after(() => broker.close());
  const gladys = await startFakeGladys({
    config: {
      frigate_url: frigate.url,
      username: 'gladys',
      password: 'S3cret-Frigate',
      mqtt_host: '127.0.0.1',
      mqtt_port: broker.port,
    },
  });
  t.after(() => gladys.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-e2e-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));

  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: gladys.url,
      GLADYS_INTEGRATION_TOKEN: 'test-token',
      GLADYS_INTEGRATION_SELECTOR: 'frigate',
      FRIGATE_DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => child.kill('SIGKILL'));
  const step = async (what, condition) => {
    try {
      await waitFor(condition, { ...WAIT, what });
    } catch (err) {
      throw new Error(`${err.message}\n--- integration output ---\n${output}`, { cause: err });
    }
  };

  // 1. Connected to Frigate and to the broker; the status says so.
  const lastStatus = () => gladys.posts('/connection_status').at(-1)?.body;
  await step('the connected status', () =>
    /MQTT broker connected/.test(lastStatus()?.message?.en ?? ''),
  );
  assert.equal(lastStatus().connected, true);
  assert.match(lastStatus().message.en, /Connected to Frigate 0\.17\.2-abcdef, 2 cameras/);

  // 2. Discovery: published on connection, and answered on Scan.
  const discovered = () => gladys.posts('/discovered_device').at(-1)?.body.devices ?? [];
  await step('the discovery list', () => discovered().length === 2);
  const count = gladys.posts('/discovered_device').length;
  gladys.send('scan-request');
  await step('the scan answer', () => gladys.posts('/discovered_device').length > count);

  // 3. The user creates the front camera: first image, badge, states.
  const front = discovered().find((device) => device.external_id.endsWith(':front'));
  const created = {
    ...front,
    features: front.features.map((feature, i) => ({ ...feature, id: `f${i}` })),
  };
  gladys.devices = [created];
  gladys.send('device-created', { device: created });
  await step('the first image', () => gladys.posts('/camera/image').length >= 1);
  assert.match(gladys.posts('/camera/image')[0].body.image, /^image\/jpg;base64,/);
  await step('the transport badge', () =>
    gladys
      .posts('/device/transport')
      .some((r) => r.body.transports.some((t) => t.device_external_id === front.external_id)),
  );

  const states = () => gladys.posts('/state').flatMap((r) => r.body.states);
  broker.publish('frigate/front/motion', 'ON');
  await step('the motion state', () =>
    states().some(
      (s) => s.device_feature_external_id === `${front.external_id}:motion` && s.state === 1,
    ),
  );

  // 4. A switch: published on MQTT, confirmed by Frigate, acked to Gladys.
  const detect = created.features.find((f) => f.external_id.endsWith(':detect'));
  const result = await gladys.command('device.set-value', {
    device: created,
    device_feature: detect,
    value: 0,
  });
  assert.deepEqual(result, { message_id: result.message_id, success: true });
  assert.ok(
    broker.published.some((p) => p.topic === 'frigate/front/detect/set' && p.payload === 'OFF'),
  );

  // 5. A review alert: fresh image first, then the scene event.
  const images = gladys.posts('/camera/image').length;
  broker.publish(
    'frigate/reviews',
    JSON.stringify({
      type: 'new',
      before: {},
      after: {
        id: 'r1',
        camera: 'front',
        severity: 'alert',
        data: { objects: ['person'], zones: ['porch'], sub_labels: [], detections: ['e1'] },
      },
    }),
  );
  await step('the scene event', () => gladys.posts('/scene/event').length === 1);
  const sceneEvent = gladys.posts('/scene/event')[0].body;
  assert.equal(sceneEvent.key, 'review_alert');
  assert.equal(sceneEvent.data.camera, front.external_id);
  assert.equal(sceneEvent.data.zone, 'porch');
  assert.ok(gladys.posts('/camera/image').length > images, 'image pushed for the alert');

  // 6. Commands answered with data: camera image, buttons, scene action.
  const image = await gladys.command('camera.get-image', { device: created });
  assert.equal(image.success, true);
  assert.match(image.data.image, /^image\/jpg;base64,/);
  const testConnection = await gladys.command('action.run', {
    key: 'test_connection',
    fields: {},
  });
  assert.equal(testConnection.success, true);
  assert.match(testConnection.data.message.en, /MQTT broker 127\.0\.0\.1:\d+: connected/);
  const snapshot = await gladys.command('scene-action.run', {
    key: 'attach_event_snapshot',
    fields: { event_id: 'known-event', bounding_box: true },
  });
  assert.equal(snapshot.success, true, snapshot.error);
  assert.equal(gladys.posts('/camera/image').at(-1).body.device_external_id, front.external_id);

  // 7. A clean shutdown.
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(!output.includes('S3cret-Frigate'), 'no password in the logs');
});
