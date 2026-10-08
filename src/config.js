// -----------------------------------------------------------------------------
// Integration configuration: defaults, normalization, validation, warnings.
//
// The user fills the form Gladys generates from the manifest `config_schema`;
// the SDK hands us raw values (strings, numbers, booleans, or nothing for a
// field never saved). Everything else reads the output of `normalizeConfig()`,
// so the defaults live here and stay aligned with the manifest
// (test/manifest.test.js checks it).
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  frigate_url: '',
  username: '',
  password: '',
  mqtt_host: '',
  mqtt_port: 1883,
  mqtt_username: '',
  mqtt_password: '',
  mqtt_tls: false,
  mqtt_topic_prefix: 'frigate',
  min_score: 70,
  trigger_cooldown: 30,
  zone_sensors: false,
  // Expert TLS settings, both optional. Without them, a certificate signed by
  // a public authority is verified normally and a self-signed one (Frigate's
  // default on port 8971) is trusted on first use, then pinned.
  tls_fingerprint: '',
  tls_ca: '',
});

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function integer(value, fallback, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && value !== '' && value !== null
    ? Math.min(max, Math.max(min, n))
    : fallback;
}

/**
 * Rebuild well-formed PEM certificates from a paste. The Gladys form has no
 * multi-line field, so a certificate pasted there arrives on a single line:
 * the base64 body is re-wrapped at 64 characters.
 * @param {string} raw
 * @returns {string} zero, one or several PEM blocks separated by newlines
 */
export function normalizePem(raw) {
  const blocks = [];
  for (const [, body] of String(raw ?? '').matchAll(PEM_BLOCK)) {
    const base64 = body.replace(/\s+/g, '');
    if (base64) {
      const lines = base64.match(/.{1,64}/g).join('\n');
      blocks.push(`-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`);
    }
  }
  return blocks.join('\n');
}

/**
 * Normalize a SHA-256 certificate fingerprint to Node's `fingerprint256`
 * format ("AB:CD:…", 32 uppercase pairs). Returns '' when it is not one.
 * @param {string} raw
 */
export function normalizeFingerprint(raw) {
  const hex = String(raw ?? '')
    .replace(/^.*=/s, '') // "SHA256 Fingerprint=AB:CD…" (openssl output)
    .replace(/^\s*sha-?256\s*:?/i, '') // "sha256:AB:CD…"
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return hex.length === 64 ? hex.match(/.{2}/g).join(':') : '';
}

/**
 * Merge the raw user configuration with the defaults.
 * @param {Record<string, unknown>} [raw] configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    frigate_url: text(raw.frigate_url).replace(/\/+$/, ''),
    username: text(raw.username),
    password: raw.password == null ? '' : String(raw.password),
    mqtt_host: text(raw.mqtt_host),
    mqtt_port: integer(raw.mqtt_port, DEFAULT_CONFIG.mqtt_port, 1, 65535),
    mqtt_username: text(raw.mqtt_username),
    mqtt_password: raw.mqtt_password == null ? '' : String(raw.mqtt_password),
    mqtt_tls: raw.mqtt_tls === true,
    mqtt_topic_prefix:
      text(raw.mqtt_topic_prefix).replace(/^\/+|\/+$/g, '') || DEFAULT_CONFIG.mqtt_topic_prefix,
    min_score: integer(raw.min_score, DEFAULT_CONFIG.min_score, 0, 100),
    trigger_cooldown: integer(raw.trigger_cooldown, DEFAULT_CONFIG.trigger_cooldown, 0, 3600),
    zone_sensors: raw.zone_sensors === true,
    tls_fingerprint: normalizeFingerprint(raw.tls_fingerprint),
    tls_ca: normalizePem(raw.tls_ca),
  };
}

/** True when real-time data comes from MQTT (otherwise: Frigate WebSocket). */
export function usesMqtt(config) {
  return Boolean(config.mqtt_host);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Check that the configuration is usable.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {Record<string, unknown>} [raw] the raw values, to report a field the
 *   user filled but that could not be parsed (certificate, fingerprint)
 * @returns {{ en: string, fr: string } | null} a user-facing error, or null
 */
export function validateConfig(config, raw = {}) {
  if (!config.frigate_url) {
    return {
      en: 'Enter the URL of your Frigate server.',
      fr: "Renseignez l'URL de votre serveur Frigate.",
    };
  }
  const url = parseUrl(config.frigate_url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return {
      en: 'The Frigate URL must look like https://192.168.1.10:8971.',
      fr: "L'URL de Frigate doit ressembler à https://192.168.1.10:8971.",
    };
  }
  if (url.username || url.password || url.search || url.hash) {
    return {
      en: 'The Frigate URL must not contain credentials, a query string or a fragment.',
      fr: "L'URL de Frigate ne doit contenir ni identifiants, ni paramètres, ni fragment.",
    };
  }
  if (Boolean(config.username) !== Boolean(config.password)) {
    return {
      en: 'Fill in both the Frigate username and password, or leave both empty.',
      fr: "Renseignez l'utilisateur et le mot de passe Frigate, ou laissez les deux vides.",
    };
  }
  if (text(raw.tls_fingerprint) && !config.tls_fingerprint) {
    return {
      en: 'The certificate fingerprint must be a SHA-256 (64 hexadecimal characters).',
      fr: "L'empreinte du certificat doit être un SHA-256 (64 caractères hexadécimaux).",
    };
  }
  if (text(raw.tls_ca)) {
    let valid = Boolean(config.tls_ca);
    try {
      for (const [block] of config.tls_ca.matchAll(PEM_BLOCK)) new X509Certificate(block);
    } catch {
      valid = false;
    }
    if (!valid) {
      return {
        en: 'The certificate authority is not a valid PEM certificate.',
        fr: "L'autorité de certification n'est pas un certificat PEM valide.",
      };
    }
  }
  if (config.tls_fingerprint && config.tls_ca) {
    return {
      en: 'Fill in either the certificate fingerprint or the certificate authority, not both.',
      fr: "Renseignez soit l'empreinte du certificat, soit l'autorité de certification, pas les deux.",
    };
  }
  if (usesMqtt(config) && /[+#\s]/.test(config.mqtt_topic_prefix)) {
    return {
      en: 'The MQTT topic prefix must not contain spaces or the wildcards + and #.',
      fr: 'Le préfixe des topics MQTT ne doit contenir ni espace, ni les jokers + et #.',
    };
  }
  return null;
}

/**
 * Non-blocking security warnings, shown in the connection status message.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {Array<{ en: string, fr: string }>}
 */
export function configWarnings(config) {
  const warnings = [];
  const url = parseUrl(config.frigate_url);
  if (!url) return warnings;
  if (url.protocol === 'http:' && !config.username) {
    warnings.push({
      en: 'Unauthenticated Frigate port (5000): anyone on the network has admin access. Prefer port 8971.',
      fr: "Port Frigate non authentifié (5000) : n'importe qui sur le réseau a un accès admin. Préférez le port 8971.",
    });
  } else if (url.protocol === 'http:') {
    warnings.push({
      en: 'The Frigate password travels unencrypted over HTTP. Prefer https:// on port 8971.',
      fr: 'Le mot de passe Frigate circule en clair en HTTP. Préférez https:// sur le port 8971.',
    });
  }
  if (usesMqtt(config) && config.mqtt_password && !config.mqtt_tls) {
    warnings.push({
      en: 'The MQTT password travels unencrypted: enable TLS on the broker if it is not on a trusted network.',
      fr: "Le mot de passe MQTT circule en clair : activez TLS sur le broker s'il n'est pas sur un réseau de confiance.",
    });
  }
  return warnings;
}
