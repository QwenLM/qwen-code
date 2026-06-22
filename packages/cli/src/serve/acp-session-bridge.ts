/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 HTTP→ACP bridge — backward-compat re-export shim.
 *
 * #4175 PR F1 lifted the bridge core (`BridgeClient`,
 * `defaultSpawnChannelFactory`, `createAcpSessionBridge` factory closure,
 * plus the supporting types/errors/options/status) to
 * `@qwen-code/acp-bridge`. This shim preserves the CLI-local bridge import
 * surface so `server.ts`, `run-qwen-serve.ts`, `workspace-agents.ts`,
 * `workspace-memory.ts`, `index.ts`, plus the bridge test suite, keep resolving
 * through one module.
 *
 * The implementation now lives at:
 *   - `@qwen-code/acp-bridge/bridge` — `createAcpSessionBridge` factory
 *   - `@qwen-code/acp-bridge/bridgeClient` — `BridgeClient` class +
 *     permission record types
 *   - `@qwen-code/acp-bridge/spawnChannel` — `defaultSpawnChannelFactory`
 *   - `@qwen-code/acp-bridge/bridgeOptions` — `BridgeOptions` +
 *     `DaemonStatusProvider` interfaces
 *   - `@qwen-code/acp-bridge/bridgeTypes` — bridge session + heartbeat
 *     types + `AcpSessionBridge` interface
 *   - `@qwen-code/acp-bridge/bridgeErrors` — typed bridge error classes
 *   - `@qwen-code/acp-bridge/workspacePaths` — `canonicalizeWorkspace`
 *     + `MAX_WORKSPACE_PATH_LENGTH`
 *   - `@qwen-code/acp-bridge/status` — protocol-versioned status types
 *     + idle envelope helpers
 *   - `@qwen-code/acp-bridge/channel` — `AcpChannel` + `ChannelFactory`
 *
 * The bridge is bound to a single canonical workspace
 * (`BridgeOptions.boundWorkspace`); multi-workspace deployments use
 * multiple daemon processes. See the module docstring on `bridge.ts`
 * in the lifted package for the full Stage 1/Stage 2 contract.
 */

export {
  createAcpSessionBridge,
  createHttpAcpBridge,
} from '@qwen-code/acp-bridge/bridge';
export { defaultSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
// `MAX_RESOLVED_PERMISSION_RECORDS`, `PendingPermission`,
// `PermissionResolutionRecord` re-exports were removed alongside the
// source definitions — the mediator now owns pending+resolved state.
export { BridgeClient } from '@qwen-code/acp-bridge/bridgeClient';
export type { BridgeClientSessionEntry } from '@qwen-code/acp-bridge/bridgeClient';

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
  BridgeDaemonStatusLimits,
  BridgeDaemonSessionDiagnostic,
  BridgeDaemonStatusSnapshot,
  AcpSessionBridge,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';

export {
  BranchWhilePromptActiveError,
  SessionNotFoundError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  PromptQueueFullError,
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
  SessionBusyError,
  InvalidRewindTargetError,
  NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE,
  // Multi-client permission coordination errors.
  CancelSentinelCollisionError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
} from '@qwen-code/acp-bridge/bridgeErrors';

export {
  MAX_WORKSPACE_PATH_LENGTH,
  canonicalizeWorkspace,
} from '@qwen-code/acp-bridge/workspacePaths';
