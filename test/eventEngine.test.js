import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, createEventEngine } from '../src/frigate/eventEngine.js';

/** A Frigate `events` message, as parsed by topics.js. */
function event(type, after) {
  return {
    type: 'event',
    data: {
      type,
      before: {},
      after: {
        id: 'e1',
        camera: 'front',
        label: 'person',
        sub_label: null,
        top_score: 0.85,
        score: 0.8,
        false_positive: false,
        stationary: false,
        current_zones: [],
        entered_zones: [],
        has_snapshot: true,
        ...after,
      },
    },
  };
}

function review(type, after) {
  return {
    type: 'review',
    data: {
      type,
      before: {},
      after: {
        id: 'r1',
        camera: 'front',
        severity: 'alert',
        data: { objects: ['person'], zones: [], sub_labels: [], detections: ['e1'] },
        ...after,
      },
    },
  };
}

function engine(options = {}) {
  let time = 0;
  const instance = createEventEngine({ now: () => time, ...options });
  instance.setCameras([{ name: 'front', objects: ['person', 'car', 'dog'] }]);
  const out = [];
  return {
    handle: (message) => out.push(...instance.handle(message)),
    advance: (seconds) => {
      time += seconds * 1000;
    },
    out,
    kinds: () => out.map((t) => t.kind),
  };
}

test('a tracked object fires object_detected once, whatever the updates', () => {
  const e = engine();
  e.handle(event('new', {}));
  e.handle(event('update', { top_score: 0.9 }));
  e.handle(event('update', { top_score: 0.95 }));
  e.handle(event('end', {}));
  assert.deepEqual(e.kinds(), [TRANSITIONS.OBJECT_DETECTED]);
  assert.deepEqual(e.out[0], {
    kind: 'object_detected',
    camera: 'front',
    label: 'person',
    subLabel: null,
    score: 85,
    eventId: 'e1',
    zones: [],
    hasSnapshot: true,
  });
});

test('false positives and stationary objects never fire; a low score waits', () => {
  const e = engine({ minScore: 80 });
  e.handle(event('update', { id: 'fp', false_positive: true, top_score: 0.99 }));
  e.handle(event('update', { id: 'parked', stationary: true }));
  e.handle(event('new', { id: 'low', top_score: 0.6 }));
  assert.deepEqual(e.out, []);
  e.handle(event('update', { id: 'low', top_score: 0.82 }));
  assert.deepEqual(
    e.out.map((t) => [t.eventId, t.score]),
    [['low', 82]],
  );
});

test('each zone entered fires once, with the score threshold', () => {
  const e = engine({ cooldownSeconds: 0 });
  e.handle(event('update', { entered_zones: ['porch'], current_zones: ['porch'] }));
  e.handle(event('update', { entered_zones: ['porch'] }));
  e.handle(event('update', { entered_zones: ['porch', 'driveway'] }));
  assert.deepEqual(
    e.out.map((t) => [t.kind, t.zone ?? null]),
    [
      ['object_detected', null],
      ['object_entered_zone', 'porch'],
      ['object_entered_zone', 'driveway'],
    ],
  );
});

test('cooldown: one transition per camera, object type and period', () => {
  const e = engine({ cooldownSeconds: 30 });
  e.handle(event('new', { id: 'a' }));
  e.advance(5);
  e.handle(event('new', { id: 'b' })); // same person walking back in: dropped
  e.handle(event('new', { id: 'c', label: 'car' })); // another object type
  e.advance(10);
  e.handle(event('update', { id: 'b', top_score: 0.99 })); // dropped stays dropped
  e.advance(20);
  e.handle(event('new', { id: 'd' }));
  assert.deepEqual(
    e.out.map((t) => t.eventId),
    ['a', 'c', 'd'],
  );
});

test('sub labels and -verified labels are flattened', () => {
  const e = engine();
  e.handle(event('new', { label: 'person-verified', sub_label: ['Alice', 0.9] }));
  assert.equal(e.out[0].label, 'person');
  assert.equal(e.out[0].subLabel, 'Alice');
});

test('review_alert: once per review, including a detection escalated to an alert', () => {
  const e = engine({ cooldownSeconds: 0 });
  e.handle(review('new', { id: 'r1', severity: 'detection' }));
  assert.deepEqual(e.out, []);
  e.handle(
    review('update', {
      id: 'r1',
      data: {
        objects: ['car', 'person-verified', 'person'],
        zones: ['driveway', 'porch'],
        sub_labels: ['Alice'],
        detections: ['e1', 'e2'],
      },
    }),
  );
  e.handle(review('update', { id: 'r1' }));
  e.handle(review('end', { id: 'r1' }));
  assert.equal(e.out.length, 1);
  assert.deepEqual(e.out[0], {
    kind: 'review_alert',
    camera: 'front',
    reviewId: 'r1',
    severity: 'alert',
    label: 'person', // first in the camera's tracked order, not in the review
    zone: 'driveway', // first entered
    objects: ['car', 'person'],
    zones: ['driveway', 'porch'],
    subLabels: ['Alice'],
    detections: ['e1', 'e2'],
  });
});

test('an alert seen only at its end still fires; detections never do', () => {
  const e = engine({ cooldownSeconds: 0 });
  e.handle(review('end', { id: 'r2' }));
  e.handle(review('end', { id: 'r3', severity: 'detection' }));
  assert.deepEqual(
    e.out.map((t) => t.reviewId),
    ['r2'],
  );
});

test('review cooldown is per camera', () => {
  const e = engine({ cooldownSeconds: 60 });
  e.handle(review('new', { id: 'r1' }));
  e.handle(review('new', { id: 'r2' }));
  e.handle(review('new', { id: 'r3', camera: 'garage' }));
  e.advance(61);
  e.handle(review('new', { id: 'r4' }));
  assert.deepEqual(
    e.out.map((t) => t.reviewId),
    ['r1', 'r3', 'r4'],
  );
});

test('garbage is ignored; memory stays bounded when ends are lost', () => {
  const e = engine({ cooldownSeconds: 0 });
  for (const message of [null, {}, { type: 'event' }, { type: 'event', data: { after: null } }]) {
    e.handle(message);
  }
  e.handle(event('new', { id: 42 }));
  e.handle({ type: 'motion', camera: 'front', active: true });
  assert.deepEqual(e.out, []);
  for (let i = 0; i < 1500; i += 1) {
    e.handle(event('new', { id: `x${i}` }));
  }
  assert.equal(e.out.length, 1500);
  // x0 was forgotten: a late update fires again, which is the bounded cost.
  e.handle(event('update', { id: 'x0' }));
  e.handle(event('update', { id: 'x1499' }));
  assert.equal(e.out.length, 1501);
});
