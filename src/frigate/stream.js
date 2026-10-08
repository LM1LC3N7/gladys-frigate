// -----------------------------------------------------------------------------
// Real-time feed from Frigate, through its WebSocket (`/ws`).
//
// Frigate relays on this socket every message it publishes on MQTT (events,
// reviews, motion, object counts, `<camera>/<setting>/state`…), and accepts
// the same `<camera>/<setting>/set` commands. Using it means the user needs no
// MQTT broker at all. Messages are JSON envelopes: `{ topic, payload }`.
//
// The stream reconnects on its own with an exponential backoff (1 s → 60 s),
// renews the Frigate session when the upgrade is refused with a 401, and
// detects half-open connections with a ping/pong heartbeat.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const HEARTBEAT_MS = 30_000;

export class FrigateStream extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./client.js').FrigateClient} options.client
   * @param {typeof WebSocket} [options.WebSocketImpl] injectable for tests
   * @param {{ debug: Function, info: Function, warn: Function, error: Function }} options.logger
   */
  constructor({ client, WebSocketImpl = WebSocket, logger }) {
    super();
    this.client = client;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.ws = null;
    this.stopped = true;
    this.connected = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  start() {
    this.stopped = false;
    this.#open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.terminate();
      this.ws = null;
    }
    this.#setConnected(false);
  }

  /**
   * Send a command to Frigate, e.g. send('front/detect/set', 'ON').
   * @param {string} topic
   * @param {string} payload
   */
  send(topic, payload) {
    if (!this.connected || !this.ws) {
      throw new Error('Frigate is not connected');
    }
    this.ws.send(JSON.stringify({ topic, payload }));
  }

  async #open() {
    if (this.stopped) {
      return;
    }
    try {
      await this.client.ensureSession();
    } catch (err) {
      this.logger.warn(`Frigate session could not be opened: ${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    if (this.stopped) {
      return;
    }

    let ws;
    try {
      ws = new this.WebSocketImpl(this.client.webSocketUrl, {
        headers: this.client.authHeaders(),
        handshakeTimeout: 10_000,
        ...this.client.tlsOptions,
      });
    } catch (err) {
      this.logger.error(`Frigate WebSocket could not be created: ${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    let alive = true;

    ws.on('open', () => {
      this.attempt = 0;
      alive = true;
      this.logger.info('Connected to the Frigate WebSocket');
      this.#setConnected(true);
      // Ask Frigate for a snapshot of every camera's state (detect, record,
      // snapshots, motion…): it answers with a `camera_activity` message.
      ws.send(JSON.stringify({ topic: 'onConnect', payload: '' }));
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (!alive) {
          this.logger.warn('Frigate WebSocket heartbeat lost, reconnecting');
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, HEARTBEAT_MS);
    });

    ws.on('pong', () => {
      alive = true;
    });

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        this.logger.debug('Ignoring a non-JSON Frigate WebSocket message');
        return;
      }
      if (message && typeof message.topic === 'string') {
        this.emit('message', message);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      this.logger.warn(`Frigate refused the WebSocket upgrade (HTTP ${res.statusCode})`);
      if (res.statusCode === 401) {
        // Expired or revoked session: force a new login on the next attempt.
        this.client.token = null;
      }
      ws.terminate();
    });

    ws.on('error', (err) => {
      this.logger.warn(`Frigate WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.ws === ws) {
        this.ws = null;
      }
      this.#setConnected(false);
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.logger.debug(`Reconnecting to Frigate in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #setConnected(connected) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.emit(connected ? 'connected' : 'disconnected');
    }
  }
}
