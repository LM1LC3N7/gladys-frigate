// -----------------------------------------------------------------------------
// Frigate real-time messages -> typed messages.
//
// The MQTT broker and the Frigate WebSocket carry the same messages: a topic
// (without the MQTT prefix, which the MQTT client strips) and a payload. Over
// MQTT payloads are text; over the WebSocket they are JSON values (a count is
// a number, `events` a JSON string). Both are accepted.
//
// Topics checked in the Frigate sources (0.16.4, 0.17.2, 0.18.0):
//   available                      online | offline (LWT, retained)
//   events                         { type: new|update|end, before, after }
//   reviews                        { type: new|update|end, before, after }
//   camera_activity                initial state of every camera (WebSocket
//                                  answer to onConnect)
//   <camera>/motion                ON | OFF (motion detected)
//   <camera>/review_status         NONE | DETECTION | ALERT
//   <camera>/<setting>/state       ON | OFF, retained (detect, recordings,
//                                  snapshots, motion, enabled, audio…)
//   <camera>/status/<role>         online | offline | disabled (0.17+: detect,
//                                  record, audio)
//   <camera|zone>/<label>          number of objects ("all" = every label)
//   <camera|zone>/<label>/active   number of moving objects
// Cameras and zones share the count topics: the names known from the
// Frigate configuration tell them apart. Anything else returns null.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

/** Larger payloads are ignored (snapshots are never subscribed to). */
export const MAX_PAYLOAD_LENGTH = 256 * 1024;

const ON_OFF = { ON: true, OFF: false };
const REVIEW_STATUSES = new Set(['NONE', 'DETECTION', 'ALERT']);
const CAMERA_STATUSES = new Set(['online', 'offline', 'disabled']);

function asText(payload) {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  return null;
}

function asJson(payload) {
  if (payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
    return payload;
  }
  const text = asText(payload);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function asCount(payload) {
  const text = asText(payload);
  if (text === null || !/^\s*\d+\s*$/.test(text)) return null;
  return Number(text);
}

/**
 * @param {string} topic without the MQTT prefix, e.g. "front/motion"
 * @param {string | Buffer | number | object} payload
 * @param {{ cameras: Set<string>, zones: Set<string> }} known names from
 *   the Frigate configuration
 * @returns {object | null}
 */
export function parseMessage(topic, payload, { cameras, zones }) {
  if (typeof topic !== 'string') return null;
  const size = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload.length : 0;
  if (size > MAX_PAYLOAD_LENGTH) return null;

  const parts = topic.split('/');
  if (parts.length === 1) {
    switch (topic) {
      case 'available': {
        const state = asText(payload)?.trim();
        return state ? { type: 'available', online: state === 'online', state } : null;
      }
      case 'events':
      case 'reviews': {
        const data = asJson(payload);
        if (!data || typeof data.after !== 'object' || data.after === null) return null;
        return { type: topic === 'events' ? 'event' : 'review', data };
      }
      case 'camera_activity': {
        const data = asJson(payload);
        return data ? { type: 'cameraActivity', cameras: data } : null;
      }
      default:
        return null;
    }
  }

  const [scope, second, third] = parts;
  const isCamera = cameras.has(scope);
  const isZone = !isCamera && zones.has(scope);
  if (!isCamera && !isZone) return null;

  if (parts.length === 2) {
    if (isCamera && second === 'motion') {
      const active = ON_OFF[asText(payload)?.trim()];
      return active === undefined ? null : { type: 'motion', camera: scope, active };
    }
    if (isCamera && second === 'review_status') {
      const status = asText(payload)?.trim();
      return REVIEW_STATUSES.has(status) ? { type: 'reviewStatus', camera: scope, status } : null;
    }
    const count = asCount(payload);
    return count === null
      ? null
      : { type: 'count', scope: isCamera ? 'camera' : 'zone', name: scope, label: second, count };
  }

  if (parts.length === 3) {
    if (third === 'active') {
      const count = asCount(payload);
      return count === null
        ? null
        : {
            type: 'activeCount',
            scope: isCamera ? 'camera' : 'zone',
            name: scope,
            label: second,
            count,
          };
    }
    if (isCamera && third === 'state') {
      const on = ON_OFF[asText(payload)?.trim()];
      return on === undefined ? null : { type: 'setting', camera: scope, setting: second, on };
    }
    if (isCamera && second === 'status') {
      // online | offline | disabled (the role is turned off, e.g. detection)
      const state = asText(payload)?.trim();
      return CAMERA_STATUSES.has(state)
        ? { type: 'cameraStatus', camera: scope, role: third, state }
        : null;
    }
  }
  return null;
}

/** "person-verified" -> "person" (Frigate marks verified labels so). */
export function baseLabel(label) {
  return typeof label === 'string' ? label.replace(/-verified$/, '') : '';
}
