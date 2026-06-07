/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { createGatewayApp, type GatewayDeps } from './server.js';
export {
  startDaemon,
  type DaemonHandle,
  type SpawnedDaemon,
  type StartDaemonOptions,
} from './daemonSupervisor.js';
export { TokenStore, type TokenInfo } from './tokenStore.js';
export { PairingService } from './pairing.js';
export { ConnectionRegistry } from './connectionRegistry.js';
export {
  AuditLog,
  type AuditEntry,
  type AuditAction,
  type AuditRecorder,
} from './auditLog.js';
export { bearerResolve, requireScope } from './auth.js';
export { SESSION_READ, OWNER, KNOWN_SCOPES, type RcScope } from './scopes.js';
export {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
export { runServe, type ServeOptions } from './cli.js';
