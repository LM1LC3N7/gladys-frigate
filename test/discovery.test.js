import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCapabilities } from '../src/frigate/capabilities.js';
import {
  CAMERA_PARAM,
  IMAGE_POLL_FREQUENCY_MS,
  buildDevices,
  cameraNameOfDevice,
  keyPart,
  parseFeatureId,
  publishDiscovery,
} from '../src/gladys/discovery.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';

// The id helpers of the SDK, with the selector Gladys gives the integration.
const gladys = {
  externalId: (suffix) => `ext:frigate:${suffix}`,
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return { device, feature: (key) => `${device}:${key}` };
  },
};

const capabilities = readCapabilities('0.17.2', FRIGATE_CONFIG);

const featuresOf = (device) =>
  device.features.map((feature) => [
    feature.external_id.slice(device.external_id.length + 1),
    feature.category,
    feature.type,
    feature.read_only,
  ]);

test('one camera device per Frigate camera, polled every minute for its image', () => {
  const devices = buildDevices(gladys, capabilities);
  assert.deepEqual(
    devices.map((device) => [device.name, device.external_id]),
    [
      ['Front door', 'ext:frigate:camera:front'],
      ['garage', 'ext:frigate:camera:garage'],
    ],
  );
  const [front] = devices;
  assert.deepEqual(front.params, [{ name: CAMERA_PARAM, value: 'front' }]);
  assert.equal(front.should_poll, true);
  assert.equal(front.poll_frequency, IMAGE_POLL_FREQUENCY_MS);
});

test('features follow the Frigate configuration of each camera', () => {
  const [front, garage] = buildDevices(gladys, capabilities);
  assert.deepEqual(featuresOf(front), [
    ['image', 'camera', 'image', true],
    ['enabled', 'camera', 'enabled', false],
    ['detect', 'switch', 'binary', false],
    ['recordings', 'switch', 'binary', false],
    ['snapshots', 'switch', 'binary', false],
    ['motion', 'motion-sensor', 'binary', true],
    ['review', 'text', 'text', true],
    ['objects', 'counter-sensor', 'integer', true],
    ['presence-person', 'presence-sensor', 'binary', true],
    ['count-person', 'counter-sensor', 'integer', true],
  ]);
  // No recordings in its file (Frigate refuses to turn them on), tracks cars.
  const garageKeys = featuresOf(garage).map(([key]) => key);
  assert.ok(!garageKeys.includes('recordings'));
  assert.ok(garageKeys.includes('presence-car') && garageKeys.includes('count-car'));
  assert.ok(!garageKeys.includes('presence-person'));
  // Switches confirm their state; sensors do not.
  const detect = front.features.find((f) => f.external_id.endsWith(':detect'));
  assert.equal(detect.has_feedback, true);
  assert.equal(
    front.features.find((f) => f.external_id.endsWith(':count-person')).keep_history,
    false,
  );
});

test('audio detection only when enabled in the Frigate file; zone sensors on demand', () => {
  const config = structuredClone(FRIGATE_CONFIG);
  config.cameras.front.audio = { enabled: false, enabled_in_config: true };
  config.cameras.front.objects.track = ['person', 'traffic light'];
  const withAudio = readCapabilities('0.17.2', config);
  const [front] = buildDevices(gladys, withAudio, { zoneSensors: true });
  const keys = featuresOf(front).map(([key]) => key);
  assert.ok(keys.includes('audio'));
  assert.ok(keys.includes('presence-traffic_light'));
  // The porch zone tracks persons only.
  assert.deepEqual(
    keys.filter((key) => key.startsWith('zone-')),
    ['zone-porch-person'],
  );
  assert.equal(
    front.features.find((f) => f.external_id.endsWith(':zone-porch-person')).name,
    'Porch person',
  );
});

test('feature ids split back into camera and key', () => {
  assert.deepEqual(parseFeatureId(gladys, 'ext:frigate:camera:front:detect'), {
    camera: 'front',
    key: 'detect',
  });
  assert.deepEqual(parseFeatureId(gladys, 'ext:frigate:camera:pi3-cam:zone-a-person'), {
    camera: 'pi3-cam',
    key: 'zone-a-person',
  });
  assert.equal(parseFeatureId(gladys, 'ext:frigate:camera:front'), null);
  assert.equal(parseFeatureId(gladys, 'ext:other:camera:front:detect'), null);
  assert.equal(keyPart('Traffic Light'), 'traffic_light');
});

test('Gladys poll frequencies: 60 s is an allowed value', () => {
  // DEVICE_POLL_FREQUENCIES of the Gladys core; anything else is a 400.
  assert.ok([1000, 2000, 10_000, 15_000, 30_000, 60_000].includes(IMAGE_POLL_FREQUENCY_MS));
});

test('the camera of a device comes from its params, else from its external id', () => {
  assert.equal(
    cameraNameOfDevice(gladys, {
      external_id: 'ext:frigate:camera:x',
      params: [{ name: CAMERA_PARAM, value: 'front' }],
    }),
    'front',
  );
  assert.equal(cameraNameOfDevice(gladys, { external_id: 'ext:frigate:camera:garage' }), 'garage');
  assert.equal(cameraNameOfDevice(gladys, { external_id: 'ext:other:camera:garage' }), null);
  assert.equal(cameraNameOfDevice(gladys, { external_id: 'ext:frigate:camera:' }), null);
  assert.equal(cameraNameOfDevice(gladys, undefined), null);
});

test('publishing replaces the list; no Frigate means an empty list (the scan ends)', async () => {
  const published = [];
  const sdk = { ...gladys, publishDiscoveredDevices: async (devices) => published.push(devices) };
  assert.equal(await publishDiscovery(sdk, capabilities), 2);
  assert.equal(await publishDiscovery(sdk, null), 0);
  assert.equal(published[0].length, 2);
  assert.deepEqual(published[1], []);
});
