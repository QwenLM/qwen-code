/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRemoteJWKSet } from 'jose';
import pg from 'pg';
import { HttpAntiResurrectionLedger } from './anti-resurrection-ledger.js';
import { PostgresCanonicalStore } from './canonical-store.js';
import { PostgresCapabilityReplayStore } from './capability-replay-store.js';
import {
  type ManagementGatewayConfig,
  type MemoryBackendConfig,
  type RuntimeGatewayConfig,
  loadManagementGatewayConfig,
  loadRuntimeGatewayConfig,
} from './config.js';
import { HttpContentProtector } from './content-protector.js';
import { createGatewayServer } from './gateway-server.js';
import { Mem0SemanticIndex } from './mem0-semantic-index.js';
import {
  createManagementServer,
  ManagementTokenVerifier,
  ScmMaintainerAuthorizer,
} from './management-server.js';
import { MemoryService, StaticPolicyResolver } from './memory-service.js';
import { PostgresPersonalMemoryPreferenceStore } from './privacy-mode-store.js';
import { PostgresRuntimeBindingAuthorizer } from './runtime-binding-authorizer.js';
import { CapabilityVerifier } from './security/capability-verifier.js';
import { EntityIdMapper } from './semantic-index.js';

const mode = process.argv[2];
if (mode === 'runtime') {
  startRuntime(loadRuntimeGatewayConfig());
} else if (mode === 'management') {
  startManagement(loadManagementGatewayConfig());
} else {
  throw new Error('Expected runtime or management process mode');
}

function startRuntime(config: RuntimeGatewayConfig): void {
  const pool = createPool(config.databaseUrl, 20);
  const preferences = new PostgresPersonalMemoryPreferenceStore(pool);
  const server = createGatewayServer(
    {
      capabilityVerifier: new CapabilityVerifier({
        issuer: config.capabilityIssuer,
        audience: config.capabilityAudience,
        expectedTenantId: config.tenantId,
        key: createRemoteJWKSet(new URL(config.capabilityJwksUrl)),
        requestHmacSecret: config.requestHmacSecret,
      }),
      runtimeBindings: new PostgresRuntimeBindingAuthorizer(pool),
      capabilityReplays: new PostgresCapabilityReplayStore(pool),
      memory: createMemory(pool, preferences, config, config.rawCaptureEnabled),
    },
    {
      certPath: config.tlsCertPath,
      keyPath: config.tlsKeyPath,
      clientCaPath: config.tlsClientCaPath,
    },
  );
  server.listen(config.listenPort, config.listenHost);
  installShutdown(server, pool);
}

function startManagement(config: ManagementGatewayConfig): void {
  const pool = createPool(config.databaseUrl, 10);
  const preferences = new PostgresPersonalMemoryPreferenceStore(pool);
  const server = createManagementServer(
    {
      tokens: new ManagementTokenVerifier({
        issuer: config.managementOidcIssuer,
        audience: config.managementOidcAudience,
        expectedTenantId: config.tenantId,
        key: createRemoteJWKSet(new URL(config.managementOidcJwksUrl)),
      }),
      maintainers: new ScmMaintainerAuthorizer({
        baseUrl: config.scmAuthorizationUrl,
        bearerToken: config.scmAuthorizationToken,
      }),
      preferences,
      memory: createMemory(pool, preferences, config, false),
    },
    {
      certPath: config.tlsCertPath,
      keyPath: config.tlsKeyPath,
    },
  );
  server.listen(config.listenPort, config.listenHost);
  installShutdown(server, pool);
}

function createMemory(
  pool: pg.Pool,
  preferences: PostgresPersonalMemoryPreferenceStore,
  config: MemoryBackendConfig,
  rawCaptureEnabled: boolean,
): MemoryService {
  return new MemoryService(
    new PostgresCanonicalStore(pool),
    new HttpAntiResurrectionLedger({
      baseUrl: config.ledgerUrl,
      bearerToken: config.ledgerToken,
    }),
    new HttpContentProtector({
      baseUrl: config.contentProtectorUrl,
      bearerToken: config.contentProtectorToken,
    }),
    new Mem0SemanticIndex({ apiKey: config.mem0ApiKey }),
    new EntityIdMapper(config.entityHmacSecret, config.entityHmacVersion),
    preferences,
    new StaticPolicyResolver(),
    {
      idempotencySecret: config.idempotencySecret,
      rawCaptureEnabled,
    },
  );
}

function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

function installShutdown(
  server: ReturnType<typeof createGatewayServer>,
  pool: pg.Pool,
): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
