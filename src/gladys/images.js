// -----------------------------------------------------------------------------
// Camera images in the format Gladys expects.
//
// Gladys takes `image/jpg;base64,...` strings of at most 150 KB, the prefix
// included. Frigate resizes and re-encodes its latest frame on demand
// (`height` and `quality` of /api/<camera>/latest.jpg), so the container
// decodes nothing: we ask for a height and a quality, then step them down
// until the image fits. The step that fitted is remembered per camera, so a
// capture usually costs one request.
//
// Captures are shared: a capture already running for a camera is joined, and
// an image younger than 2 s is reused (a dashboard opened on several screens
// does not multiply the requests to Frigate). Pushes stay under the Gladys
// rate limit of 12 images per minute and per camera.
//
// An attached image (event snapshot of the scene action) answers onGetImage
// for ATTACHED_MS: Gladys' "send a camera image" asks the integration for a
// live capture rather than reading the stored image, which would otherwise
// replace the snapshot by the current frame.
// -----------------------------------------------------------------------------

import { FrigateError, HttpStatusError } from '../frigate/errors.js';

export const MAX_IMAGE_LENGTH = 150 * 1024;
export const IMAGE_PREFIX = 'image/jpg;base64,';
const MAX_PUSHES_PER_MINUTE = 12;
const FRESH_MS = 2_000;
export const ATTACHED_MS = 60_000;

/** Height/quality steps, from the best image to the smallest one. */
export const IMAGE_STEPS = Object.freeze(
  [720, 540, 360, 240].flatMap((height) =>
    [70, 50, 35].map((quality) => Object.freeze({ height, quality })),
  ),
);

export function toGladysImage(jpeg) {
  return `${IMAGE_PREFIX}${jpeg.toString('base64')}`;
}

export class ImageTooLargeError extends FrigateError {
  constructor(what) {
    super(`The image of ${what} stays above 150 KB even at the smallest size`);
    this.name = 'ImageTooLargeError';
  }
}

export class NotConnectedError extends FrigateError {
  constructor() {
    super('Frigate is not connected');
    this.name = 'NotConnectedError';
  }
}

/**
 * @param {object} options
 * @param {() => ({ getLatestJpeg: Function } | null)} options.getClient
 *   the connected Frigate client, null while not connected
 * @param {(deviceExternalId: string, image: string) => Promise} options.publish
 *   gladys.publishCameraImage
 * @param {() => number} [options.now]
 */
export function createCameraImages({ getClient, publish, now = Date.now }) {
  const startStep = new Map(); // camera -> index in IMAGE_STEPS
  const recent = new Map(); // camera -> { at, image }
  const inFlight = new Map(); // camera -> Promise<string>
  const pushWindows = new Map(); // device external id -> { count, resetAt }
  const attachedImages = new Map(); // device external id -> { image, until }

  /**
   * The first step `fetchStep` serves under the Gladys limit, starting from
   * the one remembered for `memoKey` (null: from the best step).
   */
  async function fitted(fetchStep, memoKey, what) {
    let index = (memoKey && startStep.get(memoKey)) ?? 0;
    for (; index < IMAGE_STEPS.length; index += 1) {
      const image = toGladysImage(await fetchStep(IMAGE_STEPS[index]));
      if (image.length <= MAX_IMAGE_LENGTH) {
        // Well under the limit: try one step better next time (the scene
        // may have become simpler, at night for instance).
        const roomy = image.length < MAX_IMAGE_LENGTH / 2;
        if (memoKey) startStep.set(memoKey, roomy ? Math.max(0, index - 1) : index);
        return image;
      }
    }
    if (memoKey) startStep.delete(memoKey);
    throw new ImageTooLargeError(what);
  }

  const fetchFitting = (client, camera) =>
    fitted((step) => client.getLatestJpeg(camera, step), camera, `camera "${camera}"`);

  /**
   * A fresh image of a camera (`image/jpg;base64,...`, at most 150 KB).
   * @param {string} camera Frigate camera name
   */
  function capture(camera) {
    const cached = recent.get(camera);
    if (cached && now() - cached.at < FRESH_MS) {
      return Promise.resolve(cached.image);
    }
    const running = inFlight.get(camera);
    if (running) {
      return running;
    }
    const client = getClient();
    if (!client) {
      return Promise.reject(new NotConnectedError());
    }
    const promise = fetchFitting(client, camera)
      .then((image) => {
        recent.set(camera, { at: now(), image });
        return image;
      })
      .finally(() => inFlight.delete(camera));
    inFlight.set(camera, promise);
    return promise;
  }

  /** Room left in the Gladys rate limit of this device (and take one slot). */
  function takePushSlot(deviceExternalId) {
    const time = now();
    let window = pushWindows.get(deviceExternalId);
    if (!window || time >= window.resetAt) {
      window = { count: 0, resetAt: time + 60_000 };
      pushWindows.set(deviceExternalId, window);
    }
    if (window.count >= MAX_PUSHES_PER_MINUTE) {
      return false;
    }
    window.count += 1;
    return true;
  }

  return {
    capture,

    /**
     * The snapshot of a Frigate event (bounding box optional), fitted like
     * the camera images; its thumbnail when Frigate keeps no snapshot.
     * @param {string} eventId
     * @param {{ bbox?: boolean }} [options]
     */
    async eventSnapshot(eventId, { bbox = true } = {}) {
      const client = getClient();
      if (!client) {
        throw new NotConnectedError();
      }
      let previous = null;
      try {
        return await fitted(
          async (step) => {
            const jpeg = await client.getEventSnapshot(eventId, { ...step, bbox });
            // A finished event: Frigate serves its stored file as is, whatever
            // the size asked, so a smaller step cannot help.
            if (jpeg.length === previous) {
              throw new ImageTooLargeError(`event ${eventId}`);
            }
            previous = jpeg.length;
            return jpeg;
          },
          null,
          `event ${eventId}`,
        );
      } catch (err) {
        const noSnapshot = err instanceof HttpStatusError && err.status === 404;
        if (!noSnapshot && !(err instanceof ImageTooLargeError)) {
          throw err;
        }
        const image = toGladysImage(await client.getEventThumbnail(eventId));
        if (image.length > MAX_IMAGE_LENGTH) {
          throw new ImageTooLargeError(`event ${eventId}`);
        }
        return image;
      }
    },

    /**
     * Capture an image and publish it on the Gladys camera device.
     * @returns {Promise<boolean>} false when skipped by the rate limit
     */
    async push(deviceExternalId, camera) {
      if (!takePushSlot(deviceExternalId)) {
        return false;
      }
      await publish(deviceExternalId, await capture(camera));
      return true;
    },

    /**
     * Attach an image (an event snapshot) to a camera device: it answers
     * onGetImage for ATTACHED_MS, and is published within the same rate
     * limit as the pushes.
     * @returns {Promise<boolean>} false when the publication was skipped by
     *   the rate limit (the image is still attached)
     */
    async attach(deviceExternalId, image) {
      attachedImages.set(deviceExternalId, { image, until: now() + ATTACHED_MS });
      if (!takePushSlot(deviceExternalId)) {
        return false;
      }
      await publish(deviceExternalId, image);
      return true;
    },

    /** The image attached to a camera device, while it holds. */
    attached(deviceExternalId) {
      const entry = attachedImages.get(deviceExternalId);
      if (entry && now() < entry.until) {
        return entry.image;
      }
      attachedImages.delete(deviceExternalId);
      return null;
    },
  };
}

/**
 * The image side of the camera devices: push on poll / creation (never
 * throws, a camera failing every minute logs once), capture on demand.
 * @param {object} options
 * @param {object} options.gladys SDK instance
 * @param {ReturnType<typeof createCameraImages>} options.images
 * @param {(gladys: object, device: object) => string | null} options.cameraOf
 * @param {() => boolean} options.isConnected
 * @param {{ warn: Function }} options.logger
 */
export function createDeviceImages({ gladys, images, cameraOf, isConnected, logger }) {
  const errors = new Map(); // camera -> last error message

  return {
    async pushImage(device) {
      const camera = cameraOf(gladys, device);
      if (!camera || !isConnected()) {
        return;
      }
      try {
        await images.push(device.external_id, camera);
        errors.delete(camera);
      } catch (err) {
        if (errors.get(camera) !== err.message) {
          errors.set(camera, err.message);
          logger.warn(`Could not update the image of camera ${camera}: ${err.message}`);
        }
      }
    },

    /** onGetImage: the attached event snapshot, else a fresh image, or a clear error. */
    captureImage(device) {
      const camera = cameraOf(gladys, device);
      if (!camera) {
        return Promise.reject(new Error(`${device?.external_id} is not a Frigate camera`));
      }
      return Promise.resolve(images.attached(device.external_id) ?? images.capture(camera));
    },
  };
}
