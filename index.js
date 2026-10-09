// -----------------------------------------------------------------------------
// Entry point of the Frigate external integration for Gladys Assistant.
//
// Wiring only: the Frigate client lives in src/frigate/ (no Gladys
// dependency), the Gladys adapter in src/gladys/. The SDK reads
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and GLADYS_INTEGRATION_SELECTOR
// from the environment injected by the Gladys supervisor.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { TrustStore } from './src/frigate/tlsTrust.js';
import { createDeviceSync } from './src/gladys/deviceSync.js';
import { cameraNameOfDevice, publishDiscovery } from './src/gladys/discovery.js';
import { createFrigateSession } from './src/gladys/frigateSession.js';
import { createCameraImages, createDeviceImages } from './src/gladys/images.js';
import { MANIFEST_ACTIONS, SCENE_ACTIONS } from './src/gladys/keys.js';
import { describeTransition } from './src/gladys/messages.js';
import { createSceneEvents, createSnapshotAction } from './src/gladys/sceneEvents.js';

// /data is the only writable location of the container (see the Dockerfile).
const trustStore = new TrustStore({ filePath: '/data/tls-trust.json', logger });
const gladys = new GladysIntegration();
// The device side reads the session lazily (the arrows run after start-up).
const zoneSensors = () => session.config?.zone_sensors === true;
const discover = (capabilities) =>
  publishDiscovery(gladys, capabilities, { zoneSensors: zoneSensors() });

const cameraImages = createCameraImages({
  getClient: () => session.client,
  publish: (externalId, image) => gladys.publishCameraImage(externalId, image),
});
const deviceImages = createDeviceImages({
  gladys,
  images: cameraImages,
  cameraOf: cameraNameOfDevice,
  isConnected: () => Boolean(session.client),
  logger,
});
const deviceSync = createDeviceSync({
  gladys,
  getCapabilities: () => session.capabilities,
  getClient: () => session.client,
  getFeed: () => session.feed,
  zoneSensors,
  images: deviceImages,
  logger,
});
const sceneEvents = createSceneEvents({
  gladys,
  logger,
  // The alert image first, for a scene that sends the camera image next.
  beforeAlert: async (camera) => {
    const device = gladys.devices.find((d) => cameraNameOfDevice(gladys, d) === camera);
    if (device) await deviceImages.pushImage(device);
  },
});
const session = createFrigateSession({
  gladys,
  trustStore,
  logger,
  // Every successful read of Frigate refreshes the Discover tab.
  onConnected: discover,
  onFrigateStatus: (up) => deviceSync.frigateUp(up),
  onFeedStatus: (status) => deviceSync.feedStatus(status),
  onMessage: (message) => deviceSync.handleMessage(message),
  onTransition: (transition) => {
    logger.info(describeTransition(transition));
    sceneEvents.handle(transition);
  },
});

const applyConfig = (raw = {}) => session.apply(normalizeConfig(raw), raw);

gladys.onConfigUpdated((raw) => applyConfig(raw));
gladys.on('connected', () => {
  deviceSync.gladysConnected();
  return applyConfig(gladys.config);
});

// Always answer a scan: an empty list ends it at once, and the connection
// status says why Frigate could not be read.
gladys.onScanRequest(async () => discover(await session.ensureConnected()));
// Gladys polls each camera device every minute: fresh image, camera health.
gladys.onPoll((device) => deviceSync.poll(device));
gladys.onDeviceCreated((device) => deviceSync.deviceCreated(device));
gladys.onGetImage((device) => deviceImages.captureImage(device));
gladys.onSetValue((device, feature, value) => deviceSync.setValue(device, feature, value));

gladys.onSceneAction(
  SCENE_ACTIONS.ATTACH_EVENT_SNAPSHOT,
  createSnapshotAction({ gladys, images: cameraImages, getClient: () => session.client }),
);

gladys.onAction(MANIFEST_ACTIONS.TEST_CONNECTION, () => session.testConnection());
gladys.onAction(MANIFEST_ACTIONS.REFRESH_CAMERAS, () => session.refreshCameras());
gladys.onAction(MANIFEST_ACTIONS.RESET_CERTIFICATE, () => session.resetCertificate());

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  deviceSync.close();
  await session.close();
});

logger.info('Starting the Frigate integration...');
// The pins must be loaded before the first TLS connection: a store read
// before that would treat a pinned endpoint as a first use.
await trustStore.load();
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed', err);
  process.exit(1);
});
