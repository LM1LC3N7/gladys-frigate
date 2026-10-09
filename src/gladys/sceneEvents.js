// -----------------------------------------------------------------------------
// Scene triggers and the scene action of the manifest (milestone 5).
//
//   - Transitions of src/frigate/eventEngine.js -> publishSceneEvent with the
//     flat data the manifest declares: `camera` is the Gladys device external
//     id (the "Camera" filter of the scene editor), `camera_name` the Frigate
//     name, lists joined with ", ", score in percent, null when unknown.
//   - On a review alert, a fresh image of the camera is pushed first, so a
//     scene chaining "send the camera image" sends the alert, not the image
//     of the last poll.
//   - A safety net under the Gladys limit of 300 events per minute (the
//     engine's cooldown normally keeps far below it).
//   - attach_event_snapshot: the snapshot of a Frigate event becomes the
//     camera image (the event's camera by default), for "send the camera
//     image" right after it.
// -----------------------------------------------------------------------------

import { TRANSITIONS } from '../frigate/eventEngine.js';
import { HttpStatusError } from '../frigate/errors.js';
import { DEVICE_TYPE } from './discovery.js';
import { SCENE_TRIGGERS } from './keys.js';

const MAX_TEXT = 1000;
const EVENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

const text = (value) => (typeof value === 'string' && value ? value.slice(0, MAX_TEXT) : null);
const list = (values) => text((values ?? []).join(', '));

export class SceneActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SceneActionError';
  }
}

/**
 * @param {{ externalIds: Function }} gladys
 * @param {object} transition of src/frigate/eventEngine.js
 * @returns {{ key: string, data: object } | null}
 */
export function toSceneEvent(gladys, transition) {
  const camera = gladys.externalIds(DEVICE_TYPE, transition.camera).device;
  switch (transition.kind) {
    case TRANSITIONS.REVIEW_ALERT:
      return {
        key: SCENE_TRIGGERS.REVIEW_ALERT,
        data: {
          camera,
          camera_name: transition.camera,
          severity: transition.severity,
          label: text(transition.label),
          objects: list(transition.objects),
          zone: text(transition.zone),
          zones: list(transition.zones),
          sub_label: text(transition.subLabels?.[0]),
          review_id: text(transition.reviewId),
          event_id: text(transition.detections?.[0]),
        },
      };
    case TRANSITIONS.OBJECT_DETECTED:
    case TRANSITIONS.OBJECT_ENTERED_ZONE:
      return {
        key:
          transition.kind === TRANSITIONS.OBJECT_DETECTED
            ? SCENE_TRIGGERS.OBJECT_DETECTED
            : SCENE_TRIGGERS.OBJECT_ENTERED_ZONE,
        data: {
          camera,
          camera_name: transition.camera,
          label: text(transition.label),
          sub_label: text(transition.subLabel),
          zone: text(transition.zone ?? transition.zones?.[0]),
          zones: list(transition.zones),
          score: transition.score,
          event_id: text(transition.eventId),
        },
      };
    default:
      return null;
  }
}

/**
 * @param {object} options
 * @param {{ externalIds: Function, publishSceneEvent: Function }} options.gladys
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {(camera: string) => Promise} [options.beforeAlert] push a fresh image
 * @param {number} [options.maxPerMinute]
 * @param {() => number} [options.now]
 */
export function createSceneEvents({
  gladys,
  logger,
  beforeAlert = async () => {},
  maxPerMinute = 250,
  now = Date.now,
}) {
  let window = { start: 0, count: 0 };
  let dropped = 0;

  function allowed() {
    const time = now();
    if (time - window.start >= 60_000) {
      if (dropped > 0) {
        logger.warn(`${dropped} scene events dropped (over ${maxPerMinute} per minute)`);
      }
      window = { start: time, count: 0 };
      dropped = 0;
    }
    if (window.count >= maxPerMinute) {
      dropped += 1;
      return false;
    }
    window.count += 1;
    return true;
  }

  return {
    /** Never throws: a lost event is logged. */
    async handle(transition) {
      const event = toSceneEvent(gladys, transition);
      if (!event || !allowed()) {
        return;
      }
      if (event.key === SCENE_TRIGGERS.REVIEW_ALERT && transition.severity === 'alert') {
        await beforeAlert(transition.camera).catch(() => {});
      }
      await gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => logger.warn(`Could not send the scene event ${event.key}: ${err.message}`));
    },
  };
}

/**
 * Handler of the attach_event_snapshot scene action.
 * @param {object} options
 * @param {{ externalIds: Function }} options.gladys
 * @param {{ eventSnapshot: Function, publishImage: Function }} options.images
 * @param {() => object | null} options.getClient Frigate HTTP client while connected
 */
export function createSnapshotAction({ gladys, images, getClient }) {
  return async (fields = {}) => {
    const eventId = String(fields.event_id ?? '').trim();
    if (!EVENT_ID.test(eventId)) {
      throw new SceneActionError(`"${eventId.slice(0, 100)}" is not a Frigate event id`);
    }
    const client = getClient();
    if (!client) {
      throw new SceneActionError('Frigate is not connected');
    }
    let device = typeof fields.camera === 'string' && fields.camera ? fields.camera : null;
    if (!device) {
      let event;
      try {
        event = await client.getEvent(eventId);
      } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
          throw new SceneActionError(`Frigate has no event ${eventId}`);
        }
        throw err;
      }
      if (typeof event?.camera !== 'string') {
        throw new SceneActionError(`Frigate did not tell the camera of event ${eventId}`);
      }
      device = gladys.externalIds(DEVICE_TYPE, event.camera).device;
    }
    const image = await images.eventSnapshot(eventId, { bbox: fields.bounding_box !== false });
    if (!(await images.publishImage(device, image))) {
      throw new SceneActionError('Too many images for this camera this minute (Gladys accepts 12)');
    }
  };
}
