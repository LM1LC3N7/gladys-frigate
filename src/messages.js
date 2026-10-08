// -----------------------------------------------------------------------------
// Frigate WebSocket messages -> Gladys effects.
//
// Pure translation layer: given one `{ topic, payload }` message from Frigate
// and the set of known cameras, return what Gladys should do — feature states
// to publish, scene triggers to fire, camera images to refresh. No I/O here,
// so the whole mapping is unit-tested (test/messages.test.js).
//
// Topics handled (Frigate 0.18):
//   <camera>/motion                    ON | OFF          -> motion sensor
//   <camera>/<label>                   <count>           -> object counter
//   <camera>/{detect,recordings,snapshots}/state ON|OFF  -> switches
//   camera_activity                    JSON (onConnect)  -> initial states
//   events                             JSON              -> object_detected,
//                                                         zone_entered
//   reviews                            JSON              -> review_started
// -----------------------------------------------------------------------------

import { FEATURES, TOGGLES, countFeatureKey, trackedLabels } from './devices.js';

export const SCENE_TRIGGERS = {
  OBJECT_DETECTED: 'object_detected',
  ZONE_ENTERED: 'zone_entered',
  REVIEW_STARTED: 'review_started',
};

// Frigate setting name -> feature key, for `<camera>/<setting>/state`.
const STATE_TOPICS = Object.fromEntries(
  Object.entries(TOGGLES).map(([key, setting]) => [setting, key]),
);

function emptyEffects() {
  return { states: [], sceneEvents: [], snapshots: [] };
}

function onOff(payload) {
  if (payload === 'ON' || payload === true) return 1;
  if (payload === 'OFF' || payload === false) return 0;
  return null;
}

function parseJson(payload) {
  if (typeof payload !== 'string') {
    return payload && typeof payload === 'object' ? payload : null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Frigate labels may carry a "-verified" suffix (verified objects). */
function baseLabel(label) {
  return String(label).replace(/-verified$/, '');
}

/** Frigate sub_label is null, a string, or a [name, score] pair. */
function subLabelText(subLabel) {
  if (Array.isArray(subLabel)) return subLabel[0] == null ? '' : String(subLabel[0]);
  return subLabel == null ? '' : String(subLabel);
}

function scorePercent(object) {
  const score = Number(object.top_score ?? object.score);
  return Number.isFinite(score) ? Math.round(score * 100) : null;
}

function list(values) {
  return Array.isArray(values) ? values.map(String) : [];
}

/**
 * Index of the cameras known from the Frigate configuration.
 * @param {object} frigateConfig
 * @returns {Map<string, { labels: Set<string> }>}
 */
export function indexCameras(frigateConfig) {
  const index = new Map();
  for (const [name, cameraConfig] of Object.entries(frigateConfig?.cameras ?? {})) {
    index.set(name, { labels: new Set(trackedLabels(cameraConfig)) });
  }
  return index;
}

function objectEventData(camera, object) {
  return {
    camera_name: camera,
    label: baseLabel(object.label ?? ''),
    sub_label: subLabelText(object.sub_label),
    score: scorePercent(object),
    zones: list(object.current_zones).join(','),
    event_id: String(object.id ?? ''),
  };
}

function mapEvent(message, cameras, effects) {
  const after = message?.after;
  if (!after || !cameras.has(after.camera) || after.false_positive === true) {
    return;
  }
  const camera = after.camera;
  if (message.type === 'new') {
    effects.sceneEvents.push({
      key: SCENE_TRIGGERS.OBJECT_DETECTED,
      camera,
      data: objectEventData(camera, after),
    });
  }
  if (message.type === 'new' || message.type === 'update') {
    // One zone_entered per zone the object enters (a transition, never a
    // repeat while it stays there).
    const before = new Set(message.type === 'new' ? [] : list(message.before?.entered_zones));
    for (const zone of list(after.entered_zones)) {
      if (!before.has(zone)) {
        effects.sceneEvents.push({
          key: SCENE_TRIGGERS.ZONE_ENTERED,
          camera,
          data: { ...objectEventData(camera, after), zone },
        });
      }
    }
  }
}

function mapReview(message, cameras, effects) {
  const after = message?.after;
  if (!after || !cameras.has(after.camera)) {
    return;
  }
  // Fire when a review item starts, and when a detection escalates to an alert.
  const escalated =
    message.type === 'update' && after.severity === 'alert' && message.before?.severity !== 'alert';
  if (message.type !== 'new' && !escalated) {
    return;
  }
  const data = after.data ?? {};
  effects.sceneEvents.push({
    key: SCENE_TRIGGERS.REVIEW_STARTED,
    camera: after.camera,
    data: {
      camera_name: after.camera,
      severity: String(after.severity ?? ''),
      objects: [...new Set(list(data.objects).map(baseLabel))].join(','),
      zones: list(data.zones).join(','),
      review_id: String(after.id ?? ''),
    },
  });
  if (after.severity === 'alert') {
    // Refresh the camera image so Gladys shows the moment of the alert.
    effects.snapshots.push(after.camera);
  }
}

function mapCameraActivity(activity, cameras, effects) {
  for (const [camera, state] of Object.entries(activity ?? {})) {
    const known = cameras.get(camera);
    if (!known || !state || typeof state !== 'object') {
      continue;
    }
    const config = state.config ?? {};
    const toggles = {
      [FEATURES.DETECT]: config.detect,
      [FEATURES.RECORDINGS]: config.record,
      [FEATURES.SNAPSHOTS]: config.snapshots,
    };
    for (const [key, enabled] of Object.entries(toggles)) {
      if (typeof enabled === 'boolean') {
        effects.states.push({ camera, key, value: enabled ? 1 : 0 });
      }
    }
    if (typeof state.motion === 'boolean') {
      effects.states.push({ camera, key: FEATURES.MOTION, value: state.motion ? 1 : 0 });
    }
    if (Array.isArray(state.objects)) {
      const counts = new Map([...known.labels].map((label) => [label, 0]));
      for (const object of state.objects) {
        const label = baseLabel(object?.label ?? '');
        if (counts.has(label)) counts.set(label, counts.get(label) + 1);
      }
      for (const [label, count] of counts) {
        effects.states.push({ camera, key: countFeatureKey(label), value: count });
      }
    }
  }
}

/**
 * Translate one Frigate WebSocket message.
 * @param {{ topic: string, payload: unknown }} message
 * @param {Map<string, { labels: Set<string> }>} cameras from indexCameras()
 * @returns {{
 *   states: Array<{ camera: string, key: string, value: number }>,
 *   sceneEvents: Array<{ key: string, camera: string, data: Record<string, unknown> }>,
 *   snapshots: string[],
 * }}
 */
export function mapFrigateMessage({ topic, payload }, cameras) {
  const effects = emptyEffects();

  if (topic === 'events') {
    mapEvent(parseJson(payload), cameras, effects);
    return effects;
  }
  if (topic === 'reviews') {
    mapReview(parseJson(payload), cameras, effects);
    return effects;
  }
  if (topic === 'camera_activity') {
    mapCameraActivity(parseJson(payload), cameras, effects);
    return effects;
  }

  const parts = topic.split('/');
  const known = cameras.get(parts[0]);
  if (!known) {
    return effects;
  }
  const camera = parts[0];

  if (parts.length === 2 && parts[1] === 'motion') {
    const value = onOff(payload);
    if (value !== null) effects.states.push({ camera, key: FEATURES.MOTION, value });
  } else if (parts.length === 2 && known.labels.has(parts[1])) {
    const count = Number(payload);
    if (Number.isInteger(count) && count >= 0) {
      effects.states.push({ camera, key: countFeatureKey(parts[1]), value: count });
    }
  } else if (parts.length === 3 && parts[2] === 'state' && STATE_TOPICS[parts[1]]) {
    const value = onOff(payload);
    if (value !== null) effects.states.push({ camera, key: STATE_TOPICS[parts[1]], value });
  }
  return effects;
}
