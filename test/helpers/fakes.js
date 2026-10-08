// -----------------------------------------------------------------------------
// In-memory stand-ins for the Gladys SDK and the Frigate client/stream, so the
// wiring is tested without a Gladys server, a Frigate server or a network.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { assertSupportedVersion } from '../../src/frigate/version.js';

export const SELECTOR = 'frigate';

export function createFakeGladys({ devices = [], config = {} } = {}) {
  const gladys = new EventEmitter();
  Object.assign(gladys, {
    devices,
    config,
    handlers: {},
    actions: {},
    discovered: [],
    states: [],
    images: [],
    sceneEvents: [],
    transports: [],
    statuses: [],

    externalId(suffix) {
      return `ext:${SELECTOR}:${suffix}`;
    },
    externalIds(type, platformId) {
      const device = this.externalId(`${type}:${platformId}`);
      return { device, feature: (key) => `${device}:${key}` };
    },

    onScanRequest(cb) {
      this.handlers.scan = cb;
    },
    onSetValue(cb) {
      this.handlers.setValue = cb;
    },
    onGetImage(cb) {
      this.handlers.getImage = cb;
    },
    onConfigUpdated(cb) {
      this.handlers.configUpdated = cb;
    },
    onDeviceCreated(cb) {
      this.handlers.deviceCreated = cb;
    },
    onDeviceUpdated(cb) {
      this.handlers.deviceUpdated = cb;
    },
    onAction(key, cb) {
      this.actions[key] = cb;
    },

    async publishDiscoveredDevices(list) {
      this.discovered.push(list);
    },
    async publishStates(states) {
      this.states.push(...states);
    },
    async publishCameraImage(externalId, image) {
      this.images.push({ externalId, image });
    },
    async publishSceneEvent(key, data) {
      this.sceneEvents.push({ key, data });
    },
    async publishTransports(entries) {
      this.transports.push(...entries);
    },
    async setConnectionStatus(connected, message) {
      this.statuses.push({ connected, message });
    },
  });
  return gladys;
}

/** A Gladys device as the user created it from the discovery payload. */
export function createdDevice(gladys, discoveredDevice) {
  return { ...discoveredDevice, features: discoveredDevice.features.map((f) => ({ ...f })) };
}

export const FRIGATE_CONFIG = {
  cameras: {
    front_door: {
      friendly_name: 'Front door',
      objects: { track: ['person', 'car'] },
      zones: { driveway: {} },
    },
    garden: { objects: { track: ['person', 'dog'] } },
  },
};

export class FakeClient {
  constructor({
    version = '0.18.0-abc1234',
    config = FRIGATE_CONFIG,
    jpeg = Buffer.alloc(64),
  } = {}) {
    this.version = version;
    this.config = config;
    this.jpeg = jpeg;
    this.imageRequests = [];
  }

  async checkVersion() {
    assertSupportedVersion(this.version);
    return this.version;
  }

  async getConfig() {
    return this.config;
  }

  async getLatestJpeg(camera, options) {
    this.imageRequests.push({ camera, ...options });
    return this.jpeg;
  }
}

export class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.sent = [];
    this.started = false;
    this.stopped = false;
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  send(topic, payload) {
    this.sent.push({ topic, payload });
  }

  /** Simulate the connection opening. */
  open() {
    this.connected = true;
    this.emit('connected');
  }

  /** Simulate a message from Frigate. */
  receive(topic, payload) {
    this.emit('message', { topic, payload });
  }
}

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Let pending promise callbacks run. */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
