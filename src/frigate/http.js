// -----------------------------------------------------------------------------
// Minimal HTTP(S) client built on node:http / node:https.
//
// Why not the global `fetch`: Frigate's authenticated port (8971) serves a
// self-signed certificate by default, and `fetch` offers no per-request way to
// accept it without pulling in undici. node:https does, through the standard
// `rejectUnauthorized` option — which we only relax when the user explicitly
// opts in (`allow_self_signed`).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

export const DEFAULT_TIMEOUT_MS = 10_000;
// The integration container is capped at 256 MB: never buffer an unbounded body.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Perform an HTTP request and buffer the response body.
 * @param {string | URL} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string | Buffer} [options.body]
 * @param {boolean} [options.rejectUnauthorized] verify the TLS certificate (default true)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }>}
 */
export function httpRequest(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const rejectUnauthorized = options.rejectUnauthorized !== false;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method,
        headers:
          body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
        ...(target.protocol === 'https:' ? { rejectUnauthorized } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new HttpError(`Response from ${target.origin} is too large`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`Request to ${target.origin} timed out`, { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => {
      reject(err instanceof HttpError ? err : new HttpError(err.message, { code: err.code }));
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
