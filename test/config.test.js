import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, validateConfig } from '../src/config.js';

test('normalizeConfig applies the defaults to an empty configuration', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig trims the URL and drops trailing slashes', () => {
  const config = normalizeConfig({ frigate_url: '  http://frigate.local:5000/// ' });
  assert.equal(config.frigate_url, 'http://frigate.local:5000');
});

test('normalizeConfig clamps the snapshot settings', () => {
  assert.equal(normalizeConfig({ snapshot_interval: 1 }).snapshot_interval, 5);
  assert.equal(normalizeConfig({ snapshot_interval: 99999 }).snapshot_interval, 3600);
  assert.equal(normalizeConfig({ snapshot_interval: 0 }).snapshot_interval, 0);
  assert.equal(normalizeConfig({ snapshot_interval: 'abc' }).snapshot_interval, 60);
  assert.equal(normalizeConfig({ snapshot_height: 10 }).snapshot_height, 120);
  assert.equal(normalizeConfig({ snapshot_height: 5000 }).snapshot_height, 1080);
});

test('normalizeConfig only accepts a strict true for the self-signed opt-in', () => {
  assert.equal(normalizeConfig({ allow_self_signed: 'true' }).allow_self_signed, false);
  assert.equal(normalizeConfig({ allow_self_signed: true }).allow_self_signed, true);
});

test('validateConfig accepts the internal and the authenticated ports', () => {
  assert.equal(validateConfig(normalizeConfig({ frigate_url: 'http://192.168.1.10:5000' })), null);
  assert.equal(
    validateConfig(
      normalizeConfig({
        frigate_url: 'https://192.168.1.10:8971',
        username: 'admin',
        password: 'x',
      }),
    ),
    null,
  );
});

test('validateConfig rejects a missing or malformed URL', () => {
  for (const frigate_url of ['', 'frigate.local', 'ftp://frigate.local', 'http://']) {
    const error = validateConfig(normalizeConfig({ frigate_url }));
    assert.ok(error?.en && error?.fr, `"${frigate_url}" must be rejected`);
  }
});

test('validateConfig rejects credentials embedded in the URL', () => {
  const error = validateConfig(
    normalizeConfig({ frigate_url: 'http://admin:secret@frigate:5000' }),
  );
  assert.match(error.en, /credentials/);
});

test('validateConfig requires the username and the password together', () => {
  const error = validateConfig(
    normalizeConfig({ frigate_url: 'https://frigate:8971', username: 'admin' }),
  );
  assert.match(error.en, /both/);
});
