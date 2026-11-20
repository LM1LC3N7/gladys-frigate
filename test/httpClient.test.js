import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrigateClient, firstCookieValue, jwtExpiry } from '../src/frigate/httpClient.js';
import {
  AuthError,
  CertificateError,
  FrigateError,
  HttpStatusError,
  LoginMissingError,
  UnreachableError,
} from '../src/frigate/errors.js';
import { TRUST_REASONS, TrustStore, endpointKey } from '../src/frigate/tlsTrust.js';
import { TEST_CA_PEM, TEST_SERVER_CERT_PEM } from './helpers/certificates.js';
import { FRIGATE_CONFIG, fakeJwt, startFakeFrigate } from './helpers/fakeFrigate.js';

const SERVER_FINGERPRINT = new X509Certificate(TEST_SERVER_CERT_PEM).fingerprint256;
const OTHER_FINGERPRINT = Array(32).fill('AA').join(':');

/** A trust store in its own temporary directory, removed after the test. */
async function memoryStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-http-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return new TrustStore({ filePath: join(dir, 'tls-trust.json') }).load();
}

/** A local port nothing listens on (port 1 is a "bad port" for fetch). */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function client(frigate, options = {}) {
  return createFrigateClient({
    url: frigate.url,
    username: 'gladys',
    password: 'pw',
    retryDelayMs: 1,
    ...options,
  });
}

test('jwtExpiry and firstCookieValue read what Frigate sends', () => {
  assert.equal(jwtExpiry(fakeJwt(1000)), 1_000_000);
  assert.equal(jwtExpiry('not-a-jwt'), null);
  assert.equal(firstCookieValue(['frigate_token=abc; Path=/; HttpOnly', 'other=x']), 'abc');
  assert.equal(firstCookieValue([]), null);
});

test('first use: a self-signed certificate is trusted, pinned, then required', async (t) => {
  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const trustStore = await memoryStore(t);

  const first = client(frigate, { trustStore });
  t.after(() => first.close());
  assert.equal(await first.getVersion(), '0.17.2-abcdef');
  assert.equal(first.tlsDecision.reason, TRUST_REASONS.FIRST_USE);
  assert.equal(trustStore.get(endpointKey('127.0.0.1', frigate.port)), SERVER_FINGERPRINT);

  const second = client(frigate, { trustStore });
  t.after(() => second.close());
  await second.getVersion();
  assert.equal(second.tlsDecision.reason, TRUST_REASONS.PINNED);
});

test('a changed certificate is refused before the request (and its token) is sent', async (t) => {
  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const trustStore = await memoryStore(t);
  await trustStore.set(endpointKey('127.0.0.1', frigate.port), OTHER_FINGERPRINT);

  const frigateClient = client(frigate, { trustStore });
  t.after(() => frigateClient.close());
  await assert.rejects(
    frigateClient.getConfig(),
    (err) =>
      err instanceof CertificateError &&
      err.reason === TRUST_REASONS.CERTIFICATE_CHANGED &&
      err.fingerprint === SERVER_FINGERPRINT,
  );
  assert.equal(frigate.calls.length, 0, 'not a single request reached the server');

  // "Trust the new certificate": the next connection pins the new one.
  await trustStore.reset();
  const renewed = client(frigate, { trustStore });
  t.after(() => renewed.close());
  await renewed.getConfig();
  assert.equal(renewed.tlsDecision.reason, TRUST_REASONS.FIRST_USE);
});

test('expert settings: a CA-verified certificate is not pinned; a manual pin must match', async (t) => {
  const frigate = await startFakeFrigate({ secure: true });
  t.after(() => frigate.close());
  const trustStore = await memoryStore(t);

  const viaCa = createFrigateClient({
    url: `https://localhost:${frigate.port}`,
    username: 'gladys',
    password: 'pw',
    trustStore,
    tlsCa: TEST_CA_PEM,
  });
  t.after(() => viaCa.close());
  await viaCa.getConfig();
  assert.equal(viaCa.tlsDecision.reason, TRUST_REASONS.CA_VERIFIED);
  assert.deepEqual(trustStore.list(), [], 'nothing pinned');

  const pinned = client(frigate, { trustStore, tlsFingerprint: SERVER_FINGERPRINT });
  t.after(() => pinned.close());
  await pinned.getVersion();
  assert.equal(pinned.tlsDecision.reason, TRUST_REASONS.MANUAL_PIN);

  const wrong = client(frigate, { trustStore, tlsFingerprint: OTHER_FINGERPRINT, retries: 0 });
  t.after(() => wrong.close());
  await assert.rejects(wrong.getVersion(), CertificateError);
});

test('auth: a 401 triggers one login, then the Bearer token is used', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());

  const config = await frigateClient.getConfig();
  assert.ok(config.cameras.front);
  assert.equal(frigateClient.authMode, 'token');
  await frigateClient.getConfig();
  const logins = frigate.calls.filter((call) => call.url === '/api/login');
  assert.equal(logins.length, 1, 'the token is reused');
  assert.match(frigate.calls.at(-1).authorization, /^Bearer /);
});

test('auth: wrong credentials fail once, without retrying the login', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const frigateClient = client(frigate, { password: 'wrong' });
  t.after(() => frigateClient.close());
  await assert.rejects(
    frigateClient.getConfig(),
    (err) => err instanceof AuthError && err.code === 'invalid_credentials',
  );
  assert.equal(frigate.calls.filter((call) => call.url === '/api/login').length, 1);
});

test('auth: no credentials on an authenticated port, or a port without auth', async (t) => {
  const secured = await startFakeFrigate();
  t.after(() => secured.close());
  const anonymous = client(secured, { username: '', password: '' });
  t.after(() => anonymous.close());
  await assert.rejects(
    anonymous.getConfig(),
    (err) => err instanceof AuthError && err.code === 'credentials_required',
  );
  assert.equal(secured.calls.filter((call) => call.url === '/api/login').length, 0);

  const open = await startFakeFrigate({ account: null });
  t.after(() => open.close());
  const openClient = client(open);
  t.after(() => openClient.close());
  await openClient.getConfig();
  assert.equal(openClient.authMode, 'none');
});

test('auth: the token is renewed 5 minutes before it expires', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  let clock = Date.now();
  const frigateClient = client(frigate, { now: () => clock });
  t.after(() => frigateClient.close());
  frigate.setTokenExp(Math.floor(clock / 1000) + 600);
  await frigateClient.getConfig();
  clock += 6 * 60 * 1000; // 4 minutes left
  await frigateClient.getConfig();
  assert.equal(frigate.calls.filter((call) => call.url === '/api/login').length, 2);
});

/** A fake Frigate whose behaviour follows `phase.value` (see each test). */
function phased(phase, handlers) {
  return (req, res) => {
    const handle = handlers[phase.value];
    return handle ? handle(req, res) : false;
  };
}

const answer = (res, status, body = '') => {
  res.statusCode = status;
  res.end(body);
  return true;
};

test('auth: a login 404 while Frigate starts is a temporary failure, not "auth disabled"', async (t) => {
  const phase = { value: 'starting' };
  const frigate = await startFakeFrigate({
    override: phased(phase, {
      // Starting: no login route yet, the API still wants a token.
      starting: (req, res) =>
        req.url === '/api/login'
          ? answer(res, 404)
          : answer(res, 401, '{"message":"unauthorized"}'),
    }),
  });
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      frigateClient.getConfig(),
      (err) => err instanceof LoginMissingError && err.status === 404 && err.path === '/api/login',
    );
    assert.notEqual(frigateClient.authMode, 'disabled');
  }
  phase.value = 'up';
  const config = await frigateClient.getConfig();
  assert.ok(config.cameras.front);
  assert.equal(frigateClient.authMode, 'token', 'logged in once Frigate is up');
});

test('auth: "disabled" only on an answer without token; a later 401 logs in again', async (t) => {
  const phase = { value: 'busy' };
  let first401 = true;
  let busyRequests = 0;
  const frigate = await startFakeFrigate({
    override: phased(phase, {
      // Login 404 and the request without token fails (503): no conclusion.
      busy: (req, res) => {
        if (req.url === '/api/login') return answer(res, 404);
        busyRequests += 1;
        return answer(res, busyRequests === 1 ? 401 : 503);
      },
      // Authentication disabled: login 404, every request answered.
      disabled: (req, res) => {
        if (req.url === '/api/login') return answer(res, 404);
        if (first401) {
          first401 = false;
          return answer(res, 401);
        }
        res.setHeader('content-type', 'application/json');
        return answer(res, 200, JSON.stringify(FRIGATE_CONFIG));
      },
      // 'auth': the fake's own authentication (account gladys / pw).
    }),
  });
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());

  // First request 401, then 503 without a token: not "disabled".
  await assert.rejects(
    frigateClient.getConfig(),
    (err) => err instanceof HttpStatusError && err.status === 503,
  );
  assert.notEqual(frigateClient.authMode, 'disabled');

  phase.value = 'disabled';
  await frigateClient.getConfig();
  assert.equal(frigateClient.authMode, 'disabled', 'answered without a token');
  const unauthenticated = frigate.calls.at(-1);
  assert.equal(unauthenticated.authorization, undefined);

  phase.value = 'auth';
  const config = await frigateClient.getConfig();
  assert.ok(config.cameras.front);
  assert.equal(frigateClient.authMode, 'token', 'a 401 after "disabled" logs in again');
});

test('auth: a renewal answered 404 keeps the token, without a login per request', async (t) => {
  const phase = { value: 'up' };
  const frigate = await startFakeFrigate({
    override: phased(phase, {
      noLogin: (req, res) => (req.url === '/api/login' ? answer(res, 404) : false),
    }),
  });
  t.after(() => frigate.close());
  let clock = Date.now();
  const frigateClient = client(frigate, { now: () => clock });
  t.after(() => frigateClient.close());
  frigate.setTokenExp(Math.floor(clock / 1000) + 600);
  await frigateClient.getConfig();
  clock += 6 * 60 * 1000; // 4 minutes left: renewal due
  phase.value = 'noLogin';
  for (let i = 0; i < 3; i += 1) await frigateClient.getConfig();
  assert.equal(frigate.calls.filter((call) => call.url === '/api/login').length, 2);
  assert.equal(frigateClient.authMode, 'token');
  assert.match(frigate.calls.at(-1).authorization, /^Bearer /);
});

test('GET is retried on 5xx, never on 4xx; redirects are not followed', async (t) => {
  let failures = 2;
  const frigate = await startFakeFrigate({
    account: null,
    override: (req, res) => {
      if (req.url === '/api/stats' && failures > 0) {
        failures -= 1;
        res.statusCode = 503;
        res.end();
        return true;
      }
      if (req.url === '/api/redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://evil.example/');
        res.end();
        return true;
      }
      return false;
    },
  });
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());

  await assert.rejects(frigateClient.getStats(), (err) => err instanceof FrigateError);
  // /api/stats is unknown to the fake once the failures are spent: 404.
  assert.equal(frigate.calls.filter((call) => call.url === '/api/stats').length, 3);

  await assert.rejects(
    frigateClient.request('/api/nothing'),
    (err) => err instanceof HttpStatusError && err.status === 404,
  );
  assert.equal(frigate.calls.filter((call) => call.url === '/api/nothing').length, 1);

  await assert.rejects(
    frigateClient.request('/api/redirect'),
    (err) => err instanceof HttpStatusError && err.status === 302,
  );
});

test('timeouts, unreachable hosts and oversized answers are typed errors', async (t) => {
  const frigate = await startFakeFrigate({
    account: null,
    override: (req, res) => {
      if (req.url === '/api/slow') {
        return true; // never answers
      }
      if (req.url === '/api/big') {
        res.end(Buffer.alloc(2048));
        return true;
      }
      return false;
    },
  });
  t.after(() => frigate.close());
  const frigateClient = client(frigate, { timeoutMs: 200, retries: 0 });
  t.after(() => frigateClient.close());

  await assert.rejects(
    frigateClient.request('/api/slow'),
    (err) => err instanceof UnreachableError && err.code === 'TIMEOUT',
  );
  await assert.rejects(frigateClient.request('/api/big', { maxBytes: 1024 }), FrigateError);

  const closed = createFrigateClient({
    url: `http://127.0.0.1:${await closedPort()}`,
    retries: 0,
  });
  t.after(() => closed.close());
  await assert.rejects(
    closed.getVersion(),
    (err) => err instanceof UnreachableError && err.code === 'ECONNREFUSED',
  );
});

test('latest.jpg: the camera name is encoded, height and quality passed to Frigate', async (t) => {
  const asked = [];
  const frigate = await startFakeFrigate({
    imageBytes: (query) => {
      asked.push(query);
      return 1234;
    },
  });
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());
  const jpeg = await frigateClient.getLatestJpeg('front', { height: 540, quality: 50 });
  assert.equal(jpeg.length, 1234);
  assert.deepEqual(asked, [{ camera: 'front', height: 540, quality: 50 }]);
  await assert.rejects(frigateClient.getLatestJpeg('../config'), HttpStatusError);
  assert.ok(frigate.calls.some((call) => call.url.startsWith('/api/..%2Fconfig/latest.jpg')));
});

test('auth: concurrent requests hitting a 401 share one login', async (t) => {
  const frigate = await startFakeFrigate();
  t.after(() => frigate.close());
  const frigateClient = client(frigate);
  t.after(() => frigateClient.close());
  await Promise.all([
    frigateClient.getConfig(),
    frigateClient.getLatestJpeg('front'),
    frigateClient.getLatestJpeg('garage'),
  ]);
  assert.equal(frigate.calls.filter((call) => call.url === '/api/login').length, 1);
});
