// End to end (issue #12): the real index.js while the Frigate API fails.
// The snapshot scene action and "get image" find Frigate not connected:
// they bring the pending retry forward (session.kick), at most once per
// 5 s, never one read per call. Real clock: about 11 s.

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('index.js: a scene action or an image brings the API retry forward, without a storm', async (t) => {
  const phase = { down: false };
  const frigate = await startFakeFrigate({
    account: { user: 'gladys', password: 'S3cret-Frigate' },
    // Down: Frigate answers 404 everywhere, as while it starts.
    override: (req, res) => {
      if (!phase.down) return false;
      res.statusCode = 404;
      res.end();
      return true;
    },
  });
  t.after(() => frigate.close());
  const broker = await startTestBroker({});
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
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-e2e-retry-'));
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
  const lastStatus = () => gladys.posts('/connection_status').at(-1)?.body;
  const versionReads = () => frigate.calls.filter((call) => call.url === '/api/version').length;
  const snapshot = () =>
    gladys.command('scene-action.run', {
      key: 'attach_event_snapshot',
      fields: { event_id: 'known-event', bounding_box: true },
    });

  await step('the connected status', () =>
    /MQTT broker connected/.test(lastStatus()?.message?.en ?? ''),
  );
  const discovered = () => gladys.posts('/discovered_device').at(-1)?.body.devices ?? [];
  await step('the discovery list', () => discovered().length === 2);
  const front = discovered().find((device) => device.external_id.endsWith(':front'));
  const created = {
    ...front,
    features: front.features.map((feature, i) => ({ ...feature, id: `f${i}` })),
  };
  gladys.devices = [created];
  const getImage = () => gladys.command('camera.get-image', { device: created });

  // Frigate fails: "Test the connection" reads it, the retry waits 5 s.
  phase.down = true;
  await gladys.command('action.run', { key: 'test_connection', fields: {} });
  await step('the first retry announced', () =>
    /New attempt in 5 s/.test(lastStatus()?.message?.en ?? ''),
  );
  let reads = versionReads();
  // Right after a read: the calls fail and read nothing.
  const early = await Promise.all([snapshot(), snapshot(), snapshot(), getImage(), getImage()]);
  assert.ok(early.every((result) => result.success === false));
  assert.match(early[0].error ?? '', /not connected/);
  await sleep(200);
  assert.equal(versionReads(), reads, 'no read within 5 s of the last one');

  await step('the second retry announced', () =>
    /New attempt in 10 s/.test(lastStatus()?.message?.en ?? ''),
  );
  // 5 s after that read, Frigate is back: the calls bring the retry
  // forward (instead of 10 s), once for all of them.
  await sleep(5_200);
  phase.down = false;
  reads = versionReads();
  const late = await Promise.all([
    snapshot(),
    snapshot(),
    snapshot(),
    snapshot(),
    getImage(),
    getImage(),
  ]);
  assert.ok(
    late.every((result) => result.success === false),
    'these calls still fail',
  );
  // Brought forward: well before the scheduled retry (about 4.8 s later).
  await waitFor(() => lastStatus()?.connected === true, {
    timeoutMs: 2_000,
    what: 'connected again by the calls',
  }).catch((err) => {
    throw new Error(`${err.message}\n--- integration output ---\n${output}`, { cause: err });
  });
  assert.equal(versionReads(), reads + 1, 'one read for six calls');
  const ok = await snapshot();
  assert.equal(ok.success, true, ok.error);
  await sleep(4_000);
  assert.equal(versionReads(), reads + 1, 'the scheduled retry was dropped');

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
