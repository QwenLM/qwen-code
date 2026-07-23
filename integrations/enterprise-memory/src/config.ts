/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function base64UrlSecret(name: string): Uint8Array {
  const encoded = required(name);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  const value = Buffer.from(encoded, 'base64url');
  if (value.length < 32 || value.toString('base64url') !== encoded) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

function listenPort(name: string, fallback: number): number {
  const encoded = process.env[name];
  if (encoded === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(encoded)) {
    throw new Error(`${name} is invalid`);
  }
  const value = Number(encoded);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function listenHost(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return value === 'true';
}

function httpsUrl(name: string): string {
  const value = new URL(required(name));
  if (value.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
  return value.toString();
}

function databaseUrl(name: string): string {
  const value = new URL(required(name));
  const sslModes = value.searchParams.getAll('sslmode');
  if (
    (value.protocol !== 'postgres:' && value.protocol !== 'postgresql:') ||
    value.hostname.length === 0 ||
    sslModes.length !== 1 ||
    sslModes[0] !== 'verify-full'
  ) {
    throw new Error(`${name} must use PostgreSQL with sslmode=verify-full`);
  }
  return value.toString();
}

export interface MemoryBackendConfig {
  tenantId: string;
  idempotencySecret: Uint8Array;
  entityHmacSecret: Uint8Array;
  entityHmacVersion: string;
  ledgerUrl: string;
  ledgerToken: string;
  contentProtectorUrl: string;
  contentProtectorToken: string;
  semanticIndexApiKey: string;
}

export interface RuntimeGatewayConfig extends MemoryBackendConfig {
  databaseUrl: string;
  capabilityIssuer: string;
  capabilityAudience: string;
  capabilityJwksUrl: string;
  requestHmacSecret: Uint8Array;
  tlsCertPath: string;
  tlsKeyPath: string;
  tlsClientCaPath: string;
  listenHost: string;
  listenPort: number;
  rawCaptureEnabled: boolean;
}

export interface ManagementGatewayConfig extends MemoryBackendConfig {
  databaseUrl: string;
  managementOidcIssuer: string;
  managementOidcAudience: string;
  managementOidcJwksUrl: string;
  listenHost: string;
  listenPort: number;
  tlsCertPath: string;
  tlsKeyPath: string;
  scmAuthorizationUrl: string;
  scmAuthorizationToken: string;
}

export function loadRuntimeGatewayConfig(): RuntimeGatewayConfig {
  const rawCaptureEnabled = optionalBoolean(
    'MEMORY_RAW_CAPTURE_ENABLED',
    false,
  );
  if (
    rawCaptureEnabled &&
    process.env['MEMORY_RETENTION_CONTROLLER_READY'] !== 'true'
  ) {
    throw new Error(
      'Raw capture requires MEMORY_RETENTION_CONTROLLER_READY=true',
    );
  }
  return {
    ...loadMemoryBackendConfig(),
    databaseUrl: databaseUrl('MEMORY_RUNTIME_DATABASE_URL'),
    capabilityIssuer: required('MEMORY_CAPABILITY_ISSUER'),
    capabilityAudience: required('MEMORY_CAPABILITY_AUDIENCE'),
    capabilityJwksUrl: httpsUrl('MEMORY_CAPABILITY_JWKS_URL'),
    requestHmacSecret: base64UrlSecret('MEMORY_REQUEST_HMAC_SECRET'),
    tlsCertPath: required('MEMORY_GATEWAY_TLS_CERT'),
    tlsKeyPath: required('MEMORY_GATEWAY_TLS_KEY'),
    tlsClientCaPath: required('MEMORY_GATEWAY_TLS_CLIENT_CA'),
    listenHost: listenHost('MEMORY_GATEWAY_HOST', '127.0.0.1'),
    listenPort: listenPort('MEMORY_GATEWAY_PORT', 8443),
    rawCaptureEnabled,
  };
}

export function loadManagementGatewayConfig(): ManagementGatewayConfig {
  return {
    ...loadMemoryBackendConfig(),
    databaseUrl: databaseUrl('MEMORY_MANAGEMENT_DATABASE_URL'),
    managementOidcIssuer: required('MEMORY_MANAGEMENT_OIDC_ISSUER'),
    managementOidcAudience: required('MEMORY_MANAGEMENT_OIDC_AUDIENCE'),
    managementOidcJwksUrl: httpsUrl('MEMORY_MANAGEMENT_OIDC_JWKS_URL'),
    listenHost: listenHost('MEMORY_MANAGEMENT_HOST', '127.0.0.1'),
    listenPort: listenPort('MEMORY_MANAGEMENT_PORT', 8444),
    tlsCertPath: required('MEMORY_MANAGEMENT_TLS_CERT'),
    tlsKeyPath: required('MEMORY_MANAGEMENT_TLS_KEY'),
    scmAuthorizationUrl: httpsUrl('MEMORY_SCM_AUTHORIZATION_URL'),
    scmAuthorizationToken: required('MEMORY_SCM_AUTHORIZATION_TOKEN'),
  };
}

function loadMemoryBackendConfig(): MemoryBackendConfig {
  const entityHmacVersion = required('MEMORY_ENTITY_HMAC_VERSION');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(entityHmacVersion)) {
    throw new Error('MEMORY_ENTITY_HMAC_VERSION is invalid');
  }
  return {
    tenantId: required('MEMORY_TENANT_ID'),
    idempotencySecret: base64UrlSecret('MEMORY_IDEMPOTENCY_HMAC_SECRET'),
    entityHmacSecret: base64UrlSecret('MEMORY_ENTITY_HMAC_SECRET'),
    entityHmacVersion,
    ledgerUrl: httpsUrl('MEMORY_LEDGER_URL'),
    ledgerToken: required('MEMORY_LEDGER_TOKEN'),
    contentProtectorUrl: httpsUrl('MEMORY_CONTENT_PROTECTOR_URL'),
    contentProtectorToken: required('MEMORY_CONTENT_PROTECTOR_TOKEN'),
    semanticIndexApiKey: required('MEMORY_SEMANTIC_INDEX_API_KEY'),
  };
}
