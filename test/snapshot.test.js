import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_LENGTH, fetchSnapshot, snapshotAttempts } from '../src/snapshot.js';

test('snapshotAttempts steps quality down, then height, never below 120 px', () => {
  const attempts = snapshotAttempts(480);
  assert.deepEqual(attempts[0], { height: 480, quality: 70 });
  assert.deepEqual(attempts[1], { height: 480, quality: 50 });
  assert.ok(attempts.every((a) => a.height >= 120));
  assert.deepEqual(snapshotAttempts(120), [
    { height: 120, quality: 70 },
    { height: 120, quality: 50 },
    { height: 120, quality: 35 },
  ]);
});

test('fetchSnapshot returns the first image that fits in 150 KB', async () => {
  const requests = [];
  const client = {
    async getLatestJpeg(camera, options) {
      requests.push(options);
      // Too big until the quality drops to 35.
      return Buffer.alloc(options.quality > 35 ? 200 * 1024 : 1024);
    },
  };
  const image = await fetchSnapshot(client, 'garden', 480);
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(image.length <= MAX_IMAGE_LENGTH);
  assert.equal(requests.length, 3);
});

test('fetchSnapshot gives up when nothing fits', async () => {
  const client = { getLatestJpeg: async () => Buffer.alloc(200 * 1024) };
  await assert.rejects(fetchSnapshot(client, 'garden', 480), /150 KB/);
});
