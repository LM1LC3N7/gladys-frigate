// -----------------------------------------------------------------------------
// TLS trust policy: "trust on first use" (TOFU) with optional expert pinning.
//
// Frigate's authenticated port (8971) serves a self-signed certificate by
// default, which no standard verification accepts. Instead of asking every
// user to copy a fingerprint, the integration:
//   1. accepts a certificate that validates normally (public CA, or the expert
//      custom CA) for the expected host name — nothing is pinned, so routine
//      renewals (Let's Encrypt…) keep working;
//   2. otherwise trusts the FIRST certificate it sees for that host:port and
//      pins its SHA-256 fingerprint in /data;
//   3. refuses any later certificate that does not match the pin, until the
//      user presses "Trust the new certificate" (the pin is then cleared and
//      the next certificate becomes the new pin).
// An expert fingerprint set in the configuration replaces steps 1–3: only
// that exact certificate is accepted.
//
// This module only DECIDES and STORES; the TLS connector (httpClient.js, the
// MQTT and WebSocket clients) feeds it the peer certificate facts. It must not
// depend on the Gladys SDK (layering rule).
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const TRUST_REASONS = Object.freeze({
  /** Matches the fingerprint set in the expert configuration. */
  MANUAL_PIN: 'manual-pin',
  /** Does not match the fingerprint set in the expert configuration. */
  MANUAL_PIN_MISMATCH: 'manual-pin-mismatch',
  /** Validated by a certificate authority (system store or expert CA). */
  CA_VERIFIED: 'ca-verified',
  /** Expert CA set, but the certificate does not validate against it. */
  CA_REJECTED: 'ca-rejected',
  /** First certificate seen for this endpoint: trusted and pinned. */
  FIRST_USE: 'first-use',
  /** Matches the certificate pinned on first use. */
  PINNED: 'pinned',
  /** Differs from the certificate pinned on first use. */
  CERTIFICATE_CHANGED: 'certificate-changed',
});

/**
 * Decide whether a TLS peer certificate is trusted.
 * @param {object} peer
 * @param {string} peer.fingerprint SHA-256 fingerprint, Node `fingerprint256` format
 * @param {boolean} peer.chainValid the chain validates against the CA in use
 *   (system store, or the expert CA when one is configured)
 * @param {boolean} peer.hostnameValid the certificate covers the host name
 * @param {object} policy
 * @param {string} [policy.manualFingerprint] expert pin from the configuration
 * @param {boolean} [policy.customCa] an expert CA is configured
 * @param {string} [policy.pinnedFingerprint] fingerprint pinned on first use
 * @returns {{ trusted: boolean, reason: string, pin?: string }} `pin` is set
 *   when the caller must store a new first-use pin
 */
export function decideTrust(peer, policy = {}) {
  const fingerprint = String(peer.fingerprint ?? '').toUpperCase();
  if (policy.manualFingerprint) {
    return fingerprint && fingerprint === policy.manualFingerprint.toUpperCase()
      ? { trusted: true, reason: TRUST_REASONS.MANUAL_PIN }
      : { trusted: false, reason: TRUST_REASONS.MANUAL_PIN_MISMATCH };
  }
  if (peer.chainValid && peer.hostnameValid) {
    return { trusted: true, reason: TRUST_REASONS.CA_VERIFIED };
  }
  if (policy.customCa) {
    // The user chose their own authority: never fall back to first use.
    return { trusted: false, reason: TRUST_REASONS.CA_REJECTED };
  }
  if (!fingerprint) {
    return { trusted: false, reason: TRUST_REASONS.CERTIFICATE_CHANGED };
  }
  if (!policy.pinnedFingerprint) {
    return { trusted: true, reason: TRUST_REASONS.FIRST_USE, pin: fingerprint };
  }
  return fingerprint === policy.pinnedFingerprint.toUpperCase()
    ? { trusted: true, reason: TRUST_REASONS.PINNED }
    : { trusted: false, reason: TRUST_REASONS.CERTIFICATE_CHANGED };
}

/** Key of a TLS endpoint in the trust store ("host:port", host lowercased). */
export function endpointKey(host, port) {
  return `${String(host).toLowerCase()}:${Number(port)}`;
}

/**
 * Persistent store of first-use pins, as a small JSON file in the writable
 * /data volume: `{ "<host>:<port>": { fingerprint, pinned_at } }`.
 * Writes are atomic (temporary file + rename). When the file cannot be
 * written (no /data during development), pins stay in memory.
 */
export class TrustStore {
  /**
   * @param {object} options
   * @param {string} options.filePath e.g. /data/tls-trust.json
   * @param {{ warn: Function }} [options.logger]
   * @param {() => Date} [options.now]
   */
  constructor({ filePath, logger, now = () => new Date() }) {
    this.filePath = filePath;
    this.logger = logger;
    this.now = now;
    this.pins = new Map();
    this.loaded = false;
  }

  async load() {
    try {
      const content = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.pins = new Map(
        Object.entries(content ?? {}).filter(
          ([, entry]) => entry && typeof entry.fingerprint === 'string',
        ),
      );
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn(`TLS trust store unreadable, starting empty: ${err.message}`);
      }
      this.pins = new Map();
    }
    this.loaded = true;
    return this;
  }

  /** @returns {string | undefined} the pinned fingerprint of an endpoint */
  get(key) {
    return this.pins.get(key)?.fingerprint;
  }

  /** @returns {Array<{ endpoint: string, fingerprint: string, pinned_at: string }>} */
  list() {
    return [...this.pins].map(([endpoint, entry]) => ({ endpoint, ...entry }));
  }

  async set(key, fingerprint) {
    this.pins.set(key, { fingerprint, pinned_at: this.now().toISOString() });
    await this.#save();
  }

  /** Forget one endpoint, or every endpoint when no key is given. */
  async reset(key) {
    if (key === undefined) {
      this.pins.clear();
    } else {
      this.pins.delete(key);
    }
    await this.#save();
  }

  async #save() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.pins), null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, this.filePath);
    } catch (err) {
      this.logger?.warn(`TLS trust store not saved, pins kept in memory only: ${err.message}`);
    }
  }
}
