// -----------------------------------------------------------------------------
// One-shot MQTT connection check ("Test the connection" button).
//
// Connects with the configured account, waits for the broker's CONNACK and
// disconnects. Over TLS the socket comes from the trust-on-first-use
// connector, built before mqtt.js gets it, so a refused certificate never
// receives the CONNECT packet (and its password) — see ./tlsConnector.js.
// The long-lived subscriber (milestone 3) reuses the same stream builder.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { MqttClient } from 'mqtt';
import { FrigateError, MqttRefusedError, UnreachableError } from './errors.js';
import { bareHost, createTrustedTlsSocket } from './tlsConnector.js';

// MQTT 3.1.1 CONNACK return codes worth a precise message.
const CONNACK_BAD_CREDENTIALS = 4;
const CONNACK_NOT_AUTHORIZED = 5;

function toProbeError(err) {
  if (err instanceof FrigateError) {
    return err;
  }
  if (err?.code === CONNACK_BAD_CREDENTIALS) {
    return new MqttRefusedError('invalid_credentials');
  }
  if (err?.code === CONNACK_NOT_AUTHORIZED) {
    return new MqttRefusedError('not_authorized');
  }
  if (typeof err?.code === 'number') {
    return new MqttRefusedError('refused');
  }
  return new UnreachableError(err?.code ?? 'CLOSED');
}

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
      () => {
        const socket = tls
          ? createTrustedTlsSocket({
              host,
              port,
              trustStore,
              manualFingerprint,
              ca,
              onDecision: (decision) => {
                tlsDecision = decision;
              },
            })
          : net.connect({ host: bareHost(host), port });
        // mqtt.js only re-emits a few socket error codes: keep ours (a
        // CertificateError has none) to report why the stream closed.
        socket.once('error', (err) => {
          socketError = err;
        });
        return socket;
      },
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
        reject(toProbeError(err));
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
