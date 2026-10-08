// -----------------------------------------------------------------------------
// What this Frigate instance offers, read from /api/version and /api/config.
//
// The integration never assumes a version's features: everything the Gladys
// side exposes (devices, features, topics to follow) comes from the
// normalized model built here. Parsing is defensive — a field Frigate does
// not send reads as "off", never as a crash.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { UnsupportedVersionError } from './errors.js';

/** Oldest Frigate release this integration supports. */
export const MIN_VERSION = Object.freeze({ major: 0, minor: 16, patch: 0 });

/**
 * "0.16.4-4131252" -> { major: 0, minor: 16, patch: 4, raw }. Returns null
 * when the string does not start with a dotted version.
 */
export function parseVersion(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^"|"$/g, '');
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: text,
  };
}

/** a >= b, on major/minor/patch. */
export function versionAtLeast(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

const enabled = (section) => section?.enabled === true;
const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

function normalizeCamera(name, camera = {}) {
  const zones = Object.entries(camera.zones ?? {}).map(([zoneName, zone]) => ({
    name: zoneName,
    friendlyName: typeof zone?.friendly_name === 'string' ? zone.friendly_name : zoneName,
    objects: list(zone?.objects),
  }));
  return {
    name,
    friendlyName: typeof camera.friendly_name === 'string' ? camera.friendly_name : name,
    // `enabled` follows the runtime toggle; `enabled_in_config` (0.16+) the file.
    enabled: camera.enabled !== false,
    enabledInConfig: camera.enabled_in_config ?? camera.enabled !== false,
    detect: enabled(camera.detect),
    record: enabled(camera.record),
    snapshots: enabled(camera.snapshots),
    // A camera whose audio detection is off in the file cannot be toggled on.
    audio: camera.audio?.enabled_in_config ?? enabled(camera.audio),
    objects: list(camera.objects?.track),
    zones,
    review: {
      alerts: camera.review?.alerts?.enabled !== false,
      detections: camera.review?.detections?.enabled !== false,
    },
    ptz: Boolean(camera.onvif?.host),
  };
}

/**
 * @param {string} versionText /api/version
 * @param {object} config /api/config
 * @throws {UnsupportedVersionError} below MIN_VERSION, or an unreadable version
 */
export function readCapabilities(versionText, config) {
  const version = parseVersion(versionText);
  if (!version || !versionAtLeast(version, MIN_VERSION)) {
    throw new UnsupportedVersionError(String(versionText ?? '').trim() || 'unknown');
  }
  const cameras = Object.entries(config?.cameras ?? {})
    .map(([name, camera]) => normalizeCamera(name, camera))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    version,
    cameras,
    mqtt: {
      enabled: config?.mqtt?.enabled !== false && Boolean(config?.mqtt?.host),
      host: typeof config?.mqtt?.host === 'string' ? config.mqtt.host : '',
      topicPrefix:
        typeof config?.mqtt?.topic_prefix === 'string' ? config.mqtt.topic_prefix : 'frigate',
    },
    features: {
      faceRecognition: enabled(config?.face_recognition),
      licensePlates: enabled(config?.lpr),
      semanticSearch: enabled(config?.semantic_search),
      genai: enabled(config?.genai),
    },
    // MQTT topics that depend on the version (checked in Frigate's sources).
    topics: {
      cameraEnabled: true, // <cam>/enabled/set|state, 0.16+
      reviewStatus: true, // <cam>/review_status, 0.16+
      cameraStatus: versionAtLeast(version, { major: 0, minor: 17, patch: 0 }), // <cam>/status/<role>
    },
  };
}
