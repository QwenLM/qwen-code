/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeGatewayConfig } from './config.js';

const secret = Buffer.alloc(32, 7).toString('base64url');

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubRuntimeEnvironment(): void {
  const values = {
    MEMORY_TENANT_ID: 'tenant-a',
    MEMORY_IDEMPOTENCY_HMAC_SECRET: secret,
    MEMORY_ENTITY_HMAC_SECRET: secret,
    MEMORY_ENTITY_HMAC_VERSION: 'v1',
    MEMORY_LEDGER_URL: 'https://ledger.example.test',
    MEMORY_LEDGER_TOKEN: 'ledger-token',
    MEMORY_CONTENT_PROTECTOR_URL: 'https://keys.example.test',
    MEMORY_CONTENT_PROTECTOR_TOKEN: 'key-token',
    MEM0_API_KEY: 'mem0-token',
    MEMORY_RUNTIME_DATABASE_URL:
      'postgresql://runtime@db.example.test/memory?sslmode=verify-full',
    MEMORY_CAPABILITY_ISSUER: 'https://broker.example.test',
    MEMORY_CAPABILITY_AUDIENCE: 'memory-gateway',
    MEMORY_CAPABILITY_JWKS_URL: 'https://broker.example.test/jwks.json',
    MEMORY_REQUEST_HMAC_SECRET: secret,
    MEMORY_GATEWAY_TLS_CERT: '/run/memory/tls.crt',
    MEMORY_GATEWAY_TLS_KEY: '/run/memory/tls.key',
    MEMORY_GATEWAY_TLS_CLIENT_CA: '/run/memory/client-ca.crt',
  };
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
}

describe('runtime gateway configuration', () => {
  it('uses loopback, fixed ports, and disabled raw capture by default', () => {
    stubRuntimeEnvironment();

    expect(loadRuntimeGatewayConfig()).toMatchObject({
      listenHost: '127.0.0.1',
      listenPort: 8443,
      rawCaptureEnabled: false,
    });
  });

  it.each([
    ['MEMORY_GATEWAY_PORT', '8443junk'],
    ['MEMORY_GATEWAY_PORT', '0'],
    ['MEMORY_GATEWAY_HOST', ''],
    ['MEMORY_RAW_CAPTURE_ENABLED', 'TRUE'],
    ['MEMORY_ENTITY_HMAC_VERSION', 'version with spaces'],
    ['MEMORY_REQUEST_HMAC_SECRET', `${secret}!`],
  ])(
    'rejects invalid %s values instead of silently coercing them',
    (name, value) => {
      stubRuntimeEnvironment();
      vi.stubEnv(name, value);

      expect(() => loadRuntimeGatewayConfig()).toThrow();
    },
  );

  it('rejects duplicate sslmode parameters that pg would resolve by last value', () => {
    stubRuntimeEnvironment();
    vi.stubEnv(
      'MEMORY_RUNTIME_DATABASE_URL',
      'postgresql://runtime@db.example.test/memory?sslmode=verify-full&sslmode=disable',
    );

    expect(() => loadRuntimeGatewayConfig()).toThrow('sslmode=verify-full');
  });

  it('rejects a local socket URL that cannot provide hostname verification', () => {
    stubRuntimeEnvironment();
    vi.stubEnv(
      'MEMORY_RUNTIME_DATABASE_URL',
      'postgresql:///memory?sslmode=verify-full',
    );

    expect(() => loadRuntimeGatewayConfig()).toThrow('sslmode=verify-full');
  });
});
