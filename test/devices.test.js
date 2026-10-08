import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import {
  CAMERA_PARAM,
  FEATURES,
  buildDiscoveredDevices,
  cameraNameOfDevice,
  countFeatureKey,
  parseFeatureExternalId,
  trackedLabels,
} from '../src/devices.js';
import { FRIGATE_CONFIG, createFakeGladys } from './helpers/fakes.js';

const gladys = createFakeGladys();

test('one device per Frigate camera, named after its friendly name', () => {
  const devices = buildDiscoveredDevices(gladys, FRIGATE_CONFIG);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Front door', 'Garden'],
  );
  assert.equal(devices[0].external_id, 'ext:frigate:camera:front_door');
  assert.deepEqual(devices[0].params, [{ name: CAMERA_PARAM, value: 'front_door' }]);
});

test('a camera carries image, motion, counters and the three toggles', () => {
  const [device] = buildDiscoveredDevices(gladys, FRIGATE_CONFIG);
  const byKey = Object.fromEntries(
    device.features.map((f) => [parseFeatureExternalId(gladys, f.external_id).key, f]),
  );
  assert.equal(byKey.image.category, DEVICE_FEATURE_CATEGORIES.CAMERA);
  assert.equal(byKey.image.type, DEVICE_FEATURE_TYPES.CAMERA.IMAGE);
  assert.equal(byKey.motion.category, DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR);
  assert.equal(byKey['count-person'].category, DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR);
  assert.equal(byKey['count-car'].type, DEVICE_FEATURE_TYPES.SENSOR.INTEGER);
  for (const key of [FEATURES.DETECT, FEATURES.RECORDINGS, FEATURES.SNAPSHOTS]) {
    assert.equal(byKey[key].category, DEVICE_FEATURE_CATEGORIES.SWITCH);
    assert.equal(byKey[key].read_only, false);
    assert.equal(byKey[key].has_feedback, true);
  }
});

test('feature external_ids are unique', () => {
  const ids = buildDiscoveredDevices(gladys, FRIGATE_CONFIG).flatMap((d) =>
    d.features.map((f) => f.external_id),
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('a configuration without cameras discovers nothing', () => {
  assert.deepEqual(buildDiscoveredDevices(gladys, {}), []);
});

test('trackedLabels defaults to person, like Frigate', () => {
  assert.deepEqual(trackedLabels({}), ['person']);
  assert.deepEqual(trackedLabels({ objects: { track: ['car', 'car'] } }), ['car']);
});

test('countFeatureKey sanitizes labels with spaces', () => {
  assert.equal(countFeatureKey('traffic light'), 'count-traffic-light');
});

test('parseFeatureExternalId round-trips and rejects foreign ids', () => {
  assert.deepEqual(parseFeatureExternalId(gladys, 'ext:frigate:camera:garden:detect'), {
    camera: 'garden',
    key: 'detect',
  });
  assert.equal(parseFeatureExternalId(gladys, 'ext:other:camera:garden:detect'), null);
  assert.equal(parseFeatureExternalId(gladys, 'ext:frigate:camera:garden'), null);
  assert.equal(parseFeatureExternalId(gladys, undefined), null);
});

test('cameraNameOfDevice prefers the device param, then the external_id', () => {
  assert.equal(
    cameraNameOfDevice(gladys, {
      external_id: 'x',
      params: [{ name: CAMERA_PARAM, value: 'cam' }],
    }),
    'cam',
  );
  assert.equal(cameraNameOfDevice(gladys, { external_id: 'ext:frigate:camera:garden' }), 'garden');
  assert.equal(cameraNameOfDevice(gladys, { external_id: 'something-else' }), null);
});
