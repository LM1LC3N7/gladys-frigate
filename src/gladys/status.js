// -----------------------------------------------------------------------------
// Connection status message shown on the Configuration screen of Gladys.
//
// Combines the blocking configuration error (if any) with the non-blocking
// security warnings, so the user sees, for instance, that the unauthenticated
// port 5000 is in use even when everything works.
// -----------------------------------------------------------------------------

import { configWarnings, validateConfig } from '../config.js';

// Gladys caps the status message; keep well under it.
const MAX_MESSAGE_LENGTH = 500;

function join(parts, lang) {
  const message = parts.map((p) => p[lang]).join(' ');
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : message;
}

/**
 * One status message out of several sentences (en/fr each), kept under the
 * length Gladys accepts. Empty parts are skipped; no part at all -> undefined.
 * @param {Array<{ en: string, fr: string } | null | undefined>} parts
 */
export function composeMessage(parts) {
  const kept = parts.filter(Boolean);
  return kept.length === 0 ? undefined : { en: join(kept, 'en'), fr: join(kept, 'fr') };
}

/**
 * @param {ReturnType<import('../config.js').normalizeConfig>} config
 * @param {Record<string, unknown>} [raw]
 * @returns {{ valid: boolean, message: { en: string, fr: string } | undefined }}
 */
export function describeConfig(config, raw) {
  const error = validateConfig(config, raw);
  if (error) {
    return { valid: false, message: error };
  }
  return { valid: true, message: composeMessage(configWarnings(config)) };
}
