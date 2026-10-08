// -----------------------------------------------------------------------------
// Frigate WebSocket (/ws): the real-time feed when no broker is configured.
//
//   - Same origin, dispatcher and TLS trust as the HTTP client: the handshake
//     (and its Bearer token) only leaves once the certificate is trusted.
//   - Same messages as MQTT, as JSON `{ topic, payload }` without the prefix.
//     After opening, `onConnect` asks Frigate for `camera_activity` (the
//     state of every camera), since nothing is retained here.
//   - Reconnects with a backoff (1 s doubling to 60 s). Each attempt first
//     makes one authenticated request, which logs in or renews the token and
//     tells a refused certificate or account (status "failed", no retry:
//     Frigate rate-limits logins) from an unreachable Frigate.
//
// Same events as ./mqttClient.js: 'message' (topic, payload) and 'status'.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { WebSocket } from 'undici';
import { AuthError, CertificateError, UnreachableError } from './errors.js';

const isPermanent = (err) => err instanceof CertificateError || err instanceof AuthError;

/**
 * @param {object} options
 * @param {{ webSocketUrl: string, dispatcher: object, webSocketHeaders: Function }} options.client
 *   the Frigate HTTP client (./httpClient.js)
 * @param {number} [options.minDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 */
export function createWsFeed({
  client,
  minDelayMs = 1_000,
  maxDelayMs = 60_000,
  WebSocketImpl = WebSocket,
}) {
  const feed = new EventEmitter();
  let socket = null;
  let timer = null;
  let stopped = false;
  let failures = 0;
  let status = { state: 'connecting', error: null };

  function setStatus(state, error = null) {
    if (status.state === state && status.error?.message === error?.message) {
      return;
    }
    status = { state, error };
    feed.emit('status', status);
  }

  function scheduleReconnect(error) {
    if (stopped) {
      return;
    }
    if (isPermanent(error)) {
      stopped = true;
      setStatus('failed', error);
      return;
    }
    setStatus('disconnected', error);
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** failures);
    failures += 1;
    timer = setTimeout(connect, delay);
    timer.unref?.();
  }

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (typeof message?.topic === 'string') {
      feed.emit('message', message.topic, message.payload);
    }
  }

  async function connect() {
    if (stopped) {
      return;
    }
    // While retrying, the status stays "disconnected" with its reason.
    if (status.state !== 'disconnected') {
      setStatus('connecting');
    }
    let headers;
    try {
      headers = await client.webSocketHeaders();
    } catch (err) {
      scheduleReconnect(err);
      return;
    }
    if (stopped) {
      return;
    }
    let opened = false;
    const ws = new WebSocketImpl(client.webSocketUrl, { dispatcher: client.dispatcher, headers });
    socket = ws;
    // Listeners first: the first frame can come in the same chunk as the
    // upgrade response.
    ws.addEventListener('message', onMessage);
    ws.addEventListener('open', () => {
      opened = true;
      failures = 0;
      ws.send(JSON.stringify({ topic: 'onConnect', payload: '' }));
      setStatus('connected');
    });
    ws.addEventListener('close', (event) => {
      if (socket === ws) {
        socket = null;
      }
      scheduleReconnect(
        new UnreachableError(opened ? 'CLOSED' : 'WEBSOCKET_REFUSED', {
          cause: new Error(`WebSocket closed (${event.code})`),
        }),
      );
    });
    // 'error' is always followed by 'close'.
    ws.addEventListener('error', () => {});
  }

  feed.mode = 'websocket';
  feed.endpoint = client.webSocketUrl;
  Object.defineProperty(feed, 'status', { get: () => status });

  /** Send `{ topic, payload }` (camera commands: admin role from 0.17). */
  feed.publish = async (topic, payload) => {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
      throw new UnreachableError('CLOSED');
    }
    socket.send(JSON.stringify({ topic, payload }));
  };

  feed.close = async () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
    socket = null;
  };

  connect();
  return feed;
}
