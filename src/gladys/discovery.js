// -----------------------------------------------------------------------------
// Frigate cameras -> Gladys devices (the Discover tab).
//
// One device per Frigate camera, identified by the Frigate camera name (unique
// and stable in Frigate). The device carries the camera image; Gladys polls
// it every minute, and each poll pushes a fresh image (the dashboard camera
// widget shows the last pushed image). The sensors and switches fed by the
// real-time feed are added by a later version: Gladys then offers to update
// the devices already created ("Update" in the Discover tab).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'camera';
export const CAMERA_PARAM = 'FRIGATE_CAMERA';
export const FEATURES = Object.freeze({ IMAGE: 'image' });
// One of Gladys' DEVICE_POLL_FREQUENCIES (EVERY_MINUTES).
export const IMAGE_POLL_FREQUENCY_MS = 60_000;

/**
 * @param {{ externalIds: Function }} gladys SDK instance (id helpers only)
 * @param {{ name: string, friendlyName: string }} camera from capabilities
 */
export function buildCameraDevice(gladys, camera) {
  const ids = gladys.externalIds(DEVICE_TYPE, camera.name);
  return {
    name: camera.friendlyName || camera.name,
    external_id: ids.device,
    params: [{ name: CAMERA_PARAM, value: camera.name }],
    should_poll: true,
    poll_frequency: IMAGE_POLL_FREQUENCY_MS,
    features: [
      {
        name: 'Image',
        external_id: ids.feature(FEATURES.IMAGE),
        category: DEVICE_FEATURE_CATEGORIES.CAMERA,
        type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/** The complete discovery list of a Frigate instance. */
export function buildDevices(gladys, capabilities) {
  return (capabilities?.cameras ?? []).map((camera) => buildCameraDevice(gladys, camera));
}

/**
 * Frigate camera name of a Gladys device of this integration (from its
 * params, else from its external id), null for anything else.
 */
export function cameraNameOfDevice(gladys, device) {
  const param = (device?.params ?? []).find((p) => p.name === CAMERA_PARAM);
  if (typeof param?.value === 'string' && param.value) {
    return param.value;
  }
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  const externalId = device?.external_id;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  return externalId.slice(prefix.length) || null;
}

/**
 * Publishes the discovery list (it replaces the previous one; Gladys keeps it
 * in memory only, so it is published again on every connection).
 * @param {{ externalIds: Function, publishDiscoveredDevices: Function }} gladys
 * @param {object | null} capabilities null = Frigate not reachable: empty list
 * @returns {Promise<number>} number of cameras listed
 */
export async function publishDiscovery(gladys, capabilities) {
  const devices = buildDevices(gladys, capabilities);
  await gladys.publishDiscoveredDevices(devices);
  return devices.length;
}
