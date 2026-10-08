// -----------------------------------------------------------------------------
// HTTP client of the Frigate API.
//
//   - TLS: every https connection goes through the trust-on-first-use
//     connector (./tlsConnector.js): the request, Bearer token included, is
//     only written once the certificate is trusted.
//   - Auth: requests first go out without a token. A 401 means Frigate wants
//     one: log in (POST /api/login), keep the JWT from the Set-Cookie header,
//     send it as `Authorization: Bearer`, renew it 5 minutes before its `exp`
//     and once on a later 401. A 200 without a token means the port has no
//     authentication (5000, or auth disabled). Login is rate-limited by
//     Frigate: a refused login is never retried.
//   - Robustness: 10 s timeout, response size cap, redirects never followed
//     (the token stays on this origin), GET retried with backoff on network
//     errors and 5xx, Retry-After honored on 429, 4xx never retried.
//   - Errors are the typed ones of ./errors.js; none carries a secret.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { Agent, fetch } from 'undici';
import { AuthError, FrigateError, HttpStatusError, UnreachableError } from './errors.js';
import { createConnector } from './tlsConnector.js';
import { TRUST_REASONS } from './tlsTrust.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 30_000;

/** `exp` (ms) of a JWT, read without checking the signature; null if absent. */
export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Value of the first cookie of a Set-Cookie list (Frigate's JWT cookie). */
export function firstCookieValue(setCookies) {
  const first = [setCookies].flat().find(Boolean);
  if (!first) {
    return null;
  }
  const pair = first.split(';')[0];
  const index = pair.indexOf('=');
  const value = index === -1 ? '' : pair.slice(index + 1).trim();
  return value || null;
}

/** The error behind undici's generic "fetch failed", as one of ./errors.js. */
function toFrigateError(err) {
  if (err instanceof FrigateError) {
    return err;
  }
  const cause = err?.cause ?? err;
  if (cause instanceof FrigateError) {
    return cause;
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new UnreachableError('TIMEOUT');
  }
  return new UnreachableError(cause?.code ?? 'NETWORK');
}

const isRetryable = (err) => err instanceof UnreachableError;

/**
 * @param {object} options
 * @param {string} options.url base URL, e.g. https://192.168.1.10:8971
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {import('./tlsTrust.js').TrustStore} options.trustStore loaded store
 * @param {string} [options.tlsFingerprint] expert pin
 * @param {string} [options.tlsCa] expert authority (PEM)
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries] extra attempts for an idempotent request
 * @param {number} [options.retryDelayMs] first backoff delay, doubled each time
 * @param {() => number} [options.now]
 */
export function createFrigateClient({
  url,
  username = '',
  password = '',
  trustStore,
  tlsFingerprint = '',
  tlsCa = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 2,
  retryDelayMs = 500,
  now = Date.now,
}) {
  const base = new URL(url);
  const basePath = base.pathname.replace(/\/+$/, '');
  let tlsDecision = null;
  const dispatcher = new Agent({
    connect: createConnector(
      {
        trustStore,
        manualFingerprint: tlsFingerprint,
        ca: tlsCa,
        onDecision: (decision) => {
          // Keep "trusted on first use" over the "pinned" of the next
          // connections to the same certificate: it is the news to report.
          const firstUseKept =
            tlsDecision?.reason === TRUST_REASONS.FIRST_USE &&
            decision.reason === TRUST_REASONS.PINNED &&
            decision.fingerprint === tlsDecision.fingerprint;
          if (!firstUseKept) {
            tlsDecision = decision;
          }
        },
      },
      timeoutMs,
    ),
  });

  const auth = {
    // 'unknown' until the first answer, then 'token' (logged in), 'none'
    // (the port answered without a token) or 'disabled' (login 404: auth
    // disabled in Frigate 0.18+).
    mode: 'unknown',
    token: null,
    expiresAt: null,
  };
  const hasCredentials = Boolean(username && password);

  function target(path) {
    const target = new URL(base.href);
    const [pathname, search] = path.split('?');
    target.pathname = `${basePath}${pathname}`;
    target.search = search ? `?${search}` : '';
    return target;
  }

  async function once(path, { method = 'GET', json, withToken = true } = {}) {
    const headers = { accept: 'application/json, text/plain, image/*' };
    if (withToken && auth.token) {
      headers.authorization = `Bearer ${auth.token}`;
    }
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    try {
      return await fetch(target(path), {
        method,
        headers,
        body,
        dispatcher,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toFrigateError(err);
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** One request, retried with backoff when idempotent (GET). */
  async function send(path, options = {}) {
    const attempts = (options.method ?? 'GET') === 'GET' ? 1 + retries : 1;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await once(path, options);
      } catch (err) {
        if (attempt < attempts && isRetryable(err)) {
          await sleep(retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
      const retryable = response.status >= 500 || response.status === 429;
      if (attempt < attempts && retryable) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await sleep(
          response.status === 429 && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
            : retryDelayMs * 2 ** (attempt - 1),
        );
        continue;
      }
      return response;
    }
  }

  async function login() {
    const response = await once('/api/login', {
      method: 'POST',
      json: { user: username, password },
      withToken: false,
    });
    await response.body?.cancel();
    if (response.status === 404) {
      // Frigate 0.18 answers 404 when authentication is disabled.
      auth.mode = 'disabled';
      auth.token = null;
      return;
    }
    if (response.status === 401 || response.status === 400) {
      throw new AuthError('invalid_credentials');
    }
    if (response.status === 429) {
      throw new AuthError('rate_limited');
    }
    if (!response.ok) {
      throw new HttpStatusError(response.status, '/api/login');
    }
    const token = firstCookieValue(response.headers.getSetCookie());
    if (!token) {
      throw new HttpStatusError(response.status, '/api/login');
    }
    auth.mode = 'token';
    auth.token = token;
    auth.expiresAt = jwtExpiry(token);
  }

  async function readBody(response, maxBytes) {
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) {
          await response.body.cancel().catch(() => {});
          throw new FrigateError(`Frigate response over ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks);
  }

  /**
   * Authenticated request; resolves the raw body as a Buffer.
   * @param {string} path e.g. /api/config
   * @param {{ maxBytes?: number }} [options]
   */
  async function request(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (auth.mode === 'token' && auth.expiresAt && auth.expiresAt - now() < TOKEN_RENEW_MARGIN_MS) {
      await login();
    }
    let response = await send(path);
    if (response.status === 401) {
      await response.body?.cancel();
      if (!hasCredentials) {
        throw new AuthError('credentials_required');
      }
      await login();
      response = await send(path);
      if (response.status === 401) {
        await response.body?.cancel();
        throw new AuthError('invalid_credentials');
      }
    } else if (auth.mode === 'unknown' && response.ok) {
      auth.mode = 'none';
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new AuthError('forbidden');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatusError(response.status, path.split('?')[0]);
    }
    return readBody(response, maxBytes);
  }

  return {
    request,
    async getText(path) {
      return (await request(path)).toString('utf8');
    },
    async getJson(path) {
      const text = (await request(path)).toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        throw new FrigateError(`Frigate answered invalid JSON on ${path.split('?')[0]}`);
      }
    },
    /** GET /api/version: the version string, e.g. "0.16.4-4131252". */
    async getVersion() {
      return (await this.getText('/api/version')).trim().replace(/^"|"$/g, '');
    },
    getConfig() {
      return this.getJson('/api/config');
    },
    getStats() {
      return this.getJson('/api/stats');
    },
    /** How the last request authenticated, see `auth.mode`. */
    get authMode() {
      return auth.mode;
    },
    /** The last TLS trust decision (null over plain http). */
    get tlsDecision() {
      return tlsDecision;
    },
    async close() {
      await dispatcher.close().catch(() => {});
    },
  };
}
