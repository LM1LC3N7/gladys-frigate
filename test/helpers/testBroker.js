// Test-only MQTT 3.1.1 broker: CONNECT (with an optional account), SUBSCRIBE
// (with + and #, and an optional read deny list), PUBLISH (QoS 0, retained
// messages), PINGREQ. Enough to exercise the real mqtt.js client.

import net from 'node:net';
import tls from 'node:tls';
import mqttPacket from 'mqtt-packet';
import { TEST_SERVER_CERT_PEM, TEST_SERVER_KEY_PEM } from './certificates.js';

export function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.secure]
 * @param {{ username: string, password: string } | null} [options.account]
 * @param {(filter: string) => boolean} [options.denySubscribe] true = refused (0x80)
 */
export async function startTestBroker({ secure = false, account = null, denySubscribe } = {}) {
  const clients = new Set();
  const retained = new Map();
  const published = []; // from clients: { topic, payload }
  const stats = { connects: 0, subscribes: [] };

  function send(client, packet) {
    if (!client.socket.destroyed) client.socket.write(mqttPacket.generate(packet));
  }

  function deliver(topic, payload) {
    for (const client of clients) {
      if (client.filters.some((filter) => topicMatches(filter, topic))) {
        send(client, { cmd: 'publish', topic, payload, qos: 0, retain: false });
      }
    }
  }

  const onSocket = (socket) => {
    const client = { socket, filters: [] };
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('packet', (packet) => {
      switch (packet.cmd) {
        case 'connect': {
          stats.connects += 1;
          const ok =
            !account ||
            (packet.username === account.username &&
              String(packet.password ?? '') === account.password);
          send(client, { cmd: 'connack', returnCode: ok ? 0 : 4, sessionPresent: false });
          if (ok) clients.add(client);
          else socket.end();
          break;
        }
        case 'subscribe': {
          const granted = packet.subscriptions.map(({ topic }) => {
            stats.subscribes.push(topic);
            if (denySubscribe?.(topic)) return 0x80;
            client.filters.push(topic);
            return 0;
          });
          send(client, { cmd: 'suback', messageId: packet.messageId, granted });
          for (const [topic, payload] of retained) {
            if (
              packet.subscriptions.some(
                (s) => !denySubscribe?.(s.topic) && topicMatches(s.topic, topic),
              )
            ) {
              send(client, { cmd: 'publish', topic, payload, qos: 0, retain: true });
            }
          }
          break;
        }
        case 'publish':
          published.push({ topic: packet.topic, payload: packet.payload.toString() });
          break;
        case 'pingreq':
          send(client, { cmd: 'pingresp' });
          break;
        case 'disconnect':
          socket.end();
          break;
        default:
      }
    });
    socket.on('data', (chunk) => parser.parse(chunk));
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => {});
  };

  const server = secure
    ? tls.createServer({ key: TEST_SERVER_KEY_PEM, cert: TEST_SERVER_CERT_PEM }, onSocket)
    : net.createServer(onSocket);
  server.on('tlsClientError', () => {});
  const sockets = new Set();
  server.on(secure ? 'secureConnection' : 'connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    stats,
    published,
    /** Publish as Frigate would (retain keeps it for later subscribers). */
    publish(topic, payload, { retain = false } = {}) {
      const buffer = Buffer.from(payload);
      if (retain) retained.set(topic, buffer);
      deliver(topic, buffer);
    },
    /** Cut every client connection (the clients reconnect). */
    dropClients() {
      for (const socket of sockets) socket.destroy();
    },
    get clientCount() {
      return clients.size;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}
