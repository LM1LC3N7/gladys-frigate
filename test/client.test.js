import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrigateClient, FrigateAuthError, extractCookieValue } from '../src/frigate/client.js';
import {
  isSupportedVersion,
  parseVersion,
  UnsupportedFrigateVersionError,
} from '../src/frigate/version.js';

/** Scripted fake of httpRequest: answers each call with the next response. */
function scriptedRequest(responses) {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return { headers: {}, body: Buffer.alloc(0), ...next };
  };
  return { request, calls };
}

test('parseVersion and isSupportedVersion gate on Frigate 0.18', () => {
  assert.deepEqual(parseVersion('0.18.0-1a2b3c4'), [0, 18, 0]);
  assert.equal(parseVersion('dev'), null);
  assert.equal(isSupportedVersion('0.18.0-1a2b3c4'), true);
  assert.equal(isSupportedVersion('0.18.2'), true);
  assert.equal(isSupportedVersion('0.19.0-beta1'), true);
  assert.equal(isSupportedVersion('1.0.0'), true);
  assert.equal(isSupportedVersion('0.17.2'), false);
  assert.equal(isSupportedVersion('garbage'), false);
});

test('extractCookieValue reads the JWT from the set-cookie header', () => {
  assert.equal(extractCookieValue(['frigate_token=abc.def.ghi; Path=/; HttpOnly']), 'abc.def.ghi');
  assert.equal(extractCookieValue('frigate_token=xyz'), 'xyz');
  assert.equal(extractCookieValue(undefined), null);
  assert.equal(extractCookieValue(['frigate_token=; Path=/']), null);
});

test('without credentials, requests are sent without login', async () => {
  const { request, calls } = scriptedRequest([{ status: 200, body: Buffer.from('0.18.0-abc') }]);
  const client = new FrigateClient({ url: 'http://frigate:5000/', request });
  assert.equal(await client.getVersion(), '0.18.0-abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://frigate:5000/api/version');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('with credentials, the client logs in and sends the token as a bearer', async () => {
  const { request, calls } = scriptedRequest([
    { status: 200, headers: { 'set-cookie': ['frigate_token=tok1; Path=/'] } },
    { status: 200, body: Buffer.from('{"cameras":{}}') },
  ]);
  const client = new FrigateClient({
    url: 'https://frigate:8971',
    username: 'admin',
    password: 'secret',
    allowSelfSigned: true,
    request,
  });
  assert.deepEqual(await client.getConfig(), { cameras: {} });
  assert.equal(calls[0].url, 'https://frigate:8971/api/login');
  assert.deepEqual(JSON.parse(calls[0].body), { user: 'admin', password: 'secret' });
  assert.equal(calls[0].rejectUnauthorized, false);
  assert.equal(calls[1].headers.authorization, 'Bearer tok1');
});

test('an expired session is renewed once on a 401', async () => {
  const { request, calls } = scriptedRequest([
    { status: 200, headers: { 'set-cookie': ['frigate_token=old'] } },
    { status: 401 },
    { status: 200, headers: { 'set-cookie': ['frigate_token=new'] } },
    { status: 200, body: Buffer.from('{}') },
  ]);
  const client = new FrigateClient({
    url: 'https://f:8971',
    username: 'u',
    password: 'p',
    request,
  });
  await client.getConfig();
  assert.equal(calls[3].headers.authorization, 'Bearer new');
});

test('wrong credentials raise a FrigateAuthError', async () => {
  const { request } = scriptedRequest([{ status: 401 }]);
  const client = new FrigateClient({
    url: 'https://f:8971',
    username: 'u',
    password: 'bad',
    request,
  });
  await assert.rejects(client.getConfig(), FrigateAuthError);
});

test('a 401 without credentials explains that authentication is needed', async () => {
  const { request } = scriptedRequest([{ status: 401 }]);
  const client = new FrigateClient({ url: 'https://f:8971', request });
  await assert.rejects(client.getConfig(), /requires authentication/);
});

test('a Frigate with authentication disabled answers the login with a 404', async () => {
  const { request, calls } = scriptedRequest([
    { status: 404 },
    { status: 200, body: Buffer.from('{}') },
  ]);
  const client = new FrigateClient({ url: 'http://f:5000', username: 'u', password: 'p', request });
  await client.getConfig();
  assert.equal(calls[1].headers.authorization, undefined);
});

test('checkVersion refuses Frigate older than 0.18', async () => {
  const { request } = scriptedRequest([{ status: 200, body: Buffer.from('0.17.2-abc') }]);
  const client = new FrigateClient({ url: 'http://f:5000', request });
  await assert.rejects(client.checkVersion(), UnsupportedFrigateVersionError);
});

test('getLatestJpeg encodes the camera name and the size parameters', async () => {
  const jpeg = Buffer.from([0xff, 0xd8]);
  const { request, calls } = scriptedRequest([{ status: 200, body: jpeg }]);
  const client = new FrigateClient({ url: 'http://f:5000', request });
  assert.equal(await client.getLatestJpeg('front door', { height: 480, quality: 70 }), jpeg);
  assert.equal(calls[0].url, 'http://f:5000/api/front%20door/latest.jpg?height=480&quality=70');
});

test('HTTP errors are reported with their status', async () => {
  const { request } = scriptedRequest([{ status: 500 }]);
  const client = new FrigateClient({ url: 'http://f:5000', request });
  await assert.rejects(client.getConfig(), (err) => err.status === 500);
});

test('webSocketUrl follows the scheme of the base URL', () => {
  assert.equal(new FrigateClient({ url: 'http://f:5000' }).webSocketUrl, 'ws://f:5000/ws');
  assert.equal(new FrigateClient({ url: 'https://f:8971' }).webSocketUrl, 'wss://f:8971/ws');
});
