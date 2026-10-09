import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HttpStatusError } from '../src/frigate/errors.js';
import {
  SceneActionError,
  createSceneEvents,
  createSnapshotAction,
  toSceneEvent,
} from '../src/gladys/sceneEvents.js';
import { gladysIds } from './helpers/gladysIds.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const REVIEW = {
  kind: 'review_alert',
  camera: 'front',
  reviewId: 'r1',
  severity: 'alert',
  label: 'person',
  zone: 'porch',
  objects: ['person', 'car'],
  zones: ['porch', 'driveway'],
  subLabels: ['Alice'],
  detections: ['e1', 'e2'],
};
const DETECTED = {
  kind: 'object_detected',
  camera: 'front',
  label: 'person',
  subLabel: null,
  score: 87,
  eventId: 'e1',
  zones: [],
  hasSnapshot: true,
};
const ENTERED = { ...DETECTED, kind: 'object_entered_zone', zone: 'porch', zones: ['porch'] };

test('each transition becomes the event the manifest declares, with flat data', () => {
  for (const transition of [REVIEW, DETECTED, ENTERED]) {
    const { key, data } = toSceneEvent(gladysIds, transition);
    const trigger = manifest.scene_triggers.find((t) => t.key === key);
    assert.ok(trigger, `${key} is declared`);
    const declared = new Set([...trigger.variables, ...trigger.fields].map((v) => v.key));
    assert.deepEqual(
      Object.keys(data).filter((k) => !declared.has(k)),
      [],
      `${key}: every key is declared`,
    );
    for (const variable of trigger.variables) {
      assert.ok(variable.key in data, `${key}: ${variable.key} is sent`);
    }
    assert.ok(Object.keys(data).length <= 30);
    for (const value of Object.values(data)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
    }
  }
  assert.deepEqual(toSceneEvent(gladysIds, REVIEW).data, {
    camera: 'ext:frigate:camera:front',
    camera_name: 'front',
    severity: 'alert',
    label: 'person',
    objects: 'person, car',
    zone: 'porch',
    zones: 'porch, driveway',
    sub_label: 'Alice',
    review_id: 'r1',
    event_id: 'e1',
  });
  assert.deepEqual(toSceneEvent(gladysIds, DETECTED).data, {
    camera: 'ext:frigate:camera:front',
    camera_name: 'front',
    label: 'person',
    sub_label: null,
    zone: null,
    zones: null,
    score: 87,
    event_id: 'e1',
  });
  assert.equal(toSceneEvent(gladysIds, ENTERED).data.zone, 'porch');
  const long = toSceneEvent(gladysIds, { ...REVIEW, objects: Array(400).fill('person') });
  assert.equal(long.data.objects.length, 1000);
  assert.equal(toSceneEvent(gladysIds, { kind: 'other', camera: 'x' }), null);
});

function events({ maxPerMinute, fail = false } = {}) {
  const order = [];
  const warnings = [];
  let time = 0;
  const instance = createSceneEvents({
    gladys: {
      ...gladysIds,
      publishSceneEvent: async (key, data) => {
        if (fail) throw new Error('404');
        order.push(`event ${key} ${data.severity ?? ''}`.trim());
      },
    },
    logger: { info() {}, warn: (m) => warnings.push(m) },
    beforeAlert: async (camera) => order.push(`image ${camera}`),
    maxPerMinute,
    now: () => time,
  });
  return { instance, order, warnings, advance: (ms) => (time += ms) };
}

test('an alert pushes the camera image before its event; a detection does not', async () => {
  const { instance, order } = events();
  await instance.handle(REVIEW);
  await instance.handle({ ...REVIEW, severity: 'detection' });
  await instance.handle(DETECTED);
  assert.deepEqual(order, [
    'image front',
    'event review_alert alert',
    'event review_alert detection',
    'event object_detected',
  ]);
});

test('over the per-minute budget events are dropped and counted; failures are logged', async () => {
  const { instance, order, warnings, advance } = events({ maxPerMinute: 2 });
  for (let i = 0; i < 5; i += 1) await instance.handle(DETECTED);
  assert.equal(order.length, 2);
  advance(60_000);
  await instance.handle(DETECTED);
  assert.equal(order.length, 3);
  assert.match(warnings[0], /3 scene events dropped/);
  const failing = events({ fail: true });
  await failing.instance.handle(DETECTED);
  assert.match(failing.warnings[0], /Could not send the scene event object_detected: 404/);
});

function action({ client, published = [], room = true } = {}) {
  const calls = [];
  const handler = createSnapshotAction({
    gladys: gladysIds,
    images: {
      eventSnapshot: async (eventId, options) => {
        calls.push([eventId, options]);
        return 'image/jpg;base64,AAAA';
      },
      publishImage: async (device, image) => {
        published.push([device, image]);
        return room;
      },
    },
    getClient: () => client,
  });
  return { handler, calls, published };
}

test('attach_event_snapshot publishes the snapshot on the event camera, or the chosen one', async () => {
  const client = { getEvent: async (id) => ({ id, camera: 'garage' }) };
  const { handler, calls, published } = action({ client });
  await handler({ event_id: '1700000000.123-abc', bounding_box: true });
  await handler({
    event_id: '1700000000.123-abc',
    camera: 'ext:frigate:camera:front',
    bounding_box: false,
  });
  assert.deepEqual(published, [
    ['ext:frigate:camera:garage', 'image/jpg;base64,AAAA'],
    ['ext:frigate:camera:front', 'image/jpg;base64,AAAA'],
  ]);
  assert.deepEqual(
    calls.map(([, options]) => options.bbox),
    [true, false],
  );
});

test('attach_event_snapshot fails with a reason', async () => {
  const unknown = {
    getEvent: async () => {
      throw new HttpStatusError(404, '/api/events/x');
    },
  };
  await assert.rejects(action({ client: unknown }).handler({ event_id: 'x' }), /no event x/);
  await assert.rejects(
    action({ client: unknown }).handler({ event_id: '../config' }),
    SceneActionError,
  );
  await assert.rejects(action({ client: unknown }).handler({}), /not a Frigate event id/);
  await assert.rejects(action({ client: null }).handler({ event_id: 'x' }), /not connected/);
  const busy = action({ client: unknown, room: false });
  await assert.rejects(
    busy.handler({ event_id: 'x', camera: 'ext:frigate:camera:front' }),
    /Too many images/,
  );
});
