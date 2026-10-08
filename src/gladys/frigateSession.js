// -----------------------------------------------------------------------------
// Lifecycle of the connection to Frigate, as Gladys sees it.
//
//   - apply(config): validate the configuration, (re)create the HTTP client,
//     read the version and the cameras, publish the connection status
//     (connected, or why not, plus the security warnings). A network failure
//     is retried every minute; a refused certificate, refused credentials or
//     an unsupported version wait for the user instead (looping would only
//     hit Frigate's login rate limit or hide a real problem).
//   - The three manifest action buttons: test_connection, refresh_cameras,
//     reset_certificate.
//   - onConnected(capabilities) runs after every successful read of Frigate
//     (index.js publishes the discovery list with it).
//
// Thin adapter: the Frigate logic lives in src/frigate/.
// -----------------------------------------------------------------------------

import { configWarnings, usesMqtt } from '../config.js';
import { readCapabilities } from '../frigate/capabilities.js';
import { HttpStatusError, UnreachableError } from '../frigate/errors.js';
import { createFrigateClient } from '../frigate/httpClient.js';
import { probeMqtt } from '../frigate/mqttProbe.js';
import { describeAuth, describeError, describeTls } from './messages.js';
import { composeMessage, describeConfig } from './status.js';

const RETRY_DELAY_MS = 60_000;
const MAX_LISTED_CAMERAS = 10;

const isTransient = (err) =>
  err instanceof UnreachableError || (err instanceof HttpStatusError && err.status >= 500);

function cameraList(capabilities) {
  const names = capabilities.cameras.map((camera) => camera.friendlyName);
  const shown = names.slice(0, MAX_LISTED_CAMERAS).join(', ');
  return names.length > MAX_LISTED_CAMERAS ? `${shown}…` : shown;
}

function cameraSummary(capabilities) {
  const count = capabilities.cameras.length;
  if (count === 0) {
    return { en: 'no camera', fr: 'aucune caméra' };
  }
  const list = cameraList(capabilities);
  return {
    en: `${count} camera${count > 1 ? 's' : ''} (${list})`,
    fr: `${count} caméra${count > 1 ? 's' : ''} (${list})`,
  };
}

/** "First sentence. Second sentence." in both languages, no length cap. */
function sentences(parts) {
  const kept = parts.filter(Boolean);
  return {
    en: kept.map((part) => part.en).join(' '),
    fr: kept.map((part) => part.fr).join(' '),
  };
}

/**
 * @param {object} options
 * @param {{ setConnectionStatus: Function }} options.gladys
 * @param {import('../frigate/tlsTrust.js').TrustStore} options.trustStore loaded
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {Function} [options.clientFactory] createFrigateClient (tests)
 * @param {Function} [options.mqttCheck] probeMqtt (tests)
 * @param {number} [options.retryDelayMs]
 * @param {(capabilities: object) => Promise} [options.onConnected]
 */
export function createFrigateSession({
  gladys,
  trustStore,
  logger,
  clientFactory = createFrigateClient,
  mqttCheck = probeMqtt,
  retryDelayMs = RETRY_DELAY_MS,
  onConnected = async () => {},
}) {
  let config = null;
  let raw = {};
  let client = null;
  let capabilities = null;
  let retryTimer = null;
  // Bumped on every apply(): a slow check of an older configuration must
  // not overwrite the status of the current one.
  let generation = 0;

  function setStatus(connected, message) {
    return gladys
      .setConnectionStatus(connected, message)
      .catch((err) => logger.warn(`Could not report the connection status: ${err.message}`));
  }

  async function replaceClient() {
    await client?.close();
    client = clientFactory({
      url: config.frigate_url,
      username: config.username,
      password: config.password,
      trustStore,
      tlsFingerprint: config.tls_fingerprint,
      tlsCa: config.tls_ca,
    });
  }

  async function readFrigate() {
    const version = await client.getVersion();
    const frigateConfig = await client.getConfig();
    return readCapabilities(version, frigateConfig);
  }

  function connectedMessage() {
    const { version } = capabilities;
    const summary = cameraSummary(capabilities);
    return composeMessage([
      {
        en: `Connected to Frigate ${version.raw}, ${summary.en}.`,
        fr: `Connecté à Frigate ${version.raw}, ${summary.fr}.`,
      },
      ...configWarnings(config),
    ]);
  }

  /** Read Frigate and publish the status; schedules a retry on a transient failure. */
  async function check(currentGeneration) {
    clearTimeout(retryTimer);
    try {
      const result = await readFrigate();
      if (currentGeneration !== generation) {
        return;
      }
      capabilities = result;
      logger.info(
        `Connected to Frigate ${capabilities.version.raw} (${capabilities.cameras.length} cameras)`,
      );
      await setStatus(true, connectedMessage());
    } catch (err) {
      if (currentGeneration !== generation) {
        return;
      }
      capabilities = null;
      logger.warn(`Frigate is not available: ${err.message}`);
      await setStatus(false, composeMessage([describeError(err), ...configWarnings(config)]));
      if (isTransient(err)) {
        retryTimer = setTimeout(() => check(currentGeneration).catch(() => {}), retryDelayMs);
        retryTimer.unref?.();
      }
      throw err;
    }
    // Outside the try: a failure here is not a Frigate failure.
    await onConnected(capabilities).catch((err) =>
      logger.warn(`Could not publish the Frigate cameras to Gladys: ${err.message}`),
    );
  }

  async function checkMqtt() {
    const what = {
      en: `MQTT broker ${config.mqtt_host}:${config.mqtt_port}`,
      fr: `Broker MQTT ${config.mqtt_host}:${config.mqtt_port}`,
    };
    try {
      const { tlsDecision } = await mqttCheck({
        host: config.mqtt_host,
        port: config.mqtt_port,
        username: config.mqtt_username,
        password: config.mqtt_password,
        tls: config.mqtt_tls,
        trustStore,
        manualFingerprint: config.tls_fingerprint,
        ca: config.tls_ca,
      });
      const tls = config.mqtt_tls ? describeTls(tlsDecision) : null;
      return {
        en: `${what.en}: connected${tls ? `, certificate ${tls.en}` : ''}.`,
        fr: `${what.fr} : connecté${tls ? `, certificat ${tls.fr}` : ''}.`,
      };
    } catch (err) {
      return describeError(err, what);
    }
  }

  function invalidConfigAnswer() {
    return describeConfig(config ?? {}, raw).message;
  }

  return {
    /**
     * @param {ReturnType<import('../config.js').normalizeConfig>} newConfig
     * @param {Record<string, unknown>} rawConfig
     */
    async apply(newConfig, rawConfig = {}) {
      generation += 1;
      const currentGeneration = generation;
      clearTimeout(retryTimer);
      config = newConfig;
      raw = rawConfig;
      capabilities = null;
      const { valid, message } = describeConfig(config, raw);
      if (!valid) {
        await client?.close();
        client = null;
        logger.warn(message.en);
        await setStatus(false, message);
        return;
      }
      await replaceClient();
      await check(currentGeneration).catch(() => {});
    },

    /** The last capabilities read (null while not connected). */
    get capabilities() {
      return capabilities;
    },

    /** The Frigate HTTP client while connected, else null. */
    get client() {
      return capabilities ? client : null;
    },

    /**
     * The capabilities, reading Frigate once more when not connected (a scan
     * asked while Frigate was down). Null when Frigate still fails.
     */
    async ensureConnected() {
      if (capabilities || !client) {
        return capabilities;
      }
      await check(generation).catch(() => {});
      return capabilities;
    },

    /** "Test the connection": Frigate, its certificate and account, the broker. */
    async testConnection() {
      if (!client) {
        return invalidConfigAnswer();
      }
      const parts = [];
      try {
        await check(generation);
        parts.push(
          {
            en: `Frigate ${capabilities.version.raw}: ${cameraSummary(capabilities).en}.`,
            fr: `Frigate ${capabilities.version.raw} : ${cameraSummary(capabilities).fr}.`,
          },
          (() => {
            const tls = describeTls(client.tlsDecision);
            const auth = describeAuth(client.authMode, config.username);
            return {
              en: `Certificate: ${tls.en}. Account: ${auth.en}.`,
              fr: `Certificat : ${tls.fr}. Compte : ${auth.fr}.`,
            };
          })(),
        );
      } catch (err) {
        parts.push(describeError(err));
      }
      parts.push(
        usesMqtt(config)
          ? await checkMqtt()
          : {
              en: 'No MQTT broker configured: the Frigate WebSocket will be used.',
              fr: 'Aucun broker MQTT configuré : le WebSocket de Frigate sera utilisé.',
            },
      );
      return sentences(parts);
    },

    /** "Refresh the cameras": read the Frigate configuration again. */
    async refreshCameras() {
      if (!client) {
        return invalidConfigAnswer();
      }
      try {
        await check(generation);
      } catch (err) {
        return describeError(err);
      }
      const summary = cameraSummary(capabilities);
      return {
        en: `Frigate configuration read again: ${summary.en}. The cameras are listed in the Discover tab.`,
        fr: `Configuration de Frigate relue : ${summary.fr}. Les caméras sont listées dans l'onglet Découverte.`,
      };
    },

    /**
     * "Trust the new certificate": forget the pinned certificates (Frigate
     * and broker), reconnect, and tell which certificate is now pinned.
     */
    async resetCertificate() {
      await trustStore.reset();
      logger.info('Pinned TLS certificates forgotten at the user request');
      if (!client) {
        return {
          en: 'Pinned certificates forgotten. Complete the configuration to connect.',
          fr: 'Certificats épinglés oubliés. Complétez la configuration pour vous connecter.',
        };
      }
      // Pooled connections were trusted under the old pins: start afresh.
      await replaceClient();
      const parts = [
        {
          en: 'Pinned certificates forgotten.',
          fr: 'Certificats épinglés oubliés.',
        },
      ];
      try {
        await check(generation);
        const decision = client.tlsDecision;
        parts.push(
          decision
            ? {
                en: `Frigate certificate: ${describeTls(decision).en}.`,
                fr: `Certificat de Frigate : ${describeTls(decision).fr}.`,
              }
            : {
                en: 'Frigate is reached over http: no certificate to pin.',
                fr: 'Frigate est joint en http : aucun certificat à épingler.',
              },
        );
      } catch (err) {
        parts.push(describeError(err));
      }
      if (usesMqtt(config) && config.mqtt_tls) {
        parts.push(await checkMqtt());
      }
      return sentences(parts);
    },

    async close() {
      generation += 1;
      clearTimeout(retryTimer);
      await client?.close();
      client = null;
    },
  };
}
