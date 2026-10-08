// Test-only fake Frigate API (http or https) and fake MQTT broker.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { TEST_SERVER_CERT_PEM, TEST_SERVER_KEY_PEM } from './certificates.js';

/** A JWT with the given `exp` (seconds); the signature is never checked. */
export function fakeJwt(exp) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ sub: 'gladys', role: 'viewer', exp })}.sig`;
}

export const FRIGATE_CONFIG = {
  mqtt: { enabled: true, host: 'broker', topic_prefix: 'frigate' },
  cameras: {
    garage: { enabled: true, detect: { enabled: true }, objects: { track: ['car'] } },
    front: {
      enabled: true,
      friendly_name: 'Front door',
      detect: { enabled: true },
      record: { enabled: true },
      snapshots: { enabled: true },
      objects: { track: ['person'] },
      zones: { porch: { objects: ['person'] } },
    },
  },
};

/**
 * @param {object} [options]
 * @param {boolean} [options.secure] https with the test certificate
 * @param {{ user: string, password: string } | null} [options.account] null = no auth
 * @param {string} [options.version]
 * @param {(req, res) => boolean} [options.override] return true when handled
 */
export async function startFakeFrigate({
  secure = false,
  account = { user: 'gladys', password: 'pw' },
  version = '0.17.2-abcdef',
  override,
} = {}) {
  const calls = [];
  let tokenExp = Math.floor(Date.now() / 1000) + 3600;
  const tokens = new Set();

  const handler = (req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (override?.(req, res)) {
      return;
    }
    if (req.url === '/api/version') {
      res.end(version);
      return;
    }
    if (req.url === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { user, password } = JSON.parse(body || '{}');
        if (!account || user !== account.user || password !== account.password) {
          res.statusCode = 401;
          res.end('{"message":"Login failed"}');
          return;
        }
        const token = fakeJwt(tokenExp);
        tokens.add(token);
        res.setHeader('set-cookie', `frigate_token=${token}; Path=/; HttpOnly`);
        res.end();
      });
      return;
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (account && !tokens.has(bearer)) {
      res.statusCode = 401;
      res.end('{"message":"unauthorized"}');
      return;
    }
    if (req.url === '/api/config') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(FRIGATE_CONFIG));
      return;
    }
    res.statusCode = 404;
    res.end();
  };

  const server = secure
    ? https.createServer({ key: TEST_SERVER_KEY_PEM, cert: TEST_SERVER_CERT_PEM }, handler)
    : http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    calls,
    setTokenExp(exp) {
      tokenExp = exp;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/**
 * Minimal MQTT broker: answers the first CONNECT with a CONNACK carrying
 * `returnCode` (0 = accepted, 4 = bad credentials, 5 = not authorized).
 * `received` counts the bytes the broker got from clients.
 */
export async function startFakeBroker({ secure = false, returnCode = 0 } = {}) {
  const stats = { received: 0, connects: 0 };
  const onSocket = (socket) => {
    socket.on('data', (chunk) => {
      stats.received += chunk.length;
      if (chunk[0] >> 4 === 1) {
        stats.connects += 1;
        socket.write(Buffer.from([0x20, 0x02, 0x00, returnCode]));
      }
    });
    socket.on('error', () => {});
  };
  const server = secure
    ? tls.createServer({ key: TEST_SERVER_KEY_PEM, cert: TEST_SERVER_CERT_PEM }, onSocket)
    : net.createServer(onSocket);
  server.on('tlsClientError', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    port: server.address().port,
    stats,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}
