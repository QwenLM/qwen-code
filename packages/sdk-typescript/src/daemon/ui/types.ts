/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonAuthDeviceFlowSdkErrorKind,
  DaemonAuthProviderId,
  DaemonEvent,
  DaemonErrorKind,
  PermissionResponse,
} from '../types.js';

export const DAEMON_PLAN_TOOL_CALL_ID = 'daemon-plan';

export type DaemonUiEventType =
  // Chat-stream events (Stage 1)
  | 'user.text.delta'
  | 'user.image.delta'
  | 'user.shell.command'
  | 'assistant.text.delta'
  | 'assistant.done'
  | 'thought.text.delta'
  | 'tool.update'
  | 'shell.output'
  | 'user.shell.output'
  | 'permission.request'
  | 'permission.resolved'
  | 'model.changed'
  | 'status'
  | 'error'
  | 'debug'
  // Session-meta events
  | 'session.metadata.changed'
  | 'session.approval_mode.changed'
  | 'session.available_commands'
  | 'session.state_resync_required'
  | 'session.replay_complete'
  // Prompt lifecycle (cross-client)
  | 'prompt.cancelled'
  // Daemon assist push (server-side ghost-text suggestion)
  | 'followup.suggestion'
  // Workspace events (Wave 3-4)
  | 'workspace.memory.changed'
  | 'workspace.agent.changed'
  | 'workspace.tool.toggled'
  | 'workspace.settings.changed'
  | 'workspace.initialized'
  | 'workspace.mcp.budget_warning'
  | 'workspace.mcp.child_refused'
  | 'workspace.mcp.server_restarted'
  | 'workspace.mcp.server_restart_refused'
  // Auth flow events (Wave 4 OAuth)
  | 'auth.device_flow.started'
  | 'auth.device_flow.throttled'
  | 'auth.device_flow.authorized'
  | 'auth.device_flow.failed'
  | 'auth.device_flow.cancelled';

export interface DaemonUiEventBase {
  type: DaemonUiEventType;
  /**
   * Daemon-monotonic SSE cursor. Use as the **primary ordering key** when
   * sorting events or transcript blocks — independent of any clock and
   * preserved across reconnects via `Last-Event-ID` replay.
   */
  eventId?: number;
  /**
   * Daemon-authoritative wall-clock timestamp (ms since epoch). Extracted
   * from `event._meta.serverTimestamp` if present. Use as the fallback
   * ordering key when `eventId` is absent (synthetic frames). Always
   * prefer this over client clock for cross-client "X minutes ago" display
   * — multiple subscribers viewing the same session see the same value.
   *
   * Undefined when the daemon did not stamp the envelope. Forward-compat:
   * the SDK reads the field whether the daemon emits it today or not.
   */
  serverTimestamp?: number;
  originatorClientId?: string;
  rawEvent?: DaemonEvent;
}

export interface DaemonUiTextEvent extends DaemonUiEventBase {
  type: 'user.text.delta' | 'assistant.text.delta' | 'thought.text.delta';
  text: string;
  parentToolCallId?: string;
}

export interface DaemonUiUserImageEvent extends DaemonUiEventBase {
  type: 'user.image.delta';
  data: string;
  mimeType: string;
}

export interface DaemonUiUserShellCommandEvent extends DaemonUiEventBase {
  type: 'user.shell.command';
  command: string;
  cwd?: string;
}

export interface DaemonUiAssistantDoneEvent extends DaemonUiEventBase {
  type: 'assistant.done';
  reason?: string;
}

/**
 * Where a tool originated. Closed enum so UI dispatch (icon, MCP server
 * badge, subagent header) doesn't depend on string-matching `toolName`.
 *
 * - `builtin`: ships with qwen-code (Bash, Edit, Read, etc.)
 * - `mcp`: provided by an MCP server (cross-reference `serverId`)
 * - `subagent`: invoked by a sub-agent delegation
 * - `unknown`: daemon did not stamp provenance — treat as unspecified
 */
export type DaemonUiToolProvenance = 'builtin' | 'mcp' | 'subagent' | 'unknown';

export interface DaemonUiToolUpdateEvent extends DaemonUiEventBase {
  type: 'tool.update';
  toolCallId: string;
  title?: string;
  status?: string;
  toolName?: string;
  toolKind?: string;
  content?: unknown;
  locations?: unknown;
  /**
   * Provenance taxonomy — defaults to `'unknown'` when the daemon event
   * lacks the `provenance` field. Heuristic fallback: a `toolName` starting
   * with `mcp__` is treated as `'mcp'`.
   */
  provenance?: DaemonUiToolProvenance;
  /**
   * When `provenance: 'mcp'`, identifies which MCP server provides the
   * tool. Parsed from `update.serverId` when present, or extracted from
   * `mcp__<serverId>__<toolName>` naming convention as a fallback.
   */
  serverId?: string;
  /**
   * When the tool was invoked by a sub-agent delegation, the
   * `toolCallId` of the parent agent's `Task` (or equivalent) tool call.
   * Lets the reducer correlate sub-agent tool blocks under their
   * parent block for nested rendering.
   *
   * Source: daemon stamps this in `tool_call._meta.parentToolCallId`
   * (see `SubAgentTracker.getSubagentMeta()` in core).
   */
  parentToolCallId?: string;
  /**
   * Type name of the sub-agent that produced this tool call (e.g.
   * `'code-reviewer'`). Pairs with `parentToolCallId` — when both are
   * present the tool call originated inside a sub-agent run.
   *
   * Source: daemon stamps `tool_call._meta.subagentType`.
   */
  subagentType?: string;
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface DaemonUiShellOutputEvent extends DaemonUiEventBase {
  type: 'shell.output';
  text: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonUiUserShellOutputEvent extends DaemonUiEventBase {
  type: 'user.shell.output';
  text: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonUiPermissionOption {
  optionId: string;
  label: string;
  description?: string;
  raw: unknown;
}

export interface DaemonUiPermissionRequestEvent extends DaemonUiEventBase {
  type: 'permission.request';
  requestId: string;
  sessionId?: string;
  title: string;
  options: DaemonUiPermissionOption[];
  toolCall?: unknown;
}

export interface DaemonUiPermissionResolvedEvent extends DaemonUiEventBase {
  type: 'permission.resolved';
  requestId: string;
  outcome: string;
  /**
   * A4: the client that cast the resolving vote (canonical name). On
   * `permission_resolved` the base `originatorClientId` carries the same
   * value for back-compat — but it means the *voter* here, vs the *prompt
   * originator* on `permission_request`; prefer `voterClientId` for clarity.
   * Absent for system-initiated resolutions (timer expiry / session-closed /
   * loopback voter with no clientId). The prompt originator remains available
   * by correlating with the matching `permission.request`.
   */
  voterClientId?: string;
}

export interface DaemonUiModelChangedEvent extends DaemonUiEventBase {
  type: 'model.changed';
  modelId: string;
}

export interface DaemonUiStatusEvent extends DaemonUiEventBase {
  type: 'status' | 'debug';
  text: string;
  source?: string;
  data?: unknown;
}

export interface DaemonUiErrorEvent extends DaemonUiEventBase {
  type: 'error';
  text: string;
  recoverable?: boolean;
  code?: string;
  promptId?: string;
  source?: 'turn_error';
  /**
   * Closed-enum error category propagated from the daemon's typed-error
   * taxonomy. Lets renderers branch on `errorKind` for "retry auth" vs
   * "check file path" affordances instead of regex-matching `text`.
   * Undefined when the originating daemon event is not categorized.
   */
  errorKind?: DaemonErrorKind;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Session-meta events
 * ──────────────────────────────────────────────────────────────────────── */

export interface DaemonUiSessionMetadataChangedEvent extends DaemonUiEventBase {
  type: 'session.metadata.changed';
  sessionId: string;
  displayName?: string;
}

export interface DaemonUiSessionApprovalModeChangedEvent
  extends DaemonUiEventBase {
  type: 'session.approval_mode.changed';
  sessionId: string;
  previous: string;
  next: string;
  persisted: boolean;
}

/**
 * Slash-command availability snapshot for the session. Fires from the
 * daemon's `available_commands_update` session-update. Renderers use it
 * to refresh command completion menus (TUI / web command palette / IDE
 * quick pick).
 */
export interface DaemonUiSessionAvailableCommandsEvent
  extends DaemonUiEventBase {
  type: 'session.available_commands';
  /** Total count exposed by the daemon; convenience for renderers. */
  count: number;
  /** Raw command objects from the daemon for downstream parsing. */
  commands: ReadonlyArray<Record<string, unknown>>;
}

export interface DaemonUiStateResyncRequiredEvent extends DaemonUiEventBase {
  type: 'session.state_resync_required';
  reason: string;
  lastDeliveredId: number;
  earliestAvailableId: number;
}

/**
 * A prompt on the session was cancelled — emitted by the daemon when a
 * client calls the cancel route OR when a prompt's originator SSE
 * connection drops mid-flight. Lets multi-client UIs surface "cancelled"
 * as a first-class event instead of inferring it from the absence of
 * further assistant chunks.
 *
 * Semantic: "cancel requested", not "cancel confirmed" — the daemon
 * publishes this before the agent has necessarily wound down. The
 * reducer treats it like an `assistant.done(cancelled)` for the purpose
 * of clearing in-flight tool spinners. `originatorClientId` (on the
 * base) identifies the cancelling client.
 */
export interface DaemonUiPromptCancelledEvent extends DaemonUiEventBase {
  type: 'prompt.cancelled';
  /**
   * Why the turn was cancelled. Absent for a user-initiated cancel;
   * `'forward_failed'` when the daemon synthesized the cancel because the
   * prompt forward rejected after the user echo was already published (the
   * bridge's C3 compensating broadcast). Lets the UI distinguish "peer
   * cancelled" from "the request failed to reach the agent".
   */
  reason?: 'forward_failed' | (string & {});
}

/**
 * Daemon assist push: a follow-up suggestion the ACP child generated
 * after the last end_turn. Adapters render it as ghost-text in the
 * input placeholder. The suggestion is already post-filter
 * (`getFilterReason()===null`) and non-empty — the wire never
 * carries rejected suggestions. `promptId` correlates with the
 * just-completed turn, so consumers can suppress stale events that
 * race a fresh user prompt (typically by clearing local display
 * state on sendPrompt).
 */
export interface DaemonUiFollowupSuggestionEvent extends DaemonUiEventBase {
  type: 'followup.suggestion';
  sessionId: string;
  suggestion: string;
  promptId: string;
}

/**
 * Sentinel signalling that the daemon has finished replaying buffered
 * events after a `Last-Event-ID` resume — consumers can drop a
 * catch-up indicator deterministically. Fires on both the clean-replay
 * and ring-evicted paths, and even when nothing was replayed
 * (`replayedCount === 0`).
 */
export interface DaemonUiReplayCompleteEvent extends DaemonUiEventBase {
  type: 'session.replay_complete';
  replayedCount: number;
  /** Highest event id delivered in the replay, when any frames replayed. */
  lastReplayedEventId?: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Workspace events (Wave 3-4)
 * ──────────────────────────────────────────────────────────────────────── */

export interface DaemonUiWorkspaceMemoryChangedEvent extends DaemonUiEventBase {
  type: 'workspace.memory.changed';
  scope: 'workspace' | 'global';
  filePath: string;
  mode: 'append' | 'replace';
  bytesWritten: number;
}

export interface DaemonUiWorkspaceAgentChangedEvent extends DaemonUiEventBase {
  type: 'workspace.agent.changed';
  change: 'created' | 'updated' | 'deleted';
  name: string;
  level: 'project' | 'user';
}

export interface DaemonUiWorkspaceToolToggledEvent extends DaemonUiEventBase {
  type: 'workspace.tool.toggled';
  toolName: string;
  enabled: boolean;
}

export interface DaemonUiWorkspaceSettingsChangedEvent
  extends DaemonUiEventBase {
  type: 'workspace.settings.changed';
  key: string;
  scope: string;
  value: unknown;
}

export interface DaemonUiWorkspaceInitializedEvent extends DaemonUiEventBase {
  type: 'workspace.initialized';
  path: string;
  action: 'created' | 'overwrote' | 'noop';
}

export interface DaemonUiMcpBudgetWarningEvent extends DaemonUiEventBase {
  type: 'workspace.mcp.budget_warning';
  liveCount: number;
  reservedCount: number;
  budget: number;
  thresholdRatio: number;
  mode: 'warn' | 'enforce';
}

export interface DaemonUiMcpChildRefusedEvent extends DaemonUiEventBase {
  type: 'workspace.mcp.child_refused';
  refusedServers: ReadonlyArray<{
    name: string;
    transport: string;
    reason: 'budget_exhausted';
  }>;
  budget: number;
  liveCount: number;
  reservedCount: number;
}

export interface DaemonUiMcpServerRestartedEvent extends DaemonUiEventBase {
  type: 'workspace.mcp.server_restarted';
  serverName: string;
  durationMs: number;
}

export interface DaemonUiMcpServerRestartRefusedEvent
  extends DaemonUiEventBase {
  type: 'workspace.mcp.server_restart_refused';
  serverName: string;
  reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
}

/* ──────────────────────────────────────────────────────────────────────────
 * Auth device-flow events (Wave 4 OAuth, RFC 8628)
 * ──────────────────────────────────────────────────────────────────────── */

export interface DaemonUiAuthDeviceFlowStartedEvent extends DaemonUiEventBase {
  type: 'auth.device_flow.started';
  deviceFlowId: string;
  providerId: DaemonAuthProviderId;
  expiresAt: number;
}

export interface DaemonUiAuthDeviceFlowThrottledEvent
  extends DaemonUiEventBase {
  type: 'auth.device_flow.throttled';
  deviceFlowId: string;
  intervalMs: number;
}

export interface DaemonUiAuthDeviceFlowAuthorizedEvent
  extends DaemonUiEventBase {
  type: 'auth.device_flow.authorized';
  deviceFlowId: string;
  providerId: DaemonAuthProviderId;
  expiresAt?: number;
  accountAlias?: string;
}

export interface DaemonUiAuthDeviceFlowFailedEvent extends DaemonUiEventBase {
  type: 'auth.device_flow.failed';
  deviceFlowId: string;
  errorKind: DaemonAuthDeviceFlowSdkErrorKind;
  hint?: string;
}

export interface DaemonUiAuthDeviceFlowCancelledEvent
  extends DaemonUiEventBase {
  type: 'auth.device_flow.cancelled';
  deviceFlowId: string;
}

export type DaemonUiAuthDeviceFlowEvent =
  | DaemonUiAuthDeviceFlowStartedEvent
  | DaemonUiAuthDeviceFlowThrottledEvent
  | DaemonUiAuthDeviceFlowAuthorizedEvent
  | DaemonUiAuthDeviceFlowFailedEvent
  | DaemonUiAuthDeviceFlowCancelledEvent;

export type DaemonUiEvent =
  // Chat-stream events
  | DaemonUiTextEvent
  | DaemonUiUserImageEvent
  | DaemonUiUserShellCommandEvent
  | DaemonUiAssistantDoneEvent
  | DaemonUiToolUpdateEvent
  | DaemonUiShellOutputEvent
  | DaemonUiUserShellOutputEvent
  | DaemonUiPermissionRequestEvent
  | DaemonUiPermissionResolvedEvent
  | DaemonUiModelChangedEvent
  | DaemonUiStatusEvent
  | DaemonUiErrorEvent
  // Session-meta events
  | DaemonUiSessionMetadataChangedEvent
  | DaemonUiSessionApprovalModeChangedEvent
  | DaemonUiSessionAvailableCommandsEvent
  | DaemonUiStateResyncRequiredEvent
  | DaemonUiReplayCompleteEvent
  // Prompt lifecycle (cross-client)
  | DaemonUiPromptCancelledEvent
  // Daemon assist push (server-side ghost-text suggestion)
  | DaemonUiFollowupSuggestionEvent
  // Workspace events
  | DaemonUiWorkspaceMemoryChangedEvent
  | DaemonUiWorkspaceAgentChangedEvent
  | DaemonUiWorkspaceToolToggledEvent
  | DaemonUiWorkspaceSettingsChangedEvent
  | DaemonUiWorkspaceInitializedEvent
  | DaemonUiMcpBudgetWarningEvent
  | DaemonUiMcpChildRefusedEvent
  | DaemonUiMcpServerRestartedEvent
  | DaemonUiMcpServerRestartRefusedEvent
  // Auth device-flow events
  | DaemonUiAuthDeviceFlowEvent;

export interface NormalizeDaemonEventOptions {
  /**
   * Client id returned by `DaemonSessionClient`. Used only for optional
   * optimistic-echo suppression; the raw stream remains unchanged.
   */
  clientId?: string;
  /**
   * When a UI app already appended the user's own prompt optimistically,
   * suppress the matching `user_message_chunk` echo from the daemon.
   */
  suppressOwnUserEcho?: boolean;
  /** Keep raw daemon event envelopes on each UI event for debug panels. */
  includeRawEvent?: boolean;
}

export interface DaemonTranscriptQuestionOption {
  label: string;
  description?: string;
  raw: unknown;
}

export interface DaemonTranscriptQuestion {
  header?: string;
  question: string;
  options: DaemonTranscriptQuestionOption[];
  raw: unknown;
}

export type DaemonToolPreview =
  | {
      kind: 'ask_user_question';
      questions: DaemonTranscriptQuestion[];
    }
  | {
      kind: 'command';
      command: string;
      cwd?: string;
    }
  | {
      kind: 'file_diff';
      path: string;
      oldText?: string;
      newText?: string;
      /**
       * Optional unified-diff text. When the daemon ships a pre-computed
       * patch, prefer rendering this over recomputing in the UI.
       */
      patch?: string;
    }
  | {
      kind: 'file_read';
      path: string;
      /**
       * Optional `[startLine, endLine]` 1-based inclusive range. Undefined
       * when the tool read the entire file.
       */
      range?: readonly [number, number];
    }
  | {
      kind: 'web_fetch';
      url: string;
      /** HTTP method (defaults to GET when daemon does not stamp it). */
      method?: string;
    }
  | {
      kind: 'mcp_invocation';
      serverId: string;
      toolName: string;
      /**
       * Trimmed argument summary. Full args remain on `rawInput`; this is
       * a short string for inline display.
       */
      argsSummary?: string;
    }
  | {
      kind: 'code_block';
      /** Programming language identifier for syntax highlighting (best-effort). */
      language?: string;
      /** Code body. Renderers fence with triple-backtick markdown. */
      code: string;
      /** Optional file path / origin label, e.g., `path/to/file.ts:42`. */
      origin?: string;
    }
  | {
      kind: 'search';
      /** Query string the tool sent. */
      query: string;
      /** Match count from `resultCount` / `total` / `results.length`. */
      resultCount?: number;
      /** Up to 5 top result lines (paths, snippets). */
      top?: readonly string[];
    }
  | {
      kind: 'tabular';
      /** Column headers. Empty array when daemon doesn't stamp columns. */
      columns: readonly string[];
      /** Row values aligned with `columns`. Capped at 50 rows to bound payload. */
      rows: ReadonlyArray<readonly string[]>;
      /** Total row count if rows are truncated; undefined when full. */
      totalRows?: number;
    }
  | {
      kind: 'image_generation';
      /** Prompt that produced the image. */
      prompt: string;
      /** Optional thumbnail / URL for inline preview. */
      thumbnailUrl?: string;
      /** Optional model id (e.g., `dall-e-3`, `qwen-image`). */
      model?: string;
    }
  | {
      kind: 'subagent_delegation';
      /** Sub-agent name receiving the delegation. */
      agentName: string;
      /** Task description / prompt sent to the sub-agent. */
      task: string;
      /** Optional parent delegation id for chained subagents. */
      parentDelegationId?: string;
    }
  | {
      kind: 'key_value';
      rows: Array<{ label: string; value: string }>;
    }
  | {
      kind: 'generic';
      summary?: string;
    };

export type DaemonTranscriptBlockKind =
  | 'user'
  | 'assistant'
  | 'thought'
  | 'tool'
  | 'shell'
  | 'user_shell'
  | 'permission'
  | 'status'
  | 'error'
  | 'debug'
  | 'prompt_cancelled';

export interface DaemonTranscriptBlockBase {
  id: string;
  kind: DaemonTranscriptBlockKind;
  /**
   * Daemon-monotonic SSE cursor. Primary ordering key — use this for
   * `blocks.sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0))` instead
   * of `createdAt`, which is client-clock-based and unstable under
   * replay/reconnect (see PR-B time-schema notes).
   */
  eventId?: number;
  /**
   * Daemon-authoritative wall-clock timestamp captured when the block was
   * first observed. Mirrors the event's `serverTimestamp`. Undefined when
   * the daemon did not stamp the envelope (current state) or when the
   * block was created locally (e.g., `appendLocalUserTranscriptMessage`).
   *
   * **Prefer this** over `createdAt` for cross-client "X minutes ago"
   * display: clients viewing the same session see the same value.
   */
  serverTimestamp?: number;
  /**
   * Same as the previous `createdAt` semantics — client-local clock at the
   * moment the block was first observed. Renamed for clarity:
   * - `clientReceivedAt`: when **this** client saw the event (always set)
   * - `serverTimestamp`: when the daemon emitted it (may be unset)
   *
   * Backwards-compatible field `createdAt` is set equal to
   * `clientReceivedAt` at construction time. New code should use
   * `clientReceivedAt`.
   */
  clientReceivedAt: number;
  /**
   * @deprecated Use `clientReceivedAt` instead. Preserved for backwards
   * compatibility with code written before PR-B. Always equals
   * `clientReceivedAt`.
   */
  createdAt: number;
  /** Client-local clock at the moment the block was last mutated. */
  updatedAt: number;
}

export interface DaemonTextTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'user' | 'assistant' | 'thought';
  text: string;
  /** Images attached to this user message (base64 data URIs). */
  images?: Array<{ data: string; mimeType: string }>;
  streaming?: boolean;
  collapsed?: boolean;
  /** Used by the reducer for per-subAgent block routing; renderers may use it for nesting. */
  parentToolCallId?: string;
}

export interface DaemonToolTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'tool';
  toolCallId: string;
  title: string;
  status: string;
  toolName?: string;
  toolKind?: string;
  preview: DaemonToolPreview;
  content?: unknown;
  locations?: unknown;
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  /**
   * When this tool call was invoked by a sub-agent delegation, the
   * `toolCallId` of the parent agent's `Task`-equivalent tool call.
   * Renderers can group / nest sub-agent activity under their parent
   * block.
   *
   * Mirrors `DaemonUiToolUpdateEvent.parentToolCallId`. Resolved from
   * `tool_call._meta.parentToolCallId` (see `SubAgentTracker` in core).
   */
  parentToolCallId?: string;
  /**
   * Sub-agent type label (e.g. `'code-reviewer'`). Present iff this
   * block came from a sub-agent delegation.
   */
  subagentType?: string;
  /**
   * `id` of the parent transcript block, populated by the reducer when
   * `parentToolCallId` matches a block already in state. Renderers can
   * walk this for visual nesting without re-correlating IDs.
   */
  parentBlockId?: string;
}

export interface DaemonShellTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'shell';
  text: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonUserShellTranscriptBlock
  extends DaemonTranscriptBlockBase {
  kind: 'user_shell';
  text: string;
  command: string;
  cwd?: string;
  stream?: 'stdout' | 'stderr';
}

export interface DaemonPermissionTranscriptBlock
  extends DaemonTranscriptBlockBase {
  kind: 'permission';
  requestId: string;
  sessionId?: string;
  title: string;
  options: DaemonUiPermissionOption[];
  toolCall?: unknown;
  preview: DaemonToolPreview;
  resolved?: string;
}

export interface DaemonStatusTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'status' | 'error' | 'debug';
  text: string;
  code?: string;
  promptId?: string;
  source?: string;
  data?: unknown;
}

export interface DaemonPromptCancelledTranscriptBlock
  extends DaemonTranscriptBlockBase {
  kind: 'prompt_cancelled';
  reason?: string;
}

export type DaemonTranscriptBlock =
  | DaemonTextTranscriptBlock
  | DaemonToolTranscriptBlock
  | DaemonShellTranscriptBlock
  | DaemonUserShellTranscriptBlock
  | DaemonPermissionTranscriptBlock
  | DaemonStatusTranscriptBlock
  | DaemonPromptCancelledTranscriptBlock;

/**
 * PR-E sidechannel state — workspace / session state mirror that tracks
 * non-chat events without polluting the chat-stream `blocks[]`.
 */
export interface DaemonTranscriptSidechannelState {
  /**
   * `toolCallId` of the tool currently in `running` / `in_progress` /
   * `pending`. Updated by the reducer when a `tool.update` event arrives;
   * cleared when the tool terminates. Used by UI to show a "正在运行 X tool"
   * status header without scanning `blocks[]`.
   */
  currentToolCallId?: string;
  /**
   * Approval mode for the current session, mirrored from
   * `session.approval_mode.changed` events. Renderers use this to badge
   * the input area ("plan" / "default" / "auto-edit" / "yolo").
   */
  approvalMode?: string;
  /**
   * Per-tool progress map, keyed by `toolCallId`. Populated by future
   * `tool.progress` events (daemon-side emission pending — the SDK is
   * ready to consume the field shape today).
   */
  toolProgress: Record<string, { ratio?: number; step?: string }>;
  /** True after daemon reports missed SSE events and before state is reloaded. */
  awaitingResync: boolean;
  /** Count of resync-required frames observed by this transcript store. */
  resyncRequiredCount: number;
  /** Most recent daemon resync gap payload. */
  lastResyncRequired?: {
    reason: string;
    lastDeliveredId: number;
    earliestAvailableId: number;
  };
  /**
   * Daemon assist push: most recent `followup.suggestion` observed.
   * Adapters render the `suggestion` as ghost-text in the input
   * placeholder. `promptId` correlates with the turn that produced it
   * so consumers can correlate / suppress stale suggestions after a
   * fresh user prompt. Undefined until the daemon emits one for this
   * session. Self-invalidated by consumers on sendPrompt (no wire
   * round-trip).
   */
  lastFollowupSuggestion?: {
    suggestion: string;
    promptId: string;
  };
  pendingUserShellCommand?: {
    command: string;
    cwd?: string;
  };
}

export interface DaemonTranscriptState
  extends DaemonTranscriptSidechannelState {
  // wenshao R5 (deepseek-v4-pro): `blocks` is frozen at the dispatch
  // boundary in `reduceDaemonTranscriptEvents` (defense against
  // consumer in-place mutation poisoning the shared snapshot under
  // lazy COW). Match the runtime contract at the type level so
  // consumers get a compile-time error for `state.blocks.sort()` /
  // `.push()` instead of a runtime `TypeError`. Internal reducer
  // mutation goes through `takeBlocksOwnership` which casts away
  // readonly after copying — the only place that's allowed.
  blocks: readonly DaemonTranscriptBlock[];
  lastEventId?: number;
  activeUserBlockId?: string;
  activeAssistantBlockId?: string;
  activeThoughtBlockId?: string;
  activeAssistantBlockByParent: Record<string, string>;
  activeThoughtBlockByParent: Record<string, string>;
  blockIndexById: Record<string, number>;
  toolBlockByCallId: Record<string, string>;
  trimmedToolNotificationByCallId: Record<string, true>;
  permissionBlockByRequestId: Record<string, string>;
  nextOrdinal: number;
  now: number;
  maxBlocks: number;
}

export interface DaemonTranscriptReducerOptions {
  maxBlocks?: number;
  now?: number;
}

export interface DaemonTranscriptStore {
  getSnapshot(): DaemonTranscriptState;
  subscribe(listener: () => void): () => void;
  dispatch(event: DaemonUiEvent | DaemonUiEvent[]): void;
  appendLocalUserMessage(
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): void;
  reset(seed?: Partial<DaemonTranscriptState>): void;
  /**
   * Clear the `awaitingResync` latch that gets set when the daemon emits
   * `session.state_resync_required`.
   *
   * **Recovery flow (call BEFORE the new SSE stream starts):**
   * 1. Receive `session.state_resync_required` event → latch sets
   * 2. Call `clearAwaitingResync()` (keep blocks) OR `reset()` (clean slate)
   * 3. Re-subscribe to SSE (optionally with `Last-Event-ID: 0` for replay)
   *
   * (R6 review caught a flow bug — the earlier JSDoc said "after replay
   * drains" but while the latch is set every replay event is dropped.
   * Clear FIRST, then stream events.)
   */
  clearAwaitingResync(): void;
  /**
   * Clear `lastFollowupSuggestion` from sidechannel state. Adapters call
   * this on sendPrompt so the prior turn's ghost-text suggestion stops
   * rendering immediately (no wire round-trip — server-side
   * invalidation would waste a ring slot per prompt). Idempotent: no-op
   * when no suggestion is set.
   */
  clearFollowupSuggestion(): void;
}

export interface DaemonUiSessionActions {
  sendPrompt(text: string): Promise<unknown>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<unknown>;
  respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean>;
}
