import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatePublisher } from '../src/gladys/statePublisher.js';

function setup({ known = () => true, maxPerMinute = 250, fail = false } = {}) {
  let time = 0;
  const batches = [];
  const warnings = [];
  const publisher = createStatePublisher({
    publish: async (batch) => {
      if (fail) throw new Error('HTTP 429');
      batches.push(batch);
    },
    isKnown: known,
    logger: { warn: (message) => warnings.push(message) },
    flushMs: 60_000, // flushed by hand in the tests
    maxPerMinute,
    now: () => time,
  });
  return {
    publisher,
    batches,
    warnings,
    advance: (ms) => {
      time += ms;
    },
  };
}

test('only changed values of created devices are sent, numbers and texts', async (t) => {
  const { publisher, batches } = setup({ known: (id) => id !== 'unknown' });
  t.after(() => publisher.close());
  publisher.set([
    { id: 'a', value: 1 },
    { id: 'b', value: { text: 'alert' } },
    { id: 'unknown', value: 1 },
  ]);
  await publisher.flush();
  assert.deepEqual(batches, [
    [
      { device_feature_external_id: 'a', state: 1 },
      { device_feature_external_id: 'b', text: 'alert' },
    ],
  ]);
  publisher.set([
    { id: 'a', value: 1 },
    { id: 'b', value: { text: 'alert' } },
  ]);
  await publisher.flush();
  assert.equal(batches.length, 1, 'nothing changed');
  // A value that comes back before the flush is not sent.
  publisher.set([{ id: 'a', value: 0 }]);
  publisher.set([{ id: 'a', value: 1 }]);
  await publisher.flush();
  assert.equal(batches.length, 1);
  assert.equal(publisher.latest('unknown'), 1, 'kept for a device created later');
});

test('batches of 100 at most, under the per-minute budget; latest value wins', async (t) => {
  const { publisher, batches, advance } = setup({ maxPerMinute: 150 });
  t.after(() => publisher.close());
  publisher.set(Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, value: 1 })));
  await publisher.flush();
  await publisher.flush();
  await publisher.flush();
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 50],
  );
  publisher.set([{ id: 'f199', value: 0 }]); // replaces the pending 1
  advance(60_000);
  await publisher.flush();
  assert.equal(batches.length, 3);
  assert.ok(batches[2].some((s) => s.device_feature_external_id === 'f199' && s.state === 0));
  assert.equal(batches[2].length, 50);
});

test('republish sends what a new device lacks; forget sends everything again', async (t) => {
  let created = false;
  const { publisher, batches } = setup({ known: (id) => id === 'old' || created });
  t.after(() => publisher.close());
  publisher.set([
    { id: 'old', value: 1 },
    { id: 'new', value: 5 },
  ]);
  await publisher.flush();
  assert.deepEqual(batches.at(-1), [{ device_feature_external_id: 'old', state: 1 }]);
  created = true;
  publisher.republish();
  await publisher.flush();
  assert.deepEqual(batches.at(-1), [{ device_feature_external_id: 'new', state: 5 }]);
  publisher.forget();
  await publisher.flush();
  assert.equal(batches.at(-1).length, 2);
});

test('a refused batch is logged, not retried in a loop', async (t) => {
  const { publisher, warnings } = setup({ fail: true });
  t.after(() => publisher.close());
  publisher.set([{ id: 'a', value: 1 }]);
  await publisher.flush();
  await publisher.flush();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not publish 1 states to Gladys: HTTP 429/);
});
