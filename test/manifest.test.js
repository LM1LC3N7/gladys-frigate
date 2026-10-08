// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The store indexer validates the manifest itself; these tests keep it in
// sync with what the code actually does.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_TRIGGERS, indexCameras, mapFrigateMessage } from '../src/messages.js';
import { FRIGATE_CONFIG, createFakeGladys } from './helpers/fakes.js';
import { FrigateIntegration } from '../src/integration.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the manifest targets the latest Gladys release line (5.1+)', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('the manifest version and image tag follow package.json', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${pkg.version}`));
});

test('config_schema defaults match DEFAULT_CONFIG and every value field is known', () => {
  for (const field of manifest.config_schema.filter((f) => f.type !== 'section')) {
    assert.ok(field.key in DEFAULT_CONFIG, `"${field.key}" is missing from DEFAULT_CONFIG`);
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, `default of "${field.key}"`);
    }
  }
});

test('every manifest action has a registered handler', () => {
  const gladys = createFakeGladys();
  new FrigateIntegration({ gladys }).register();
  for (const action of manifest.actions) {
    assert.equal(typeof gladys.actions[action.key], 'function', `no handler for "${action.key}"`);
  }
});

test('the manifest declares exactly the scene triggers the code fires', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
});

test('every key of a fired event is a declared field or variable', () => {
  const cameras = indexCameras(FRIGATE_CONFIG);
  const object = {
    id: 'e',
    camera: 'front_door',
    label: 'person',
    entered_zones: ['driveway'],
  };
  const review = { id: 'r', camera: 'front_door', severity: 'alert', data: {} };
  const events = [
    ...mapFrigateMessage(
      { topic: 'events', payload: JSON.stringify({ type: 'new', before: object, after: object }) },
      cameras,
    ).sceneEvents,
    ...mapFrigateMessage(
      { topic: 'reviews', payload: JSON.stringify({ type: 'new', before: review, after: review }) },
      cameras,
    ).sceneEvents,
  ];
  assert.equal(new Set(events.map((e) => e.key)).size, 3, 'all three triggers are exercised');
  for (const { key, data } of events) {
    const trigger = manifest.scene_triggers.find((t) => t.key === key);
    const declared = new Set([
      ...trigger.fields.map((f) => f.key),
      ...trigger.variables.map((v) => v.key),
    ]);
    // `camera` (the Gladys device) is added by the integration when firing.
    for (const dataKey of ['camera', ...Object.keys(data)]) {
      assert.ok(declared.has(dataKey), `"${dataKey}" is not declared on trigger "${key}"`);
    }
    for (const field of trigger.fields) {
      assert.ok(
        field.key === 'camera' || field.key in data,
        `filter "${field.key}" of trigger "${key}" never receives a value`,
      );
    }
  }
});
