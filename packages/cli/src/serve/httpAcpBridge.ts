/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 HTTP→ACP bridge — backward-compat re-export shim.
 *
 * #4175 PR F1 lifted the bridge core (`BridgeClient`,
 * `defaultSpawnChannelFactory`, `createHttpAcpBridge` factory closure,
 * plus the supporting types/errors/options/status) to
 * `@qwen-code/acp-bridge`. This shim preserves every existing relative
 * import path (`./httpAcpBridge.js`) so `server.ts`, `runQwenServe.ts`,
 * `workspaceAgents.ts`, `workspaceMemory.ts`, `index.ts`, plus the
 * bridge test suite, keep resolving without any call-site changes.
 *
 * The implementation now lives at:
 *   - `@qwen-code/acp-bridge/bridge` — `createHttpAcpBridge` factory
 *   - `@qwen-code/acp-bridge/bridgeClient` — `BridgeClient` class +
 *     permission record types
 *   - `@qwen-code/acp-bridge/spawnChannel` — `defaultSpawnChannelFactory`
 *   - `@qwen-code/acp-bridge/bridgeOptions` — `BridgeOptions` +
 *     `DaemonStatusProvider` interfaces
 *   - `@qwen-code/acp-bridge/bridgeTypes` — bridge session + heartbeat
 *     types + `HttpAcpBridge` interface
 *   - `@qwen-code/acp-bridge/bridgeErrors` — typed bridge error classes
 *   - `@qwen-code/acp-bridge/workspacePaths` — `canonicalizeWorkspace`
 *     + `MAX_WORKSPACE_PATH_LENGTH`
 *   - `@qwen-code/acp-bridge/status` — protocol-versioned status types
 *     + idle envelope helpers
 *   - `@qwen-code/acp-bridge/channel` — `AcpChannel` + `ChannelFactory`
 *
 * Per #3803 §02 the bridge is bound to a single canonical workspace
 * (`BridgeOptions.boundWorkspace`); multi-workspace deployments use
 * multiple daemon processes. See the module docstring on `bridge.ts`
 * in the lifted package for the full Stage 1/Stage 2 contract.
 */

export { createHttpAcpBridge } from '@qwen-code/acp-bridge/bridge';
export { defaultSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
export {
  BridgeClient,
  MAX_RESOLVED_PERMISSION_RECORDS,
} from '@qwen-code/acp-bridge/bridgeClient';
export type {
  BridgeClientSessionEntry,
  PendingPermission,
  PermissionResolutionRecord,
} from '@qwen-code/acp-bridge/bridgeClient';

export type {
  AcpChannel,
  AcpChannelExitInfo,
  ChannelFactory,
} from '@qwen-code/acp-bridge';

export type {
  BridgeOptions,
  DaemonStatusProvider,
} from '@qwen-code/acp-bridge/bridgeOptions';

export type { BridgeFileSystem } from '@qwen-code/acp-bridge/bridgeFileSystem';

export type {
  BridgeSpawnRequest,
  BridgeSession,
  BridgeRestoreSessionRequest,
  BridgeSessionState,
  BridgeRestoredSession,
  BridgeSessionSummary,
  SessionMetadataUpdate,
  BridgeClientRequestContext,
  BridgeHeartbeatResult,
  BridgeHeartbeatState,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';

export {
  SessionNotFoundError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
} from '@qwen-code/acp-bridge/bridgeErrors';

export {
  MAX_WORKSPACE_PATH_LENGTH,
  canonicalizeWorkspace,
} from '@qwen-code/acp-bridge/workspacePaths';
