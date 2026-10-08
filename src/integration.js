// -----------------------------------------------------------------------------
// The Frigate integration: wires a Frigate server to the Gladys SDK.
//
// Lifecycle:
//   start(config) -> check the Frigate version, read its configuration,
//                    publish the cameras as discovered devices, open the
//                    real-time WebSocket and start the periodic snapshots;
//   stop()        -> close everything (configuration change, Gladys
//                    disconnection, container shutdown).
// Every start bumps a generation counter, so an outdated start that resolves
// late (slow Frigate) never overrides a newer one.
//
// The class takes the SDK instance and factories as dependencies, so the
// whole wiring is unit-tested with fakes (test/integration.test.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, validateConfig } from './config.js';
import { FrigateClient, FrigateAuthError } from './frigate/client.js';
import { FrigateStream } from './frigate/stream.js';
import { UnsupportedFrigateVersionError } from './frigate/version.js';
import {
  TOGGLES,
  buildDiscoveredDevices,
  cameraIds,
  cameraNameOfDevice,
  parseFeatureExternalId,
} from './devices.js';
import { indexCameras, mapFrigateMessage } from './messages.js';
import { fetchSnapshot } from './snapshot.js';

export const START_RETRY_MS = 30_000;
// Gladys accepts at most 12 images per minute and per camera.
export const MIN_IMAGE_SPACING_MS = 5_000;
const MAX_STATES_PER_REQUEST = 100;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** User-facing (en/fr) explanation of a start failure. */
export function describeStartError(err, config) {
  if (err instanceof UnsupportedFrigateVersionError) {
    return {
      en: `Frigate ${err.version} is not supported: update Frigate to 0.18 or later.`,
      fr: `Frigate ${err.version} n'est pas supporté : mettez Frigate à jour en 0.18 ou plus.`,
    };
  }
  if (err instanceof FrigateAuthError) {
    return {
      en: 'Frigate refused the connection: check the username and password.',
      fr: "Frigate a refusé la connexion : vérifiez l'utilisateur et le mot de passe.",
    };
  }
  if (/certificate|self[- ]signed|CERT_|UNABLE_TO_VERIFY/i.test(`${err.code} ${err.message}`)) {
    return {
      en: 'The Frigate TLS certificate is not trusted: enable "Accept a self-signed certificate".',
      fr: 'Le certificat TLS de Frigate n\'est pas reconnu : activez "Accepter un certificat auto-signé".',
    };
  }
  return {
    en: `Cannot reach Frigate at ${config.frigate_url}, retrying.`,
    fr: `Impossible de joindre Frigate à ${config.frigate_url}, nouvel essai en cours.`,
  };
}

function isPermanent(err) {
  return err instanceof UnsupportedFrigateVersionError || err instanceof FrigateAuthError;
}

export class FrigateIntegration {
  /**
   * @param {object} options
   * @param {object} options.gladys SDK instance (GladysIntegration)
   * @param {object} [options.logger]
   * @param {(config: object) => FrigateClient} [options.createClient]
   * @param {(client: FrigateClient, logger: object) => FrigateStream} [options.createStream]
   */
  constructor({ gladys, logger, createClient, createStream }) {
    this.gladys = gladys;
    this.logger = logger ?? createLogger({ name: 'frigate' });
    this.createClient =
      createClient ??
      ((config) =>
        new FrigateClient({
          url: config.frigate_url,
          username: config.username,
          password: config.password,
          allowSelfSigned: config.allow_self_signed,
        }));
    this.createStream = createStream ?? ((client, logger) => new FrigateStream({ client, logger }));

    this.generation = 0;
    this.config = normalizeConfig();
    this.client = null;
    this.stream = null;
    this.cameras = new Map();
    this.lastValues = new Map();
    this.lastImageAt = new Map();
    this.snapshotTimer = null;
    this.snapshotBusy = false;
    this.retryTimer = null;
  }

  /** Register every SDK handler. Call once, before gladys.connect(). */
  register() {
    const { gladys } = this;
    gladys.onScanRequest(() => this.scan());
    gladys.onSetValue((device, feature, value) => this.setValue(device, feature, value));
    gladys.onGetImage((device) => this.getImage(device));
    gladys.onConfigUpdated((config) => this.#safeStart(config));
    gladys.onDeviceCreated((device) => this.onDeviceChanged(device));
    gladys.onDeviceUpdated((device) => this.onDeviceChanged(device));
    gladys.onAction('test_connection', () => this.testConnection());
    gladys.on('connected', () => this.#safeStart(gladys.config));
    gladys.on('disconnected', () => this.stop());
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(rawConfig) {
    this.stop();
    const generation = this.generation;
    const config = normalizeConfig(rawConfig);
    this.config = config;

    const invalid = validateConfig(config);
    if (invalid) {
      this.logger.warn(invalid.en);
      await this.#setStatus(false, invalid);
      return;
    }

    const client = this.createClient(config);
    try {
      const version = await client.checkVersion();
      const frigateConfig = await client.getConfig();
      if (generation !== this.generation) return;
      this.logger.info(
        `Frigate ${version} reached, ${Object.keys(frigateConfig.cameras ?? {}).length} camera(s)`,
      );
      this.client = client;
      this.cameras = indexCameras(frigateConfig);
      await this.gladys.publishDiscoveredDevices(
        buildDiscoveredDevices(this.gladys, frigateConfig),
      );
    } catch (err) {
      if (generation !== this.generation) return;
      this.logger.error(`Frigate start failed: ${err.message}`);
      await this.#setStatus(false, describeStartError(err, config));
      if (!isPermanent(err)) {
        this.retryTimer = setTimeout(() => this.#safeStart(rawConfig), START_RETRY_MS);
      }
      return;
    }
    if (generation !== this.generation) return;

    const stream = this.createStream(client, this.logger);
    this.stream = stream;
    stream.on('message', (message) => this.#handleMessage(message));
    stream.on('connected', () => this.#onStreamStatus(true));
    stream.on('disconnected', () => this.#onStreamStatus(false));
    stream.start();

    if (config.snapshot_interval > 0) {
      this.snapshotTimer = setInterval(() => this.pushSnapshots(), config.snapshot_interval * 1000);
    }
  }

  stop() {
    this.generation += 1;
    clearTimeout(this.retryTimer);
    clearInterval(this.snapshotTimer);
    this.retryTimer = null;
    this.snapshotTimer = null;
    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream.stop();
      this.stream = null;
    }
    this.client = null;
    this.lastValues.clear();
  }

  // --- SDK handlers ----------------------------------------------------------

  async scan() {
    const client = this.#requireClient();
    const frigateConfig = await client.getConfig();
    this.cameras = indexCameras(frigateConfig);
    await this.gladys.publishDiscoveredDevices(buildDiscoveredDevices(this.gladys, frigateConfig));
  }

  async setValue(device, feature, value) {
    const parsed = parseFeatureExternalId(this.gladys, feature.external_id);
    const setting = parsed && TOGGLES[parsed.key];
    if (!setting) {
      throw new Error(`Feature ${feature.external_id} cannot be controlled`);
    }
    if (!this.stream) {
      throw new Error('Frigate is not connected');
    }
    // Frigate confirms with `<camera>/<setting>/state`, which publishes the
    // new state back to Gladys (has_feedback).
    this.stream.send(`${parsed.camera}/${setting}/set`, Number(value) ? 'ON' : 'OFF');
  }

  async getImage(device) {
    const client = this.#requireClient();
    const camera = cameraNameOfDevice(this.gladys, device);
    if (!camera) {
      throw new Error(`Device ${device.external_id} is not a Frigate camera`);
    }
    return fetchSnapshot(client, camera, this.config.snapshot_height);
  }

  async onDeviceChanged(device) {
    const camera = cameraNameOfDevice(this.gladys, device);
    if (!camera) return;
    // Forget what was sent for this device, then ask Frigate for a fresh
    // state of every camera so the new device starts with real values.
    for (const feature of device.features ?? []) {
      this.lastValues.delete(feature.external_id);
    }
    if (this.stream?.connected) {
      this.stream.send('onConnect', '');
      await this.#publishTransports();
    }
  }

  async testConnection() {
    const config = normalizeConfig(this.gladys.config);
    const invalid = validateConfig(config);
    if (invalid) {
      throw new Error(invalid.en);
    }
    const client = this.createClient(config);
    const version = await client.checkVersion();
    const frigateConfig = await client.getConfig();
    const count = Object.keys(frigateConfig.cameras ?? {}).length;
    return {
      en: `Connected to Frigate ${version}: ${count} camera(s) found.`,
      fr: `Connecté à Frigate ${version} : ${count} caméra(s) trouvée(s).`,
    };
  }

  // --- Snapshots -------------------------------------------------------------

  /** Push a fresh image of every camera the user created. */
  async pushSnapshots() {
    if (this.snapshotBusy || !this.client) return;
    this.snapshotBusy = true;
    try {
      for (const camera of this.#createdCameras()) {
        await this.pushSnapshot(camera);
      }
    } finally {
      this.snapshotBusy = false;
    }
  }

  async pushSnapshot(camera) {
    const client = this.client;
    if (!client) return;
    const now = Date.now();
    if (now - (this.lastImageAt.get(camera) ?? 0) < MIN_IMAGE_SPACING_MS) return;
    this.lastImageAt.set(camera, now);
    try {
      const image = await fetchSnapshot(client, camera, this.config.snapshot_height);
      await this.gladys.publishCameraImage(cameraIds(this.gladys, camera).device, image);
    } catch (err) {
      this.logger.warn(`Snapshot of camera "${camera}" failed: ${err.message}`);
    }
  }

  // --- Internals -------------------------------------------------------------

  async #safeStart(rawConfig) {
    try {
      await this.start(rawConfig);
    } catch (err) {
      this.logger.error(`Frigate start crashed: ${err.message}`);
    }
  }

  #requireClient() {
    if (!this.client) {
      throw new Error('Frigate is not connected: check the configuration');
    }
    return this.client;
  }

  /** Frigate camera names of the devices the user created in Gladys. */
  #createdCameras() {
    return (this.gladys.devices ?? [])
      .map((device) => cameraNameOfDevice(this.gladys, device))
      .filter((camera) => camera && this.cameras.has(camera));
  }

  #createdFeatureIds() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async #handleMessage(message) {
    const effects = mapFrigateMessage(message, this.cameras);
    try {
      await this.#publishStates(effects.states);
      await this.#publishSceneEvents(effects.sceneEvents);
      for (const camera of effects.snapshots) {
        if (this.#createdCameras().includes(camera)) await this.pushSnapshot(camera);
      }
    } catch (err) {
      this.logger.warn(`Could not forward the Frigate message "${message.topic}": ${err.message}`);
    }
  }

  async #publishStates(states) {
    if (states.length === 0) return;
    const created = this.#createdFeatureIds();
    const changed = [];
    for (const { camera, key, value } of states) {
      const id = cameraIds(this.gladys, camera).feature(key);
      if (created.has(id) && this.lastValues.get(id) !== value) {
        this.lastValues.set(id, value);
        changed.push({ device_feature_external_id: id, state: value });
      }
    }
    for (const batch of chunk(changed, MAX_STATES_PER_REQUEST)) {
      await this.gladys.publishStates(batch);
    }
  }

  async #publishSceneEvents(events) {
    if (events.length === 0) return;
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    for (const { key, camera, data } of events) {
      const deviceId = cameraIds(this.gladys, camera).device;
      if (created.has(deviceId)) {
        await this.gladys.publishSceneEvent(key, { camera: deviceId, ...data });
      }
    }
  }

  async #onStreamStatus(connected) {
    if (!connected) {
      // States will be re-sent in full on the next `camera_activity`.
      this.lastValues.clear();
    }
    try {
      await this.#setStatus(
        connected,
        connected
          ? undefined
          : {
              en: 'Connection to Frigate lost, reconnecting.',
              fr: 'Connexion à Frigate perdue, reconnexion en cours.',
            },
      );
      await this.#publishTransports();
    } catch (err) {
      this.logger.warn(`Could not report the Frigate connection status: ${err.message}`);
    }
  }

  async #publishTransports() {
    const transport = this.stream?.connected ? 'local' : 'unreachable';
    const entries = this.#createdCameras().map((camera) => ({
      external_id: cameraIds(this.gladys, camera).device,
      transport,
    }));
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries);
    }
  }

  async #setStatus(connected, message) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.logger.warn(`Could not report the connection status: ${err.message}`);
    }
  }
}
