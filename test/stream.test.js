// Exercises the WebSocket stream against a real local `ws` server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { FrigateClient } from '../src/frigate/client.js';
import { FrigateStream } from '../src/frigate/stream.js';
import { silentLogger } from './helpers/fakes.js';

async function startServer() {
  const server = new WebSocketServer({ port: 0, path: '/ws' });
  await once(server, 'listening');
  return server;
}

test('the stream relays messages, sends commands and requests the initial state', async (t) => {
  const server = await startServer();
  const client = new FrigateClient({ url: `http://127.0.0.1:${server.address().port}` });
  const stream = new FrigateStream({ client, logger: silentLogger });
  t.after(() => {
    stream.stop();
    server.close();
  });

  const received = [];
  server.on('connection', (socket) => {
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    socket.send(JSON.stringify({ topic: 'front_door/motion', payload: 'ON' }));
    socket.send('not json');
  });

  // Listen before starting: the first frame can arrive in the same chunk as
  // the upgrade response, i.e. synchronously right after 'connected'.
  const firstMessage = once(stream, 'message');
  stream.start();
  await once(stream, 'connected');
  const [message] = await firstMessage;
  assert.deepEqual(message, { topic: 'front_door/motion', payload: 'ON' });

  stream.send('front_door/detect/set', 'OFF');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, [
    { topic: 'onConnect', payload: '' },
    { topic: 'front_door/detect/set', payload: 'OFF' },
  ]);
});

test('the stream reconnects after the server drops the connection', async (t) => {
  const server = await startServer();
  const client = new FrigateClient({ url: `http://127.0.0.1:${server.address().port}` });
  const stream = new FrigateStream({ client, logger: silentLogger });
  t.after(() => {
    stream.stop();
    server.close();
  });

  let connections = 0;
  server.on('connection', (socket) => {
    connections += 1;
    if (connections === 1) socket.terminate();
  });

  const firstDrop = once(stream, 'disconnected');
  stream.start();
  await firstDrop;
  await once(stream, 'connected');
  assert.equal(connections, 2);
  assert.equal(stream.connected, true);
});

test('sending while disconnected throws', () => {
  const stream = new FrigateStream({
    client: new FrigateClient({ url: 'http://127.0.0.1:1' }),
    logger: silentLogger,
  });
  assert.throws(() => stream.send('a/detect/set', 'ON'), /not connected/);
});
