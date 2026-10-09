// -----------------------------------------------------------------------------
// Typed Frigate messages (src/frigate/topics.js) -> states of the camera
// device features (src/gladys/discovery.js).
//
// MQTT gives each value on its own topic (retained for the toggles, so a
// (re)connection brings them back); the WebSocket gives `camera_activity`
// (motion, objects, toggles of every camera) when it opens. Both end up as
// `{ id, value }` pairs: a number, or `{ text }` for the review status.
// -----------------------------------------------------------------------------

import { baseLabel } from '../frigate/topics.js';
import {
  DEVICE_TYPE,
  FEATURES,
  TOGGLES,
  countKey,
  presenceKey,
  trackedLabels,
  zoneKey,
} from './discovery.js';

const SETTINGS = new Set(Object.values(TOGGLES));
// camera_activity `config` keys -> setting names of the MQTT topics.
const ACTIVITY_SETTINGS = {
  detect: 'detect',
  enabled: 'enabled',
  snapshots: 'snapshots',
  record: 'recordings',
  audio: 'audio',
};
const REVIEW_TEXT = { NONE: 'none', DETECTION: 'detection', ALERT: 'alert' };

/**
 * @param {object} options
 * @param {{ externalIds: Function }} options.gladys
 * @param {() => object | null} options.getCapabilities
 * @param {() => boolean} options.zoneSensors
 */
export function createStateMapper({ gladys, getCapabilities, zoneSensors }) {
  const id = (camera, key) => gladys.externalIds(DEVICE_TYPE, camera).feature(key);
  const binary = (value) => (value ? 1 : 0);

  function camerasOfZone(zone) {
    return (getCapabilities()?.cameras ?? []).filter((camera) =>
      camera.zones.some((z) => z.name === zone),
    );
  }

  function cameraOf(name) {
    return getCapabilities()?.cameras.find((camera) => camera.name === name) ?? null;
  }

  function counts(camera, label, count) {
    if (label === 'all') {
      return [{ id: id(camera, FEATURES.OBJECTS), value: count }];
    }
    return [
      { id: id(camera, countKey(label)), value: count },
      { id: id(camera, presenceKey(label)), value: binary(count > 0) },
    ];
  }

  function zoneCounts(zone, label, count) {
    if (!zoneSensors() || label === 'all') {
      return [];
    }
    return camerasOfZone(zone).map((camera) => ({
      id: id(camera.name, zoneKey(zone, label)),
      value: binary(count > 0),
    }));
  }

  function activity(cameras) {
    const states = [];
    for (const [name, data] of Object.entries(cameras ?? {})) {
      const camera = cameraOf(name);
      if (!camera || !data || typeof data !== 'object') {
        continue;
      }
      if (typeof data.motion === 'boolean') {
        states.push({ id: id(name, FEATURES.MOTION), value: binary(data.motion) });
      }
      for (const [key, setting] of Object.entries(ACTIVITY_SETTINGS)) {
        if (typeof data.config?.[key] === 'boolean') {
          states.push({ id: id(name, setting), value: binary(data.config[key]) });
        }
      }
      if (Array.isArray(data.objects)) {
        const objects = data.objects.filter((object) => typeof object?.label === 'string');
        states.push({ id: id(name, FEATURES.OBJECTS), value: objects.length });
        for (const label of trackedLabels(camera)) {
          const count = objects.filter((object) => baseLabel(object.label) === label).length;
          states.push(...counts(name, label, count));
        }
        if (zoneSensors()) {
          for (const zone of camera.zones) {
            const labels = zone.objects.length ? zone.objects : trackedLabels(camera);
            for (const label of labels) {
              const present = objects.some(
                (object) =>
                  baseLabel(object.label) === label &&
                  Array.isArray(object.current_zones) &&
                  object.current_zones.includes(zone.name),
              );
              states.push({ id: id(name, zoneKey(zone.name, label)), value: binary(present) });
            }
          }
        }
      }
    }
    return states;
  }

  return {
    /**
     * @param {object} message typed message of src/frigate/topics.js
     * @returns {Array<{ id: string, value: number | { text: string } }>}
     */
    map(message) {
      switch (message?.type) {
        case 'motion':
          return [{ id: id(message.camera, FEATURES.MOTION), value: binary(message.active) }];
        case 'setting':
          return SETTINGS.has(message.setting)
            ? [{ id: id(message.camera, message.setting), value: binary(message.on) }]
            : [];
        case 'reviewStatus':
          return [
            {
              id: id(message.camera, FEATURES.REVIEW),
              value: { text: REVIEW_TEXT[message.status] },
            },
          ];
        case 'count':
          return message.scope === 'camera'
            ? counts(message.name, message.label, message.count)
            : zoneCounts(message.name, message.label, message.count);
        case 'cameraActivity':
          return activity(message.cameras);
        default:
          return [];
      }
    },
  };
}
