// -----------------------------------------------------------------------------
// Device states -> Gladys, within its limits.
//
//   - Only the features of devices the user created (gladys.devices) are
//     published: the others would be refused.
//   - An unchanged value is not sent again. The latest value of every
//     feature is kept, created device or not: `republish()` sends what Gladys
//     lacks (a device just created), `forget()` sends everything again (Gladys
//     reconnected).
//   - Values are batched (one request per `flushMs`, at most 100 states) and
//     kept under `maxPerMinute` (Gladys accepts 300 per minute). Past the
//     budget, only the latest value of each feature waits for the next
//     minute: intermediate values are dropped, never queued without bound.
// -----------------------------------------------------------------------------

const BATCH_SIZE = 100;

/**
 * @param {object} options
 * @param {(states: object[]) => Promise} options.publish gladys.publishStates
 * @param {(featureExternalId: string) => boolean} options.isKnown
 * @param {{ warn: Function }} options.logger
 * @param {number} [options.flushMs]
 * @param {number} [options.maxPerMinute]
 * @param {() => number} [options.now]
 */
export function createStatePublisher({
  publish,
  isKnown,
  logger,
  flushMs = 1_000,
  maxPerMinute = 250,
  now = Date.now,
}) {
  const last = new Map(); // feature id -> serialized last published value
  const latest = new Map(); // feature id -> latest value, known to Gladys or not
  const pending = new Map(); // feature id -> value waiting to be sent
  let window = { start: 0, count: 0 };
  let timer = null;
  let flushing = null;
  let closed = false;

  const serialize = (value) => (typeof value === 'number' ? String(value) : JSON.stringify(value));

  function schedule(delay = flushMs) {
    if (!timer && !closed && pending.size > 0) {
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => {});
      }, delay);
      timer.unref?.();
    }
  }

  function budget() {
    const time = now();
    if (time - window.start >= 60_000) {
      window = { start: time, count: 0 };
    }
    return maxPerMinute - window.count;
  }

  async function flush() {
    if (flushing) {
      return flushing;
    }
    flushing = (async () => {
      if (pending.size === 0) {
        return;
      }
      const room = Math.min(budget(), BATCH_SIZE);
      if (room <= 0) {
        schedule(window.start + 60_000 - now());
        return;
      }
      const batch = [...pending].slice(0, room);
      for (const [id] of batch) {
        pending.delete(id);
      }
      window.count += batch.length;
      try {
        await publish(
          batch.map(([id, value]) =>
            typeof value === 'number'
              ? { device_feature_external_id: id, state: value }
              : { device_feature_external_id: id, text: value.text },
          ),
        );
        for (const [id, value] of batch) {
          last.set(id, serialize(value));
        }
      } catch (err) {
        // Not retried: the next change (or resync) publishes again.
        logger.warn(`Could not publish ${batch.length} states to Gladys: ${err.message}`);
      }
    })().finally(() => {
      flushing = null;
      schedule();
    });
    return flushing;
  }

  return {
    /** Queue the states that changed. */
    set(states) {
      for (const { id, value } of states) {
        latest.set(id, value);
        if (!isKnown(id)) {
          continue;
        }
        if (last.get(id) === serialize(value)) {
          // Back to the published value before the flush: nothing to send.
          pending.delete(id);
          continue;
        }
        pending.set(id, value);
      }
      schedule();
    },

    /** Send the latest values Gladys does not have yet (a device was created). */
    republish() {
      this.set([...latest].map(([id, value]) => ({ id, value })));
    },

    /** Send every latest value again, even unchanged (Gladys reconnected). */
    forget() {
      last.clear();
      this.republish();
    },

    /** The latest value of a feature (also for devices not created). */
    latest(id) {
      return latest.get(id);
    },

    /** Send what is pending now (tests, shutdown). */
    flush,

    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
