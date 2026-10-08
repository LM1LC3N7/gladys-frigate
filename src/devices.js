// -----------------------------------------------------------------------------
// Frigate cameras -> Gladys devices.
//
// Each Frigate camera becomes one Gladys device carrying:
//   - an image feature (snapshots: pushed periodically + fetched on demand);
//   - a motion sensor (Frigate's motion detection);
//   - one object counter per tracked label (person, car, dog…);
//   - three switches mirroring Frigate's runtime toggles: object detection,
//     recordings and snapshots.
// The device is identified by the Frigate camera name, which Frigate
// guarantees to be unique and stable.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'camera';
export const CAMERA_PARAM = 'FRIGATE_CAMERA';

export const FEATURES = {
  IMAGE: 'image',
  MOTION: 'motion',
  DETECT: 'detect',
  RECORDINGS: 'recordings',
  SNAPSHOTS: 'snapshots',
};

// Frigate runtime toggles: feature key -> setting name in the Frigate topics
// (`<camera>/<setting>/set` and `<camera>/<setting>/state`).
export const TOGGLES = {
  [FEATURES.DETECT]: 'detect',
  [FEATURES.RECORDINGS]: 'recordings',
  [FEATURES.SNAPSHOTS]: 'snapshots',
};

const COUNT_PREFIX = 'count-';
export const MAX_OBJECT_COUNT = 100;

/** Feature key of the counter of a tracked label ("traffic light" -> "count-traffic-light"). */
export function countFeatureKey(label) {
  return `${COUNT_PREFIX}${String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')}`;
}

function humanize(value) {
  const text = String(value).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function cameraIds(gladys, cameraName) {
  return gladys.externalIds(DEVICE_TYPE, cameraName);
}

/**
 * Split a feature external_id back into its Frigate camera and feature key.
 * @returns {{ camera: string, key: string } | null}
 */
export function parseFeatureExternalId(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const rest = externalId.slice(prefix.length);
  const index = rest.lastIndexOf(':');
  if (index <= 0 || index === rest.length - 1) {
    return null;
  }
  return { camera: rest.slice(0, index), key: rest.slice(index + 1) };
}

/** Frigate camera name of a Gladys device (from its params, else its external_id). */
export function cameraNameOfDevice(gladys, device) {
  const param = (device.params ?? []).find((p) => p.name === CAMERA_PARAM);
  if (param?.value) {
    return param.value;
  }
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  return device.external_id?.startsWith(prefix) ? device.external_id.slice(prefix.length) : null;
}

/** Labels Frigate tracks on a camera (defaults to "person", like Frigate). */
export function trackedLabels(cameraConfig) {
  const track = cameraConfig?.objects?.track;
  const labels = Array.isArray(track) && track.length > 0 ? track : ['person'];
  return [...new Set(labels.map(String))];
}

function binarySensor(name, externalId, category) {
  return {
    name,
    external_id: externalId,
    category,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

function toggle(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
}

/**
 * Discovery payload of one Frigate camera.
 * @param {object} gladys SDK instance
 * @param {string} cameraName Frigate camera name
 * @param {object} cameraConfig camera section of the Frigate configuration
 */
export function buildCameraDevice(gladys, cameraName, cameraConfig = {}) {
  const ids = cameraIds(gladys, cameraName);
  const name = cameraConfig.friendly_name || humanize(cameraName);
  return {
    name,
    external_id: ids.device,
    params: [{ name: CAMERA_PARAM, value: cameraName }],
    features: [
      {
        name: 'Image',
        external_id: ids.feature(FEATURES.IMAGE),
        category: DEVICE_FEATURE_CATEGORIES.CAMERA,
        type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      binarySensor('Motion', ids.feature(FEATURES.MOTION), DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR),
      ...trackedLabels(cameraConfig).map((label) => ({
        name: humanize(label),
        external_id: ids.feature(countFeatureKey(label)),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: MAX_OBJECT_COUNT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      })),
      toggle('Object detection', ids.feature(FEATURES.DETECT)),
      toggle('Recordings', ids.feature(FEATURES.RECORDINGS)),
      toggle('Snapshots', ids.feature(FEATURES.SNAPSHOTS)),
    ],
  };
}

/** Discovery payload of every camera of a Frigate configuration. */
export function buildDiscoveredDevices(gladys, frigateConfig) {
  const cameras = frigateConfig?.cameras ?? {};
  return Object.entries(cameras).map(([cameraName, cameraConfig]) =>
    buildCameraDevice(gladys, cameraName, cameraConfig),
  );
}
