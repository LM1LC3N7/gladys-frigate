// Test-only TLS material (see test/fixtures/tls/README.md).

import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../fixtures/tls/${name}`, import.meta.url), 'utf8');

export const TEST_CA_PEM = read('ca.pem');
export const TEST_SERVER_CERT_PEM = read('server.pem');
export const TEST_SERVER_KEY_PEM = read('server.key');
