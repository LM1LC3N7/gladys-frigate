import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCapabilities } from '../src/frigate/capabilities.js';
import {
  CAMERA_PARAM,
  IMAGE_POLL_FREQUENCY_MS,
  buildDevices,
  cameraNameOfDevice,
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

test('one camera device per Frigate camera, with its image, polled every minute', () => {
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
  assert.deepEqual(
    front.features.map((feature) => [feature.external_id, feature.category, feature.type]),
    [['ext:frigate:camera:front:image', 'camera', 'image']],
  );
  assert.equal(front.features[0].read_only, true);
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
