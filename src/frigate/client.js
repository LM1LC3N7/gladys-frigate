// -----------------------------------------------------------------------------
// Frigate HTTP API client (Frigate 0.18+).
//
// Two ways to reach Frigate:
//   - the internal port (5000): no authentication, every request is admin;
//   - the authenticated port (8971, HTTPS with a self-signed certificate by
//     default): POST /api/login returns a JWT in a cookie, which Frigate also
//     accepts as an `Authorization: Bearer` header.
// The client logs in lazily, and logs in again once when a request is answered
// with a 401 (expired session).
// -----------------------------------------------------------------------------

import { httpRequest, HttpError } from './http.js';
import { assertSupportedVersion } from './version.js';

export class FrigateAuthError extends HttpError {
  constructor(message) {
    super(message, { status: 401 });
    this.name = 'FrigateAuthError';
  }
}

/**
 * Extract the value of the first cookie of a `set-cookie` header.
 * @param {string[] | string | undefined} setCookie
 * @returns {string | null}
 */
export function extractCookieValue(setCookie) {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!first) {
    return null;
  }
  const pair = first.split(';', 1)[0];
  const index = pair.indexOf('=');
  if (index <= 0) {
    return null;
  }
  const value = pair.slice(index + 1).trim();
  return value || null;
}

export class FrigateClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, e.g. http://192.168.1.10:5000
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {boolean} [options.allowSelfSigned]
   * @param {typeof httpRequest} [options.request] injectable for tests
   */
  constructor({
    url,
    username = '',
    password = '',
    allowSelfSigned = false,
    request = httpRequest,
  }) {
    this.baseUrl = url.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.allowSelfSigned = allowSelfSigned;
    this.request = request;
    this.token = null;
  }

  get hasCredentials() {
    return Boolean(this.username && this.password);
  }

  /** Options shared by the HTTP and WebSocket connections. */
  get tlsOptions() {
    return { rejectUnauthorized: !this.allowSelfSigned };
  }

  /** Headers authenticating a request (HTTP or WebSocket upgrade). */
  authHeaders() {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** URL of the Frigate WebSocket (same feed as MQTT: events, reviews, states). */
  get webSocketUrl() {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws`;
  }

  async login() {
    this.token = null;
    if (!this.hasCredentials) {
      return;
    }
    const res = await this.request(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: this.username, password: this.password }),
      ...this.tlsOptions,
    });
    if (res.status === 404) {
      // Authentication is disabled on this Frigate (or this is the internal
      // port): requests go through without a token.
      return;
    }
    if (res.status === 401) {
      throw new FrigateAuthError('Frigate rejected the username or password');
    }
    if (res.status !== 200) {
      throw new HttpError(`Frigate login failed (HTTP ${res.status})`, { status: res.status });
    }
    const token = extractCookieValue(res.headers['set-cookie']);
    if (!token) {
      throw new HttpError('Frigate login succeeded but returned no session token');
    }
    this.token = token;
  }

  /** Log in if credentials are set and no session is open yet. */
  async ensureSession() {
    if (this.hasCredentials && !this.token) {
      await this.login();
    }
  }

  async #get(path, { accept = 'application/json' } = {}) {
    await this.ensureSession();
    const send = () =>
      this.request(`${this.baseUrl}${path}`, {
        headers: { accept, ...this.authHeaders() },
        ...this.tlsOptions,
      });
    let res = await send();
    if (res.status === 401 && this.hasCredentials) {
      await this.login();
      res = await send();
    }
    if (res.status === 401 || res.status === 403) {
      throw new FrigateAuthError(
        this.hasCredentials
          ? `Frigate refused access to ${path} (HTTP ${res.status})`
          : `Frigate requires authentication: set a username and password (HTTP ${res.status})`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(`Frigate answered HTTP ${res.status} on ${path}`, { status: res.status });
    }
    return res;
  }

  async #getJson(path) {
    const res = await this.#get(path);
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new HttpError(`Frigate returned invalid JSON on ${path}`);
    }
  }

  /** @returns {Promise<string>} e.g. "0.18.0-1a2b3c4" */
  async getVersion() {
    const res = await this.#get('/api/version', { accept: 'text/plain' });
    return res.body.toString('utf8').trim();
  }

  /** Fetch the version and throw if this Frigate is older than supported. */
  async checkVersion() {
    const version = await this.getVersion();
    assertSupportedVersion(version);
    return version;
  }

  /** @returns {Promise<object>} the full Frigate configuration */
  async getConfig() {
    return this.#getJson('/api/config');
  }

  /**
   * Latest frame of a camera, as JPEG.
   * @param {string} camera Frigate camera name
   * @param {{ height?: number, quality?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async getLatestJpeg(camera, { height, quality } = {}) {
    const params = new URLSearchParams();
    if (height) params.set('height', String(height));
    if (quality) params.set('quality', String(quality));
    const query = params.size > 0 ? `?${params}` : '';
    const res = await this.#get(`/api/${encodeURIComponent(camera)}/latest.jpg${query}`, {
      accept: 'image/jpeg',
    });
    return res.body;
  }
}
