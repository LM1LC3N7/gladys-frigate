// -----------------------------------------------------------------------------
// Keys published in the manifest and stored by Gladys.
//
// Scene trigger and scene action keys are saved inside the users' scenes:
// renaming or removing one breaks every scene using it. They are frozen here
// and pinned by test/manifest.test.js — add new keys, never rename these.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGERS = Object.freeze({
  REVIEW_ALERT: 'review_alert',
  OBJECT_DETECTED: 'object_detected',
  OBJECT_ENTERED_ZONE: 'object_entered_zone',
});

export const SCENE_ACTIONS = Object.freeze({
  ATTACH_EVENT_SNAPSHOT: 'attach_event_snapshot',
});

export const MANIFEST_ACTIONS = Object.freeze({
  TEST_CONNECTION: 'test_connection',
  REFRESH_CAMERAS: 'refresh_cameras',
  // Forget the certificates pinned on first use (Frigate and broker): the next
  // connection trusts and pins the certificate it is served.
  RESET_CERTIFICATE: 'reset_certificate',
});
