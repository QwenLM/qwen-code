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
  | 'assistant.text.delta'
  | 'assistant.done'
  | 'thought.text.delta'
  | 'tool.update'
  | 'shell.output'
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
  // Workspace events (Wave 3-4)
  | 'workspace.memory.changed'
  | 'workspace.agent.changed'
  | 'workspace.tool.toggled'
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
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface DaemonUiShellOutputEvent extends DaemonUiEventBase {
  type: 'shell.output';
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
}

export interface DaemonUiModelChangedEvent extends DaemonUiEventBase {
  type: 'model.changed';
  modelId: string;
}

export interface DaemonUiStatusEvent extends DaemonUiEventBase {
  type: 'status' | 'debug';
  text: string;
}

export interface DaemonUiErrorEvent extends DaemonUiEventBase {
  type: 'error';
  text: string;
  recoverable?: boolean;
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
  | DaemonUiAssistantDoneEvent
  | DaemonUiToolUpdateEvent
  | DaemonUiShellOutputEvent
  | DaemonUiPermissionRequestEvent
  | DaemonUiPermissionResolvedEvent
  | DaemonUiModelChangedEvent
  | DaemonUiStatusEvent
  | DaemonUiErrorEvent
  // Session-meta events
  | DaemonUiSessionMetadataChangedEvent
  | DaemonUiSessionApprovalModeChangedEvent
  | DaemonUiSessionAvailableCommandsEvent
  // Workspace events
  | DaemonUiWorkspaceMemoryChangedEvent
  | DaemonUiWorkspaceAgentChangedEvent
  | DaemonUiWorkspaceToolToggledEvent
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
  | 'permission'
  | 'status'
  | 'error'
  | 'debug';

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
   * Backwards-compatible alias `createdAt` remains as a getter for
   * existing consumers; new code should use `clientReceivedAt`.
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
  streaming?: boolean;
  collapsed?: boolean;
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
}

export interface DaemonShellTranscriptBlock extends DaemonTranscriptBlockBase {
  kind: 'shell';
  text: string;
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
}

export type DaemonTranscriptBlock =
  | DaemonTextTranscriptBlock
  | DaemonToolTranscriptBlock
  | DaemonShellTranscriptBlock
  | DaemonPermissionTranscriptBlock
  | DaemonStatusTranscriptBlock;

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
}

export interface DaemonTranscriptState extends DaemonTranscriptSidechannelState {
  blocks: DaemonTranscriptBlock[];
  lastEventId?: number;
  activeUserBlockId?: string;
  activeAssistantBlockId?: string;
  activeThoughtBlockId?: string;
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
  appendLocalUserMessage(text: string): void;
  reset(seed?: Partial<DaemonTranscriptState>): void;
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
