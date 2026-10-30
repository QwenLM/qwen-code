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
 * in `packages/sdk-typescript/src/daemon/session-agents.ts`. Keep both in
 * sync.
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
  /** Set when the agent ran as the leader of this squad. */
  squadName?: string;
  /**
   * Set on a member's reply its squad's leader was waiting on: the squad it
   * answered for. Display only; leader logic keys on `squadName`.
   */
  memberSquadName?: string;
}

/**
 * Outcome of a squad leader's turn. `no_action`: the leader replied with
 * nothing (it decided nothing was needed); rendered as a muted line.
 */
export type SessionSquadOutcome = 'no_action';

/**
 * Whitespace plus the invisible characters a model may answer with when it
 * means "nothing": every default-ignorable code point (zero-width space /
 * non-joiner / joiner, word joiner, U+FEFF, soft hyphen, the bidi marks and
 * isolates, variation selectors, ...). Matched by Unicode property rather
 * than a hand-kept list so no invisible character is missed; visible format
 * characters (e.g. the Arabic number signs, which are `Cf`) are not in it.
 * `String.prototype.trim()` keeps all of these but U+FEFF.
 */
const BLANK_AGENT_TEXT = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;

/**
 * True when an agent's text shows nothing: empty, or only whitespace and
 * invisible characters (see {@link BLANK_AGENT_TEXT}). Such a reply counts as
 * no reply (a squad leader's `no_action`), never as a blank message.
 * Mirrored in web-shell (`isBlankAgentText` in agent-message-details.tsx).
 */
export function isBlankAgentText(text: string): boolean {
  return BLANK_AGENT_TEXT.test(text);
}

/**
 * Longest `displayText` an `agent_message` record may carry, in characters.
 * The daemon must not send a longer reply, and the ACP child refuses one
 * (session-external-record-params.ts), so both read this one value.
 */
export const MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS = 262_144;

/**
 * Most `steps` an `agent_message` record may carry. The daemon keeps the
 * latest ones; the ACP child refuses a longer list.
 */
export const MAX_AGENT_MESSAGE_STEPS = 64;

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
  /** Set on a squad leader's empty reply. */
  squadOutcome?: SessionSquadOutcome;
}

/** `systemPayload` of an `agent_mention` record. */
export interface AgentMentionRecordPayload {
  displayText: string;
  /** Agent ids the message addressed. */
  mentionedAgentIds: string[];
  /** Squad ids the message addressed (each runs its leader in squad mode). */
  mentionedSquadIds?: string[];
  /** Author when an agent (not the user) posted via `session_send`. */
  author?: SessionAgentAuthor;
  /** Why some addressed squads were not started (leader unavailable). */
  error?: string;
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
  mentionedSquadIds?: string[];
  /** `no_action`: a squad leader's empty reply (a muted one-line row). */
  squadOutcome?: SessionSquadOutcome;
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
   * A finished run with no record in the transcript that can run again:
   * interrupted by a daemon restart (`failed`, error "daemon restarted") or
   * another stop of the daemon's agents (error "stopped: …", e.g. agent
   * collaboration turned off),
   * stopped because its runtime went `offline`, or finished before a restart
   * with its record never written. Offer "Retry"
   * (`POST .../runs/:runId/retry`) and "Dismiss"
   * (`POST .../runs/:runId/cancel`). Always sent with `recorded: false`.
   */
  retryable?: boolean;
  /** Set on the final frame of a retried run: the run that replaces it. */
  retriedAsRunId?: string;
  /**
   * The squad engagement this run belongs to: the leader's squad-mode run,
   * or a member run the leader delegated and is waiting on.
   */
  squadId?: string;
  /** That squad's name, for the session's engagement bar. */
  squadName?: string;
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
  scope: 'agents' | 'runtimes' | 'squads';
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
  /** Set on a squad leader's run: it runs in squad mode for this squad. */
  squadId?: string;
  /**
   * Record state of a terminal run, persisted so a restarted daemon can
   * offer the run again: `true` once its `agent_message` record is in the
   * transcript; `false` while no record is there (its write is deferred or
   * failed, or the run is offered for retry: interrupted by a restart, or
   * offline); absent when none is expected (cancelled while queued,
   * dismissed, retried, or a refused write).
   */
  recorded?: boolean;
}

/**
 * One squad engagement in a chat session: a person @-mentioned the squad, its
 * leader runs in squad mode, delegates to members by @-mention, and is woken
 * each time one of them finishes. Ends (`active: false`) when a leader turn
 * finishes with nothing outstanding and no further leader turn queued.
 */
export interface SessionSquadEngagement {
  leaderAgentId: string;
  /** The record (or `pending:` trigger id) that started it. */
  startedByRecordId: string;
  /** Member runs the leader delegated and has not yet been woken for. */
  outstandingRunIds: string[];
  /**
   * Member runs that finished while their reply's record was still pending:
   * each owes the leader a wake once the record lands (or the reply is given
   * up on). Persisted so a restarted daemon still wakes the leader. Absent
   * when none.
   */
  pendingWakeRunIds?: string[];
  active: boolean;
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
  /** Squad engagements in this session, by squad id. */
  squads?: Record<string, SessionSquadEngagement>;
}

/* ------------------------------------------------------------------------ */
/* Squads: daemon-owned, per workspace (`<agentsDir>/squads.json`).          */
/* ------------------------------------------------------------------------ */

export const SESSION_SQUADS_SCHEMA_VERSION = 1 as const;

export interface SessionSquadMember {
  agentId: string;
  /** What the leader should use this member for (shown in the roster). */
  role?: string;
}

/**
 * A named group of agents with a leader. `@name` wakes only the leader, which
 * coordinates: it delegates to members by @-mention and is woken when they
 * reply. Names share the agents' namespace (no agent and squad share one).
 */
export interface SessionSquad {
  id: string;
  name: string;
  description?: string;
  /** Standing instructions for the leader, shown in its squad briefing. */
  instructions?: string;
  leaderAgentId: string;
  /** Agents only; the leader need not be one of them. */
  members: SessionSquadMember[];
  createdAt: number;
  updatedAt: number;
  /** Set when a person retires the squad; it then takes no new work. */
  retiredAt?: number;
}

export interface SessionSquadsFile {
  schemaVersion: typeof SESSION_SQUADS_SCHEMA_VERSION;
  squads: SessionSquad[];
}

/**
 * Why a squad cannot be activated: its leader agent no longer exists, was
 * retired, or is disabled. A missing or retired leader needs a new leader.
 */
export type SessionSquadLeaderIssue = 'missing' | 'retired' | 'disabled';

/** A squad as the routes return it: names resolved against the roster. */
export interface SessionSquadView extends SessionSquad {
  leaderName?: string;
  /** Set when the squad cannot be activated (see {@link SessionSquadLeaderIssue}). */
  leaderIssue?: SessionSquadLeaderIssue;
  members: Array<SessionSquadMember & { name: string }>;
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
  /**
   * Text sent as the user turn: the chat session since the agent's read
   * cursor (the delta) when `nativeSessionId` is resumed, else the
   * conversation from the start (bounded by the budget).
   */
  prompt: string;
  /**
   * Set only with `nativeSessionId`: the turn built without the read cursor
   * (the conversation from the start, bounded by the budget). Sent instead of
   * `prompt` when the resume is refused and a fresh native session is
   * started, so that session gets the history in the same turn.
   */
  freshPrompt?: string;
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
  sessionSendServer?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
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
  /** See {@link AgentAdapterTurnInput.freshPrompt}; set only with `nativeSessionId`. */
  freshPrompt?: string;
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
export const MIN_PROGRAM_VERSIONS: Readonly<
  Record<'claude' | 'codex', string>
> = {
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
