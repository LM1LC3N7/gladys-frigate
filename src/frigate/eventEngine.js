// -----------------------------------------------------------------------------
// Frigate `events` and `reviews` -> business transitions, one per incident.
//
// Frigate sends an update per tracked object several times a second; scenes
// want "a person was detected", once. Rules:
//   - object_detected: once per tracked object (event id), when it is a true
//     positive, not stationary, and its best score reaches `minScore`.
//   - object_entered_zone: once per tracked object and zone, same filters.
//   - review_alert (the "new review" trigger, filtered by severity in the
//     scenes): once per review item, with its severity, plus once more when
//     a detection is escalated to an alert.
//   - Cooldown: a transition is dropped when the same one (trigger, camera,
//     object type, zone; camera and severity for reviews) fired less than
//     `cooldownSeconds` ago, so a person
//     walking in and out of the frame does not flood the scenes. A dropped
//     transition is not fired later: the incident is over for the scenes.
//   - Reviews carry no score: Frigate's own thresholds already apply.
// Labels lose Frigate's "-verified" suffix. Scores are percentages (0-100).
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { baseLabel } from './topics.js';

export const TRANSITIONS = Object.freeze({
  OBJECT_DETECTED: 'object_detected',
  OBJECT_ENTERED_ZONE: 'object_entered_zone',
  REVIEW_ALERT: 'review_alert',
});

// Tracked objects / reviews remembered at once; Frigate sends `end` for
// each, this only bounds the memory when an `end` is lost.
const MAX_TRACKED = 1000;
const SEVERITIES = new Set(['alert', 'detection']);

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
const unique = (values) => [...new Set(values)];

/** Frigate sub_label: null, "name" or ["name", score]. */
function subLabelOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function percent(score) {
  return typeof score === 'number' && Number.isFinite(score)
    ? Math.round(Math.min(Math.max(score, 0), 1) * 100)
    : 0;
}

/** Insertion-ordered map dropping its oldest entries past `max`. */
function boundedSet(map, key, value, max = MAX_TRACKED) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

/**
 * @param {object} options
 * @param {number} [options.minScore] 0-100
 * @param {number} [options.cooldownSeconds] 0 = no cooldown
 * @param {() => number} [options.now]
 */
export function createEventEngine({ minScore = 70, cooldownSeconds = 30, now = Date.now } = {}) {
  // event id -> { detected: boolean, zones: Set<string> }
  const objects = new Map();
  // review id -> true once alerted
  const reviews = new Map();
  // cooldown key -> time of the last transition
  const lastFired = new Map();
  // camera -> tracked labels, in the order of the Frigate configuration
  let labelOrder = new Map();

  function coolingDown(key) {
    if (cooldownSeconds <= 0) {
      return false;
    }
    const time = now();
    const last = lastFired.get(key);
    if (last !== undefined && time - last < cooldownSeconds * 1000) {
      return true;
    }
    boundedSet(lastFired, key, time);
    return false;
  }

  function handleEvent({ type, after }) {
    const id = after.id;
    if (typeof id !== 'string' || typeof after.camera !== 'string') {
      return [];
    }
    if (type === 'end') {
      objects.delete(id);
      return [];
    }
    const score = percent(after.top_score ?? after.score);
    if (after.false_positive === true || score < minScore) {
      return [];
    }
    const state = objects.get(id) ?? { detected: false, zones: new Set() };
    boundedSet(objects, id, state);
    const base = {
      camera: after.camera,
      label: baseLabel(after.label),
      subLabel: subLabelOf(after.sub_label),
      score,
      eventId: id,
    };
    const transitions = [];
    if (!state.detected && after.stationary !== true) {
      state.detected = true;
      if (!coolingDown(`${TRANSITIONS.OBJECT_DETECTED}|${base.camera}|${base.label}`)) {
        transitions.push({
          kind: TRANSITIONS.OBJECT_DETECTED,
          ...base,
          zones: strings(after.current_zones),
          hasSnapshot: after.has_snapshot === true,
        });
      }
    }
    for (const zone of strings(after.entered_zones)) {
      if (state.zones.has(zone)) {
        continue;
      }
      state.zones.add(zone);
      if (!coolingDown(`${TRANSITIONS.OBJECT_ENTERED_ZONE}|${base.camera}|${zone}|${base.label}`)) {
        transitions.push({
          kind: TRANSITIONS.OBJECT_ENTERED_ZONE,
          ...base,
          zone,
          zones: unique([...strings(after.current_zones), zone]),
        });
      }
    }
    return transitions;
  }

  /** The object scenes should filter on: first in the camera's tracked order. */
  function mainLabel(camera, labels) {
    const order = labelOrder.get(camera) ?? [];
    return order.find((label) => labels.includes(label)) ?? labels[0] ?? null;
  }

  function handleReview({ type, after }) {
    const id = after.id;
    if (typeof id !== 'string' || typeof after.camera !== 'string') {
      return [];
    }
    const severity = SEVERITIES.has(after.severity) ? after.severity : null;
    const seen = reviews.get(id); // undefined, "detection" or "alert"
    if (type === 'end') {
      reviews.delete(id);
      // Fired already; or an item seen only at its end still fires once.
      if (seen) {
        return [];
      }
    } else if (severity) {
      boundedSet(reviews, id, seen === 'alert' ? 'alert' : severity);
    }
    // Once per item, plus once more for a detection escalated to an alert.
    if (!severity || seen === severity || seen === 'alert') {
      return [];
    }
    if (coolingDown(`${TRANSITIONS.REVIEW_ALERT}|${after.camera}|${severity}`)) {
      return [];
    }
    const data = after.data ?? {};
    const labels = unique(strings(data.objects).map(baseLabel)).filter(Boolean);
    const zones = unique(strings(data.zones));
    return [
      {
        kind: TRANSITIONS.REVIEW_ALERT,
        camera: after.camera,
        reviewId: id,
        severity,
        label: mainLabel(after.camera, labels),
        zone: zones[0] ?? null,
        objects: labels,
        zones,
        subLabels: unique(strings(data.sub_labels)),
        detections: strings(data.detections),
      },
    ];
  }

  return {
    /** Tracked labels per camera, for the main object of a review. */
    setCameras(cameras = []) {
      labelOrder = new Map(cameras.map((camera) => [camera.name, camera.objects ?? []]));
    },

    /**
     * @param {object} message typed message of ./topics.js
     * @returns {object[]} transitions (possibly none)
     */
    handle(message) {
      const data = message?.data;
      if (!data || typeof data.after !== 'object' || data.after === null) {
        return [];
      }
      if (message.type === 'event') return handleEvent(data);
      if (message.type === 'review') return handleReview(data);
      return [];
    },
  };
}
