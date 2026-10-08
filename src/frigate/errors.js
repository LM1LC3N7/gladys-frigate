// -----------------------------------------------------------------------------
// Typed errors of the Frigate client.
//
// The Gladys adapter turns them into user-facing messages (src/gladys/
// messages.js); the client itself only states facts. No message ever carries
// a password, a token, a cookie or a request body.
// -----------------------------------------------------------------------------

export class FrigateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The TLS peer was not trusted: the request was never sent. */
export class CertificateError extends FrigateError {
  /**
   * @param {string} reason a TRUST_REASONS value (src/frigate/tlsTrust.js)
   * @param {string} endpoint "host:port"
   * @param {string} fingerprint SHA-256 of the certificate that was refused
   */
  constructor(reason, endpoint, fingerprint) {
    super(`Untrusted certificate for ${endpoint} (${reason})`);
    this.reason = reason;
    this.endpoint = endpoint;
    this.fingerprint = fingerprint;
  }
}

/**
 * Frigate refused the credentials, or asked for some while none are
 * configured. `code`: 'invalid_credentials' | 'credentials_required' |
 * 'rate_limited' | 'forbidden'.
 */
export class AuthError extends FrigateError {
  constructor(code) {
    super(`Frigate authentication failed (${code})`);
    this.code = code;
  }
}

/** Frigate answered with an unexpected HTTP status. */
export class HttpStatusError extends FrigateError {
  constructor(status, path) {
    super(`Frigate answered HTTP ${status} on ${path}`);
    this.status = status;
    this.path = path;
  }
}

/** No answer: DNS, refused or reset connection, timeout. */
export class UnreachableError extends FrigateError {
  /** @param {string} code a Node error code (ECONNREFUSED…) or 'TIMEOUT' */
  constructor(code, options) {
    super(`Frigate is unreachable (${code})`, options);
    this.code = code;
  }
}

/** Frigate older than the oldest supported version (0.16). */
export class UnsupportedVersionError extends FrigateError {
  constructor(version) {
    super(`Frigate ${version} is not supported (0.16 or later required)`);
    this.version = version;
  }
}

/** The MQTT broker refused the connection (CONNACK return code). */
export class MqttRefusedError extends FrigateError {
  /** @param {'invalid_credentials' | 'not_authorized' | 'refused'} code */
  constructor(code) {
    super(`The MQTT broker refused the connection (${code})`);
    this.code = code;
  }
}
