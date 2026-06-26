/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { createServeApp, type ServeAppDeps } from './server.js';
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
} from './status.js';
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
  defaultSpawnChannelFactory,
  // #4297 fold-in 1 (16:32:44-round S2): export every typed error
  // class that `sendBridgeError` matches via `instanceof`. External
  // embeds that want to recognize these errors (parallel to how
  // they already match `WorkspaceInitConflictError` /
  // `SessionNotFoundError`) need them on the public barrel; without
  // this they have to deep-import `./acp-session-bridge.js`.
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionNotFoundError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  type AcpChannel,
  type AcpSessionBridge,
  type BridgeOptions,
  type BridgeSession,
  type BridgeSpawnRequest,
  type ChannelFactory,
  type HttpAcpBridge,
} from './acp-session-bridge.js';
export {
  EventBus,
  EVENT_SCHEMA_VERSION,
  type BridgeEvent,
  type SubscribeOptions,
} from './event-bus.js';
export { createInMemoryChannel } from './in-memory-channel.js';
