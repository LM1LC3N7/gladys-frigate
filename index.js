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
import { createFrigateSession } from './src/gladys/frigateSession.js';
import { MANIFEST_ACTIONS } from './src/gladys/keys.js';

// /data is the only writable location of the container (see the Dockerfile).
const trustStore = new TrustStore({ filePath: '/data/tls-trust.json', logger });
const gladys = new GladysIntegration();
const session = createFrigateSession({ gladys, trustStore, logger });

const applyConfig = (raw = {}) => session.apply(normalizeConfig(raw), raw);

gladys.onConfigUpdated((raw) => applyConfig(raw));
gladys.on('connected', () => applyConfig(gladys.config));

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
