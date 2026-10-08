// -----------------------------------------------------------------------------
// TLS sockets that apply the trust-on-first-use policy (./tlsTrust.js).
//
// Node verifies nothing here (`rejectUnauthorized: false`): the decision is
// ours, taken SYNCHRONOUSLY in the first 'secureConnect' listener, which is
// registered before the socket is handed to anyone. That ordering matters:
// what a client writes before the handshake ends (mqtt.js writes its CONNECT
// packet, broker password included, as soon as it gets the stream) is
// flushed to the peer one event-loop turn after 'secureConnect' — a refusal
// taken after any `await` would come too late. Checked on Node 22.
//
// Used by the HTTP client (undici `connect`, the request is only written
// once the socket is handed back) and by the MQTT probe (mqtt.js stream
// builder). No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import net from 'node:net';
import tls from 'node:tls';
import { CertificateError, UnreachableError } from './errors.js';
import { decideTrust, endpointKey } from './tlsTrust.js';

/** "[fe80::1]" (URL.hostname) -> "fe80::1" (what tls.connect expects). */
export function bareHost(host) {
  return String(host).replace(/^\[(.*)\]$/, '$1');
}

/**
 * Open a TLS socket whose peer certificate goes through decideTrust().
 * An untrusted peer is destroyed with a CertificateError before any byte
 * written by the caller leaves; a first-use certificate is pinned.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {import('./tlsTrust.js').TrustStore} options.trustStore loaded store
 * @param {string} [options.manualFingerprint] expert pin (config tls_fingerprint)
 * @param {string} [options.ca] expert authority, PEM (config tls_ca)
 * @param {(decision: object) => void} [options.onDecision] receives
 *   `{ trusted, reason, endpoint, fingerprint }`
 * @returns {tls.TLSSocket}
 */
export function createTrustedTlsSocket({
  host,
  port,
  trustStore,
  manualFingerprint = '',
  ca = '',
  onDecision,
}) {
  const hostname = bareHost(host);
  const endpoint = endpointKey(hostname, port);
  const socket = tls.connect({
    host: hostname,
    port,
    // RFC 6066 forbids an IP address as SNI (Node warns about it).
    servername: net.isIP(hostname) ? undefined : hostname,
    rejectUnauthorized: false,
    ...(ca ? { ca } : {}),
  });
  socket.once('secureConnect', () => {
    const certificate = socket.getPeerCertificate();
    const hasCertificate = Boolean(certificate && certificate.raw);
    const fingerprint = hasCertificate ? certificate.fingerprint256 : '';
    const decision = decideTrust(
      {
        fingerprint,
        chainValid: socket.authorized,
        hostnameValid: hasCertificate && !tls.checkServerIdentity(hostname, certificate),
      },
      {
        manualFingerprint,
        customCa: Boolean(ca),
        pinnedFingerprint: trustStore.get(endpoint),
      },
    );
    onDecision?.({ trusted: decision.trusted, reason: decision.reason, endpoint, fingerprint });
    if (!decision.trusted) {
      socket.destroy(new CertificateError(decision.reason, endpoint, fingerprint));
      return;
    }
    if (decision.pin) {
      // The store logs its own write failures and never rejects.
      trustStore.set(endpoint, decision.pin);
    }
  });
  return socket;
}

/**
 * undici `connect` function: plain TCP for http:, trust-on-first-use TLS
 * for https:. The callback gets the socket only once it is trusted, so
 * undici never writes a request (and its Bearer token) to an untrusted peer.
 *
 * @param {object} tlsOptions same as createTrustedTlsSocket, minus host/port
 * @param {number} [timeoutMs] connection + handshake timeout
 */
export function createConnector(tlsOptions, timeoutMs = 10_000) {
  return function connect(options, callback) {
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    const secure = options.protocol === 'https:';
    const socket = secure
      ? createTrustedTlsSocket({ ...tlsOptions, host: options.hostname, port })
      : net.connect({ host: bareHost(options.hostname), port });

    let settled = false;
    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', settle);
      if (error) {
        socket.destroy();
        callback(error);
      } else {
        callback(null, socket);
      }
    };
    const timer = setTimeout(() => settle(new UnreachableError('TIMEOUT')), timeoutMs);
    socket.once('error', settle);
    // Listeners run in registration order: for TLS, the trust check above
    // has already run (and destroyed an untrusted socket) by now.
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      if (!socket.destroyed) {
        settle();
      }
    });
  };
}
