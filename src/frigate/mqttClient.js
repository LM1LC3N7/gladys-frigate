// -----------------------------------------------------------------------------
// Long-lived MQTT subscriber: the real-time feed when a broker is configured.
//
//   - Same transport as the connection check (./mqttStream.js): over TLS the
//     broker password only leaves once the certificate is trusted.
//   - Subscribes on every connection (clean session, so a reconnection
//     starts from scratch) to the topics ./topics.js understands, never to
//     `<prefix>/#`: the retained per-object snapshots are JPEGs.
//   - Reconnects on its own after a network failure. A refused certificate
//     or refused credentials stop it instead: retrying cannot fix them, the
//     user has to (status "failed").
//
// Emits 'message' (topic without the prefix, payload Buffer) and 'status'
// ({ state: 'connecting' | 'connected' | 'disconnected' | 'failed', error }).
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MqttClient } from 'mqtt';
import { CertificateError, MqttRefusedError } from './errors.js';
import { mqttStreamBuilder, toMqttError } from './mqttStream.js';

/** Topic filters, relative to the prefix (non-overlapping: no duplicates). */
export const SUBSCRIPTIONS = Object.freeze([
  'available',
  'events',
  'reviews',
  '+/+', // <camera>/motion, <camera>/review_status, <camera|zone>/<label>
  '+/+/active', // <camera|zone>/<label>/active
  '+/+/state', // <camera>/<setting>/state
  '+/status/+', // <camera>/status/<role> (0.17+)
]);

/** Errors that a retry cannot fix. */
export const isPermanent = (err) =>
  err instanceof CertificateError || err instanceof MqttRefusedError;

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {boolean} [options.tls]
 * @param {import('./tlsTrust.js').TrustStore} options.trustStore
 * @param {string} [options.manualFingerprint]
 * @param {string} [options.ca]
 * @param {string} options.prefix Frigate topic prefix, e.g. "frigate"
 * @param {number} [options.reconnectPeriodMs]
 * @param {number} [options.connectTimeoutMs]
 */
export function createMqttFeed({
  host,
  port,
  username = '',
  password = '',
  tls = false,
  trustStore,
  manualFingerprint = '',
  ca = '',
  prefix,
  reconnectPeriodMs = 5_000,
  connectTimeoutMs = 10_000,
}) {
  const feed = new EventEmitter();
  const topicStart = `${prefix}/`;
  let socketError = null;
  let stopped = false;
  let status = { state: 'connecting', error: null };

  function setStatus(state, error = null) {
    if (status.state === state && status.error?.message === error?.message) {
      return;
    }
    status = { state, error };
    feed.emit('status', status);
  }

  const client = new MqttClient(
    mqttStreamBuilder({
      host,
      port,
      tls,
      trustStore,
      manualFingerprint,
      ca,
      onSocketError: (err) => {
        socketError = err;
      },
    }),
    {
      clientId: `gladys-frigate-${randomBytes(4).toString('hex')}`,
      username: username || undefined,
      password: password || undefined,
      protocolVersion: 4,
      clean: true,
      resubscribe: false,
      keepalive: 30,
      reconnectPeriod: reconnectPeriodMs,
      connectTimeout: connectTimeoutMs,
    },
  );

  function fail(err) {
    stopped = true;
    client.end(true);
    setStatus('failed', err);
  }

  client.on('connect', () => {
    socketError = null;
    client.subscribe(
      SUBSCRIPTIONS.map((filter) => `${prefix}/${filter}`),
      { qos: 0 },
      (err, granted) => {
        // A broker ACL refusing the read gives the 0x80 granted code. Only
        // a refusal of everything is fatal: the topics are independent.
        const refused = err || (granted?.length && granted.every((grant) => grant.qos === 0x80));
        if (refused && !stopped) {
          fail(new MqttRefusedError('not_authorized'));
        }
      },
    );
    setStatus('connected');
  });
  client.on('message', (topic, payload) => {
    if (topic.startsWith(topicStart)) {
      feed.emit('message', topic.slice(topicStart.length), payload);
    }
  });
  client.on('error', (err) => {
    const error = toMqttError(err);
    if (isPermanent(error)) {
      fail(error);
    }
  });
  client.on('close', () => {
    if (stopped) {
      return;
    }
    const error = toMqttError(socketError ?? { code: 'CLOSED' });
    socketError = null;
    if (isPermanent(error)) {
      fail(error);
      return;
    }
    setStatus('disconnected', error);
  });
  client.on('reconnect', () => {
    if (!stopped && status.state !== 'disconnected') {
      setStatus('connecting');
    }
  });

  feed.mode = 'mqtt';
  feed.endpoint = `${host}:${port}`;
  Object.defineProperty(feed, 'status', { get: () => status });

  /** Publish to `<prefix>/<topic>` (camera commands). */
  feed.publish = (topic, payload) => client.publishAsync(`${prefix}/${topic}`, payload, { qos: 0 });

  feed.close = () =>
    new Promise((resolve) => {
      stopped = true;
      client.end(true, {}, () => resolve());
    });

  return feed;
}
