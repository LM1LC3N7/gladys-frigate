// -----------------------------------------------------------------------------
// Entry point of the Frigate external integration for Gladys Assistant.
//
// Environment variables injected by the Gladys supervisor (read by the SDK):
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// All the logic lives in src/integration.js; this file only wires it up.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { FrigateIntegration } from './src/integration.js';

const gladys = new GladysIntegration();
const integration = new FrigateIntegration({ gladys });

// Handlers must be registered BEFORE connect().
integration.register();

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  integration.stop();
});

logger.info('Starting the Frigate integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed', err);
  process.exit(1);
});
