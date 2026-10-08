import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_PREFIX,
  IMAGE_STEPS,
  ImageTooLargeError,
  MAX_IMAGE_LENGTH,
  NotConnectedError,
  createCameraImages,
} from '../src/gladys/images.js';

/** Fake client: the JPEG size depends on the asked height and quality. */
function fakeClient(sizeOf) {
  const asked = [];
  return {
    asked,
    async getLatestJpeg(camera, step) {
      asked.push({ camera, ...step });
      return Buffer.alloc(sizeOf(step), 1);
    },
  };
}

const base64Length = (bytes) => IMAGE_PREFIX.length + Math.ceil(bytes / 3) * 4;

test('the first step that fits under 150 KB (prefix and base64 included) is used', async () => {
  // Only 540p at quality 50 or less fits.
  const client = fakeClient(({ height, quality }) =>
    height <= 540 && quality <= 50 ? 100_000 : 200_000,
  );
  const images = createCameraImages({ getClient: () => client, publish: async () => {} });
  const image = await images.capture('front');
  assert.ok(image.startsWith(IMAGE_PREFIX));
  assert.ok(image.length <= MAX_IMAGE_LENGTH);
  assert.deepEqual(client.asked.at(-1), { camera: 'front', height: 540, quality: 50 });
  assert.ok(base64Length(100_000) <= MAX_IMAGE_LENGTH && base64Length(116_000) > MAX_IMAGE_LENGTH);
});

test('the step that fitted is remembered, and one better is tried when roomy', async () => {
  let time = 0;
  let busy = false;
  let bytes = 110_000; // fits at the first step, but not roomy
  const client = fakeClient(({ quality }) => (busy && quality > 35 ? 200_000 : bytes));
  const images = createCameraImages({
    getClient: () => client,
    publish: async () => {},
    now: () => time,
  });
  await images.capture('front');
  assert.equal(client.asked.length, 1);
  busy = true; // the scene got busier: steps down to quality 35
  time += 10_000;
  await images.capture('front');
  const firstFit = client.asked.length;
  assert.ok(firstFit > 2);
  busy = false;
  bytes = 10_000; // now tiny: starts one step better next time
  time += 10_000;
  await images.capture('front');
  assert.equal(client.asked.length, firstFit + 1, 'started at the remembered step');
  time += 10_000;
  await images.capture('front');
  const [previous, last] = client.asked.slice(-2);
  assert.ok(
    IMAGE_STEPS.findIndex((s) => s.height === last.height && s.quality === last.quality) <
      IMAGE_STEPS.findIndex((s) => s.height === previous.height && s.quality === previous.quality),
  );
});

test('a camera too big at every step, or no connection, is a clear error', async () => {
  const huge = createCameraImages({
    getClient: () => fakeClient(() => 500_000),
    publish: async () => {},
  });
  await assert.rejects(huge.capture('front'), ImageTooLargeError);
  const offline = createCameraImages({ getClient: () => null, publish: async () => {} });
  await assert.rejects(offline.capture('front'), NotConnectedError);
});

test('concurrent captures share one request; an image is reused for 2 s', async () => {
  let time = 0;
  const client = fakeClient(() => 1000);
  const images = createCameraImages({
    getClient: () => client,
    publish: async () => {},
    now: () => time,
  });
  const [a, b] = await Promise.all([images.capture('front'), images.capture('front')]);
  assert.equal(a, b);
  assert.equal(client.asked.length, 1);
  time += 1000;
  await images.capture('front');
  assert.equal(client.asked.length, 1);
  time += 1500;
  await images.capture('front');
  assert.equal(client.asked.length, 2);
  await images.capture('garage');
  assert.equal(client.asked.length, 3);
});

test('pushes go to Gladys, at most 12 per minute and per camera', async () => {
  let time = 0;
  const published = [];
  const images = createCameraImages({
    getClient: () => fakeClient(() => 1000),
    publish: async (externalId, image) => published.push([externalId, image.slice(0, 17)]),
    now: () => time,
  });
  for (let i = 0; i < 13; i += 1) {
    time += 3000;
    assert.equal(await images.push('ext:frigate:camera:front', 'front'), i < 12);
  }
  assert.equal(published.length, 12);
  assert.deepEqual(published[0], ['ext:frigate:camera:front', IMAGE_PREFIX]);
  time += 60_000;
  assert.equal(await images.push('ext:frigate:camera:front', 'front'), true);
});
