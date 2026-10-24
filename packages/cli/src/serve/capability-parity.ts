/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The capability parity matrix (issue #15075): which `qwen serve` capability
 * tags the Managed Agent path stands behind.
 *
 * Every legacy tag carries exactly one row, so a new tag cannot land without
 * a decision on the Managed side. `managed` names Managed evidence, which
 * `capability-parity.test.ts` checks against the code; `legacy` and `absent`
 * carry a reason instead. The matrix reports; it never requires a difference
 * to be closed.
 */

import {
  SERVE_CAPABILITY_REGISTRY,
  type ServeFeature,
} from './capabilities.js';

/**
 * The Managed route labels and templates a caller supplies, read from the
 * committed twin by the test. This module stays pure data and pure functions:
 * it ships in `dist`, where a path resolved from the source tree would be
 * wrong and the fixture, which lives in another package, is absent.
 */
export interface ManagedSurfaceSet {
  /** `SurfaceRegistry` capability of each route; a twin repeats its label. */
  labels: ReadonlySet<string>;
  /** Every route template, as the twin records it. */
  routes: ReadonlySet<string>;
}

export const PARITY_COLUMNS = ['legacy only', 'both', 'managed only'] as const;

export type ParityColumn = (typeof PARITY_COLUMNS)[number];

/**
 * `managed`: the Managed path stands behind the tag, naming its evidence.
 * `legacy`: a legacy-daemon concern the Managed control plane does not own.
 * `absent`: a Managed gap, with the reason it is deliberately absent.
 */
export type ParityStanding = 'managed' | 'legacy' | 'absent';

export interface ParityRow {
  standing: ParityStanding;
  /** `managed` evidence tags, plus the row's reason for `legacy`/`absent`. */
  evidence: string;
}

/**
 * Evidence tokens name Managed code; each kind is checked against the source
 * it points at:
 *
 * - `tool:<name>`: a Hosted Workspace profile declares the tool.
 * - `surface:<capability>`: a `SurfaceRegistry.Capability` has a mounted
 *   route in the committed twin.
 * - `docs:<path>`: the file exists (documented behavior with no route or
 *   tool to point at).
 */
const LEGACY_ONLY = (reason: string): ParityRow => ({
  standing: 'legacy',
  evidence: reason,
});
const NO_MANAGED_EQUIVALENT = (reason: string): ParityRow => ({
  standing: 'absent',
  evidence: reason,
});

/** The Managed standing of each legacy tag, keyed by the registry. */
export const CAPABILITY_PARITY: Record<ServeFeature, ParityRow> = {
  // --- transport and daemon discovery: only the Control plane serves these ---
  health: LEGACY_ONLY('managed deploys behind its own probes, not /health'),
  daemon_status: LEGACY_ONLY('no daemon status document in Managed'),
  daemon_update: LEGACY_ONLY('Managed upgrades are deployments'),
  capabilities: NO_MANAGED_EQUIVALENT(
    'no Managed capability document; this matrix is the closest surface',
  ),
  session_create: { standing: 'managed', evidence: 'surface:SESSION_CREATE' },
  hosted_harness_private_v1: {
    standing: 'managed',
    evidence: 'docs:packages/cli/src/serve/hosted-harness-session.ts',
  },
  managed_session_journal_delta_v1: {
    standing: 'managed',
    evidence: 'docs:packages/cli/src/serve/hosted-harness-session.ts',
  },
  session_startup_config: LEGACY_ONLY(
    'a client startup config, not a Managed input',
  ),
  session_id_override: LEGACY_ONLY('clients do not choose Managed Session ids'),
  session_scope_override: LEGACY_ONLY(
    'Managed Session scope is workspace-bound',
  ),
  session_load: LEGACY_ONLY(
    'Managed loads a Session through its own harness load, not a tag',
  ),
  session_resume: LEGACY_ONLY(
    'Managed resume is host-owned, not legacy-shaped',
  ),
  unstable_session_resume: LEGACY_ONLY('deprecated alias of the legacy resume'),
  session_list: { standing: 'managed', evidence: 'surface:SESSION_LIST' },
  session_catalog_batch: LEGACY_ONLY('no batched catalog route in Managed'),
  session_info: LEGACY_ONLY('aggregate counts are a legacy disk scan'),
  session_source_metadata: NO_MANAGED_EQUIVALENT(
    'no Managed session source metadata field',
  ),
  session_side_task: NO_MANAGED_EQUIVALENT('no Managed side-task surface'),
  session_prompt: { standing: 'managed', evidence: 'surface:TURN_SUBMIT' },
  session_turn_status: NO_MANAGED_EQUIVALENT(
    'Managed reads Turns by list and get, not a status route',
  ),
  session_attachments: NO_MANAGED_EQUIVALENT(
    'Managed prompts carry no legacy attachment references',
  ),
  session_attachment_chunk_upload: NO_MANAGED_EQUIVALENT(
    'no Managed chunked attachment upload',
  ),
  session_attachment_list: NO_MANAGED_EQUIVALENT(
    'no Managed attachment listing',
  ),
  session_mid_turn_message_mutation: {
    standing: 'managed',
    evidence: 'surface:USER_MESSAGE_COMMAND',
  },
  session_mid_turn_message_query: {
    standing: 'managed',
    evidence: 'surface:USER_MESSAGE_QUERY',
  },
  session_mid_turn_send_now: NO_MANAGED_EQUIVALENT(
    'Managed consumes queued guidance automatically at safe model boundaries',
  ),
  session_cancel: { standing: 'managed', evidence: 'surface:TURN_CANCEL' },
  session_events: { standing: 'managed', evidence: 'surface:TAIL_EVENTS' },
  session_artifacts: { standing: 'managed', evidence: 'surface:ARTIFACT_LIST' },
  session_artifacts_persistence: {
    standing: 'managed',
    evidence: 'surface:ARTIFACT_CONTENT',
  },
  session_artifact_library: {
    standing: 'managed',
    evidence: 'surface:ARTIFACT_GET',
  },
  session_sources: NO_MANAGED_EQUIVALENT('no Managed session source list'),
  slow_client_warning: LEGACY_ONLY(
    'SSE backpressure is a legacy transport knob',
  ),
  typed_event_schema: {
    standing: 'managed',
    evidence: 'docs:packages/cli/src/serve/hosted-harness-session.ts',
  },
  session_set_model: {
    standing: 'managed',
    evidence: 'surface:SESSION_MODEL_CHANGE',
  },
  client_identity: LEGACY_ONLY(
    'Managed admission is actor- and workspace-scoped',
  ),
  client_heartbeat: LEGACY_ONLY('no Managed client heartbeat'),
  session_permission_vote: {
    standing: 'managed',
    evidence: 'surface:ACTION_RESPOND',
  },
  permission_vote: { standing: 'managed', evidence: 'surface:ACTION_RESPOND' },
  workspace_mcp: { standing: 'managed', evidence: 'surface:MCP_CATALOG' },
  workspace_skills: { standing: 'managed', evidence: 'surface:SESSION_SKILLS' },
  workspace_skills_config_runtime: NO_MANAGED_EQUIVALENT(
    'no Managed skill settings mutation',
  ),
  workspace_providers: NO_MANAGED_EQUIVALENT('no Managed provider listing'),
  workspace_acp_preheat: LEGACY_ONLY('no ACP child to preheat in Managed'),
  workspace_acp_status: LEGACY_ONLY('no ACP child status in Managed'),
  auth_provider_install: NO_MANAGED_EQUIVALENT(
    'Managed auth is the Control plane bearer and signature scheme',
  ),
  workspace_memory: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_remember: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_remember_project_scope: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_remember_user_scope: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_forget: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_forget_scope: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_memory_dream: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  memory_import_v1: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  workspace_agents: NO_MANAGED_EQUIVALENT(
    'Managed agent definitions are tenant resources, not workspace files',
  ),
  workspace_agent_generate: NO_MANAGED_EQUIVALENT(
    'no Managed agent-definition generation',
  ),
  agent_collaboration_v1: {
    standing: 'managed',
    evidence: 'surface:AGENT_DEFINITION_CREATE',
  },
  workspace_env: NO_MANAGED_EQUIVALENT('no Managed workspace env route'),
  workspace_preflight: NO_MANAGED_EQUIVALENT('no Managed preflight route'),
  session_context: NO_MANAGED_EQUIVALENT('no Managed session context route'),
  session_context_usage: NO_MANAGED_EQUIVALENT(
    'no Managed context usage route',
  ),
  session_supported_commands: NO_MANAGED_EQUIVALENT(
    'no Managed supported-commands route',
  ),
  session_tasks: { standing: 'managed', evidence: 'surface:TASK_LIST' },
  session_agents: NO_MANAGED_EQUIVALENT('no Managed session agent listing'),
  session_agent_trace: NO_MANAGED_EQUIVALENT('no Managed agent trace route'),
  scheduled_task_session_reuse: {
    standing: 'managed',
    evidence: 'surface:AUTOMATION_RUN',
  },
  // Managed automations carry no `gate`: a definition has a cron, a prompt
  // and catch-up limits, so a quiet watch still spends a turn there.
  scheduled_task_gate: NO_MANAGED_EQUIVALENT(
    'no scheduled-task gate in Managed automations',
  ),
  session_monitor_tool_correlation: {
    standing: 'managed',
    evidence: 'tool:monitor',
  },
  session_stats: NO_MANAGED_EQUIVALENT('no Managed session statistics route'),
  session_lsp: NO_MANAGED_EQUIVALENT('no LSP in the Managed execution profile'),
  session_resources: NO_MANAGED_EQUIVALENT(
    'no Managed session resources route',
  ),
  session_status: NO_MANAGED_EQUIVALENT(
    'Managed Sessions are read, not status-probed',
  ),
  session_close: { standing: 'managed', evidence: 'surface:SESSION_CLOSE' },
  session_archive: { standing: 'managed', evidence: 'surface:SESSION_ARCHIVE' },
  session_archive_idle_guard: {
    standing: 'managed',
    evidence: 'surface:SESSION_UNARCHIVE',
  },
  session_storage_conflict_repair: NO_MANAGED_EQUIVALENT(
    'durable store owns storage conflicts',
  ),
  session_metadata: NO_MANAGED_EQUIVALENT(
    'Managed renames a Session and has no metadata bag',
  ),
  session_organization: NO_MANAGED_EQUIVALENT(
    'no Managed session organization route',
  ),
  session_export: { standing: 'managed', evidence: 'surface:TRANSCRIPT_QUERY' },
  standalone_sessions_v1: NO_MANAGED_EQUIVALENT(
    'Managed has no standalone lane',
  ),
  standalone_session_options_v1: NO_MANAGED_EQUIVALENT(
    'Managed has no standalone lane',
  ),
  session_transcript: {
    standing: 'managed',
    evidence: 'surface:TRANSCRIPT_QUERY',
  },
  session_transcript_pagination: {
    standing: 'managed',
    evidence: 'surface:TRANSCRIPT_QUERY',
  },
  session_turn_navigation: {
    standing: 'managed',
    evidence: 'surface:TURN_GET',
  },
  mcp_guardrails: NO_MANAGED_EQUIVALENT('no Managed MCP client budget'),
  // Managed manages a Session's MCP servers through the Harness, revision
  // checked and idempotent (add, edit, remove, enable, disable, reload,
  // restart). Two differences: the daemon's routes mutate workspace-level
  // configuration, and Managed answers `supported: false` unless the Harness
  // advertises `session-mcp-management/1`. The routes are mounted either way,
  // so the row claims the surface and records both limits here.
  workspace_mcp_manage: {
    standing: 'managed',
    evidence: 'surface:MCP_MANAGEMENT',
  },
  mcp_guardrail_events: NO_MANAGED_EQUIVALENT('no Managed MCP client budget'),
  external_tool_guard: NO_MANAGED_EQUIVALENT(
    'no external per-tool policy provider on the Managed execution boundary',
  ),
  mcp_server_runtime_mutation: {
    standing: 'managed',
    evidence: 'surface:MCP_MANAGEMENT',
  },
  workspace_file_read: {
    standing: 'managed',
    evidence: 'surface:WORKSPACE_FILES_READ',
  },
  workspace_file_bytes: NO_MANAGED_EQUIVALENT('no Managed raw byte read route'),
  workspace_file_read_cursor: NO_MANAGED_EQUIVALENT(
    'no Managed byte-cursor paging',
  ),
  workspace_file_write: {
    standing: 'managed',
    evidence: 'tool:write_file,tool:edit',
  },
  workspace_file_upload: NO_MANAGED_EQUIVALENT('no Managed file upload route'),
  workspace_file_delete: NO_MANAGED_EQUIVALENT('no Managed file delete route'),
  workspace_directory_create: NO_MANAGED_EQUIVALENT(
    'no Managed directory create route',
  ),
  workspace_directory_delete: NO_MANAGED_EQUIVALENT(
    'no Managed directory delete route',
  ),
  session_approval_mode_control: {
    standing: 'managed',
    evidence: 'surface:SESSION_APPROVAL_CHANGE',
  },
  workspace_tool_toggle: NO_MANAGED_EQUIVALENT('no Managed tool toggle route'),
  workspace_skill_settings_toggle: NO_MANAGED_EQUIVALENT(
    'no Managed skill settings mutation',
  ),
  workspace_skill_settings_batch_toggle: NO_MANAGED_EQUIVALENT(
    'no Managed skill settings mutation',
  ),
  workspace_session_refresh: NO_MANAGED_EQUIVALENT(
    'no Managed session refresh route',
  ),
  extension_batch_activation_v2: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  extension_activation_explicit_refresh: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  workspace_skill_manage: NO_MANAGED_EQUIVALENT(
    'no Managed skill management route',
  ),
  web_shell_brand: {
    standing: 'managed',
    evidence: 'docs:packages/web-shell/README.md',
  },
  workspace_settings: NO_MANAGED_EQUIVALENT('no Managed settings route'),
  workspace_permissions: NO_MANAGED_EQUIVALENT('no Managed permissions route'),
  workspace_voice: NO_MANAGED_EQUIVALENT('no Managed voice route'),
  workspace_voice_transcription: NO_MANAGED_EQUIVALENT(
    'no Managed voice route',
  ),
  workspace_trust: NO_MANAGED_EQUIVALENT(
    'Managed Workspace admission is grants and actors, not folder trust',
  ),
  workspace_trust_grant: NO_MANAGED_EQUIVALENT(
    'Managed Workspace admission is grants and actors, not folder trust',
  ),
  workspace_trust_hot_reload: NO_MANAGED_EQUIVALENT(
    'Managed Workspace admission is grants and actors, not folder trust',
  ),
  workspace_init: NO_MANAGED_EQUIVALENT('no Managed workspace init route'),
  workspace_github_setup: NO_MANAGED_EQUIVALENT(
    'no Managed GitHub setup route',
  ),
  workspace_github_prs: NO_MANAGED_EQUIVALENT('no Managed GitHub PRs route'),
  workspace_git_worktrees: NO_MANAGED_EQUIVALENT(
    'no Managed worktree management route',
  ),
  workspace_mcp_restart: {
    standing: 'managed',
    evidence: 'surface:MCP_MANAGEMENT',
  },
  session_recap: NO_MANAGED_EQUIVALENT('no Managed recap route'),
  session_generation: NO_MANAGED_EQUIVALENT(
    'no Managed stateless generation route',
  ),
  workspace_generation: NO_MANAGED_EQUIVALENT(
    'no Managed stateless generation route',
  ),
  session_btw: NO_MANAGED_EQUIVALENT('no Managed side-question route'),
  session_shell_command: {
    standing: 'managed',
    evidence: 'tool:run_shell_command',
  },
  mcp_workspace_pool: NO_MANAGED_EQUIVALENT('no Managed MCP pool'),
  mcp_pool_restart: NO_MANAGED_EQUIVALENT('no Managed MCP pool'),
  require_auth: NO_MANAGED_EQUIVALENT(
    'every Managed route is authenticated; there is no loopback opt-out',
  ),
  allow_origin: LEGACY_ONLY('browser CORS opt-in belongs to the local daemon'),
  auth_device_flow: NO_MANAGED_EQUIVALENT(
    'Managed auth is the Control plane bearer and signature scheme',
  ),
  permission_mediation: {
    standing: 'managed',
    evidence: 'surface:ACTION_RESPOND,surface:SESSION_APPROVAL',
  },
  prompt_absolute_deadline: NO_MANAGED_EQUIVALENT(
    'no Managed prompt deadline knob',
  ),
  writer_idle_timeout: NO_MANAGED_EQUIVALENT(
    'a TUI writer timeout; Managed has no TUI writer',
  ),
  non_blocking_prompt: { standing: 'managed', evidence: 'surface:TURN_SUBMIT' },
  session_language: NO_MANAGED_EQUIVALENT('no Managed language route'),
  user_language_sync: NO_MANAGED_EQUIVALENT('no Managed language route'),
  session_message_deletion: NO_MANAGED_EQUIVALENT(
    'no Managed message deletion route',
  ),
  session_rewind: NO_MANAGED_EQUIVALENT('no Managed rewind route'),
  workspace_hooks: { standing: 'managed', evidence: 'surface:HOOK_CATALOG' },
  session_hooks: { standing: 'managed', evidence: 'surface:HOOK_CATALOG' },
  workspace_extensions: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  session_branch: NO_MANAGED_EQUIVALENT('no Managed branch route'),
  session_branch_worktree: NO_MANAGED_EQUIVALENT('no Managed branch route'),
  rate_limit: NO_MANAGED_EQUIVALENT('no Managed rate-limit knob'),
  workspace_reload: NO_MANAGED_EQUIVALENT('no Managed reload route'),
  workspace_model_reload: NO_MANAGED_EQUIVALENT(
    'the model is chosen per Session, not reloaded per workspace',
  ),
  channel_delivery: {
    standing: 'managed',
    evidence: 'surface:CHANNEL_DELIVERY_GET',
  },
  channel_reload: NO_MANAGED_EQUIVALENT('no Managed channel reload route'),
  channel_control: NO_MANAGED_EQUIVALENT('no Managed channel control route'),
  channel_management: { standing: 'managed', evidence: 'surface:CHANNEL_LIST' },
  channel_delete_config_loss_convergence: NO_MANAGED_EQUIVALENT(
    'no Managed channel delete route',
  ),
  workspace_channel_observed_contacts: NO_MANAGED_EQUIVALENT(
    'no Managed observed-contact route',
  ),
  multi_workspace_sessions: LEGACY_ONLY(
    'a daemon hosting several runtimes; Managed scopes by Workspace',
  ),
  multi_workspace_session_rewind: LEGACY_ONLY(
    'a daemon hosting several runtimes; Managed scopes by Workspace',
  ),
  multi_workspace_session_shell: LEGACY_ONLY(
    'a daemon hosting several runtimes; Managed scopes by Workspace',
  ),
  dynamic_workspace_registration: {
    standing: 'managed',
    evidence: 'surface:WORKSPACE_REGISTER',
  },
  persistent_workspace_registration: {
    standing: 'managed',
    evidence: 'surface:WORKSPACE_REGISTRATION_GET',
  },
  workspace_display_name: NO_MANAGED_EQUIVALENT(
    'Workspace identity is the registered directory',
  ),
  scratch_workspace_registration: {
    standing: 'managed',
    evidence: 'surface:WORKSPACE_CREATE',
  },
  workspace_runtime_removal: NO_MANAGED_EQUIVALENT(
    'no Managed Workspace removal route',
  ),
  native_directory_picker: LEGACY_ONLY(
    'a daemon-host dialog; Managed has none',
  ),
  workspace_runtime: {
    standing: 'managed',
    evidence: 'surface:WORKSPACE_DIRECTORIES',
  },
  workspace_runtime_stop: NO_MANAGED_EQUIVALENT(
    'no Managed Workspace stop route',
  ),
  workspace_local_open: LEGACY_ONLY('a daemon-host open; Managed has none'),
  workspace_local_terminal: LEGACY_ONLY(
    'a daemon-host terminal; Managed has none',
  ),
  workspace_qualified_rest_core: NO_MANAGED_EQUIVALENT(
    'Managed routes already name their Workspace in the path',
  ),
  workspace_qualified_voice: NO_MANAGED_EQUIVALENT('no Managed voice route'),
  workspace_qualified_memory: NO_MANAGED_EQUIVALENT(
    'issue #15075: no Managed memory CRUD',
  ),
  extension_management_v2: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  extension_list_details: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  extension_state: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  extension_git_credentials: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  extension_local_path_install: NO_MANAGED_EQUIVALENT(
    'no Managed extension management route',
  ),
  workspace_persisted_transcript: {
    standing: 'managed',
    evidence: 'surface:TRANSCRIPT_QUERY',
  },
  workspace_session_export: {
    standing: 'managed',
    evidence: 'surface:TRANSCRIPT_QUERY',
  },
  workspace_archived_session_export: NO_MANAGED_EQUIVALENT(
    'no Managed archived export route',
  ),
  workspace_session_live_state: NO_MANAGED_EQUIVALENT(
    'no Managed live-state snapshot',
  ),
  workspace_session_metadata: NO_MANAGED_EQUIVALENT(
    'Managed renames a Session and has no metadata bag',
  ),
  session_worktree_persistence_v1: NO_MANAGED_EQUIVALENT(
    'no Managed worktrees',
  ),
  session_worktree_reset_v1: NO_MANAGED_EQUIVALENT('no Managed worktrees'),
  workspace_qualified_acp: LEGACY_ONLY('no ACP in Managed'),
  client_mcp_over_ws: NO_MANAGED_EQUIVALENT(
    'no client-hosted MCP over the Managed transport',
  ),
  cdp_tunnel_over_ws: NO_MANAGED_EQUIVALENT('no Managed CDP tunnel'),
  browser_automation_mcp: NO_MANAGED_EQUIVALENT('no Managed CDP tunnel'),
  voice_transcribe: NO_MANAGED_EQUIVALENT('no Managed voice route'),
  realtime_voice: NO_MANAGED_EQUIVALENT('no Managed voice route'),
  realtime_voice_web: NO_MANAGED_EQUIVALENT('no Managed voice route'),
  web_terminal: NO_MANAGED_EQUIVALENT('no Managed web terminal'),
};

export interface CapabilityParityMatrix {
  'legacy only': ServeFeature[];
  both: ServeFeature[];
  'managed only': string[];
}

/**
 * Managed route labels with no legacy tag behind them, and why each is not a
 * parity claim. These are Managed operations the daemon models differently
 * rather than capabilities the daemon lacks; the two-column reading above
 * already accounts for them, so listing them as "managed only" would only
 * restate that.
 */
export const MANAGED_ONLY_NOT_A_GAP = new Set([
  // Covered by a legacy tag the row maps at a different granularity.
  'SESSION_GET',
  'SESSION_RENAME',
  'SESSION_DELETE',
  'SESSION_CWD_CHANGE',
  'SESSION_OPERATION_GET',
  'SESSION_MODELS',
  'SESSION_MCP',
  'SESSION_OPTIONS',
  'ITEM_LIST',
  'TOOL_RESULT_GET',
  'TURN_LIST',
  'TASK_GET',
  'TASK_CANCEL',
  'TASK_EVENT_LIST',
  'ACTION_GET',
  'ACTION_LIST',
  'WORKSPACE_GET',
  'WORKSPACE_LIST',
  'WORKSPACE_DIRECTORY_CHECK',
  'WORKSPACE_FILES_QUERY',
  'WORKSPACE_FILES_READ',
  // Tenant resources and admission the daemon has no counterpart for.
  'AGENT_DEFINITION_GET',
  'AGENT_DEFINITION_UPDATE',
  'AUTOMATION_CREATE',
  'AUTOMATION_GET',
  'AUTOMATION_LIST',
  'AUTOMATION_RETIRE',
  'AUTOMATION_RUN_LIST',
  'AUTOMATION_UPDATE',
  'CHANNEL_DELIVERY_LIST',
  'RUNTIME_NODE_LIST',
  // Internal writer and publication routes: between the control plane and its
  // own stores, behind writer credentials, never a client capability.
  'PUB_ADMISSION_PREPARE',
  'PUB_FINISH',
  'PUB_FINISHED',
  'PUB_GRANT',
  'PUB_OPERATION_GET',
  'PUB_OPERATION_RECOVER',
  'PUB_RANGE',
  'PUB_RECEIPT_COMMIT',
  'PUB_RECEIPT_VERIFY',
  'PUB_RESOURCE',
  'PUB_SEGMENT',
  'PUB_STREAM_PREFIX',
  'PUB_STREAM_SEAL',
  'STORE_APPROVAL_QUERY',
  'STORE_USER_MESSAGE_CLAIM',
  'STORE_EXECUTION_AUTHORIZE',
  'STORE_LIFECYCLE_AUTHORIZE',
  'STORE_RECOVERY_BLOCK',
  'STORE_RESOURCE_GET',
  'STORE_RESTORE',
  'STORE_TOOL_RESULT_PUBLISH',
  'STORE_TRANSACTION_COMMIT',
  'STORE_TRANSACTION_LIST',
  'STORE_WRITER_ACQUIRE',
  'STORE_WRITER_RENEW',
  'STORE_WRITER_SEAL',
]);

/**
 * The Managed capabilities the matrix reports with no legacy counterpart.
 * Each entry is a real gap, not an exclusion: the Managed path serves it and
 * `SERVE_CAPABILITY_REGISTRY` has no tag for it. Pinning the list makes the
 * column checked — a route added or removed without a decision fails the
 * suite — while the signal stays visible to whoever reads the matrix.
 *
 * Each label is a route pair on the public and the WebShell surface:
 * `SESSION_CONTEXT_COMPRESSION` compresses a Session's context,
 * `SESSION_RECOVERY_QUERY` reads a Session's recovery state and
 * `SESSION_RECOVERY_RECHECK` re-runs its recovery checks. The daemon
 * advertises no tag for any of the three.
 */
export const MANAGED_ONLY_REPORTED: readonly string[] = [
  'SESSION_CONTEXT_COMPRESSION',
  'SESSION_RECOVERY_QUERY',
  'SESSION_RECOVERY_RECHECK',
];

/**
 * Every `surface:` target a row cites, so a claim is one place only. */
function citedLabels(): Set<string> {
  const cited = new Set<string>();
  for (const row of Object.values(CAPABILITY_PARITY)) {
    if (row.standing !== 'managed') continue;
    for (const token of row.evidence.split(',')) {
      const match = /^surface:(.+)$/.exec(token.trim());
      if (match) cited.add(match[1]!);
    }
  }
  return cited;
}

/**
 * The Managed route labels no row cites: a route the Managed control plane
 * serves with no legacy tag behind it. Derived from the twin, so a newly
 * mounted route shows up here instead of needing a hand edit.
 */
export function managedOnlyLabels(surface: ManagedSurfaceSet): string[] {
  const cited = citedLabels();
  return [...surface.labels]
    .filter((label) => !cited.has(label))
    .filter((label) => !MANAGED_ONLY_NOT_A_GAP.has(label))
    .sort();
}

export function capabilityParityMatrix(
  surface: ManagedSurfaceSet,
): CapabilityParityMatrix {
  const legacyOnly: ServeFeature[] = [];
  const both: ServeFeature[] = [];
  for (const tag of Object.keys(SERVE_CAPABILITY_REGISTRY) as ServeFeature[]) {
    const row = CAPABILITY_PARITY[tag];
    (row.standing === 'managed' ? both : legacyOnly).push(tag);
  }
  return {
    'legacy only': legacyOnly,
    both,
    'managed only': managedOnlyLabels(surface),
  };
}
