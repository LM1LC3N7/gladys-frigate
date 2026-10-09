// -----------------------------------------------------------------------------
// One-shot MQTT connection check ("Test the connection" button).
//
// Connects with the configured account, waits for the broker's CONNACK and
// disconnects. Over TLS the socket comes from the trust-on-first-use
// connector, built before mqtt.js gets it, so a refused certificate never
// receives the CONNECT packet (and its password) — see ./mqttStream.js.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { MqttClient } from 'mqtt';
import { UnreachableError } from './errors.js';
import { mqttStreamBuilder, toMqttError } from './mqttStream.js';

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
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ tlsDecision: object | null }>}
 */
export function probeMqtt({
  host,
  port,
  username = '',
  password = '',
  tls = false,
  trustStore,
  manualFingerprint = '',
  ca = '',
  timeoutMs = 10_000,
}) {
  return new Promise((resolve, reject) => {
    let tlsDecision = null;
    let socketError = null;
    let finished = false;

    const client = new MqttClient(
      mqttStreamBuilder({
        host,
        port,
        tls,
        trustStore,
        manualFingerprint,
        ca,
        onDecision: (decision) => {
          tlsDecision = decision;
        },
        onSocketError: (err) => {
          socketError = err;
        },
      }),
      {
        clientId: `gladys-frigate-check-${randomBytes(4).toString('hex')}`,
        username: username || undefined,
        password: password || undefined,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: timeoutMs,
      },
    );

    function finish(err) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      client.end(true);
      if (err) {
        reject(toMqttError(err));
      } else {
        resolve({ tlsDecision });
      }
    }

    const timer = setTimeout(() => finish(new UnreachableError('TIMEOUT')), timeoutMs);
    client.once('connect', () => finish());
    client.once('error', (err) => finish(err));
    client.once('close', () => finish(socketError ?? new UnreachableError('CLOSED')));
  });
}
