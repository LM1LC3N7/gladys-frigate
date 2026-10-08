import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  configWarnings,
  normalizeConfig,
  normalizeFingerprint,
  normalizePem,
  usesMqtt,
  validateConfig,
} from '../src/config.js';
import { describeConfig } from '../src/gladys/status.js';
import { TEST_CA_PEM } from './helpers/certificates.js';

const BASE = { frigate_url: 'https://192.168.1.10:8971', username: 'gladys', password: 'pw' };

test('normalizeConfig applies the defaults to an empty configuration', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULT_CONFIG });
});

test('normalizeConfig trims values and clamps numbers', () => {
  const config = normalizeConfig({
    frigate_url: '  https://frigate:8971/// ',
    mqtt_port: 99999,
    min_score: -5,
    trigger_cooldown: 'abc',
    mqtt_topic_prefix: '/frigate/',
  });
  assert.equal(config.frigate_url, 'https://frigate:8971');
  assert.equal(config.mqtt_port, 65535);
  assert.equal(config.min_score, 0);
  assert.equal(config.trigger_cooldown, 30);
  assert.equal(config.mqtt_topic_prefix, 'frigate');
});

test('booleans only accept a strict true', () => {
  const config = normalizeConfig({ mqtt_tls: 'true', zone_sensors: 1 });
  assert.equal(config.mqtt_tls, false);
  assert.equal(config.zone_sensors, false);
  assert.equal(normalizeConfig({ mqtt_tls: true }).mqtt_tls, true);
});

test('normalizePem re-wraps a certificate pasted on a single line', () => {
  const oneLine = TEST_CA_PEM.replace(/\n/g, ' ');
  const pem = normalizePem(oneLine);
  assert.equal(pem, TEST_CA_PEM.trim());
  assert.doesNotThrow(() => new X509Certificate(pem));
  assert.equal(normalizePem('garbage'), '');
});

test('normalizeFingerprint accepts the common notations', () => {
  const hex = 'ab'.repeat(32);
  const expected = Array(32).fill('AB').join(':');
  assert.equal(normalizeFingerprint(hex), expected);
  assert.equal(normalizeFingerprint(`SHA256 Fingerprint=${expected}`), expected);
  assert.equal(normalizeFingerprint(expected.toLowerCase()), expected);
  assert.equal(normalizeFingerprint(`sha256:${hex}`), expected);
  assert.equal(normalizeFingerprint(Array(32).fill('ab').join(' ')), expected);
  assert.equal(normalizeFingerprint('AB:CD'), '');
});

test('a typical authenticated configuration is valid', () => {
  assert.equal(validateConfig(normalizeConfig(BASE)), null);
});

test('the URL is required, http(s) only, without credentials or query', () => {
  for (const frigate_url of [
    '',
    'frigate.local',
    'ftp://frigate',
    'https://u:p@frigate:8971',
    'https://frigate:8971/?token=x',
  ]) {
    assert.ok(validateConfig(normalizeConfig({ ...BASE, frigate_url })), frigate_url);
  }
});

test('the Frigate username and password go together', () => {
  assert.match(validateConfig(normalizeConfig({ ...BASE, password: '' })).en, /both/);
});

test('the expert TLS fields are optional (trust on first use by default)', () => {
  const config = normalizeConfig(BASE);
  assert.equal(config.tls_fingerprint, '');
  assert.equal(config.tls_ca, '');
  assert.equal(validateConfig(config, BASE), null);
});

test('an expert CA must be a valid PEM certificate', () => {
  const check = (tls_ca) =>
    validateConfig(normalizeConfig({ ...BASE, tls_ca }), { ...BASE, tls_ca });
  assert.match(check('not a certificate').en, /not a valid/);
  assert.match(
    check('-----BEGIN CERTIFICATE-----bm90IGEgY2VydA==-----END CERTIFICATE-----').en,
    /not a valid/,
  );
  assert.equal(check(TEST_CA_PEM), null);
  assert.equal(check(TEST_CA_PEM.replace(/\n/g, ' ')), null, 'a single-line paste is accepted');
});

test('an expert fingerprint must be a SHA-256', () => {
  const check = (tls_fingerprint) =>
    validateConfig(normalizeConfig({ ...BASE, tls_fingerprint }), { ...BASE, tls_fingerprint });
  assert.match(check('AB:CD').en, /64/);
  assert.equal(check('ab'.repeat(32)), null);
});

test('the expert fingerprint and CA are mutually exclusive', () => {
  const raw = { ...BASE, tls_fingerprint: 'ab'.repeat(32), tls_ca: TEST_CA_PEM };
  assert.match(validateConfig(normalizeConfig(raw), raw).en, /not both/);
});

test('MQTT is optional: without a host, the WebSocket feed is used', () => {
  assert.equal(usesMqtt(normalizeConfig(BASE)), false);
  assert.equal(usesMqtt(normalizeConfig({ ...BASE, mqtt_host: 'broker' })), true);
});

test('the MQTT topic prefix refuses wildcards', () => {
  const error = validateConfig(
    normalizeConfig({ ...BASE, mqtt_host: 'broker', mqtt_topic_prefix: 'frigate/#' }),
  );
  assert.match(error.en, /wildcards/);
});

test('the unauthenticated port and clear-text passwords raise warnings', () => {
  assert.match(configWarnings(normalizeConfig({ frigate_url: 'http://f:5000' }))[0].en, /5000/);
  assert.match(
    configWarnings(normalizeConfig({ ...BASE, frigate_url: 'http://f:8971' }))[0].en,
    /unencrypted/,
  );
  assert.match(
    configWarnings(normalizeConfig({ ...BASE, mqtt_host: 'b', mqtt_password: 'x' }))[0].en,
    /MQTT/,
  );
  assert.deepEqual(configWarnings(normalizeConfig(BASE)), []);
});

test('describeConfig reports the error first, then the warnings', () => {
  assert.equal(describeConfig(normalizeConfig({})).valid, false);
  const insecure = describeConfig(normalizeConfig({ frigate_url: 'http://f:5000' }));
  assert.equal(insecure.valid, true);
  assert.match(insecure.message.fr, /5000/);
  assert.deepEqual(describeConfig(normalizeConfig(BASE)), { valid: true, message: undefined });
});

test('no secret ends up in a status message', () => {
  const raw = { ...BASE, password: 'S3cr3t!', mqtt_host: 'b', mqtt_password: 'MqttS3cr3t' };
  const { message } = describeConfig(normalizeConfig({ ...raw, frigate_url: 'http://f:8971' }));
  for (const text of Object.values(message)) {
    assert.ok(!text.includes('S3cr3t'), 'passwords never appear in messages');
  }
});

test('the CA fixture is a certificate authority', () => {
  assert.equal(new X509Certificate(TEST_CA_PEM).ca, true);
});
