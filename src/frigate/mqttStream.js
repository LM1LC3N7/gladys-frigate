// -----------------------------------------------------------------------------
// MQTT transport shared by the connection check (./mqttProbe.js) and the
// long-lived subscriber (./mqttClient.js).
//
// mqtt.js 5 writes the CONNECT packet (with the broker password) as soon as
// its stream builder returns, before any TLS handshake. Over TLS the socket
// therefore comes from the trust-on-first-use connector, which decides
// synchronously on 'secureConnect' and destroys an untrusted socket before
// the buffered CONNECT reaches the peer — see ./tlsConnector.js.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { FrigateError, MqttRefusedError, UnreachableError } from './errors.js';
import { bareHost, createTrustedTlsSocket } from './tlsConnector.js';

// MQTT 3.1.1 CONNACK return codes worth a precise message.
const CONNACK_BAD_CREDENTIALS = 4;
const CONNACK_NOT_AUTHORIZED = 5;

/**
 * Stream builder for `new MqttClient(builder, options)`.
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {boolean} [options.tls]
 * @param {import('./tlsTrust.js').TrustStore} [options.trustStore]
 * @param {string} [options.manualFingerprint]
 * @param {string} [options.ca]
 * @param {(decision: object) => void} [options.onDecision] TLS trust decision
 * @param {(err: Error) => void} [options.onSocketError] the socket's own
 *   error: mqtt.js only re-emits a few codes (a CertificateError has none)
 */
export function mqttStreamBuilder({
  host,
  port,
  tls = false,
  trustStore,
  manualFingerprint = '',
  ca = '',
  onDecision,
  onSocketError,
}) {
  return () => {
    const socket = tls
      ? createTrustedTlsSocket({ host, port, trustStore, manualFingerprint, ca, onDecision })
      : net.connect({ host: bareHost(host), port });
    socket.once('error', (err) => onSocketError?.(err));
    return socket;
  };
}

/** mqtt.js / socket error -> typed error of ./errors.js. */
export function toMqttError(err) {
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
