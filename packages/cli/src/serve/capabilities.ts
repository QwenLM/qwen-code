/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SERVE_CAPABILITY_REGISTRY,
  SERVE_PROTOCOL_VERSION,
  SUPPORTED_SERVE_PROTOCOL_VERSIONS,
  type ServeFeature,
  type ServeProtocolVersion,
  type ServeProtocolVersions,
} from '@qwen-code/sdk/daemon';

export {
  SERVE_CAPABILITY_REGISTRY,
  SERVE_PROTOCOL_VERSION,
  SUPPORTED_SERVE_PROTOCOL_VERSIONS,
  type ServeCapabilityDescriptor,
  type ServeFeature,
  type ServeProtocolVersion,
  type ServeProtocolVersions,
} from '@qwen-code/sdk/daemon';

/**
 * Per-deployment feature toggles surfaced through `/capabilities`.
 *
 * advertised.
 */
export interface AdvertiseFeatureToggles {
  hostedHarness?: boolean;
  requireAuth?: boolean;
  turnSkillFileSnapshotAvailable?: boolean;
  turnExtensionStoreLeaseAvailable?: boolean;
  sessionRetireIfIdleAvailable?: boolean;
  /**
   * Whether the daemon is serving the workspace-agent collaboration routes
   * (`agent_collaboration_v1`) for this response. Resolved from
   * `experimental.agentCollaboration` at call time rather than snapshotted at
   * boot: which routes exist at all is settled at startup, but a workspace
   * opting in or out afterwards is seen on the next request. Left unset by the
   * pre-runtime bootstrap envelope, which reads no workspace settings and so
   * omits the tag even when the runtime envelope will advertise it.
   */
  agentCollaborationEnabled?: boolean;
  mcpPoolActive?: boolean;
  externalToolGuardActive?: boolean;
  allowOriginActive?: boolean;
  promptDeadlineMs?: number;
  writerIdleTimeoutMs?: number;
  persistSettingAvailable?: boolean;
  modelPreferencesAvailable?: boolean;
  userSkillActivationAvailable?: boolean;
  voiceTranscriptionAvailable?: boolean;
  sessionShellCommandEnabled?: boolean;
  sessionArtifactsPersistenceAvailable?: boolean;
  sessionGenerationAvailable?: boolean;
  sessionBtwStreamAvailable?: boolean;
  currentSessionSchedulingAvailable?: boolean;
  workspaceGenerationAvailable?: boolean;
  rateLimit?: boolean;
  reloadAvailable?: boolean;
  /**
   * Whether the daemon exposes the channel worker reload route
   * (`channel_reload`). Set while the runtime manager is enabled.
   */
  channelReloadAvailable?: boolean;
  channelControlAvailable?: boolean;
  channelManagementAvailable?: boolean;
  /**
   * Whether the daemon will accept client-hosted MCP servers over the WS
   * (`client_mcp_over_ws`, issue #5626).
   */
  clientMcpOverWsEnabled?: boolean;
  /**
   * Whether the daemon exposes the Plan C `/cdp` tunnel endpoint
   * (`cdp_tunnel_over_ws`, issue #5626).
   */
  cdpTunnelOverWsEnabled?: boolean;
  /**
   * Whether the daemon can register browser automation MCP tools for the CDP
   * tunnel (`browser_automation_mcp`, issue #5626).
   */
  browserAutomationMcpAvailable?: boolean;
  voiceWsAvailable?: boolean;
  multiWorkspaceSessionsEnabled?: boolean;
  dynamicWorkspaceRegistrationAvailable?: boolean;
  persistentWorkspaceRegistrationAvailable?: boolean;
  scratchWorkspaceRegistrationAvailable?: boolean;
  gitWorkspaceCloneAvailable?: boolean;
  workspaceRuntimeRemovalAvailable?: boolean;
  workspaceDirectoriesAvailable?: boolean;
  nativeDirectoryPickerAvailable?: boolean;
  workspaceRuntimeAvailable?: boolean;
  workspaceRuntimeStopAvailable?: boolean;
  localPathOpenAvailable?: boolean;
  localTerminalOpenAvailable?: boolean;
  /**
   * Whether the HTTP ACP surface is enabled (default on; opts out via
   * QWEN_SERVE_ACP_HTTP=0). Workspace-qualified ACP is only advertised when on.
   */
  acpHttpEnabled?: boolean;
  realtimeVoiceEnabled?: boolean;
  realtimeVoiceWebEnabled?: boolean;
  workspaceTrustHotReloadAvailable?: boolean;
  standaloneSessionsAvailable?: boolean;
}

/**
 * Subset of `ServeFeature` whose advertisement depends on runtime config
 * (currently just `require_auth`, which is announced only when the
 * daemon was started with `--require-auth`). Each entry pairs the
 * feature key with a predicate over `AdvertiseFeatureToggles` — the
 * toggle decision lives next to the feature key, so adding a new
 * conditional tag is **two coordinated changes** instead of four:
 *
 * 1. Register the tag in `SERVE_CAPABILITY_REGISTRY` (defined in
 *    `packages/sdk-typescript/src/daemon/capabilities.ts` and re-exported
 *    here) with its `since` protocol version (just like baseline tags).
 * 2. Add an entry to THIS Map mapping the tag to a toggle predicate
 *    (extend `AdvertiseFeatureToggles` first if the predicate needs a
 *    new field to read).
 *
 * The previous `Set` + per-feature `if`-branch shape needed FOUR
 * coordinated changes (registry, set, toggles interface, predicate
 * branch) and silently fail-CLOSED when the branch was missed —
 * fail-CLOSED is good, but invisible to the contributor adding the
 * tag. The Map shape collapses the predicate-decision and the
 * set-membership into one entry, so a future contributor either
 * registers the predicate (advertised when toggle on) or doesn't
 * register the tag in the Map at all (advertised unconditionally
 * like baseline tags) — both are intentional, neither is a silent
 * miss.
 *
 * Reviewed-through-failure: the
 * `every conditional tag advertises when its toggle is on` test in
 * `server.test.ts` iterates this Map's keys, so a future tag added
 * here whose predicate isn't honored by `getAdvertisedServeFeatures`
 * fails the suite — adoption-of-record for the Map shape rather than
 * relying on a hand-maintained invariant.
 */
export const CONDITIONAL_SERVE_FEATURES: ReadonlyMap<
  ServeFeature,
  (toggles: AdvertiseFeatureToggles) => boolean
> = new Map<ServeFeature, (toggles: AdvertiseFeatureToggles) => boolean>([
  ['session_message_deletion', (toggles) => toggles.hostedHarness !== true],
  ['hosted_harness_private_v1', (toggles) => toggles.hostedHarness === true],
  [
    'managed_session_journal_delta_v1',
    (toggles) => toggles.hostedHarness === true,
  ],
  [
    'session_retire_if_idle',
    (toggles) => toggles.sessionRetireIfIdleAvailable === true,
  ],
  ['require_auth', (toggles) => toggles.requireAuth === true],
  [
    'turn_skill_file_snapshot',
    (toggles) => toggles.turnSkillFileSnapshotAvailable === true,
  ],
  [
    'turn_skill_session_effects_check',
    (toggles) => toggles.turnSkillFileSnapshotAvailable === true,
  ],
  [
    'turn_extension_store_lease',
    (toggles) => toggles.turnExtensionStoreLeaseAvailable === true,
  ],
  [
    'agent_collaboration_v1',
    (toggles) => toggles.agentCollaborationEnabled === true,
  ],
  [
    'standalone_sessions_v1',
    (toggles) => toggles.standaloneSessionsAvailable === true,
  ],
  [
    'standalone_session_options_v1',
    (toggles) => toggles.standaloneSessionsAvailable === true,
  ],
  ['mcp_workspace_pool', (toggles) => toggles.mcpPoolActive === true],
  ['mcp_pool_restart', (toggles) => toggles.mcpPoolActive === true],
  [
    'external_tool_guard',
    (toggles) => toggles.externalToolGuardActive === true,
  ],
  ['allow_origin', (toggles) => toggles.allowOriginActive === true],
  [
    'prompt_absolute_deadline',
    (toggles) =>
      typeof toggles.promptDeadlineMs === 'number' &&
      toggles.promptDeadlineMs > 0,
  ],
  [
    'writer_idle_timeout',
    (toggles) =>
      typeof toggles.writerIdleTimeoutMs === 'number' &&
      toggles.writerIdleTimeoutMs > 0,
  ],
  ['workspace_settings', (toggles) => toggles.persistSettingAvailable === true],
  [
    'workspace_model_preferences',
    (toggles) => toggles.modelPreferencesAvailable === true,
  ],
  [
    'user_skill_activation',
    (toggles) => toggles.userSkillActivationAvailable === true,
  ],
  ['user_language_sync', (toggles) => toggles.persistSettingAvailable === true],
  ['workspace_voice', (toggles) => toggles.persistSettingAvailable === true],
  [
    'workspace_voice_transcription',
    (toggles) => toggles.voiceTranscriptionAvailable === true,
  ],
  [
    'session_shell_command',
    (toggles) => toggles.sessionShellCommandEnabled === true,
  ],
  [
    'session_artifact_library',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'workspace_artifact_library',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'workspace_artifact_library_stream',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'session_artifacts_persistence',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'session_sources',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'generated_ui_state',
    (toggles) => toggles.sessionArtifactsPersistenceAvailable === true,
  ],
  [
    'session_generation',
    (toggles) => toggles.sessionGenerationAvailable === true,
  ],
  [
    'session_btw_stream',
    (toggles) => toggles.sessionBtwStreamAvailable === true,
  ],
  [
    'scheduled_task_session_reuse',
    (toggles) => toggles.currentSessionSchedulingAvailable === true,
  ],
  [
    'workspace_generation',
    (toggles) => toggles.workspaceGenerationAvailable === true,
  ],
  ['rate_limit', (toggles) => toggles.rateLimit === true],
  ['workspace_reload', (toggles) => toggles.reloadAvailable === true],
  [
    'workspace_trust_hot_reload',
    (toggles) => toggles.workspaceTrustHotReloadAvailable === true,
  ],
  [
    'workspace_trust_grant',
    (toggles) => toggles.workspaceTrustHotReloadAvailable === true,
  ],
  ['channel_reload', (toggles) => toggles.channelReloadAvailable === true],
  ['channel_control', (toggles) => toggles.channelControlAvailable === true],
  [
    'channel_management',
    (toggles) => toggles.channelManagementAvailable === true,
  ],
  [
    'channel_delete_config_loss_convergence',
    (toggles) => toggles.channelManagementAvailable === true,
  ],
  [
    'multi_workspace_sessions',
    (toggles) => toggles.multiWorkspaceSessionsEnabled === true,
  ],
  [
    'multi_workspace_session_rewind',
    (toggles) => toggles.multiWorkspaceSessionsEnabled === true,
  ],
  [
    'multi_workspace_session_shell',
    (toggles) =>
      toggles.multiWorkspaceSessionsEnabled === true &&
      toggles.sessionShellCommandEnabled === true,
  ],
  [
    'dynamic_workspace_registration',
    (toggles) => toggles.dynamicWorkspaceRegistrationAvailable === true,
  ],
  [
    'persistent_workspace_registration',
    (toggles) => toggles.persistentWorkspaceRegistrationAvailable === true,
  ],
  [
    'workspace_order',
    (toggles) => toggles.persistentWorkspaceRegistrationAvailable === true,
  ],
  [
    'scratch_workspace_registration',
    (toggles) => toggles.scratchWorkspaceRegistrationAvailable === true,
  ],
  [
    'git_workspace_clone',
    (toggles) => toggles.gitWorkspaceCloneAvailable === true,
  ],
  [
    'workspace_runtime_removal',
    (toggles) => toggles.workspaceRuntimeRemovalAvailable === true,
  ],
  [
    'workspace_directories',
    (toggles) => toggles.workspaceDirectoriesAvailable === true,
  ],
  [
    'native_directory_picker',
    (toggles) => toggles.nativeDirectoryPickerAvailable === true,
  ],
  [
    'workspace_runtime_stop',
    (toggles) => toggles.workspaceRuntimeStopAvailable === true,
  ],
  [
    'workspace_runtime',
    (toggles) => toggles.workspaceRuntimeAvailable === true,
  ],
  [
    'workspace_skills_config_runtime',
    (toggles) => toggles.workspaceRuntimeAvailable === true,
  ],
  [
    'skill_archive_install',
    (toggles) => toggles.workspaceRuntimeAvailable === true,
  ],
  [
    'skill_zip_file_source',
    (toggles) => toggles.workspaceRuntimeAvailable === true,
  ],
  [
    'workspace_local_open',
    (toggles) => toggles.localPathOpenAvailable === true,
  ],
  [
    'workspace_local_terminal',
    (toggles) => toggles.localTerminalOpenAvailable === true,
  ],
  [
    'workspace_qualified_acp',
    // The plural routes are pre-mounted for workspaces registered after app
    // creation, but the capability becomes meaningful only once a secondary
    // runtime exists. Until then the qualified primary route is only an alias
    // for the always-available legacy `/acp` surface.
    (toggles) =>
      toggles.acpHttpEnabled === true &&
      toggles.multiWorkspaceSessionsEnabled === true,
  ],
  [
    'workspace_qualified_voice',
    // Like qualified ACP, the plural Voice surface is mounted ahead of time
    // but only becomes useful once the daemon has a secondary runtime.
    (toggles) =>
      toggles.acpHttpEnabled === true &&
      toggles.multiWorkspaceSessionsEnabled === true,
  ],
  [
    'workspace_qualified_memory',
    (toggles) =>
      toggles.acpHttpEnabled === true &&
      toggles.multiWorkspaceSessionsEnabled === true,
  ],
  ['client_mcp_over_ws', (toggles) => toggles.clientMcpOverWsEnabled === true],
  ['cdp_tunnel_over_ws', (toggles) => toggles.cdpTunnelOverWsEnabled === true],
  [
    'browser_automation_mcp',
    (toggles) => toggles.browserAutomationMcpAvailable === true,
  ],
  [
    // Advertised whenever the `/voice/stream` WS endpoint exists. A configured
    // token (or `--require-auth`) no longer suppresses it: browsers can't set
    // an `Authorization` header on a WebSocket, so the Web Shell carries the
    // bearer token in the `Sec-WebSocket-Protocol` subprotocol, which the ACP
    // upgrade listener verifies (see acp-http/index.ts).
    'voice_transcribe',
    (toggles) => toggles.voiceWsAvailable !== false,
  ],
  [
    'realtime_voice',
    (toggles) =>
      toggles.acpHttpEnabled === true && toggles.realtimeVoiceEnabled === true,
  ],
  [
    'realtime_voice_web',
    (toggles) =>
      toggles.acpHttpEnabled === true &&
      toggles.realtimeVoiceWebEnabled === true,
  ],
  ['web_terminal', (toggles) => toggles.acpHttpEnabled === true],
]);

export const SERVE_FEATURES = Object.freeze(
  Object.keys(SERVE_CAPABILITY_REGISTRY) as ServeFeature[],
);

function serveProtocolVersionIndex(version: ServeProtocolVersion): number {
  return SUPPORTED_SERVE_PROTOCOL_VERSIONS.indexOf(version);
}

function isFeatureAvailableInProtocol(
  feature: ServeFeature,
  protocolVersion: ServeProtocolVersion,
): boolean {
  return (
    serveProtocolVersionIndex(SERVE_CAPABILITY_REGISTRY[feature].since) <=
    serveProtocolVersionIndex(protocolVersion)
  );
}

export function getRegisteredServeFeatures(): ServeFeature[] {
  return [...SERVE_FEATURES];
}

/** The hosted persona's curated tag set: exactly the registry entries
 * carrying `hostedPersona`, filtered to the current protocol. Membership
 * is a curation fact declared once — in the registry — so adding a tag to
 * the persona is a registry edit, and a second or third list cannot
 * exist to drift. */
export function hostedPersonaServeFeatures(): ServeFeature[] {
  return SERVE_FEATURES.filter((feature) => {
    if (!isFeatureAvailableInProtocol(feature, SERVE_PROTOCOL_VERSION))
      return false;
    const entry = SERVE_CAPABILITY_REGISTRY[feature] as
      | { hostedPersona?: boolean }
      | undefined;
    return entry?.hostedPersona === true;
  });
}

export function getAdvertisedServeFeatures(
  protocolVersion: ServeProtocolVersion = SERVE_PROTOCOL_VERSION,
  toggles: AdvertiseFeatureToggles = {},
): ServeFeature[] {
  return SERVE_FEATURES.filter((feature) => {
    if (!isFeatureAvailableInProtocol(feature, protocolVersion)) return false;
    // Conditional tags route through the per-feature toggle predicate;
    // baseline tags (no Map entry) advertise unconditionally. Without
    // this gate every daemon would advertise the conditional tags
    // regardless of operator opt-in, breaking the "tag presence =
    // behavior is on" contract clients depend on.
    const predicate = CONDITIONAL_SERVE_FEATURES.get(feature);
    if (predicate !== undefined) return predicate(toggles);
    return true;
  });
}

export function getServeFeatures(): ServeFeature[] {
  return getAdvertisedServeFeatures();
}

export function getServeProtocolVersions(): ServeProtocolVersions {
  return {
    current: SERVE_PROTOCOL_VERSION,
    supported: [...SUPPORTED_SERVE_PROTOCOL_VERSIONS],
  };
}
