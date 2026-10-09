import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeMqtt } from '../src/frigate/mqttProbe.js';
import { CertificateError, MqttRefusedError, UnreachableError } from '../src/frigate/errors.js';
import { TRUST_REASONS, TrustStore, endpointKey } from '../src/frigate/tlsTrust.js';
import { startFakeBroker } from './helpers/fakeFrigate.js';

async function store(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-mqtt-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return new TrustStore({ filePath: join(dir, 'tls-trust.json') }).load();
}

const probe = (port, trustStore, options = {}) =>
  probeMqtt({
    host: '127.0.0.1',
    port,
    username: 'gladys',
    password: 'S3cret',
    trustStore,
    timeoutMs: 2000,
    ...options,
  });

test('a broker that accepts the account answers the check', async (t) => {
  const broker = await startFakeBroker();
  t.after(() => broker.close());
  const result = await probe(broker.port, await store(t));
  assert.equal(result.tlsDecision, null);
  assert.equal(broker.stats.connects, 1);
});

test('refused credentials and authorization are told apart', async (t) => {
  const badPassword = await startFakeBroker({ returnCode: 4 });
  t.after(() => badPassword.close());
  await assert.rejects(
    probe(badPassword.port, await store(t)),
    (err) => err instanceof MqttRefusedError && err.code === 'invalid_credentials',
  );
  const notAuthorized = await startFakeBroker({ returnCode: 5 });
  t.after(() => notAuthorized.close());
  await assert.rejects(
    probe(notAuthorized.port, await store(t)),
    (err) => err instanceof MqttRefusedError && err.code === 'not_authorized',
  );
});

test('an unreachable broker is reported as such', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    probe(port, await store(t)),
    (err) => err instanceof UnreachableError && err.code === 'ECONNREFUSED',
  );
});

test('TLS: the broker certificate is trusted on first use, then pinned', async (t) => {
  const broker = await startFakeBroker({ secure: true });
  t.after(() => broker.close());
  const trustStore = await store(t);
  const first = await probe(broker.port, trustStore, { tls: true });
  assert.equal(first.tlsDecision.reason, TRUST_REASONS.FIRST_USE);
  const second = await probe(broker.port, trustStore, { tls: true });
  assert.equal(second.tlsDecision.reason, TRUST_REASONS.PINNED);
});

test('TLS: a changed broker certificate never receives the CONNECT (nor its password)', async (t) => {
  const broker = await startFakeBroker({ secure: true });
  t.after(() => broker.close());
  const trustStore = await store(t);
  await trustStore.set(endpointKey('127.0.0.1', broker.port), Array(32).fill('AA').join(':'));
  await assert.rejects(
    probe(broker.port, trustStore, { tls: true }),
    (err) => err instanceof CertificateError && err.reason === TRUST_REASONS.CERTIFICATE_CHANGED,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(broker.stats.received, 0, 'not a single application byte reached the broker');
});
