/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared contract for session-centric multi-agent collaboration.
 *
 * The model: an ordinary chat session is the conversation. The user (and other
 * agents) @-mention workspace agents inside it; each mentioned agent runs one
 * turn in its OWN native session (a hidden Qwen ACP session, a Claude Code
 * session, or a Codex thread), keyed by (chat session, agent), and its reply is
 * written back into the same chat session as an authored message. There are no
 * threads, tickets, statuses or sub-tasks.
 *
 * Layer ownership (see docs/plans/2026-10-05-session-multi-agent-redesign.md):
 * - daemon orchestrator (cli/serve/session-agents): queueing, coalescing, live
 *   progress, status, approvals, leases, adapters;
 * - ACP child (cli/acp-integration Session): durable record + model history,
 *   via the `qwen/control/session/external_record` ext method;
 * - transcript-replay (acp-bridge): projects the records for reload, /resume
 *   and export, so the three restore paths share one projection.
 *
 * Cross-package copies: web-shell cannot import core, so the wire shapes the
 * browser reads (`QwenAgentMessageMeta`, `SessionAgentRunFrame`) are mirrored
 * in `packages/sdk-typescript/src/daemon/ui/types.ts`. Keep both in sync.
 */

/** Programs an agent can run with. Mirrors `AgentProgram` in workspace-agents/types.ts. */
export type SessionAgentProgram = 'qwen' | 'claude' | 'codex';

/* ------------------------------------------------------------------------ */
/* Records: written by the ACP child, projected by transcript-replay.        */
/* ------------------------------------------------------------------------ */

/**
 * `ChatRecord.subtype` values introduced by this feature.
 *
 * - `agent_mention`: a user message that @-mentions agents. It is recorded as a
 *   user message (so it shows up and the main model sees it next turn) but it
 *   does NOT start a main-model turn — the mentioned agents answer instead.
 * - `agent_message`: one agent's finished reply (or its failure), authored.
 *
 * Both are `type: 'user'` records so the main model reads them as input rather
 * than as its own words. Every subtype allow/deny list that classifies user
 * records (turn boundaries, title, recovery trim, export) must handle both.
 */
export const AGENT_MENTION_SUBTYPE = 'agent_mention' as const;
export const AGENT_MESSAGE_SUBTYPE = 'agent_message' as const;

export type SessionAgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'offline';

export type SessionAgentTerminalStatus = Extract<
  SessionAgentRunStatus,
  'completed' | 'failed' | 'cancelled' | 'offline'
>;

export interface SessionAgentStep {
  /** Stable id within the run (tool call id when the program has one). */
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed';
}

/** Author identity carried on records, live frames and rendered messages. */
export interface SessionAgentAuthor {
  agentId: string;
  name: string;
  color?: string;
  program?: SessionAgentProgram;
  /** Runtime the agent ran on: 'local' or a host id. */
  runtimeId?: string;
}

/** `systemPayload` of an `agent_message` record. */
export interface AgentMessageRecordPayload {
  /** Markdown shown in the UI. */
  displayText: string;
  author: SessionAgentAuthor;
  runId: string;
  status: SessionAgentTerminalStatus;
  error?: string;
  steps?: SessionAgentStep[];
  /** Native session the reply came from (resume pointer), for diagnostics. */
  nativeSessionId?: string;
  /** Tokens the run spent, when the program reports it. */
  totalTokens?: number;
  /** The record uuid that triggered this run (the mention or agent message). */
  triggerRecordId?: string;
}

/** `systemPayload` of an `agent_mention` record. */
export interface AgentMentionRecordPayload {
  displayText: string;
  /** Agent ids the message addressed. */
  mentionedAgentIds: string[];
  /** Author when an agent (not the user) posted via `session_send`. */
  author?: SessionAgentAuthor;
}

/* ------------------------------------------------------------------------ */
/* Ext method: daemon -> ACP child.                                          */
/* ------------------------------------------------------------------------ */

/** `qwen/control/session/external_record` (SERVE_CONTROL_EXT_METHODS.sessionExternalRecord). */
export const SESSION_EXTERNAL_RECORD_EXT_METHOD =
  'qwen/control/session/external_record' as const;

export type SessionExternalRecordRequest =
  | {
      sessionId: string;
      kind: 'agent_mention';
      /** Idempotency key; a repeated key returns the first result. */
      recordKey: string;
      /** Text the main model reads (already enveloped by the daemon). */
      modelText: string;
      payload: AgentMentionRecordPayload;
    }
  | {
      sessionId: string;
      kind: 'agent_message';
      recordKey: string;
      modelText: string;
      payload: AgentMessageRecordPayload;
    };

export interface SessionExternalRecordResponse {
  sessionId: string;
  /** uuid of the written record (the read cursor anchor). */
  recordId: string;
  /** False when the record already existed for this recordKey. */
  created: boolean;
  /**
   * True when a main-model turn was running: the child holds the record and
   * writes it once the turn settles; `recordId` is then empty, so the caller
   * must not advance a read cursor to it.
   */
  deferred?: boolean;
}

/* ------------------------------------------------------------------------ */
/* Live meta: what the browser sees on the session event stream.            */
/* ------------------------------------------------------------------------ */

/**
 * `_meta.qwenAgentMessage` on the `agent_message_chunk` / `user_message_chunk`
 * update that the ACP child emits when it writes an external record, and that
 * transcript-replay emits for the same record. The segment id is
 * `agent:<runId>` (or `mention:<record uuid>`), so live and replay reconcile.
 */
export interface QwenAgentMessageMeta {
  kind: 'agent_message' | 'agent_mention';
  author?: SessionAgentAuthor;
  runId?: string;
  status?: SessionAgentTerminalStatus;
  error?: string;
  steps?: SessionAgentStep[];
  totalTokens?: number;
  mentionedAgentIds?: string[];
}

export const QWEN_AGENT_MESSAGE_META_KEY = 'qwenAgentMessage' as const;

/**
 * In-flight state is NOT in the transcript. The daemon publishes it on the
 * workspace agent event stream (`GET /workspaces/:ws/agent/session-events?sessionId=`) as `run`
 * frames, keyed by session. The browser renders these as live agent messages
 * at the bottom of the session and drops them once the terminal record lands.
 */
export interface SessionAgentRunFrame {
  type: 'run';
  sessionId: string;
  runId: string;
  author: SessionAgentAuthor;
  status: SessionAgentRunStatus;
  /** 1-based position among this agent's queued runs, when queued. */
  queuePosition?: number;
  outputText?: string;
  thoughtText?: string;
  steps?: SessionAgentStep[];
  /** Present while status === 'awaiting_approval'. */
  permission?: SessionAgentPermissionPrompt;
  error?: string;
  totalTokens?: number;
  /** Epoch ms of the last activity (for "no activity for N min"). */
  activityAt: number;
  /**
   * Record state of a terminal frame. The client rule:
   * - `true`: the run's `agent_message` record is in the transcript; drop the
   *   live card (the record renders instead).
   * - `false`: the record is pending (deferred while a main-model turn runs,
   *   or its write is being retried), or the run is `retryable`; keep the
   *   card. A later frame for the same run settles it.
   * - absent: no record will be written for this run (cancelled while
   *   queued, dismissed, or superseded by `retriedAsRunId`); drop the card.
   * Non-terminal frames never carry it.
   */
  recorded?: boolean;
  /** uuid of that record, when known. */
  recordId?: string;
  /**
   * A run interrupted by a daemon restart (`failed`, error "daemon
   * restarted"): offer "Retry" (`POST .../runs/:runId/retry`) and "Dismiss"
   * (`POST .../runs/:runId/cancel`).
   */
  retryable?: boolean;
  /** Set on the final frame of a retried run: the run that replaces it. */
  retriedAsRunId?: string;
}

export interface SessionAgentPermissionPrompt {
  requestId: string;
  title: string;
  /** Tool kind / name, when known. */
  toolName?: string;
  /** Raw input preview, bounded. */
  inputPreview?: string;
  options: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
}

/** Signal frame: roster or runtime presence changed; clients refetch. */
export interface SessionAgentChangedFrame {
  type: 'changed';
  scope: 'agents' | 'runtimes';
}

export type SessionAgentEventFrame =
  | SessionAgentRunFrame
  | SessionAgentChangedFrame;

/* ------------------------------------------------------------------------ */
/* Bindings: daemon-owned state per chat session.                            */
/* ------------------------------------------------------------------------ */

export const SESSION_AGENTS_SCHEMA_VERSION = 1 as const;

/** One (chat session, agent) pair. */
export interface SessionAgentBinding {
  agentId: string;
  /** Program-native session id to resume (Qwen session id / Claude session_id / Codex threadId). */
  nativeSessionId?: string;
  /** Runtime the native session lives on; a resume is only valid there. */
  runtimeId?: string;
  /**
   * Program that created the native session. A different runtime or program
   * means a fresh native session, and the agent is then given the
   * conversation from the start (bounded), not the delta after the cursor.
   */
  program?: SessionAgentProgram;
  /** Last chat-session record uuid this agent has been given (read cursor). */
  readThroughRecordId?: string;
  /**
   * Set only on a remote Host, for a turn it runs on behalf of a coordinator:
   * the agent is not in this Host's roster, so the persona travels with the
   * assignment and this binding is what authorizes the hidden `agent` session.
   */
  remotePersona?: { name: string; instructions?: string; model?: string };
}

export interface SessionAgentRun {
  id: string;
  agentId: string;
  status: SessionAgentRunStatus;
  /** Record uuids that triggered this run (coalesced while queued). */
  triggerRecordIds: string[];
  /** Agent-to-agent hop count of the chain this run belongs to. */
  chainDepth: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /**
   * Remote runs: lease fencing (see host protocol below). Kept on a run
   * cancelled while a Host executed it, so a restarted daemon can still tell
   * that Host the run was cancelled.
   */
  lease?: {
    hostId: string;
    leaseId: string;
    attempt: number;
    expiresAt: number;
    /** Highest `HostTurnEventBatch.sequence` accepted for this attempt. */
    lastSequence?: number;
  };
  attempts: number;
  totalTokens?: number;
  /** The run this one retries (see `retryable` on the run frame). */
  retryOf?: string;
}

/** On disk: `<agentsDir>/sessions/<sessionId>.json`, mode 0600. */
export interface SessionAgentsFile {
  schemaVersion: typeof SESSION_AGENTS_SCHEMA_VERSION;
  sessionId: string;
  bindings: Record<string, SessionAgentBinding>;
  /** Live and recent runs; terminal runs are trimmed to the newest 50. */
  runs: SessionAgentRun[];
  /**
   * Tokens agent runs in this chat session have spent since the last human
   * message (reset by a human mention). Bounded by the token budget.
   */
  chainTokens?: number;
}

/* ------------------------------------------------------------------------ */
/* Adapters: one per program, shared by local and remote execution.          */
/* ------------------------------------------------------------------------ */

export type AgentAdapterEvent =
  | { type: 'native_session'; nativeSessionId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thought_delta'; text: string }
  | { type: 'step'; step: SessionAgentStep }
  | { type: 'permission_request'; prompt: SessionAgentPermissionPrompt }
  | { type: 'permission_resolved'; requestId: string }
  | { type: 'usage'; totalTokens: number }
  /** An outbound message the agent posted with the `session_send` tool. */
  | { type: 'session_send'; text: string };

export interface AgentAdapterTurnInput {
  /** Text sent as the user turn (delta of the chat session + trigger). */
  prompt: string;
  /** System / developer instructions (persona). Applied on a fresh session. */
  instructions?: string;
  model?: string;
  /** Resume this native session when set. */
  nativeSessionId?: string;
  /** Working directory on the machine that executes the program. */
  cwd: string;
  /**
   * The `session_send` MCP server to expose to the program for this turn
   * (stdio command). Undefined when the runtime cannot offer it.
   */
  sessionSendServer?: { command: string; args: string[]; env?: Record<string, string> };
  signal: AbortSignal;
  onEvent(event: AgentAdapterEvent): void;
  /** Resolves with the chosen optionId; the adapter answers the program. */
  awaitPermission(prompt: SessionAgentPermissionPrompt): Promise<string>;
}

export interface AgentAdapterTurnResult {
  status: 'completed' | 'failed' | 'cancelled';
  /** Final answer text (the deliverable). */
  outputText: string;
  error?: string;
  nativeSessionId?: string;
  /** True when the requested resume was refused and a fresh session was used. */
  resumeRejected?: boolean;
  totalTokens?: number;
}

export interface AgentAdapter {
  readonly program: SessionAgentProgram;
  runTurn(input: AgentAdapterTurnInput): Promise<AgentAdapterTurnResult>;
}

/* ------------------------------------------------------------------------ */
/* Host protocol v2 (coordinator <-> remote `qwen serve`).                   */
/* ------------------------------------------------------------------------ */

/**
 * Transport is unchanged (outbound HTTP from the Host: enroll, heartbeat,
 * pickup, events, result). What changes is the payload: work is a session
 * turn, progress is an ordered event batch, permissions round-trip, and the
 * result returns the native session id.
 */
export const HOST_PROTOCOL_VERSION = 2 as const;

export interface HostTurnAssignment {
  protocol: typeof HOST_PROTOCOL_VERSION;
  sessionId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  leaseExpiresAt: number;
  agent: SessionAgentAuthor & { instructions?: string; model?: string };
  program: SessionAgentProgram;
  prompt: string;
  nativeSessionId?: string;
}

export interface HostTurnEventBatch {
  sessionId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  /** Monotonic per (runId, attempt); the coordinator drops replays. */
  sequence: number;
  events: AgentAdapterEvent[];
}

/**
 * Per-run answer to a lease renewal in the heartbeat response. `cancelled`
 * means the person stopped the run on the coordinator: the Host aborts the
 * turn and does not post a result.
 */
export interface HostLeaseStatus {
  runId: string;
  ok: boolean;
  cancelled?: boolean;
}

/** Returned in heartbeat / pickup responses. */
export interface HostPermissionDecision {
  runId: string;
  attempt: number;
  requestId: string;
  optionId: string;
  /**
   * Unique per decision. A person may answer the same `requestId` again;
   * the newest decision replaces the earlier one, and the Host applies each
   * `decisionId` at most once.
   */
  decisionId?: string;
}

export interface HostTurnResult {
  sessionId: string;
  runId: string;
  attempt: number;
  leaseId: string;
  result: AgentAdapterTurnResult;
}

/** Programs a Host advertises after probing its PATH. */
export interface HostProgramProbe {
  program: SessionAgentProgram;
  version?: string;
  available: boolean;
  /** Why it is unavailable (missing, below minimum version, ...). */
  reason?: string;
}

/** Minimum CLI versions, following Multica's floors (server/pkg/agent/version.go). */
export const MIN_PROGRAM_VERSIONS: Readonly<Record<'claude' | 'codex', string>> = {
  claude: '2.0.0',
  // `codex app-server --listen stdio://` arrived in 0.100.0.
  codex: '0.100.0',
};

/* ------------------------------------------------------------------------ */
/* Limits.                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Agent-to-agent chain limit. 0 means unlimited (the default, per product
 * decision 2026-10-05); the UI always offers "stop all agents" and shows token
 * usage per agent message. A human post resets the chain.
 */
export const DEFAULT_AGENT_CHAIN_LIMIT = 0;

/**
 * Cumulative token budget for agent runs in one chat session between two
 * human messages (`experimental.agentTokenBudget`). Once spent, agents may
 * still answer what they were asked but cannot wake other agents until a
 * person posts again. 0 means unlimited. The default matches the thread-era
 * per-tree budget.
 */
export const DEFAULT_AGENT_TOKEN_BUDGET = 1_000_000;

/** Budget for the conversation delta handed to an agent, in characters. */
export const AGENT_INPUT_CHAR_BUDGET = 48_000;
