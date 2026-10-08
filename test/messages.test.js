import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_TRIGGERS, indexCameras, mapFrigateMessage } from '../src/messages.js';
import { FRIGATE_CONFIG } from './helpers/fakes.js';

const cameras = indexCameras(FRIGATE_CONFIG);
const map = (topic, payload) => mapFrigateMessage({ topic, payload }, cameras);

function event(type, after, before = after) {
  return JSON.stringify({ type, before, after });
}

const person = {
  id: '1718.123-abc',
  camera: 'front_door',
  label: 'person',
  sub_label: ['Alice', 0.91],
  top_score: 0.874,
  current_zones: ['driveway'],
  entered_zones: ['driveway'],
  false_positive: false,
};

test('motion ON/OFF becomes the motion sensor state', () => {
  assert.deepEqual(map('front_door/motion', 'ON').states, [
    { camera: 'front_door', key: 'motion', value: 1 },
  ]);
  assert.deepEqual(map('front_door/motion', 'OFF').states, [
    { camera: 'front_door', key: 'motion', value: 0 },
  ]);
});

test('object counts only update the labels the camera tracks', () => {
  assert.deepEqual(map('front_door/person', 2).states, [
    { camera: 'front_door', key: 'count-person', value: 2 },
  ]);
  assert.deepEqual(map('front_door/dog', 1).states, [], 'dog is not tracked on front_door');
  assert.deepEqual(map('front_door/all', 3).states, []);
  assert.deepEqual(map('front_door/person', 'abc').states, []);
});

test('toggle states are mirrored on the switches', () => {
  assert.deepEqual(map('garden/detect/state', 'OFF').states, [
    { camera: 'garden', key: 'detect', value: 0 },
  ]);
  assert.deepEqual(map('garden/recordings/state', 'ON').states, [
    { camera: 'garden', key: 'recordings', value: 1 },
  ]);
  assert.deepEqual(map('garden/snapshots/state', 'ON').states, [
    { camera: 'garden', key: 'snapshots', value: 1 },
  ]);
  assert.deepEqual(map('garden/audio/state', 'ON').states, []);
});

test('messages of unknown cameras or topics are ignored', () => {
  for (const [topic, payload] of [
    ['unknown_cam/motion', 'ON'],
    ['model_state', '{}'],
    ['front_door/review_status', 'ALERT'],
  ]) {
    assert.deepEqual(map(topic, payload), { states: [], sceneEvents: [], snapshots: [] });
  }
});

test('camera_activity gives the full initial state of every camera', () => {
  const activity = JSON.stringify({
    front_door: {
      motion: true,
      objects: [{ label: 'person' }, { label: 'person-verified' }, { label: 'cat' }],
      config: { detect: true, record: false, snapshots: true },
    },
    unknown_cam: { motion: true },
  });
  const states = map('camera_activity', activity).states;
  assert.deepEqual(states, [
    { camera: 'front_door', key: 'detect', value: 1 },
    { camera: 'front_door', key: 'recordings', value: 0 },
    { camera: 'front_door', key: 'snapshots', value: 1 },
    { camera: 'front_door', key: 'motion', value: 1 },
    { camera: 'front_door', key: 'count-person', value: 2 },
    { camera: 'front_door', key: 'count-car', value: 0 },
  ]);
});

test('a new event fires object_detected and zone_entered', () => {
  const { sceneEvents } = map('events', event('new', person));
  assert.deepEqual(sceneEvents, [
    {
      key: SCENE_TRIGGERS.OBJECT_DETECTED,
      camera: 'front_door',
      data: {
        camera_name: 'front_door',
        label: 'person',
        sub_label: 'Alice',
        score: 87,
        zones: 'driveway',
        event_id: '1718.123-abc',
      },
    },
    {
      key: SCENE_TRIGGERS.ZONE_ENTERED,
      camera: 'front_door',
      data: {
        camera_name: 'front_door',
        label: 'person',
        sub_label: 'Alice',
        score: 87,
        zones: 'driveway',
        event_id: '1718.123-abc',
        zone: 'driveway',
      },
    },
  ]);
});

test('an update only fires zone_entered for newly entered zones', () => {
  const before = { ...person, entered_zones: ['driveway'] };
  const after = { ...person, entered_zones: ['driveway', 'porch'], current_zones: ['porch'] };
  const { sceneEvents } = map('events', event('update', after, before));
  assert.equal(sceneEvents.length, 1);
  assert.equal(sceneEvents[0].key, SCENE_TRIGGERS.ZONE_ENTERED);
  assert.equal(sceneEvents[0].data.zone, 'porch');
  assert.deepEqual(map('events', event('update', before, before)).sceneEvents, []);
  assert.deepEqual(map('events', event('end', after, before)).sceneEvents, []);
});

test('false positives, unknown cameras and broken payloads fire nothing', () => {
  assert.deepEqual(
    map('events', event('new', { ...person, false_positive: true })).sceneEvents,
    [],
  );
  assert.deepEqual(map('events', event('new', { ...person, camera: 'nope' })).sceneEvents, []);
  assert.deepEqual(map('events', 'not json').sceneEvents, []);
  assert.deepEqual(map('events', JSON.stringify({ type: 'new' })).sceneEvents, []);
});

test('scene event data stays flat (scalars only)', () => {
  const { sceneEvents } = map(
    'events',
    event('new', { ...person, sub_label: null, top_score: null }),
  );
  for (const { data } of sceneEvents) {
    for (const value of Object.values(data)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
    }
  }
  assert.equal(sceneEvents[0].data.sub_label, '');
  assert.equal(sceneEvents[0].data.score, null);
});

const review = {
  id: 'rev-1',
  camera: 'garden',
  severity: 'alert',
  data: { objects: ['person', 'person-verified', 'dog'], zones: ['lawn'] },
};

test('a new alert fires review_started and refreshes the camera image', () => {
  const effects = map('reviews', event('new', review));
  assert.deepEqual(effects.sceneEvents, [
    {
      key: SCENE_TRIGGERS.REVIEW_STARTED,
      camera: 'garden',
      data: {
        camera_name: 'garden',
        severity: 'alert',
        objects: 'person,dog',
        zones: 'lawn',
        review_id: 'rev-1',
      },
    },
  ]);
  assert.deepEqual(effects.snapshots, ['garden']);
});

test('a detection fires review_started without an image refresh', () => {
  const effects = map('reviews', event('new', { ...review, severity: 'detection' }));
  assert.equal(effects.sceneEvents[0].data.severity, 'detection');
  assert.deepEqual(effects.snapshots, []);
});

test('a detection escalating to an alert fires again; other updates do not', () => {
  const detection = { ...review, severity: 'detection' };
  assert.equal(map('reviews', event('update', review, detection)).sceneEvents.length, 1);
  assert.equal(map('reviews', event('update', review, review)).sceneEvents.length, 0);
  assert.equal(map('reviews', event('end', review, review)).sceneEvents.length, 0);
});
