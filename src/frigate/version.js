// -----------------------------------------------------------------------------
// Frigate version gate.
//
// This integration targets the latest Frigate release only (0.18). Older
// versions expose a different authentication model and WebSocket topics, so
// they are refused up front with a clear message instead of half-working.
// -----------------------------------------------------------------------------

export const MIN_FRIGATE_VERSION = '0.18.0';

export class UnsupportedFrigateVersionError extends Error {
  constructor(version) {
    super(
      `Frigate ${version} is not supported: version ${MIN_FRIGATE_VERSION} or later is required`,
    );
    this.name = 'UnsupportedFrigateVersionError';
    this.version = version;
  }
}

/**
 * Parse a Frigate version string ("0.18.0-1a2b3c4", "0.18.1").
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return false;
  }
  const min = parseVersion(MIN_FRIGATE_VERSION);
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] !== min[i]) {
      return parsed[i] > min[i];
    }
  }
  return true;
}

export function assertSupportedVersion(version) {
  if (!isSupportedVersion(version)) {
    throw new UnsupportedFrigateVersionError(version);
  }
}
