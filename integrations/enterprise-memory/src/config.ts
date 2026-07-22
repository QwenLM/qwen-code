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
  const value = Buffer.from(required(name), 'base64url');
  if (value.length < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
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
  if (
    (value.protocol !== 'postgres:' && value.protocol !== 'postgresql:') ||
    value.searchParams.get('sslmode') !== 'verify-full'
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
  mem0ApiKey: string;
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
  const listenPort = Number.parseInt(
    process.env['MEMORY_GATEWAY_PORT'] ?? '8443',
    10,
  );
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error('MEMORY_GATEWAY_PORT is invalid');
  }
  const rawCaptureEnabled =
    process.env['MEMORY_RAW_CAPTURE_ENABLED'] === 'true';
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
    listenHost: process.env['MEMORY_GATEWAY_HOST'] ?? '127.0.0.1',
    listenPort,
    rawCaptureEnabled,
  };
}

export function loadManagementGatewayConfig(): ManagementGatewayConfig {
  const listenPort = Number.parseInt(
    process.env['MEMORY_MANAGEMENT_PORT'] ?? '8444',
    10,
  );
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new Error('MEMORY_MANAGEMENT_PORT is invalid');
  }
  return {
    ...loadMemoryBackendConfig(),
    databaseUrl: databaseUrl('MEMORY_MANAGEMENT_DATABASE_URL'),
    managementOidcIssuer: required('MEMORY_MANAGEMENT_OIDC_ISSUER'),
    managementOidcAudience: required('MEMORY_MANAGEMENT_OIDC_AUDIENCE'),
    managementOidcJwksUrl: httpsUrl('MEMORY_MANAGEMENT_OIDC_JWKS_URL'),
    listenHost: process.env['MEMORY_MANAGEMENT_HOST'] ?? '127.0.0.1',
    listenPort,
    tlsCertPath: required('MEMORY_MANAGEMENT_TLS_CERT'),
    tlsKeyPath: required('MEMORY_MANAGEMENT_TLS_KEY'),
    scmAuthorizationUrl: httpsUrl('MEMORY_SCM_AUTHORIZATION_URL'),
    scmAuthorizationToken: required('MEMORY_SCM_AUTHORIZATION_TOKEN'),
  };
}

function loadMemoryBackendConfig(): MemoryBackendConfig {
  return {
    tenantId: required('MEMORY_TENANT_ID'),
    idempotencySecret: base64UrlSecret('MEMORY_IDEMPOTENCY_HMAC_SECRET'),
    entityHmacSecret: base64UrlSecret('MEMORY_ENTITY_HMAC_SECRET'),
    entityHmacVersion: required('MEMORY_ENTITY_HMAC_VERSION'),
    ledgerUrl: httpsUrl('MEMORY_LEDGER_URL'),
    ledgerToken: required('MEMORY_LEDGER_TOKEN'),
    contentProtectorUrl: httpsUrl('MEMORY_CONTENT_PROTECTOR_URL'),
    contentProtectorToken: required('MEMORY_CONTENT_PROTECTOR_TOKEN'),
    mem0ApiKey: required('MEM0_API_KEY'),
  };
}
