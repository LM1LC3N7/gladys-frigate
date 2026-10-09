// -----------------------------------------------------------------------------
// Transport badge of each camera device (gladys.publishTransports).
//
//   unreachable  Frigate does not answer, announces it is offline, or the
//                camera's detection stream has been offline for 30 s
//   local + degraded
//                the recording stream has been offline for 30 s, or the
//                real-time feed is interrupted (states may be outdated)
//   local        otherwise
//
// Frigate flaps `<camera>/status/<role>` offline/online while it restarts
// ffmpeg: an offline role only counts once it stayed offline `debounceMs`.
// Frigate 0.16 has no status topics: the camera fps of /api/stats feeds the
// same `detect` role. Only changes are published, for created devices only.
// -----------------------------------------------------------------------------

import { DEVICE_TYPE } from './discovery.js';

const MESSAGES = {
  frigateDown: { en: 'Frigate does not answer', fr: 'Frigate ne répond pas' },
  frigateOffline: {
    en: 'Frigate announces it is offline (restarting?)',
    fr: "Frigate s'annonce hors ligne (redémarrage ?)",
  },
  detectOffline: {
    en: 'The camera stream is lost: check the camera and its connection',
    fr: 'Le flux de la caméra est perdu : vérifiez la caméra et sa connexion',
  },
  recordOffline: {
    en: 'The recording stream is interrupted',
    fr: "Le flux d'enregistrement est interrompu",
  },
  feedDown: {
    en: 'Real-time feed interrupted: the states may be outdated',
    fr: 'Flux temps réel interrompu : les états peuvent être périmés',
  },
};

/**
 * @param {object} options
 * @param {{ externalIds: Function, publishTransports: Function }} options.gladys
 * @param {() => string[]} options.createdCameras Frigate names of the created devices
 * @param {{ warn: Function }} options.logger
 * @param {number} [options.debounceMs]
 */
export function createTransportTracker({ gladys, createdCameras, logger, debounceMs = 30_000 }) {
  const state = {
    frigateUp: null, // HTTP read succeeded (null = unknown)
    frigateOnline: null, // Frigate's `available`
    feed: null, // feed state, null = no feed
  };
  const offlineRoles = new Map(); // `${camera}|${role}` -> { confirmed, timer }
  const published = new Map(); // device external id -> serialized transport
  let scheduled = false;
  let closed = false;

  function roleOffline(camera, role) {
    return offlineRoles.get(`${camera}|${role}`)?.confirmed === true;
  }

  function transportOf(camera) {
    if (state.frigateUp === false) {
      return { transport: 'unreachable', message: MESSAGES.frigateDown };
    }
    if (state.frigateOnline === false) {
      return { transport: 'unreachable', message: MESSAGES.frigateOffline };
    }
    if (roleOffline(camera, 'detect')) {
      return { transport: 'unreachable', message: MESSAGES.detectOffline };
    }
    if (roleOffline(camera, 'record')) {
      return { transport: 'local', degraded: true, message: MESSAGES.recordOffline };
    }
    // "connecting" is the normal start: only a lost feed is degraded.
    if (state.feed === 'disconnected' || state.feed === 'failed') {
      return { transport: 'local', degraded: true, message: MESSAGES.feedDown };
    }
    return { transport: 'local' };
  }

  async function publish() {
    scheduled = false;
    if (closed || state.frigateUp === null) {
      return;
    }
    const changes = [];
    for (const camera of createdCameras()) {
      const externalId = gladys.externalIds(DEVICE_TYPE, camera).device;
      const entry = { external_id: externalId, ...transportOf(camera) };
      const key = JSON.stringify(entry);
      if (published.get(externalId) !== key) {
        published.set(externalId, key);
        changes.push(entry);
      }
    }
    for (let i = 0; i < changes.length; i += 100) {
      const batch = changes.slice(i, i + 100);
      await gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) published.delete(entry.external_id);
        logger.warn(`Could not publish the camera transports: ${err.message}`);
      });
    }
  }

  function update() {
    if (!scheduled && !closed) {
      scheduled = true;
      setImmediate(() => publish().catch(() => {}));
    }
  }

  function setRole(camera, role, offline) {
    const key = `${camera}|${role}`;
    const current = offlineRoles.get(key);
    if (!offline) {
      if (current) {
        clearTimeout(current.timer);
        offlineRoles.delete(key);
        update();
      }
      return;
    }
    if (current) {
      return;
    }
    const entry = { confirmed: false, timer: null };
    entry.timer = setTimeout(() => {
      entry.confirmed = true;
      update();
    }, debounceMs);
    entry.timer.unref?.();
    offlineRoles.set(key, entry);
  }

  return {
    /** The HTTP read of Frigate succeeded (true) or failed (false). */
    setFrigateUp(up) {
      state.frigateUp = up;
      update();
    },
    /** Frigate's `available` announcement. */
    setFrigateOnline(online) {
      state.frigateOnline = online;
      update();
    },
    /** Feed state ('connected', 'disconnected'…), null when there is none. */
    setFeed(feedState) {
      state.feed = feedState;
      update();
    },
    /** `<camera>/status/<role>`: online | offline | disabled. */
    setCameraStatus(camera, role, status) {
      setRole(camera, role, status === 'offline');
    },
    /** Frigate 0.16: camera health from /api/stats. */
    setCameraHealth(camera, healthy) {
      setRole(camera, 'detect', !healthy);
    },
    /** A device was created: publish its badge. */
    refresh: update,
    /** Publish every badge again (Gladys reconnected). */
    forget() {
      published.clear();
      update();
    },
    close() {
      closed = true;
      for (const entry of offlineRoles.values()) clearTimeout(entry.timer);
      offlineRoles.clear();
    },
    transportOf,
  };
}
