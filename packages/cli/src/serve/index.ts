/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { createServeApp, type ServeAppDeps } from './server.js';
export {
  getServeAppLifecycle,
  type ServeAppLifecycle,
  type ServeAppLifecycleBindingOptions,
} from './serve-app-lifecycle.js';
export {
  runQwenServe,
  type RunHandle,
  type RunQwenServeDeps,
} from './run-qwen-serve.js';
export {
  CAPABILITIES_SCHEMA_VERSION,
  STAGE1_FEATURES,
  type CapabilitiesEnvelope,
  type ServeMode,
  type ServeOptions,
  type Stage1Feature,
} from './types.js';
export {
  CONDITIONAL_SERVE_FEATURES,
  SERVE_CAPABILITY_REGISTRY,
  SERVE_FEATURES,
  SERVE_PROTOCOL_VERSION,
  SUPPORTED_SERVE_PROTOCOL_VERSIONS,
  getAdvertisedServeFeatures,
  getRegisteredServeFeatures,
  getServeFeatures,
  getServeProtocolVersions,
  type AdvertiseFeatureToggles,
  type ServeCapabilityDescriptor,
  type ServeFeature,
  type ServeProtocolVersion,
  type ServeProtocolVersions,
} from './capabilities.js';
export {
  ACP_PREFLIGHT_KINDS,
  BridgeTimeoutError,
  SessionRestoreTimeoutError,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_ERROR_KINDS,
  SERVE_STATUS_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  createIdleAcpPreflightCells,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceSkillsStatus,
  IDLE_HOOK_EVENTS,
  mapDomainErrorToErrorKind,
  type AcpPreflightKind,
  type ServeEnvCell,
  type ServeEnvKind,
  type ServeErrorKind,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeSessionContextStatus,
  type ServeSessionAgentTaskStatus,
  type ServeSessionMonitorTaskStatus,
  type ServeSessionProcessTaskLifecycleStatus,
  type ServeSessionShellTaskStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeSessionTaskLifecycleStatus,
  type ServeSessionTaskStatus,
  type ServeSessionTasksStatus,
  type ServeSkillLevel,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceEnvStatus,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspacePreflightStatus,
  type ServeWorkspaceProviderCurrent,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillStatus,
  type ServeWorkspaceSkillsStatus,
  type ServeHookConfig,
  type ServeHookEntry,
  type ServeHookEventMeta,
  type ServeHookMatcherKind,
  type ServeHookSource,
  type ServeSessionHooksStatus,
  type ServeWorkspaceHooksStatus,
  type ServeExtensionCapabilities,
  type ServeExtensionEntry,
  type ServeExtensionInstallType,
  type ServeExtensionOriginSource,
  type ServeWorkspaceExtensionsStatus,
} from '@qwen-code/acp-bridge/status';
export {
  ENV_NONSECRET_VARS,
  ENV_PROXY_VARS,
  ENV_SECRET_VARS,
  buildEnvStatusFromProcess,
} from './env-snapshot.js';
export {
  bearerAuth,
  createMutationGate,
  denyBrowserOriginCors,
  hostAllowlist,
  type CreateMutationGateDeps,
  type MutationGateOptions,
} from './auth.js';
export {
  createAcpSessionBridge,
  createHttpAcpBridge,
} from '@qwen-code/acp-bridge/bridge';
export { defaultSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
// The bridge error classes external embeds most commonly need to recognize
// live on this public barrel; the full set `sendBridgeError`
// (server/error-response.ts) matches via `instanceof` is on
// `@qwen-code/acp-bridge/bridgeErrors`. In-repo callers import these classes
// from `@qwen-code/acp-bridge/bridgeErrors` directly, so this block looks
// unused from inside the repo but is load-bearing public surface.
export {
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionNotFoundError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
} from '@qwen-code/acp-bridge/bridgeErrors';
export type { AcpChannel, ChannelFactory } from '@qwen-code/acp-bridge/channel';
export type {
  AcpSessionBridge,
  BridgeSession,
  BridgeSpawnRequest,
  HttpAcpBridge,
} from '@qwen-code/acp-bridge/bridgeTypes';
export type { BridgeOptions } from '@qwen-code/acp-bridge/bridgeOptions';
export {
  EventBus,
  EVENT_SCHEMA_VERSION,
  type BridgeEvent,
  type SubscribeOptions,
} from '@qwen-code/acp-bridge/eventBus';
export { createInMemoryChannel } from '@qwen-code/acp-bridge/inMemoryChannel';
