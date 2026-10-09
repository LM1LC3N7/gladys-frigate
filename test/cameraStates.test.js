import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCapabilities } from '../src/frigate/capabilities.js';
import { parseMessage } from '../src/frigate/topics.js';
import { createStateMapper } from '../src/gladys/cameraStates.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';
import { gladysIds } from './helpers/gladysIds.js';

const capabilities = readCapabilities('0.17.2', FRIGATE_CONFIG);
const known = { cameras: new Set(['front', 'garage']), zones: new Set(['porch']) };

function mapper(zoneSensors = false) {
  const instance = createStateMapper({
    gladys: gladysIds,
    getCapabilities: () => capabilities,
    zoneSensors: () => zoneSensors,
  });
  return (topic, payload) =>
    Object.fromEntries(
      instance
        .map(parseMessage(topic, payload, known))
        .map(({ id, value }) => [id.replace('ext:frigate:camera:', ''), value]),
    );
}

test('MQTT topics become feature states', () => {
  const map = mapper();
  assert.deepEqual(map('front/motion', 'ON'), { 'front:motion': 1 });
  assert.deepEqual(map('front/detect/state', 'OFF'), { 'front:detect': 0 });
  assert.deepEqual(map('front/enabled/state', 'ON'), { 'front:enabled': 1 });
  assert.deepEqual(map('front/recordings/state', 'ON'), { 'front:recordings': 1 });
  assert.deepEqual(
    map('front/motion/state', 'ON'),
    {},
    'the motion detection toggle has no feature',
  );
  assert.deepEqual(map('front/review_status', 'ALERT'), { 'front:review': { text: 'alert' } });
  assert.deepEqual(map('front/person', '2'), {
    'front:count-person': 2,
    'front:presence-person': 1,
  });
  assert.deepEqual(map('front/person', '0'), {
    'front:count-person': 0,
    'front:presence-person': 0,
  });
  assert.deepEqual(map('front/all', '3'), { 'front:objects': 3 });
  assert.deepEqual(map('front/person/active', '1'), {});
});

test('zone counts only feed zone sensors when the option is on', () => {
  assert.deepEqual(mapper(false)('porch/person', '1'), {});
  assert.deepEqual(mapper(true)('porch/person', '1'), { 'front:zone-porch-person': 1 });
  assert.deepEqual(mapper(true)('porch/all', '1'), {});
});

test('camera_activity (WebSocket) gives the full state of every camera', () => {
  const activity = {
    front: {
      motion: true,
      objects: [
        { label: 'person-verified', current_zones: ['porch'], stationary: false },
        { label: 'person', current_zones: [], stationary: true },
        { label: 'dog', current_zones: [], stationary: false },
      ],
      config: { detect: true, enabled: true, snapshots: false, record: true },
    },
    garage: { motion: false, objects: [], config: { detect: false } },
    unknown: { motion: true },
  };
  assert.deepEqual(mapper(true)('camera_activity', JSON.stringify(activity)), {
    'front:motion': 1,
    'front:detect': 1,
    'front:enabled': 1,
    'front:snapshots': 0,
    'front:recordings': 1,
    'front:objects': 3,
    'front:count-person': 2,
    'front:presence-person': 1,
    'front:zone-porch-person': 1,
    'garage:motion': 0,
    'garage:detect': 0,
    'garage:objects': 0,
    'garage:count-car': 0,
    'garage:presence-car': 0,
  });
});
