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
import { cameraNameOfDevice, publishDiscovery } from './src/gladys/discovery.js';
import { createFrigateSession } from './src/gladys/frigateSession.js';
import { createCameraImages } from './src/gladys/images.js';
import { MANIFEST_ACTIONS } from './src/gladys/keys.js';
import { describeTransition } from './src/gladys/messages.js';

// /data is the only writable location of the container (see the Dockerfile).
const trustStore = new TrustStore({ filePath: '/data/tls-trust.json', logger });
const gladys = new GladysIntegration();
const session = createFrigateSession({
  gladys,
  trustStore,
  logger,
  // Every successful read of Frigate refreshes the Discover tab.
  onConnected: (capabilities) => publishDiscovery(gladys, capabilities),
  // Logged until the scene triggers use them (milestone 5).
  onTransition: (transition) => logger.info(describeTransition(transition)),
});
const images = createCameraImages({
  getClient: () => session.client,
  publish: (externalId, image) => gladys.publishCameraImage(externalId, image),
});

// Last image error per camera: a camera failing every minute logs once.
const imageErrors = new Map();

/** Push a fresh image of a camera device; never throws (logged instead). */
async function pushImage(device) {
  const camera = cameraNameOfDevice(gladys, device);
  if (!camera || !session.client) {
    return;
  }
  try {
    await images.push(device.external_id, camera);
    imageErrors.delete(camera);
  } catch (err) {
    if (imageErrors.get(camera) !== err.message) {
      imageErrors.set(camera, err.message);
      logger.warn(`Could not update the image of camera ${camera}: ${err.message}`);
    }
  }
}

const applyConfig = (raw = {}) => session.apply(normalizeConfig(raw), raw);

gladys.onConfigUpdated((raw) => applyConfig(raw));
gladys.on('connected', () => applyConfig(gladys.config));

gladys.onScanRequest(async () => {
  // Always answer: an empty list ends the scan at once, and the connection
  // status says why Frigate could not be read.
  await publishDiscovery(gladys, await session.ensureConnected());
});
// Gladys polls each camera device every minute: the poll pushes an image.
gladys.onPoll((device) => pushImage(device));
gladys.onDeviceCreated((device) => pushImage(device));
gladys.onGetImage(async (device) => {
  const camera = cameraNameOfDevice(gladys, device);
  if (!camera) {
    throw new Error(`${device?.external_id} is not a Frigate camera`);
  }
  return images.capture(camera);
});

gladys.onAction(MANIFEST_ACTIONS.TEST_CONNECTION, () => session.testConnection());
gladys.onAction(MANIFEST_ACTIONS.REFRESH_CAMERAS, () => session.refreshCameras());
gladys.onAction(MANIFEST_ACTIONS.RESET_CERTIFICATE, () => session.resetCertificate());

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
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
