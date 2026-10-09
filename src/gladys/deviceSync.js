// -----------------------------------------------------------------------------
// Camera devices kept in sync with Frigate.
//
//   - Real-time messages -> feature states (./cameraStates.js, published by
//     ./statePublisher.js) and transport badges (./transports.js).
//   - Commands (onSetValue): a switch publishes `<camera>/<setting>/set` on
//     the feed, then waits for Frigate's `<camera>/<setting>/state`; no
//     confirmation within 4 s fails the command with a reason (in WebSocket
//     mode Frigate 0.17+ silently ignores commands from non-admin accounts).
//   - Polls (every minute per camera device): push a fresh image; on Frigate
//     0.16, which has no `status/<role>` topics, read the camera fps from
//     /api/stats for the transport badge.
// -----------------------------------------------------------------------------

import { createStateMapper } from './cameraStates.js';
import { TOGGLES, cameraNameOfDevice, parseFeatureId } from './discovery.js';
import { createStatePublisher } from './statePublisher.js';
import { createTransportTracker } from './transports.js';

const CONFIRM_TIMEOUT_MS = 4_000;
const STATS_MAX_AGE_MS = 30_000;

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * @param {object} options
 * @param {object} options.gladys SDK instance
 * @param {() => object | null} options.getCapabilities
 * @param {() => object | null} options.getClient Frigate HTTP client while connected
 * @param {() => object | null} options.getFeed the real-time feed
 * @param {() => boolean} options.zoneSensors
 * @param {{ pushImage: (device: object) => Promise }} options.images
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {number} [options.confirmTimeoutMs]
 * @param {number} [options.debounceMs] camera status debounce
 * @param {number} [options.flushMs] state batching
 * @param {() => number} [options.now]
 */
export function createDeviceSync({
  gladys,
  getCapabilities,
  getClient,
  getFeed,
  zoneSensors,
  images,
  logger,
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS,
  debounceMs,
  flushMs,
  now = Date.now,
}) {
  // Feature ids of the created devices, cached per gladys.devices array (the
  // SDK replaces the array on every change).
  let knownFor = null;
  let known = new Set();
  function knownIds() {
    if (knownFor !== gladys.devices) {
      knownFor = gladys.devices;
      known = new Set(
        (gladys.devices ?? []).flatMap((device) =>
          (device.features ?? []).map((feature) => feature.external_id),
        ),
      );
    }
    return known;
  }
  const createdCameras = () =>
    (gladys.devices ?? []).map((device) => cameraNameOfDevice(gladys, device)).filter(Boolean);

  const mapper = createStateMapper({ gladys, getCapabilities, zoneSensors });
  const states = createStatePublisher({
    publish: (batch) => gladys.publishStates(batch),
    isKnown: (id) => knownIds().has(id),
    logger,
    flushMs,
    now,
  });
  const transports = createTransportTracker({ gladys, createdCameras, logger, debounceMs });
  const waiters = new Set(); // { camera, setting, on, resolve }
  const cameraEnabled = new Map(); // camera -> last `enabled` state
  let stats = { at: 0, promise: null };

  function confirm(message) {
    for (const waiter of waiters) {
      if (
        waiter.camera === message.camera &&
        waiter.setting === message.setting &&
        waiter.on === message.on
      ) {
        waiter.resolve();
      }
    }
  }

  function waitForState(camera, setting, on) {
    return new Promise((resolve, reject) => {
      const waiter = { camera, setting, on, resolve: null };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new CommandError(
            getFeed()?.mode === 'websocket'
              ? 'Frigate did not confirm the change: without an MQTT broker, commands need an admin Frigate account'
              : 'Frigate did not confirm the change in time',
          ),
        );
      }, confirmTimeoutMs);
      waiter.resolve = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });
  }

  /** Frigate 0.16: camera fps from /api/stats (shared, at most every 30 s). */
  async function checkHealth() {
    const capabilities = getCapabilities();
    const client = getClient();
    if (!capabilities || capabilities.topics.cameraStatus || !client) {
      return;
    }
    if (!stats.promise || now() - stats.at > STATS_MAX_AGE_MS) {
      // One read (and at most one warning) for all the cameras polled.
      stats = {
        at: now(),
        promise: client.getStats().catch((err) => {
          logger.warn(`Could not read the Frigate stats: ${err.message}`);
          return null;
        }),
      };
    }
    const data = await stats.promise;
    if (!data) {
      return;
    }
    for (const camera of capabilities.cameras) {
      const entry = data?.cameras?.[camera.name] ?? data?.[camera.name];
      const fps = Number(entry?.camera_fps);
      const disabled = cameraEnabled.get(camera.name) === false || camera.enabled === false;
      transports.setCameraHealth(camera.name, disabled || fps > 0);
    }
  }

  return {
    /** A typed message of the real-time feed. */
    handleMessage(message) {
      states.set(mapper.map(message));
      switch (message.type) {
        case 'setting':
          if (message.setting === 'enabled') cameraEnabled.set(message.camera, message.on);
          confirm(message);
          break;
        case 'cameraStatus':
          transports.setCameraStatus(message.camera, message.role, message.state);
          break;
        case 'available':
          transports.setFrigateOnline(message.online);
          break;
        default:
      }
    },

    /** The feed state changed; a new connection resends every state. */
    feedStatus({ state }) {
      transports.setFeed(state);
      if (state === 'connected') {
        states.forget();
      }
    },

    /** The HTTP read of Frigate succeeded or failed. */
    frigateUp(up) {
      transports.setFrigateUp(up);
    },

    /** Gladys (re)connected: it may have restarted, resend everything. */
    gladysConnected() {
      states.forget();
      transports.forget();
    },

    async deviceCreated(device) {
      states.republish();
      transports.refresh();
      await images.pushImage(device);
    },

    async poll(device) {
      // A camera turned off (in Frigate or Gladys) has no image to show:
      // Gladys would refuse it anyway.
      if (cameraEnabled.get(cameraNameOfDevice(gladys, device)) !== false) {
        await images.pushImage(device);
      }
      await checkHealth();
    },

    /** onSetValue: a Frigate toggle. */
    async setValue(device, feature, value) {
      const parsed = parseFeatureId(gladys, feature?.external_id);
      const setting = parsed && TOGGLES[parsed.key];
      if (!setting) {
        throw new CommandError(`${feature?.external_id} cannot be changed`);
      }
      const feed = getFeed();
      if (feed?.status.state !== 'connected') {
        throw new CommandError(
          'The real-time feed is not connected: the command cannot reach Frigate',
        );
      }
      const on = Number(value) === 1;
      const confirmed = waitForState(parsed.camera, setting, on);
      try {
        await feed.publish(`${parsed.camera}/${setting}/set`, on ? 'ON' : 'OFF');
      } catch (err) {
        confirmed.catch(() => {});
        throw new CommandError(`The command could not be sent: ${err.message}`);
      }
      await confirmed;
    },

    close() {
      states.close();
      transports.close();
    },

    // Exposed for the tests.
    states,
    transports,
  };
}
