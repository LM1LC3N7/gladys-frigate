// Test-only Gladys: the host API (/api/integration/v1) and the integration
// WebSocket, enough to run the real index.js against it.

import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * @param {object} options
 * @param {object} options.config the integration configuration
 * @param {object[]} [options.devices] devices created by the user
 */
export async function startFakeGladys({ config, devices = [] }) {
  const received = []; // { method, path, body }
  const results = new Map(); // message_id -> command-result payload
  let socket = null;
  let nextId = 1;
  const state = { devices };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const path = req.url.replace('/api/integration/v1', '');
      received.push({ method: req.method, path, body: body ? JSON.parse(body) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer test-token') {
        res.statusCode = 401;
        res.end('{}');
      } else if (req.method === 'GET' && path === '/device') {
        res.end(JSON.stringify(state.devices));
      } else if (req.method === 'GET' && path === '/config') {
        res.end(JSON.stringify({ config }));
      } else {
        res.end('{"success":true}');
      }
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const { type, payload } = JSON.parse(String(data));
      if (type === 'authenticate.integration-request' && payload.token === 'test-token') {
        ws.send(JSON.stringify({ type: 'authentication.connected', payload: {} }));
      } else if (type === 'external-integration.command-result') {
        results.set(payload.message_id, payload);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    /** The requests to a host API path (e.g. "/state"). */
    posts: (path) => received.filter((r) => r.method === 'POST' && r.path === path),
    set devices(list) {
      state.devices = list;
    },
    /** An event without answer (scan request, device created…). */
    send(type, payload = {}) {
      socket.send(JSON.stringify({ type: `external-integration.${type}`, payload }));
    },
    /** A command, resolved with its command-result. */
    async command(type, payload = {}, timeoutMs = 8000) {
      const messageId = `m${nextId++}`;
      socket.send(
        JSON.stringify({
          type: `external-integration.${type}`,
          payload: { ...payload, message_id: messageId },
        }),
      );
      const deadline = Date.now() + timeoutMs;
      while (!results.has(messageId)) {
        if (Date.now() > deadline) throw new Error(`No result for ${type}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return results.get(messageId);
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
