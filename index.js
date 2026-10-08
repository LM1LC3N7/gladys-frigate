// -----------------------------------------------------------------------------
// Entry point of the Frigate external integration for Gladys Assistant.
//
// Wiring only: the Frigate client lives in src/frigate/ (no Gladys
// dependency), the Gladys adapter in src/gladys/. The SDK reads
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and GLADYS_INTEGRATION_SELECTOR
// from the environment injected by the Gladys supervisor.
//
// Milestone 1 (scaffold): the configuration is validated and reported; the
// Frigate connection is wired in the next milestones.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { describeConfig } from './src/gladys/status.js';

const gladys = new GladysIntegration();

// Temporary until the Frigate connection is wired (milestones 2 to 5).
const NOT_WIRED = {
  en: 'The Frigate connection is not available in this build yet.',
  fr: "La connexion à Frigate n'est pas encore disponible dans cette version.",
};

async function applyConfig(raw = {}) {
  const config = normalizeConfig(raw);
  const { valid, message } = describeConfig(config, raw);
  if (!valid) {
    logger.warn(message.en);
  }
  const shown = !valid
    ? message
    : {
        en: [message?.en, NOT_WIRED.en].filter(Boolean).join(' '),
        fr: [message?.fr, NOT_WIRED.fr].filter(Boolean).join(' '),
      };
  await gladys
    .setConnectionStatus(false, shown)
    .catch((err) => logger.warn(`Could not report the connection status: ${err.message}`));
}

gladys.onConfigUpdated((raw) => applyConfig(raw));
gladys.on('connected', () => applyConfig(gladys.config));

gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

logger.info('Starting the Frigate integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed', err);
  process.exit(1);
});
