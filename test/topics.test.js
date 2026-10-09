import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAYLOAD_LENGTH, baseLabel, parseMessage } from '../src/frigate/topics.js';

const known = { cameras: new Set(['front', 'garage']), zones: new Set(['porch']) };
const parse = (topic, payload) => parseMessage(topic, payload, known);

test('global topics: available, events, reviews, camera_activity', () => {
  assert.deepEqual(parse('available', 'online'), {
    type: 'available',
    online: true,
    state: 'online',
  });
  assert.deepEqual(parse('available', Buffer.from('offline')), {
    type: 'available',
    online: false,
    state: 'offline',
  });
  const event = { type: 'new', before: {}, after: { id: 'e1', camera: 'front' } };
  assert.deepEqual(parse('events', JSON.stringify(event)), { type: 'event', data: event });
  assert.deepEqual(parse('reviews', Buffer.from(JSON.stringify(event))).type, 'review');
  // The WebSocket may hand a parsed object.
  assert.deepEqual(parse('events', event), { type: 'event', data: event });
  assert.equal(parse('events', '{not json'), null);
  assert.equal(parse('events', '{"type":"new"}'), null, 'no after');
  assert.deepEqual(parse('camera_activity', '{"front":{"motion":true}}'), {
    type: 'cameraActivity',
    cameras: { front: { motion: true } },
  });
  assert.equal(parse('stats', '{}'), null);
});

test('camera topics: motion, review status, settings, status per role', () => {
  assert.deepEqual(parse('front/motion', 'ON'), { type: 'motion', camera: 'front', active: true });
  assert.deepEqual(parse('front/motion', 'OFF'), {
    type: 'motion',
    camera: 'front',
    active: false,
  });
  assert.deepEqual(parse('front/review_status', 'ALERT'), {
    type: 'reviewStatus',
    camera: 'front',
    status: 'ALERT',
  });
  assert.equal(parse('front/review_status', 'MAYBE'), null);
  assert.deepEqual(parse('front/detect/state', 'OFF'), {
    type: 'setting',
    camera: 'front',
    setting: 'detect',
    on: false,
  });
  // motion/state is the motion detection toggle, not the motion itself.
  assert.deepEqual(parse('front/motion/state', 'ON').type, 'setting');
  assert.equal(parse('front/motion_threshold/state', '30'), null, 'numbers are not toggles');
  assert.deepEqual(parse('front/status/detect', 'offline'), {
    type: 'cameraStatus',
    camera: 'front',
    role: 'detect',
    state: 'offline',
  });
  assert.equal(parse('front/status/record', 'disabled').state, 'disabled');
  assert.equal(parse('front/status/record', 'maybe'), null);
});

test('counts on cameras and zones; unknown names and garbage are ignored', () => {
  assert.deepEqual(parse('front/person', '2'), {
    type: 'count',
    scope: 'camera',
    name: 'front',
    label: 'person',
    count: 2,
  });
  // WebSocket payloads are JSON numbers.
  assert.deepEqual(parse('porch/all', 1), {
    type: 'count',
    scope: 'zone',
    name: 'porch',
    label: 'all',
    count: 1,
  });
  assert.deepEqual(parse('garage/car/active', '0'), {
    type: 'activeCount',
    scope: 'camera',
    name: 'garage',
    label: 'car',
    count: 0,
  });
  assert.equal(parse('front/person', '-1'), null);
  assert.equal(parse('front/person', 'many'), null);
  assert.equal(parse('backyard/person', '1'), null, 'unknown camera');
  assert.equal(parse('porch/detect/state', 'ON'), null, 'a zone has no settings');
  assert.equal(parse('front/person/snapshot', Buffer.alloc(10)), null);
  assert.equal(parse('front/a/b/c', '1'), null);
  assert.equal(parse(undefined, '1'), null);
});

test('oversized payloads are dropped before parsing', () => {
  const huge = JSON.stringify({
    type: 'new',
    after: { id: 'x', pad: 'x'.repeat(MAX_PAYLOAD_LENGTH) },
  });
  assert.equal(parse('events', huge), null);
});

test('baseLabel drops the -verified suffix', () => {
  assert.equal(baseLabel('person-verified'), 'person');
  assert.equal(baseLabel('car'), 'car');
  assert.equal(baseLabel(null), '');
});
