/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Session multi-agent orchestrator, one per workspace.
 *
 * Owns, per chat session (session-multi-agent design §3.1): queueing and coalescing of agent runs,
 * starting them (locally through an adapter, or by handing them to a remote
 * Host through the in-memory pickup queue), live progress frames, run status,
 * permission relay, Host leases, and the agent-to-agent chain.
 *
 * Durable output goes through the ACP child (`bridge.appendExternalRecord`):
 * an `agent_mention` record for the post that addressed agents, and an
 * `agent_message` record per finished run. In-flight state lives only here
 * and on the event hub. Bindings and runs are persisted per chat session by
 * the core binding store; the in-memory copy is authoritative while the
 * daemon runs (this assumes one daemon per workspace).
 *
 * Concurrency rules: per (chat session, agent) at most one executing run and
 * at most one queued run (session-multi-agent design §8-3, run-queue.ts), so a native session is
 * never driven by two processes; and per agent, across chat sessions, at
 * most `maxConcurrentRuns` executing runs (default 1). Queued runs start
 * oldest first across sessions; `queuePosition` on a frame counts the
 * agent's queued runs in every session.
 *
 * Record state: a run's terminal frame says whether its `agent_message`
 * record is in the transcript (`recorded`, see contract.ts). A record the
 * ACP child deferred (a main-model turn was running), or one whose write
 * failed, is watched by re-sending the same idempotent request with backoff
 * until it lands, for at most {@link RECORD_WATCH_MAX_MS}; meanwhile the
 * snapshot keeps reporting the run with `recorded: false`.
 *
 * Restart: runs a previous daemon left live are adopted from disk. Queued
 * runs of managed-host agents stay queued; a remote run that was executing
 * under a lease is re-adopted with its lease and last accepted event
 * sequence, so the Host can carry on; every other one is `failed` with
 * "daemon restarted" and offered for {@link SessionAgentOrchestrator.retry}.
 * A run that finished with its record still pending (`run.recorded: false`;
 * the record request itself is in memory only) is offered for retry too,
 * while the transcript is checked for the record in case it landed.
 *
 * Stop: a stopped local run ignores what its adapter still reports while the
 * turn winds down (a late permission request is refused, never shown), and a
 * remote one is answered `cancelled` from then on. A remote run whose lease
 * lapses (its Host went away) ends `offline` without a record and is offered
 * for retry like a restart failure.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import {
  isAgentAddressable,
  maxConcurrentRunsFor,
  readWorkspaceAgents,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import type { WorkspaceAgent } from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  AGENT_INPUT_CHAR_BUDGET,
  DEFAULT_AGENT_TOKEN_BUDGET,
  AGENT_MESSAGE_SUBTYPE,
  HOST_PROTOCOL_VERSION,
  isBlankAgentText,
  MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS,
  MAX_AGENT_MESSAGE_STEPS,
  type AgentAdapter,
  type AgentAdapterEvent,
  type AgentAdapterTurnInput,
  type AgentMessageRecordPayload,
  type HostPermissionDecision,
  type HostTurnAssignment,
  type HostTurnEventBatch,
  type HostTurnResult,
  type SessionAgentAuthor,
  type SessionAgentPermissionPrompt,
  type SessionAgentProgram,
  type SessionAgentRun,
  type SessionAgentRunFrame,
  type SessionAgentRunStatus,
  type SessionAgentStep,
  type SessionAgentTerminalStatus,
  type SessionAgentsFile,
  type SessionExternalRecordResponse,
  type SessionSquad,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { readSquads as readWorkspaceSquads } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import {
  formatAgentMentionModelText,
  formatAgentMessageModelText,
} from '@qwen-code/qwen-code-core/agents/session-agents/envelope.js';
import {
  canReuseNativeSession,
  isTerminalSessionAgentRunStatus,
  isValidSessionAgentsSessionId,
  listSessionAgentsSessionIds,
  readSessionAgents,
  trimTerminalRuns,
  writeSessionAgents,
} from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import {
  buildAgentInput,
  type BuildAgentInputOptions,
  type ConversationRecordLike,
  type SquadBriefing,
} from '@qwen-code/qwen-code-core/agents/session-agents/conversation-delta.js';
import {
  isWithinChainLimit,
  isWithinTokenBudget,
  nextChainDepth,
  normalizeAgentChainLimit,
  normalizeAgentTokenBudget,
  resolveMentionTargetsWithSquads,
  type UnavailableSquadTarget,
} from '@qwen-code/qwen-code-core/agents/session-agents/chain.js';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
  type BridgeClientRequestContext,
} from '../acp-session-bridge.js';
import {
  MAX_EXTERNAL_RECORD_ID_LENGTH,
  MAX_EXTERNAL_RECORD_MENTION_IDS,
  MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH,
  MAX_EXTERNAL_RECORD_TEXT_LENGTH,
} from '../../acp-integration/session-external-record-params.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { sessionAgentNativeSessionId } from '../../runtime/agent-session-source.js';
import {
  getAdapter as defaultGetAdapter,
  type AgentAdapterContext,
} from './adapters/index.js';
import type {
  QwenAcpAdapterBridge,
  QwenSessionSendBinding,
} from './adapters/qwen-acp.js';
import {
  getSessionAgentEventHub,
  type SessionAgentEventHub,
} from './events.js';
import {
  enqueueTrigger,
  isExecutingRun,
  nextRunnable,
  queuePosition,
} from './run-queue.js';

/** Runtime id of this daemon in bindings and author stamps. */
export const LOCAL_SESSION_AGENT_RUNTIME_ID = 'local';
/**
 * A local run with no agent activity (and no person to wait on) for this
 * long is stopped. Paused while a permission is pending.
 */
export const SESSION_AGENT_STALL_TIMEOUT_MS = 15 * 60_000;
export const SESSION_AGENT_STALLED_ERROR = 'agent_run_stalled';
export const SESSION_AGENT_RESTARTED_ERROR = 'daemon restarted';
/** Why an orchestrator is stopped (see {@link SessionAgentOrchestrator.dispose}). */
export type SessionAgentStopReason =
  /** The daemon is stopping (or restarting). */
  | 'shutdown'
  /** The workspace's runtime was replaced by a new bridge. */
  | 'runtime_replaced'
  /** The workspace was closed or removed from the daemon. */
  | 'workspace_closed'
  | 'workspace_untrusted'
  /** `experimental.agentCollaboration` was turned off for the workspace. */
  | 'collaboration_disabled';
/** The error a local run stopped mid-turn by dispose ends with, per reason. */
export const SESSION_AGENT_STOPPED_ERRORS: Readonly<
  Record<SessionAgentStopReason, string>
> = {
  shutdown: SESSION_AGENT_RESTARTED_ERROR,
  runtime_replaced: 'stopped: the workspace runtime was restarted',
  workspace_closed: 'stopped: the workspace was closed',
  workspace_untrusted: 'stopped: the workspace is no longer trusted',
  collaboration_disabled: 'stopped: agent collaboration was turned off',
};
export const SESSION_AGENT_OFFLINE_ERROR = 'runtime went offline';
/** A run finished before a restart, its reply never in the transcript. */
export const SESSION_AGENT_REPLY_NOT_RECORDED_ERROR =
  'the reply was not recorded before the daemon stopped';
/** Remote turn lease; a Host renews it while it works. */
export const HOST_TURN_LEASE_MS = 60_000;
const SWEEP_INTERVAL_MS = 5_000;
// A run's output is kept up to what its record may carry.
const MAX_OUTPUT_CHARS = MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS;
const MAX_THOUGHT_CHARS = 65_536;
const MAX_FRAME_STEPS = 8;
/** Steps a run keeps (the oldest go first): what its record may carry. */
const MAX_RUN_STEPS = MAX_AGENT_MESSAGE_STEPS;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
// The ACP child's limit on a mention's display text, so an accepted mention
// can be recorded.
const MAX_MENTION_TEXT_CHARS = MAX_EXTERNAL_RECORD_TEXT_LENGTH;
/** Appended to a reply clipped to the record's display text limit. */
const CLIPPED_REPLY_NOTE = '\n\n[Reply truncated.]';
/**
 * Tokens a turn that reported no count (a failed stats read, a Host that
 * omits usage) is charged against `experimental.agentTokenBudget`. Counted
 * as 0, such turns would let an agent-to-agent loop run unbounded while the
 * chain limit is off (its default). A low estimate of one agent turn (the
 * system prompt and tools alone come near it): the default budget allows
 * about 100 such turns between a person's posts.
 */
export const UNREPORTED_TURN_TOKENS = 10_000;
/** How long a deferred post is carried before it is assumed recorded. */
const PENDING_POST_TTL_MS = 60 * 60_000;
/** First re-check of a deferred / failed `agent_message` record write. */
export const RECORD_WATCH_INITIAL_MS = 1_000;
const RECORD_WATCH_MAX_INTERVAL_MS = 15_000;
/** How long a pending record is watched before the watcher gives up. */
export const RECORD_WATCH_MAX_MS = PENDING_POST_TTL_MS;
/**
 * How long a restarted daemon checks the transcript for the record of a run
 * that finished with it pending. Its writer died with the previous daemon, so
 * this only catches a record that landed before the run's state was saved.
 */
export const RECORD_RECOVERY_WATCH_MAX_MS = 30_000;
/** Terminal runs the snapshot still reports (record pending, or retryable). */
const MAX_SETTLED_RUNS = 200;
/** How long a Host is told "cancelled" for a run stopped while it ran it. */
const CANCELLED_LEASE_TTL_MS = 10 * 60_000;

/**
 * Writes durable records through the ACP child. A record is deferred (and
 * `recordId` is empty) while a main-model turn runs; a Managed session
 * refuses with `errorKind: 'managed_session_unsupported'`.
 */
export type SessionAgentRecordWriter = Pick<
  AcpSessionBridge,
  'appendExternalRecord'
>;

export type SessionAgentBridge = QwenAcpAdapterBridge &
  SessionAgentRecordWriter;

type RecordRequest = Parameters<
  SessionAgentRecordWriter['appendExternalRecord']
>[1];

/** A linked agent definition, as far as a session turn needs it. */
export interface SessionAgentDefinition {
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  /** Set when the definition names an external executor (refused). */
  executor?: unknown;
}

/** A refusal the route maps to an HTTP status. */
export class SessionAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionAgentError';
  }
}

export interface SessionAgentRunSummary {
  runId: string;
  agentId: string;
  status: SessionAgentRunStatus;
}

/** One live run, as {@link SessionAgentOrchestrator.liveRuns} reports it. */
export interface SessionAgentLiveRunSummary {
  sessionId: string;
  runId: string;
  agentId: string;
  status: SessionAgentRunStatus;
  /** The Host executing it, for a run handed to a remote runtime. */
  hostId?: string;
}

export interface SessionAgentMentionResult {
  /** uuid of the `agent_mention` record; empty while it is deferred. */
  recordId: string;
  /** The ACP child holds the record until the main-model turn settles. */
  deferred?: boolean;
  runs: SessionAgentRunSummary[];
  /** Why some mentioned squads were not started (also on the record). */
  squadError?: string;
}

/**
 * Answer to a Host's lease renewal, event batch or result. A failure means
 * the Host must stop the turn; `reason: 'cancelled'` (with `cancelled:
 * true`) means the person stopped the run here: abort it and post no
 * result. Host routes map it to `HostLeaseStatus.cancelled` (heartbeat) and
 * to 409 `{error: 'cancelled', cancelled: true}` (events, result).
 */
export type HostAck =
  | { ok: true; duplicate?: boolean; leaseExpiresAt?: number }
  | { ok: false; reason: 'unknown_run' | 'lease_mismatch' }
  | { ok: false; reason: 'cancelled'; cancelled: true };

export interface SessionAgentOrchestratorOptions {
  workspaceCwd: string;
  bridge: SessionAgentBridge;
  hub?: SessionAgentEventHub;
  /** `experimental.agentChainLimit` for this workspace, read per use. */
  chainLimit?: () => number;
  /** `experimental.agentTokenBudget` for this workspace, read per use. */
  tokenBudget?: () => number;
  /** Test seams. */
  readAgents?: (workspaceCwd: string) => Promise<WorkspaceAgent[]>;
  readSquads?: (workspaceCwd: string) => Promise<SessionSquad[]>;
  loadRecords?: (
    sessionId: string,
  ) => Promise<readonly ConversationRecordLike[]>;
  getAdapter?: (
    program: SessionAgentProgram,
    context: AgentAdapterContext,
  ) => AgentAdapter;
  now?: () => number;
  stallTimeoutMs?: number;
  leaseMs?: number;
  /** First re-check delay of a pending record (doubles, capped at 15s). */
  recordWatchMs?: number;
  /** Loads a linked agent definition (`WorkspaceAgent.agentType`) by name. */
  loadDefinition?: (
    workspaceCwd: string,
    name: string,
  ) => Promise<SessionAgentDefinition | null>;
  /**
   * The loopback URL of this daemon's `session_send` endpoint for one
   * (chat session, agent) binding
   * (`POST .../sessions/:sessionId/agents/:agentId/send`). Undefined (or not
   * loopback) means local turns are not offered the `session_send` tool.
   */
  sessionSendUrl?: (sessionId: string, agentId: string) => string | undefined;
  /**
   * Brings a chat session that is not live back into the bridge, before an
   * external record is written to it again. Default: `bridge.resumeSession`.
   * A standalone (daemon-owned) chat session restores through its own
   * service instead (routes/session-agents.ts).
   */
  restoreSession?: (sessionId: string) => Promise<void>;
  /** Set false in tests to drive sweeps by hand. */
  startTimers?: boolean;
}

interface SessionState {
  sessionId: string;
  file: SessionAgentsFile;
  writeChain: Promise<void>;
}

interface PendingPermission {
  resolve(optionId: string): void;
  reject(error: Error): void;
}

interface LiveRun {
  sessionId: string;
  run: SessionAgentRun;
  author: SessionAgentAuthor;
  /** The agent's `maxConcurrentRuns`, as last read from the roster. */
  maxConcurrent: number;
  frame: SessionAgentRunFrame;
  steps: Map<string, SessionAgentStep>;
  controller?: AbortController;
  /** `shutdown`: the orchestrator is stopping (see dispose). */
  abortReason?: 'cancelled' | 'stalled' | 'shutdown';
  pendingPermissions: Map<string, PendingPermission>;
  voterContexts: Map<string, BridgeClientRequestContext>;
  /** Newest chat record the run's prompt included (the next read cursor). */
  lastRecordId?: string;
  /**
   * This turn offered the adapter a from-the-start prompt for a refused
   * resume. A fresh native session then already holds the conversation, so
   * the cursor advances normally instead of being reset.
   */
  offeredFreshPrompt?: boolean;
  nativeSessionId?: string;
  totalTokens?: number;
  sendCount: number;
  /** Serializes `session_send` handling so records keep their order. */
  sendChain: Promise<void>;
  /** Name of the squad this run leads (`run.squadId`), once known. */
  squadName?: string;
  /**
   * The squad whose leader waited on this (member) run, kept once the run
   * finishes and is released from the engagement: its record and last frame
   * still name the squad.
   */
  memberSquadId?: string;
  /** Lease, attempt and last sequence live on `run.lease` (persisted). */
  remote?: {
    hostId: string;
    program: SessionAgentProgram;
    decisions: HostPermissionDecision[];
  };
}

/**
 * A terminal run the snapshot still reports: its record is pending (watched
 * until it lands), or it was interrupted by a restart and can be retried.
 */
interface SettledRun {
  sessionId: string;
  frame: SessionAgentRunFrame;
  /** The record request being re-sent; absent for a retryable run. */
  request?: RecordRequest;
  /**
   * Adopted after a restart with its record pending: the request is gone,
   * so the watcher only looks for the record in the transcript.
   */
  recovered?: true;
  /** `error` to show once the record lands (a write error is cleared). */
  recordedError?: string;
  /**
   * Leaders a member reply owes a wake: fired with the record's uuid once it
   * lands, or with the reply carried as a post if the watcher gives up. The
   * engagement stays active meanwhile.
   */
  wakes?: PendingWake[];
  timer?: ReturnType<typeof setTimeout>;
}

/** A squad leader to wake once a member reply's record settles. */
interface PendingWake {
  squadId: string;
  /** As read when the member finished; its run re-checks the roster. */
  leader: WorkspaceAgent;
  chainDepth: number;
}

/** A squad an agent's post addressed, with the leader it runs. */
interface SquadTarget {
  squad: SessionSquad;
  leader: WorkspaceAgent;
}

interface CancelledLease {
  sessionId: string;
  hostId: string;
  leaseId: string;
  attempt: number;
  at: number;
}

/**
 * A post the ACP child accepted but deferred (a main-model turn was running),
 * so it is not yet in the transcript the delta is read from. Carried here
 * and handed to agents until it shows up in the records.
 */
interface PendingPost {
  sessionId: string;
  /** The trigger id used for it (`pending:<recordKey>`). */
  id: string;
  kind: 'agent_mention' | 'agent_message';
  speaker: string;
  text: string;
  authorAgentId?: string;
  runId?: string;
  createdAt: number;
}

/** Maps an external-record failure to the error the route / run reports. */
/**
 * A reply's display text within the ACP child's limit for an `agent_message`
 * record (the adapter's final answer is not bounded): longer text keeps its
 * start and says it was cut, so the record is never refused for its size.
 */
function clipReplyText(text: string): string {
  if (text.length <= MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS) return text;
  let end = MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS - CLIPPED_REPLY_NOTE.length;
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + CLIPPED_REPLY_NOTE;
}

/**
 * The steps an `agent_message` record carries, within the ACP child's
 * limits: the latest {@link MAX_AGENT_MESSAGE_STEPS}, titles cut to their
 * limit, and none whose id is too long to record.
 */
function recordSteps(steps: Iterable<SessionAgentStep>): SessionAgentStep[] {
  return [...steps]
    .filter((step) => step.id.length <= MAX_EXTERNAL_RECORD_ID_LENGTH)
    .slice(-MAX_AGENT_MESSAGE_STEPS)
    .map((step) =>
      step.title.length > MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH
        ? {
            ...step,
            title: step.title.slice(0, MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH),
          }
        : step,
    );
}

/**
 * The ACP child refuses a record listing more ids than it holds, so a
 * message addressing more agents or squads is refused here, up front, instead
 * of being written and lost.
 */
function assertMentionFitsRecord(agents: number, squads: number): void {
  if (
    agents > MAX_EXTERNAL_RECORD_MENTION_IDS ||
    squads > MAX_EXTERNAL_RECORD_MENTION_IDS
  ) {
    throw new SessionAgentError(
      400,
      'too_many_mentions',
      `A message can address at most ${MAX_EXTERNAL_RECORD_MENTION_IDS} agents and ${MAX_EXTERNAL_RECORD_MENTION_IDS} squads.`,
    );
  }
}

function recordWriteError(error: unknown): SessionAgentError {
  const data = (error as { data?: unknown } | undefined)?.data;
  const kind =
    typeof data === 'object' && data !== null
      ? (data as { errorKind?: unknown }).errorKind
      : undefined;
  const message = getErrorMessage(error);
  if (
    kind === 'managed_session_unsupported' ||
    message.includes('managed_session_unsupported') ||
    message.includes('not supported in managed sessions')
  ) {
    // TODO(multi-agent): confirm how the bridge surfaces the child's
    // invalidParams `data` (errorKind) on the rejected promise.
    return new SessionAgentError(
      400,
      'managed_session_unsupported',
      'Session agents are not supported in managed sessions.',
    );
  }
  return new SessionAgentError(502, 'record_write_failed', message);
}

/** Trigger id for a written or deferred external record. */
function triggerIdFor(
  response: SessionExternalRecordResponse,
  recordKey: string,
): string {
  return response.deferred || !response.recordId
    ? `pending:${recordKey}`
    : response.recordId;
}

interface FinishOutcome {
  status: SessionAgentTerminalStatus;
  outputText: string;
  error?: string;
  nativeSessionId?: string;
  totalTokens?: number;
  /** The program refused the resume and used a fresh native session. */
  resumeRejected?: boolean;
}

/**
 * The program an agent runs with: `execution.provider`, default `qwen`.
 * For a managed-host agent without `provider`, "the host's default" is taken
 * to be qwen when offered, else the first program the host advertises.
 */
export function programForAgent(
  agent: WorkspaceAgent,
  hostPrograms?: readonly SessionAgentProgram[],
): SessionAgentProgram | undefined {
  if (agent.execution?.mode !== 'managed-host') {
    // A local agent may run Claude Code or Codex on this machine; whether the
    // CLI is installed is checked by the adapter when the turn starts.
    return agent.execution?.provider ?? 'qwen';
  }
  const provider = agent.execution.provider;
  if (!hostPrograms) return provider ?? 'qwen';
  if (provider) return hostPrograms.includes(provider) ? provider : undefined;
  return hostPrograms.includes('qwen') ? 'qwen' : hostPrograms[0];
}

function authorFor(
  agent: WorkspaceAgent,
  runtimeId?: string,
  program?: SessionAgentProgram,
): SessionAgentAuthor {
  return {
    agentId: agent.id,
    name: agent.name,
    ...(agent.color ? { color: agent.color } : {}),
    ...(program ? { program } : {}),
    ...(runtimeId ? { runtimeId } : {}),
  };
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * The stdio MCP server that exposes `session_send` to a local Claude / Codex
 * turn: this CLI's hidden `agents session-send-mcp` command, pointed at the
 * run's endpoint, with the run's token in its environment.
 */
export function buildSessionSendServer(
  url: string,
  token: string,
): NonNullable<AgentAdapterTurnInput['sessionSendServer']> | undefined {
  // Same entry precedent as `currentCliWorkerLaunch`.
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1];
  if (!cliEntry) return undefined;
  // Inspector flags would make every MCP child open a debugger.
  const execArgv = process.execArgv.filter(
    (arg) => !/^--(inspect|debug)/.test(arg),
  );
  // TODO(multi-agent): a dev build started through a loader env var (see
  // `processBootLoaderEnv`) does not pass it on here; production bundles do
  // not need it.
  return {
    command: process.execPath,
    args: [...execArgv, cliEntry, 'agents', 'session-send-mcp', '--url', url],
    env: { QWEN_SESSION_SEND_TOKEN: token },
  };
}

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenBudgetError(budget: number, names: string[]): string {
  return `Agent token budget (${budget.toLocaleString('en-US')} tokens since your last message) reached; not started: ${names
    .map((name) => `@${name}`)
    .join(', ')}. Post a message to continue.`;
}

/** Why mentioned squads were not started, one sentence each. */
/**
 * Why an agent's post started no one: the agents it named that cannot run,
 * and the `@tokens` that matched no agent. Undefined when it named none.
 */
function unreachedAgentsError(
  unavailable: readonly WorkspaceAgent[],
  unknown: readonly string[],
): string | undefined {
  const reasons = [
    ...(unavailable.length > 0
      ? [
          `${unavailable.map((agent) => `@${agent.name}`).join(', ')} cannot run (paused or retired)`,
        ]
      : []),
    ...(unknown.length > 0
      ? [`${unknown.map((name) => `@${name}`).join(', ')} matched no agent`]
      : []),
  ];
  return reasons.length > 0
    ? `This post reached no agent: ${reasons.join('; ')}.`
    : undefined;
}

function squadUnavailableError(
  unavailable: readonly UnavailableSquadTarget[],
): string {
  return unavailable
    .map(({ squad, reason }) =>
      reason === 'retired'
        ? `Squad @${squad.name} is retired.`
        : reason === 'leader_disabled'
          ? `Squad @${squad.name} was not started: its leader is paused. Resume the leader or pick another one.`
          : `Squad @${squad.name} was not started: it needs a new leader (the leader agent was ${
              reason === 'leader_retired' ? 'retired' : 'removed'
            }).`,
    )
    .join(' ');
}

const PROGRAM_LABELS: Readonly<Record<SessionAgentProgram, string>> = {
  qwen: 'Qwen Code',
  claude: 'Claude Code',
  codex: 'Codex',
};

function joinErrors(...errors: Array<string | undefined>): string | undefined {
  const present = errors.filter((error): error is string => !!error);
  return present.length > 0 ? present.join(' ') : undefined;
}

function chainLimitError(limit: number, names: string[]): string {
  return `Agent chain limit (${limit}) reached; not started: ${names
    .map((name) => `@${name}`)
    .join(', ')}.`;
}

/** Reads a definition the way the daemon's agent-definition routes do. */
async function defaultLoadDefinition(
  workspaceCwd: string,
  name: string,
): Promise<SessionAgentDefinition | null> {
  // Lazy: the routes module is heavy and only an agent with `agentType`
  // running outside this daemon's ACP child needs it.
  const { createDaemonSubagentManager } = await import(
    '../workspace-agents.js'
  );
  return createDaemonSubagentManager(workspaceCwd).loadSubagent(name);
}

/**
 * Persona text for a turn the ACP child does not resolve itself (a Claude /
 * Codex turn, or any remote turn): the linked definition's prompt followed
 * by the agent's own instructions. Fails closed like `resolveAgentPersona`.
 * TODO(multi-agent): model-facing text — needs eval before release. For a
 * remote qwen turn the Host wraps all of this under "configured with these
 * instructions", after the identity contract, while a local qwen turn puts
 * the definition prompt before it.
 */
export async function resolveTurnPersona(
  agent: WorkspaceAgent,
  program: SessionAgentProgram,
  loadDefinition: (name: string) => Promise<SessionAgentDefinition | null>,
): Promise<{ instructions?: string; model?: string }> {
  let definitionPrompt: string | undefined;
  let definitionModel: string | undefined;
  if (agent.agentType) {
    const loaded = await loadDefinition(agent.agentType);
    if (!loaded) {
      throw new Error(`Agent definition "${agent.agentType}" is unavailable.`);
    }
    if (loaded.executor !== undefined) {
      throw new Error(
        `Agent definition "${agent.agentType}" declares an external executor, which a workspace Agent cannot use. Set execution.mode to "managed-host" on the Agent instead, or use a definition without an executor block.`,
      );
    }
    if (
      program !== 'qwen' &&
      ((loaded.tools?.length && !loaded.tools.includes('*')) ||
        loaded.disallowedTools?.length)
    ) {
      throw new Error(
        `Agent definition "${agent.agentType}" restricts tools, which the ${program} runtime cannot enforce. Use the Qwen runtime for this definition, or choose a definition without tool restrictions.`,
      );
    }
    definitionPrompt = loaded.systemPrompt?.trim() || undefined;
    definitionModel = loaded.model?.trim() || undefined;
  }
  const instructions = [definitionPrompt, agent.instructions?.trim()]
    .filter(Boolean)
    .join('\n\n');
  // A definition's model names a Qwen model; Claude / Codex keep their own
  // default unless the agent record names one.
  const model =
    agent.model ??
    (program === 'qwen' && definitionModel && definitionModel !== 'inherit'
      ? definitionModel
      : undefined);
  return {
    ...(instructions ? { instructions } : {}),
    ...(model ? { model } : {}),
  };
}

export class SessionAgentOrchestrator {
  readonly workspaceCwd: string;
  readonly bridge: SessionAgentBridge;
  private readonly hub: SessionAgentEventHub;
  private readonly chainLimit: () => number;
  private readonly tokenBudget: () => number;
  private readonly readAgents: (
    workspaceCwd: string,
  ) => Promise<WorkspaceAgent[]>;
  private readonly readSquads: (
    workspaceCwd: string,
  ) => Promise<SessionSquad[]>;
  /** Squad names by id, as last read (frames carry them). */
  private readonly squadNames = new Map<string, string>();
  private readonly loadRecords: (
    sessionId: string,
  ) => Promise<readonly ConversationRecordLike[]>;
  private readonly adapterFor: (
    program: SessionAgentProgram,
    context: AgentAdapterContext,
  ) => AgentAdapter;
  private readonly now: () => number;
  private readonly stallTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly sessionSendUrl?: (
    sessionId: string,
    agentId: string,
  ) => string | undefined;
  private readonly recordWatchMs: number;
  private readonly restoreSession: (sessionId: string) => Promise<void>;
  private readonly loadDefinition: (
    workspaceCwd: string,
    name: string,
  ) => Promise<SessionAgentDefinition | null>;
  private readonly sessions = new Map<string, Promise<SessionState>>();
  /** States adopted by startup recovery; `session()` hands these out. */
  private readonly startupStates = new Map<string, SessionState>();
  /** Every adopted state, by session id (for cross-session scheduling). */
  private readonly states = new Map<string, SessionState>();
  private readonly live = new Map<string, LiveRun>();
  private readonly pendingPosts = new Map<string, PendingPost>();
  /** By run id; insertion order is age (oldest evicted first). */
  private readonly settled = new Map<string, SettledRun>();
  /** By run id: remote runs cancelled here while a Host executed them. */
  private readonly cancelledLeases = new Map<string, CancelledLease>();
  /**
   * `session_send` bearer token per (chat session, agent) binding
   * (32 random bytes, hex), in memory only. See {@link rotateSendToken}.
   */
  private readonly sendTokens = new Map<string, string>();
  /** States with unsaved event sequences, flushed by the sweep. */
  private readonly dirty = new Set<SessionState>();
  private readonly recovered: Promise<void>;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** What a local run dispose stops ends with (see dispose's reason). */
  private stoppedError = SESSION_AGENT_RESTARTED_ERROR;

  constructor(options: SessionAgentOrchestratorOptions) {
    this.workspaceCwd = options.workspaceCwd;
    this.bridge = options.bridge;
    this.hub = options.hub ?? getSessionAgentEventHub(options.workspaceCwd);
    this.chainLimit = options.chainLimit ?? (() => 0);
    this.tokenBudget =
      options.tokenBudget ?? (() => DEFAULT_AGENT_TOKEN_BUDGET);
    this.readAgents = options.readAgents ?? readWorkspaceAgents;
    this.readSquads = options.readSquads ?? readWorkspaceSquads;
    this.loadRecords =
      options.loadRecords ??
      (async (sessionId) => {
        const data = await new SessionService(this.workspaceCwd).loadSession(
          sessionId,
        );
        return data?.conversation.messages ?? [];
      });
    this.adapterFor = options.getAdapter ?? defaultGetAdapter;
    this.now = options.now ?? Date.now;
    this.stallTimeoutMs =
      options.stallTimeoutMs ?? SESSION_AGENT_STALL_TIMEOUT_MS;
    this.leaseMs = options.leaseMs ?? HOST_TURN_LEASE_MS;
    this.sessionSendUrl = options.sessionSendUrl;
    this.recordWatchMs = options.recordWatchMs ?? RECORD_WATCH_INITIAL_MS;
    this.restoreSession =
      options.restoreSession ??
      (async (sessionId) => {
        await this.bridge.resumeSession({
          sessionId,
          workspaceCwd: this.workspaceCwd,
        });
      });
    this.loadDefinition = options.loadDefinition ?? defaultLoadDefinition;
    this.recovered = this.recoverOnStartup().catch((error) => {
      writeStderrLine(
        `qwen serve: session agent recovery failed in ${this.workspaceCwd}: ${getErrorMessage(error)}`,
      );
    });
    if (options.startTimers !== false) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * A person posted `text` addressing agents in chat session `sessionId`.
   * Records the post (it does not start a main-model turn) and starts or
   * queues one run per addressed agent. Idempotent on `clientMessageId`.
   */
  async mention(
    sessionId: string,
    input: { text: unknown; clientMessageId: unknown },
  ): Promise<SessionAgentMentionResult> {
    this.assertRunning();
    if (!isValidSessionAgentsSessionId(sessionId)) {
      throw new SessionAgentError(
        400,
        'invalid_session_id',
        'Invalid session id.',
      );
    }
    const { text, clientMessageId } = input;
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > MAX_MENTION_TEXT_CHARS
    ) {
      throw new SessionAgentError(400, 'invalid_text', 'text is required.');
    }
    if (
      typeof clientMessageId !== 'string' ||
      !CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)
    ) {
      throw new SessionAgentError(
        400,
        'invalid_client_message_id',
        'clientMessageId must be 1-128 characters of [A-Za-z0-9_.:-].',
      );
    }
    const roster = await this.readAgents(this.workspaceCwd);
    const squads = await this.loadSquads();
    const targets = resolveMentionTargetsWithSquads(text, roster, squads);
    // A squad target runs its leader (resolution already checked it can).
    const squadLeaders = targets.squads.flatMap((squad) => {
      const leader = roster.find((agent) => agent.id === squad.leaderAgentId);
      return leader ? [{ squad, leader }] : [];
    });
    assertMentionFitsRecord(targets.agents.length, squadLeaders.length);
    const squadError =
      targets.unavailableSquads.length > 0
        ? squadUnavailableError(targets.unavailableSquads)
        : undefined;
    if (targets.agents.length === 0 && squadLeaders.length === 0) {
      const details = {
        unavailable: targets.unavailable.map((agent) => agent.name),
        unknown: targets.unknown,
        ...(targets.unavailableSquads.length > 0
          ? {
              unavailableSquads: targets.unavailableSquads.map(
                ({ squad, reason }) => ({ name: squad.name, reason }),
              ),
            }
          : {}),
      };
      if (squadError) {
        throw new SessionAgentError(
          400,
          'squad_unavailable',
          squadError,
          details,
        );
      }
      throw new SessionAgentError(
        400,
        'no_agents_mentioned',
        'The message does not @-mention any available agent.',
        details,
      );
    }
    const state = await this.session(sessionId);
    const recordKey = `mention:${clientMessageId}`;
    let record: SessionExternalRecordResponse;
    try {
      record = await this.appendRecord(sessionId, {
        kind: 'agent_mention',
        recordKey,
        // Passed unchanged: the main model detects the envelope by its
        // exact start and end.
        modelText: formatAgentMentionModelText(text, [
          ...targets.agents.map((agent) => agent.name),
          ...squadLeaders.map(({ squad }) => squad.name),
        ]),
        payload: {
          displayText: text,
          mentionedAgentIds: targets.agents.map((agent) => agent.id),
          ...(squadLeaders.length > 0
            ? { mentionedSquadIds: squadLeaders.map(({ squad }) => squad.id) }
            : {}),
          ...(squadError ? { error: squadError } : {}),
        },
      });
    } catch (error) {
      throw recordWriteError(error);
    }
    const triggerId = triggerIdFor(record, recordKey);
    if (!record.created) {
      // A replayed request: the first one already queued its runs.
      return {
        recordId: record.recordId,
        ...(record.deferred ? { deferred: true } : {}),
        runs: state.file.runs
          .filter((run) => run.triggerRecordIds.includes(triggerId))
          .map((run) => ({
            runId: run.id,
            agentId: run.agentId,
            status: run.status,
          })),
      };
    }
    if (record.deferred) {
      this.addPendingPost({
        sessionId,
        id: triggerId,
        kind: 'agent_mention',
        speaker: 'User',
        text,
        createdAt: this.now(),
      });
    }
    // A person posted: the agents' shared token budget starts over.
    delete state.file.chainTokens;
    const depth = nextChainDepth({ kind: 'human' });
    const runs: SessionAgentRunSummary[] = [];
    const addRun = (summary: SessionAgentRunSummary) => {
      if (!runs.some((existing) => existing.runId === summary.runId)) {
        runs.push(summary);
      }
    };
    // Squads first, so a leader also named directly runs in squad mode.
    for (const { squad, leader } of squadLeaders) {
      this.startEngagement(state, squad, triggerId);
      addRun(this.enqueue(state, leader, triggerId, depth, squad.id));
    }
    for (const agent of targets.agents) {
      addRun(this.enqueue(state, agent, triggerId, depth));
    }
    // The runs are already queued in memory and the record is written, so a
    // failed save is logged (by persist) rather than reported as a refusal;
    // a local run re-saves before it starts and fails there if it cannot.
    await this.persist(state).catch(() => {});
    for (const agent of targets.agents) this.pumpAgent(agent.id);
    for (const { leader } of squadLeaders) this.pumpAgent(leader.id);
    return {
      recordId: record.recordId,
      ...(record.deferred ? { deferred: true } : {}),
      runs,
      ...(squadError ? { squadError } : {}),
    };
  }

  /**
   * Cancels one run (queued or executing), or dismisses a `retryable` one
   * (its final frame then has neither `recorded` nor `retryable`). False
   * when it is neither: unknown, finished, or finished with its record still
   * pending.
   */
  async cancel(sessionId: string, runId: string): Promise<boolean> {
    const live = this.live.get(runId);
    if (!live || live.sessionId !== sessionId) {
      const settled = this.settled.get(runId);
      if (settled?.sessionId !== sessionId || !settled.frame.retryable) {
        return false;
      }
      this.dropSettled(runId, {});
      // Dismissed: a later restart must not offer it again.
      const state = await this.session(sessionId);
      const run = state.file.runs.find((candidate) => candidate.id === runId);
      if (run?.recorded === false) {
        delete run.recorded;
        await this.persist(state).catch(() => {});
      }
      return true;
    }
    const state = await this.session(sessionId);
    await this.cancelLive(state, live);
    return true;
  }

  /**
   * Runs a `failed` or `offline` run again (typically one a daemon restart
   * interrupted), or any run the snapshot offers as `retryable` (one whose
   * record a restart lost): queues a NEW run with the same triggers and
   * chain depth, `retryOf: runId`, and, when the old run is still in the
   * snapshot (retryable, or its record pending), publishes its final frame
   * with `retriedAsRunId`; a run whose record already landed gets no frame.
   * Refuses (SessionAgentError) when the run is unknown
   * (404 `run_not_found`), not retryable (409 `run_not_retryable`),
   * already retried (409 `run_already_retried`), or its agent can no longer
   * take work (409 `agent_unavailable`).
   * Squads carry over. A leader's retry leads its squad again (`squadId`),
   * re-opening the engagement a restart or a failure ended. A member whose
   * record is still pending owes its leaders a wake ({@link SettledRun.wakes}):
   * the new run takes its place as an outstanding run of those engagements,
   * so its reply wakes them instead.
   */
  async retry(
    sessionId: string,
    runId: string,
  ): Promise<SessionAgentRunSummary> {
    this.assertRunning();
    if (!isValidSessionAgentsSessionId(sessionId)) {
      throw new SessionAgentError(
        400,
        'invalid_session_id',
        'Invalid session id.',
      );
    }
    const state = await this.session(sessionId);
    const run = state.file.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new SessionAgentError(404, 'run_not_found', 'No such run.');
    }
    if (
      run.status !== 'failed' &&
      run.status !== 'offline' &&
      this.settled.get(runId)?.frame.retryable !== true
    ) {
      throw new SessionAgentError(
        409,
        'run_not_retryable',
        'Only a failed or offline run can be retried.',
      );
    }
    const roster = await this.readAgents(this.workspaceCwd);
    const agent = roster.find((candidate) => candidate.id === run.agentId);
    if (!agent || !isAgentAddressable(agent)) {
      throw new SessionAgentError(
        409,
        'agent_unavailable',
        'This agent is disabled or no longer exists.',
      );
    }
    // The squad a leader run led, if it still exists and is still led by
    // this agent.
    const ledSquad = run.squadId
      ? (await this.loadSquads()).find(
          (candidate) =>
            candidate.id === run.squadId &&
            candidate.leaderAgentId === agent.id,
        )
      : undefined;
    // After the roster and squad reads, which another retry call may have
    // raced.
    if (state.file.runs.some((candidate) => candidate.retryOf === runId)) {
      throw new SessionAgentError(
        409,
        'run_already_retried',
        'This run was already retried.',
      );
    }
    const trigger = run.triggerRecordIds[0];
    if (trigger === undefined) {
      throw new SessionAgentError(
        409,
        'run_not_retryable',
        'This run has no trigger to answer.',
      );
    }
    // Synchronous from here to the persist, so no settle ends a carried
    // engagement in between.
    if (ledSquad) this.startEngagement(state, ledSquad, trigger);
    // A new run id: the record key is `agent:<runId>`, and the old run may
    // already own one, which would make the retry's reply a silent no-op.
    let summary: SessionAgentRunSummary | undefined;
    for (const triggerId of run.triggerRecordIds) {
      summary = this.enqueue(
        state,
        agent,
        triggerId,
        run.chainDepth,
        ledSquad?.id,
      );
    }
    const retried = summary && this.live.get(summary.runId)?.run;
    if (!retried) {
      throw new SessionAgentError(
        409,
        'run_not_retryable',
        'This run has no trigger to answer.',
      );
    }
    retried.retryOf ??= runId;
    if (run.recorded === false) delete run.recorded;
    // The wakes a member's pending record owed: the new run answers for it.
    for (const { squadId } of this.settled.get(runId)?.wakes ?? []) {
      this.trackDelegation(state, squadId, retried.id);
    }
    this.dropSettled(runId, { retriedAsRunId: retried.id });
    // Saves the dropped `pendingWakeRunIds`; the engagements stay open on
    // the new run.
    this.settleEngagements(state);
    await this.persist(state).catch(() => {});
    this.pumpAgent(agent.id);
    return {
      runId: retried.id,
      agentId: agent.id,
      status: retried.status,
    };
  }

  /** "Stop all agents" for one chat session. Returns the runs it stopped. */
  async stopAll(sessionId: string): Promise<string[]> {
    // A member reply still being recorded no longer wakes its leader.
    let droppedWakes = false;
    for (const settled of this.settled.values()) {
      if (settled.sessionId === sessionId && settled.wakes) {
        delete settled.wakes;
        droppedWakes = true;
      }
    }
    const runs = [...this.live.values()].filter(
      (live) => live.sessionId === sessionId,
    );
    if (runs.length === 0) {
      if (droppedWakes) {
        const state = await this.session(sessionId);
        if (this.settleEngagements(state)) {
          await this.persist(state).catch(() => {});
        }
      }
      return [];
    }
    const state = await this.session(sessionId);
    // Queued first, so finishing an executing run cannot start one of them.
    runs.sort(
      (a, b) => Number(isExecutingRun(a.run)) - Number(isExecutingRun(b.run)),
    );
    for (const live of runs) await this.cancelLive(state, live);
    return runs.map((live) => live.run.id);
  }

  /**
   * Answers a pending permission of a run. `voter` is the requesting
   * client's context (loopback bit, client id), forwarded to the bridge so a
   * `local-only` policy judges the real voter.
   */
  resolvePermission(
    sessionId: string,
    runId: string,
    requestId: string,
    optionId: unknown,
    voter?: BridgeClientRequestContext,
  ): void {
    const live = this.live.get(runId);
    if (!live || live.sessionId !== sessionId) {
      throw new SessionAgentError(404, 'run_not_found', 'No such live run.');
    }
    const prompt = live.frame.permission;
    if (!prompt || prompt.requestId !== requestId) {
      throw new SessionAgentError(
        404,
        'permission_not_found',
        'No pending permission request for this run.',
      );
    }
    if (
      typeof optionId !== 'string' ||
      !prompt.options.some((option) => option.optionId === optionId)
    ) {
      throw new SessionAgentError(400, 'invalid_option', 'Unknown optionId.');
    }
    if (live.remote) {
      // A second answer replaces the first (the Host applies the newest
      // `decisionId` it has not applied yet). The frame wakes the Host's
      // decisions long-poll, which follows run frames of its runtime.
      const decision: HostPermissionDecision = {
        runId,
        attempt: live.run.attempts,
        requestId,
        optionId,
        decisionId: randomUUID(),
      };
      live.remote.decisions = [
        ...live.remote.decisions.filter(
          (existing) => existing.requestId !== requestId,
        ),
        decision,
      ];
      // Unthrottled: this frame is the Host's wake-up, not streaming.
      this.publish(live, { immediate: true });
      return;
    }
    const pending = live.pendingPermissions.get(requestId);
    if (!pending) {
      throw new SessionAgentError(
        409,
        'permission_already_answered',
        'This permission request was already answered.',
      );
    }
    if (voter) live.voterContexts.set(requestId, voter);
    live.pendingPermissions.delete(requestId);
    pending.resolve(optionId);
  }

  /**
   * An agent posted `text` with its `session_send` tool: the MCP child calls
   * the (chat session, agent) endpoint with that binding's token. The post is
   * attributed to the agent's CURRENT executing local run in that session.
   * Resolves once the post is recorded and routed; rejects with a
   * SessionAgentError: 401 `invalid_session_send_token` (unknown binding or
   * wrong token), 400 `invalid_text`, 409 `run_not_running` (no run of that
   * agent is executing in the session right now).
   */
  async postFromAgent(
    sessionId: string,
    agentId: string,
    token: string,
    text: unknown,
  ): Promise<void> {
    this.assertRunning();
    const expected = this.sendTokens.get(this.sendKey(sessionId, agentId));
    // One answer for "no such binding" and "wrong token": the route is not
    // behind the daemon bearer.
    if (!expected || !tokensMatch(expected, token)) {
      throw new SessionAgentError(
        401,
        'invalid_session_send_token',
        'Unknown agent binding or invalid session_send token.',
      );
    }
    if (
      typeof text !== 'string' ||
      isBlankAgentText(text) ||
      text.length > MAX_MENTION_TEXT_CHARS
    ) {
      throw new SessionAgentError(400, 'invalid_text', 'text is required.');
    }
    const live = [...this.live.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.run.agentId === agentId &&
        !candidate.remote &&
        !candidate.abortReason &&
        isExecutingRun(candidate.run),
    );
    if (!live) {
      throw new SessionAgentError(
        409,
        'run_not_running',
        'The agent has no running turn in this session.',
      );
    }
    const state = await this.session(sessionId);
    live.frame.activityAt = this.now();
    await this.queueSessionSend(state, live, text);
  }

  /** Live frames of one chat session (what a reconnecting client renders). */
  async snapshot(sessionId: string): Promise<SessionAgentRunFrame[]> {
    if (!isValidSessionAgentsSessionId(sessionId)) {
      throw new SessionAgentError(
        400,
        'invalid_session_id',
        'Invalid session id.',
      );
    }
    await this.recovered;
    const frames = [...this.live.values()]
      .filter((live) => live.sessionId === sessionId)
      .map((live) => this.buildFrame(live));
    // Finished runs whose record is still pending, and retryable ones.
    for (const settled of this.settled.values()) {
      if (settled.sessionId === sessionId) frames.push({ ...settled.frame });
    }
    return frames;
  }

  /**
   * Every live (queued or executing) run across all chat sessions. Read-only:
   * the roster view reports agent status and runtime load from it, and roster
   * changes that would strand a run (retire, move) refuse on it. Waits for
   * startup recovery, so a run recovered from disk is never missed.
   */
  async liveRuns(): Promise<SessionAgentLiveRunSummary[]> {
    await this.recovered;
    return [...this.live.values()].map((live) => ({
      sessionId: live.sessionId,
      runId: live.run.id,
      agentId: live.run.agentId,
      status: live.run.status,
      ...(live.remote ? { hostId: live.remote.hostId } : {}),
    }));
  }

  /**
   * Resolves once startup recovery has adopted the runs a previous daemon
   * left. Host routes await it before `renewLease` / `acceptHostEvents` /
   * `completeHostTurn`, so a Host whose run is being re-adopted is not
   * told `unknown_run` in that window.
   */
  ready(): Promise<void> {
    return this.recovered;
  }

  /**
   * Stops this daemon's executing local runs and the timers. A stopped run
   * ends `failed` with the error for `reason` ("daemon restarted" for a
   * shutdown; see {@link SESSION_AGENT_STOPPED_ERRORS}), writes no record
   * (the bridge is going away, or the workspace is off limits) and is saved
   * `recorded: false`, so the next orchestrator for this workspace offers it
   * for retry; queued local runs stay queued on disk and are offered the
   * same way (see adopt). Remote runs are left on disk as they are (queued,
   * or executing under their lease with the last accepted sequence), so the
   * next orchestrator (after a restart, or a replaced bridge) re-adopts them
   * and their Host carries on. Idempotent: a later call's reason is ignored.
   */
  async dispose(reason: SessionAgentStopReason = 'shutdown'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stoppedError = SESSION_AGENT_STOPPED_ERRORS[reason];
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const settled of this.settled.values()) {
      if (settled.timer) clearTimeout(settled.timer);
    }
    // `stopped` already keeps queued runs from starting.
    for (const live of this.live.values()) {
      if (
        live.remote ||
        live.author.runtimeId !== LOCAL_SESSION_AGENT_RUNTIME_ID ||
        !isExecutingRun(live.run)
      ) {
        continue;
      }
      live.abortReason = 'shutdown';
      for (const pending of live.pendingPermissions.values()) {
        pending.reject(new Error('daemon stopping'));
      }
      live.pendingPermissions.clear();
      live.controller?.abort();
    }
    for (const state of this.dirty) await this.persist(state).catch(() => {});
    this.dirty.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Remote queue (Host protocol v2). HTTP wiring lives elsewhere.           */
  /* ---------------------------------------------------------------------- */

  /**
   * Hands the next eligible queued turn to `hostId`, which offers `programs`.
   * The assignment carries a lease the Host must renew (events and
   * `renewLease` both renew it) before it expires.
   */
  async pickupForHost(
    hostId: string,
    programs: readonly SessionAgentProgram[],
  ): Promise<HostTurnAssignment | undefined> {
    if (this.stopped) return undefined;
    await this.recovered;
    const roster = await this.readAgents(this.workspaceCwd);
    // Oldest first across chat sessions, like local runs.
    const queued = [...this.live.values()]
      .filter((live) => live.run.status === 'queued')
      .sort((a, b) => a.run.createdAt - b.run.createdAt);
    for (const live of queued) {
      const { run } = live;
      if (run.status !== 'queued') continue;
      const agent = roster.find((candidate) => candidate.id === run.agentId);
      if (
        !agent ||
        !isAgentAddressable(agent) ||
        agent.execution?.mode !== 'managed-host' ||
        !agent.execution.hostIds.includes(hostId)
      ) {
        continue;
      }
      live.maxConcurrent = maxConcurrentRunsFor(agent);
      if (this.executingCount(agent.id) >= live.maxConcurrent) continue;
      const program = programForAgent(agent, programs);
      if (!program) continue;
      const state = await this.session(live.sessionId);
      if (run.status !== 'queued') continue;
      if (nextRunnable(state.file.runs, agent.id)?.id !== run.id) continue;
      // Re-checked after the await: a concurrent pickup may have started one.
      if (this.executingCount(agent.id) >= live.maxConcurrent) continue;

      // Claim synchronously: a concurrent pickup sees `running` and skips.
      const now = this.now();
      run.status = 'running';
      run.attempts += 1;
      run.startedAt = now;
      delete run.error;
      const lease: NonNullable<SessionAgentRun['lease']> = {
        hostId,
        leaseId: randomUUID(),
        attempt: run.attempts,
        expiresAt: now + this.leaseMs,
        lastSequence: 0,
      };
      run.lease = lease;
      live.author = authorFor(agent, hostId, program);
      live.remote = { hostId, program, decisions: [] };
      live.frame.activityAt = now;
      this.republishQueued(agent.id);
      try {
        const persona = await resolveTurnPersona(agent, program, (name) =>
          this.loadDefinition(this.workspaceCwd, name),
        );
        const binding = state.file.bindings[agent.id] ?? { agentId: agent.id };
        const records = await this.loadRecords(live.sessionId);
        const squad = await this.squadBriefingFor(live, roster);
        // A native session lives on one runtime. On a different Host the
        // agent starts a fresh one that has seen nothing, so it gets the
        // conversation from the start (bounded by the budget), not the delta
        // after the old runtime's cursor.
        const sameRuntime =
          binding.runtimeId === hostId &&
          canReuseNativeSession(binding, hostId, program);
        // A native session lives on one runtime; resume only there.
        const nativeSessionId = sameRuntime
          ? binding.nativeSessionId
          : undefined;
        const readThroughRecordId = sameRuntime
          ? binding.readThroughRecordId
          : undefined;
        const inputOptions: Omit<
          BuildAgentInputOptions,
          'readThroughRecordId'
        > = {
          records,
          trigger: {
            agentId: agent.id,
            agentName: agent.name,
            recordIds: run.triggerRecordIds,
          },
          budgetChars: AGENT_INPUT_CHAR_BUDGET,
          pendingMessages: this.pendingFor(live.sessionId, agent.id, records),
          ...(squad ? { squad } : {}),
        };
        const input = buildAgentInput({ ...inputOptions, readThroughRecordId });
        live.lastRecordId = input.lastRecordId;
        // A resume the Host's program refuses starts a fresh native session,
        // which must get the conversation from the start in this same turn.
        const freshPrompt =
          nativeSessionId && readThroughRecordId !== undefined
            ? buildAgentInput(inputOptions).prompt
            : undefined;
        live.offeredFreshPrompt = freshPrompt !== undefined;
        await this.persist(state);
        this.publish(live);
        return {
          protocol: HOST_PROTOCOL_VERSION,
          sessionId: live.sessionId,
          runId: run.id,
          attempt: lease.attempt,
          leaseId: lease.leaseId,
          // Renewals before this returns are not reflected; fine for a lease
          // this fresh.
          leaseExpiresAt: lease.expiresAt,
          // The linked definition (`agentType`) is resolved here: the Host
          // does not have this workspace's definitions.
          agent: { ...this.authorOf(live), ...persona },
          program,
          prompt: input.prompt,
          ...(freshPrompt !== undefined ? { freshPrompt } : {}),
          ...(nativeSessionId ? { nativeSessionId } : {}),
        };
      } catch (error) {
        await this.finishRun(state, live, {
          status: 'failed',
          outputText: '',
          error: getErrorMessage(error),
        });
      }
    }
    return undefined;
  }

  /**
   * Extends a Host's lease on a run it is executing. Returns `{ok: true,
   * leaseExpiresAt}`; `{ok: false, reason: 'cancelled', cancelled: true}`
   * when the run was cancelled here (the Host aborts the turn and posts no
   * result); `{ok: false, reason: 'unknown_run' | 'lease_mismatch'}` when
   * the lease is stale (the Host drops the turn).
   */
  renewLease(
    hostId: string,
    runId: string,
    attempt: number,
    leaseId: string,
  ): HostAck {
    const fenced = this.fence(hostId, runId, attempt, leaseId);
    if (!fenced.ok) return fenced;
    const lease = fenced.live.run.lease!;
    lease.expiresAt = this.now() + this.leaseMs;
    return { ok: true, leaseExpiresAt: lease.expiresAt };
  }

  /**
   * Gives back a pickup the Host never received (its pickup response was
   * lost): the run is queued again for any Host, and the next claim gets
   * attempt + 1. Fenced like {@link renewLease}; returns `{ok: true}` or
   * the same failures.
   */
  releaseHostAssignment(
    hostId: string,
    assignment: {
      sessionId: string;
      runId: string;
      attempt: number;
      leaseId: string;
    },
  ): HostAck {
    const fenced = this.fence(
      hostId,
      assignment.runId,
      assignment.attempt,
      assignment.leaseId,
      assignment.sessionId,
    );
    if (!fenced.ok) return fenced;
    const { live } = fenced;
    live.run.status = 'queued';
    delete live.run.lease;
    delete live.run.startedAt;
    delete live.remote;
    live.author = { ...live.author };
    delete live.author.runtimeId;
    // The Host never ran it: nothing it streamed belongs to the next attempt.
    delete live.frame.permission;
    delete live.frame.outputText;
    delete live.frame.thoughtText;
    delete live.frame.steps;
    live.steps.clear();
    const state = this.states.get(live.sessionId);
    if (state) void this.persist(state).catch(() => {});
    // Wakes other Hosts' pickups and refreshes queue positions.
    this.publish(live);
    this.republishQueued(live.run.agentId);
    return { ok: true };
  }

  /**
   * Folds an ordered event batch from a Host, like a local turn's events.
   * Same returns as {@link renewLease}, plus `{ok: true, duplicate: true}`
   * for a batch at or below the last accepted sequence. The sequence is
   * persisted with the run (flushed by the sweep), so fencing survives a
   * daemon restart.
   */
  acceptHostEvents(hostId: string, batch: HostTurnEventBatch): HostAck {
    const fenced = this.fence(
      hostId,
      batch.runId,
      batch.attempt,
      batch.leaseId,
      batch.sessionId,
    );
    if (!fenced.ok) return fenced;
    const { live } = fenced;
    const lease = live.run.lease!;
    if (batch.sequence <= (lease.lastSequence ?? 0)) {
      return { ok: true, duplicate: true };
    }
    // TODO(multi-agent): a gap in `sequence` is accepted as-is; a Host that
    // dropped a batch loses those deltas from the live frame only (the final
    // text comes with the result). Needs a real Host to decide on resend.
    lease.lastSequence = batch.sequence;
    lease.expiresAt = this.now() + this.leaseMs;
    const state = this.states.get(live.sessionId);
    if (state) {
      this.dirty.add(state);
      for (const event of batch.events) this.applyEvent(state, live, event);
    }
    return { ok: true, leaseExpiresAt: lease.expiresAt };
  }

  /**
   * A Host finished a turn. Returns `{ok: true}`, or a failure as in
   * {@link renewLease} (a cancelled run's result is dropped).
   */
  async completeHostTurn(
    hostId: string,
    result: HostTurnResult,
  ): Promise<HostAck> {
    const fenced = this.fence(
      hostId,
      result.runId,
      result.attempt,
      result.leaseId,
      result.sessionId,
    );
    if (!fenced.ok) return fenced;
    const state = await this.session(result.sessionId);
    await fenced.live.sendChain;
    await this.finishRun(state, fenced.live, {
      status: result.result.status,
      outputText: result.result.outputText,
      ...(result.result.error ? { error: result.result.error } : {}),
      ...(result.result.nativeSessionId
        ? { nativeSessionId: result.result.nativeSessionId }
        : {}),
      ...(result.result.totalTokens !== undefined
        ? { totalTokens: result.result.totalTokens }
        : {}),
      ...(result.result.resumeRejected ? { resumeRejected: true } : {}),
    });
    return { ok: true };
  }

  /**
   * Permission decisions waiting for `hostId`. Kept until the Host reports
   * `permission_resolved` (or the run ends), so a lost response is resent;
   * the Host must apply each (runId, attempt, requestId) once.
   */
  decisionsForHost(hostId: string): HostPermissionDecision[] {
    const decisions: HostPermissionDecision[] = [];
    for (const live of this.live.values()) {
      if (live.remote?.hostId !== hostId) continue;
      decisions.push(...live.remote.decisions);
    }
    return decisions;
  }

  /**
   * Periodic work: lease expiry for remote runs, stall watchdog for local
   * ones. Public so tests (and a shutdown path) can drive it.
   */
  sweep(): void {
    const now = this.now();
    for (const state of this.dirty) void this.persist(state).catch(() => {});
    this.dirty.clear();
    for (const [runId, cancelled] of [...this.cancelledLeases]) {
      if (now - cancelled.at > CANCELLED_LEASE_TTL_MS) {
        this.cancelledLeases.delete(runId);
      }
    }
    for (const live of [...this.live.values()]) {
      if (!isExecutingRun(live.run)) continue;
      if (live.remote) {
        const lease = live.run.lease;
        if (lease && lease.expiresAt < now) {
          void this.session(live.sessionId).then((state) =>
            this.finishRun(state, live, {
              status: 'offline',
              outputText: live.frame.outputText ?? '',
              error: SESSION_AGENT_OFFLINE_ERROR,
            }),
          );
        }
        continue;
      }
      // Paused while a person is deciding a permission.
      if (live.frame.permission) continue;
      if (now - live.frame.activityAt >= this.stallTimeoutMs) {
        live.abortReason = 'stalled';
        live.controller?.abort();
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private assertRunning(): void {
    if (this.stopped) {
      throw new SessionAgentError(
        503,
        'orchestrator_stopped',
        'Session agents are stopping in this workspace.',
      );
    }
  }

  private session(sessionId: string): Promise<SessionState> {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = this.recovered.then(async () => {
        // Recovery may have adopted this session after this call began;
        // one in-memory state per session, always.
        const recovered = this.startupStates.get(sessionId);
        if (recovered) return recovered;
        const file = await readSessionAgents(this.workspaceCwd, sessionId);
        return this.adopt(file, undefined);
      });
      this.sessions.set(sessionId, state);
      // A failed read must not poison the session for the daemon's life.
      state.catch(() => {
        if (this.sessions.get(sessionId) === state) {
          this.sessions.delete(sessionId);
        }
      });
    }
    return state;
  }

  /**
   * Takes a file read from disk into memory. Live runs on disk at this point
   * belong to a previous daemon (one daemon per workspace). With `roster`
   * (startup recovery): queued runs of managed-host agents stay queued for
   * pickup, and a remote run executing under a lease (`running`) is
   * re-adopted with that lease (renewed for one period) and its last
   * accepted sequence. Every other live run is `failed` with "daemon
   * restarted" and offered for {@link retry} (`retryable` in the snapshot);
   * a leased one is also fenced as cancelled, so its Host aborts. A remote
   * run that was `awaiting_approval` is in that last group: the prompt it
   * waits on was in memory only.
   */
  private adopt(
    file: SessionAgentsFile,
    roster: readonly WorkspaceAgent[] | undefined,
  ): SessionState {
    const state: SessionState = {
      sessionId: file.sessionId,
      file,
      writeChain: Promise.resolve(),
    };
    this.states.set(file.sessionId, state);
    const now = this.now();
    let changed = false;
    const authorOf = (run: SessionAgentRun): SessionAgentAuthor => {
      const agent = roster?.find((candidate) => candidate.id === run.agentId);
      return agent
        ? authorFor(
            agent,
            agent.execution?.mode === 'managed-host'
              ? undefined
              : LOCAL_SESSION_AGENT_RUNTIME_ID,
            programForAgent(agent),
          )
        : { agentId: run.agentId, name: run.agentId };
    };
    for (const run of file.runs) {
      if (isTerminalSessionAgentRunStatus(run.status)) {
        // A run cancelled while a Host ran it keeps its lease (finishRun).
        if (
          run.status === 'cancelled' &&
          run.lease &&
          now - (run.endedAt ?? run.createdAt) <= CANCELLED_LEASE_TTL_MS
        ) {
          this.rememberCancelledLease(file.sessionId, run);
        }
        if (run.recorded === false && !this.settled.has(run.id)) {
          if (this.adoptUnrecorded(file, run, authorOf(run), now)) {
            changed = true;
          }
        }
        continue;
      }
      if (this.live.has(run.id)) continue;
      const agent = roster?.find((candidate) => candidate.id === run.agentId);
      const remoteAgent =
        agent !== undefined && agent.execution?.mode === 'managed-host';
      if (run.status === 'queued' && remoteAgent) {
        this.live.set(run.id, this.newLive(file.sessionId, run, agent));
        continue;
      }
      if (run.status === 'running' && run.lease && remoteAgent) {
        const live = this.newLive(file.sessionId, run, agent);
        const program = programForAgent(agent) ?? 'qwen';
        live.author = authorFor(agent, run.lease.hostId, program);
        live.remote = { hostId: run.lease.hostId, program, decisions: [] };
        run.lease.expiresAt = now + this.leaseMs;
        this.live.set(run.id, live);
        changed = true;
        continue;
      }
      if (run.lease) this.rememberCancelledLease(file.sessionId, run);
      run.status = 'failed';
      run.error = SESSION_AGENT_RESTARTED_ERROR;
      run.endedAt = now;
      // No record: a further restart still offers it (see adoptUnrecorded).
      run.recorded = false;
      delete run.lease;
      changed = true;
      this.addSettled(run.id, {
        sessionId: file.sessionId,
        frame: {
          type: 'run',
          sessionId: file.sessionId,
          runId: run.id,
          author: authorOf(run),
          status: 'failed',
          error: SESSION_AGENT_RESTARTED_ERROR,
          activityAt: now,
          recorded: false,
          retryable: true,
        },
      });
    }
    this.restorePendingWakes(state, roster);
    // Member runs that died with the previous daemon wake no leader.
    if (this.settleEngagements(state)) changed = true;
    if (changed) void this.persist(state).catch(() => {});
    return state;
  }

  /**
   * A run a previous daemon finished whose record is not known to have
   * landed (`recorded: false`): offered for retry (`retryable`), while the
   * transcript is checked for the record. A cancelled or already retried
   * one is let go. Returns whether `run` changed.
   */
  private adoptUnrecorded(
    file: SessionAgentsFile,
    run: SessionAgentRun,
    author: SessionAgentAuthor,
    now: number,
  ): boolean {
    if (
      run.status === 'cancelled' ||
      file.runs.some((candidate) => candidate.retryOf === run.id)
    ) {
      delete run.recorded;
      return true;
    }
    // A run a restart (or any dispose) failed, or one that went offline,
    // never wrote a record: there is nothing to look for.
    const wroteRecord =
      run.status !== 'offline' &&
      !Object.values(SESSION_AGENT_STOPPED_ERRORS).includes(run.error ?? '');
    this.addSettled(run.id, {
      sessionId: file.sessionId,
      frame: {
        type: 'run',
        sessionId: file.sessionId,
        runId: run.id,
        author,
        status: run.status,
        error: run.error ?? SESSION_AGENT_REPLY_NOT_RECORDED_ERROR,
        ...(run.totalTokens !== undefined
          ? { totalTokens: run.totalTokens }
          : {}),
        activityAt: run.endedAt ?? now,
        recorded: false,
        retryable: true,
      },
      ...(wroteRecord ? { recovered: true as const } : {}),
    });
    if (wroteRecord) this.watchRecord(run.id);
    return false;
  }

  /**
   * Member replies that owed their squad leader a wake when the previous
   * daemon stopped (`pendingWakeRunIds`, saved by settleEngagements). Each
   * one's run is watched for its record again (see adoptUnrecorded), which
   * wakes the leader with the record once it is found in the transcript, or
   * with the reply carried as a post once the watcher gives up (see
   * watchRecord). An entry whose run is gone, let go (cancelled, retried) or
   * not watched, or whose leader is unavailable, wakes no one; the
   * engagement then ends as usual. Needs the roster (startup recovery).
   */
  private restorePendingWakes(
    state: SessionState,
    roster: readonly WorkspaceAgent[] | undefined,
  ): void {
    if (!roster) return;
    for (const [squadId, engagement] of Object.entries(
      state.file.squads ?? {},
    )) {
      if (!engagement.active || !engagement.pendingWakeRunIds) continue;
      const leader = roster.find(
        (agent) => agent.id === engagement.leaderAgentId,
      );
      if (!leader || !isAgentAddressable(leader)) {
        writeStderrLine(
          `qwen serve: squad ${squadId} in session ${state.sessionId} lost its leader across a restart; its pending wake was dropped.`,
        );
        continue;
      }
      for (const runId of engagement.pendingWakeRunIds) {
        const settled = this.settled.get(runId);
        const run = state.file.runs.find((candidate) => candidate.id === runId);
        if (!run || !settled?.recovered) continue;
        if (settled.sessionId !== state.sessionId) continue;
        const wakes = (settled.wakes ??= []);
        if (wakes.some((wake) => wake.squadId === squadId)) continue;
        wakes.push({
          squadId,
          leader,
          chainDepth: nextChainDepth({
            kind: 'agent',
            chainDepth: run.chainDepth,
          }),
        });
      }
    }
  }

  private async recoverOnStartup(): Promise<void> {
    const ids = await listSessionAgentsSessionIds(this.workspaceCwd);
    if (ids.length === 0) return;
    let roster: WorkspaceAgent[] | undefined;
    for (const sessionId of ids) {
      let file: SessionAgentsFile;
      try {
        file = await readSessionAgents(this.workspaceCwd, sessionId);
      } catch (error) {
        writeStderrLine(
          `qwen serve: skipping unreadable session agents file for ${sessionId}: ${getErrorMessage(error)}`,
        );
        continue;
      }
      // Nothing to adopt: no live run, no remote run cancelled while its
      // Host ran it (whose Host must still be told), and no finished run
      // whose record is pending (offered for retry).
      if (
        file.runs.every(
          (run) =>
            isTerminalSessionAgentRunStatus(run.status) &&
            !(run.status === 'cancelled' && run.lease) &&
            run.recorded !== false,
        )
      ) {
        continue;
      }
      roster ??= await this.readAgents(this.workspaceCwd);
      const state = this.adopt(file, roster);
      this.startupStates.set(sessionId, state);
      if (!this.sessions.has(sessionId)) {
        this.sessions.set(sessionId, Promise.resolve(state));
      }
    }
  }

  private newLive(
    sessionId: string,
    run: SessionAgentRun,
    agent: WorkspaceAgent,
  ): LiveRun {
    const maxConcurrent = maxConcurrentRunsFor(agent);
    const author = authorFor(
      agent,
      agent.execution?.mode === 'managed-host'
        ? undefined
        : LOCAL_SESSION_AGENT_RUNTIME_ID,
      programForAgent(agent),
    );
    return {
      sessionId,
      run,
      author,
      maxConcurrent,
      frame: {
        type: 'run',
        sessionId,
        runId: run.id,
        author,
        status: run.status,
        activityAt: this.now(),
      },
      steps: new Map(),
      pendingPermissions: new Map(),
      voterContexts: new Map(),
      sendCount: 0,
      sendChain: Promise.resolve(),
    };
  }

  /**
   * Queues (or coalesces) a run of `agent`. `squadId` runs it as that
   * squad's leader; without one, a leader whose squad engagement is active
   * in this session runs in squad mode anyway (a person or agent addressing
   * the leader mid-engagement).
   */
  private enqueue(
    state: SessionState,
    agent: WorkspaceAgent,
    recordId: string,
    chainDepth: number,
    squadId?: string,
  ): SessionAgentRunSummary {
    const squad = squadId ?? this.activeSquadLedBy(state, agent.id);
    const outcome = enqueueTrigger(state.file.runs, {
      agentId: agent.id,
      recordId,
      chainDepth,
      now: this.now(),
      newRunId: () => `sr_${randomUUID()}`,
      ...(squad ? { squadId: squad } : {}),
    });
    let live = this.live.get(outcome.run.id);
    if (!live) {
      live = this.newLive(state.sessionId, outcome.run, agent);
      this.live.set(outcome.run.id, live);
    }
    this.publish(live);
    return {
      runId: outcome.run.id,
      agentId: agent.id,
      status: outcome.run.status,
    };
  }

  /** Executing runs of `agentId` in every chat session, local or remote. */
  private executingCount(agentId: string): number {
    let count = 0;
    for (const live of this.live.values()) {
      if (live.run.agentId === agentId && isExecutingRun(live.run)) count += 1;
    }
    return count;
  }

  /**
   * Starts queued LOCAL runs of `agentId`, oldest first across chat
   * sessions, while it is under its `maxConcurrentRuns` and each run is
   * next in its own session. Remote runs wait for a Host's pickup. Then
   * republishes the agent's queued frames (their positions moved).
   */
  private pumpAgent(agentId: string): void {
    if (this.stopped) return;
    const queued = [...this.live.values()]
      .filter(
        (live) =>
          live.run.agentId === agentId &&
          live.run.status === 'queued' &&
          live.author.runtimeId === LOCAL_SESSION_AGENT_RUNTIME_ID,
      )
      .sort((a, b) => a.run.createdAt - b.run.createdAt);
    for (const live of queued) {
      if (this.executingCount(agentId) >= live.maxConcurrent) break;
      const state = this.states.get(live.sessionId);
      if (!state) continue;
      if (nextRunnable(state.file.runs, agentId)?.id !== live.run.id) continue;
      // Claims the run synchronously (status `running`) before its first
      // await, so the count above sees it on the next iteration.
      void this.runLocal(state, live).catch((error) => {
        writeStderrLine(
          `qwen serve: session agent run ${live.run.id} crashed: ${getErrorMessage(error)}`,
        );
      });
    }
    this.republishQueued(agentId);
  }

  private republishQueued(agentId: string): void {
    for (const live of this.live.values()) {
      if (live.run.agentId === agentId && live.run.status === 'queued') {
        this.publish(live);
      }
    }
  }

  private async runLocal(state: SessionState, live: LiveRun): Promise<void> {
    const { run } = live;
    // Claim synchronously so the one-executing-run rule holds.
    run.status = 'running';
    run.startedAt = this.now();
    run.attempts += 1;
    delete run.error;
    const controller = new AbortController();
    live.controller = controller;
    live.frame.activityAt = this.now();
    this.publish(live);

    let outcome: FinishOutcome;
    try {
      const roster = await this.readAgents(this.workspaceCwd);
      const agent = roster.find((candidate) => candidate.id === run.agentId);
      if (!agent || !isAgentAddressable(agent)) {
        throw new Error('This agent is disabled or no longer exists.');
      }
      if (agent.execution?.mode === 'managed-host') {
        throw new Error('This agent now runs on a remote runtime.');
      }
      const program = programForAgent(agent)!;
      live.author = authorFor(agent, LOCAL_SESSION_AGENT_RUNTIME_ID, program);
      live.maxConcurrent = maxConcurrentRunsFor(agent);
      // The qwen ACP child resolves its persona itself (from the roster).
      const persona =
        program === 'qwen'
          ? {
              ...(agent.instructions
                ? { instructions: agent.instructions }
                : {}),
              ...(agent.model ? { model: agent.model } : {}),
            }
          : await resolveTurnPersona(agent, program, (name) =>
              this.loadDefinition(this.workspaceCwd, name),
            );
      const binding = state.file.bindings[agent.id] ?? { agentId: agent.id };
      const records = await this.loadRecords(state.sessionId);
      const squad = await this.squadBriefingFor(live, roster);
      // The agent's native session is reusable only on the runtime and with
      // the program that created it. After a move (remote -> local) or a
      // program change it starts fresh, so it gets the conversation from the
      // start (bounded by the budget), not the delta after the old cursor.
      const sameNativeSession = canReuseNativeSession(
        binding,
        LOCAL_SESSION_AGENT_RUNTIME_ID,
        program,
      );
      const resumable =
        sameNativeSession &&
        binding.runtimeId === LOCAL_SESSION_AGENT_RUNTIME_ID
          ? binding.nativeSessionId
          : undefined;
      // Qwen's hidden session id is planned (deterministic per agent and
      // chat session) and must be on disk with the running run before the
      // session is created: the ACP child authorizes it from this file.
      const nativeSessionId =
        program === 'qwen'
          ? sessionAgentNativeSessionId(agent.id, state.sessionId)
          : resumable;
      const readThroughRecordId = sameNativeSession
        ? binding.readThroughRecordId
        : undefined;
      const inputOptions: Omit<BuildAgentInputOptions, 'readThroughRecordId'> =
        {
          records,
          trigger: {
            agentId: agent.id,
            agentName: agent.name,
            recordIds: run.triggerRecordIds,
          },
          budgetChars: AGENT_INPUT_CHAR_BUDGET,
          pendingMessages: this.pendingFor(state.sessionId, agent.id, records),
          ...(squad ? { squad } : {}),
        };
      const input = buildAgentInput({ ...inputOptions, readThroughRecordId });
      live.lastRecordId = input.lastRecordId;
      // A resume the program refuses starts a fresh native session, which
      // must get the conversation from the start in this same turn.
      const freshPrompt =
        nativeSessionId && readThroughRecordId !== undefined
          ? buildAgentInput(inputOptions).prompt
          : undefined;
      live.offeredFreshPrompt = freshPrompt !== undefined;
      state.file.bindings[agent.id] = {
        ...binding,
        agentId: agent.id,
        ...(nativeSessionId
          ? {
              nativeSessionId,
              runtimeId: LOCAL_SESSION_AGENT_RUNTIME_ID,
            }
          : {}),
      };
      await this.persist(state);
      if (controller.signal.aborted) throw new Error('cancelled');
      // A Claude / Codex process lives for one turn: its `session_send`
      // server gets a fresh token now. The hidden qwen session outlives the
      // turn, so the adapter rotates the token only when it (re)creates it.
      const sessionSend: QwenSessionSendBinding = {
        isCurrent: () => this.sendTokenIsCurrent(state.sessionId, agent.id),
        rotate: () => this.rotateSendToken(state.sessionId, agent.id),
      };
      const sessionSendServer =
        program === 'qwen'
          ? undefined
          : this.rotateSendToken(state.sessionId, agent.id);
      const adapter = this.adapterFor(program, {
        workspaceCwd: this.workspaceCwd,
        bridge: this.bridge,
        agentId: agent.id,
        permissionVoteContext: (requestId) => live.voterContexts.get(requestId),
        sessionSend,
      });
      const result = await adapter.runTurn({
        prompt: input.prompt,
        ...(freshPrompt !== undefined ? { freshPrompt } : {}),
        ...persona,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        cwd: this.workspaceCwd,
        ...(sessionSendServer ? { sessionSendServer } : {}),
        signal: controller.signal,
        onEvent: (event) => this.applyEvent(state, live, event),
        awaitPermission: (prompt) => this.awaitPermission(live, prompt),
      });
      outcome = {
        status: result.status,
        outputText: result.outputText,
        ...(result.error ? { error: result.error } : {}),
        ...(result.nativeSessionId
          ? { nativeSessionId: result.nativeSessionId }
          : {}),
        ...(result.totalTokens !== undefined
          ? { totalTokens: result.totalTokens }
          : {}),
        ...(result.resumeRejected ? { resumeRejected: true } : {}),
      };
    } catch (error) {
      outcome = {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        outputText: live.frame.outputText ?? '',
        error: getErrorMessage(error),
      };
    }
    if (live.abortReason === 'stalled') {
      outcome = {
        ...outcome,
        status: 'failed',
        error: SESSION_AGENT_STALLED_ERROR,
      };
    } else if (live.abortReason === 'cancelled') {
      outcome = { ...outcome, status: 'cancelled' };
      delete outcome.error;
    } else if (live.abortReason === 'shutdown') {
      outcome = {
        ...outcome,
        status: 'failed',
        error: this.stoppedError,
      };
    }
    await live.sendChain;
    await this.finishRun(state, live, outcome);
  }

  private awaitPermission(
    live: LiveRun,
    prompt: SessionAgentPermissionPrompt,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (live.controller?.signal.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      live.pendingPermissions.set(prompt.requestId, { resolve, reject });
    });
  }

  private applyEvent(
    state: SessionState,
    live: LiveRun,
    event: AgentAdapterEvent,
  ): void {
    if (isTerminalSessionAgentRunStatus(live.run.status)) return;
    // Stopping: the turn is winding down. Nothing it still reports may
    // revive the run; a late permission request is refused by the adapter
    // (`awaitPermission` rejects) and never shown. Only its token count and
    // native session id are kept.
    if (
      live.abortReason &&
      event.type !== 'usage' &&
      event.type !== 'native_session'
    ) {
      return;
    }
    const frame = live.frame;
    frame.activityAt = this.now();
    switch (event.type) {
      case 'native_session':
        live.nativeSessionId = event.nativeSessionId;
        break;
      case 'text_delta':
        frame.outputText = ((frame.outputText ?? '') + event.text).slice(
          -MAX_OUTPUT_CHARS,
        );
        break;
      case 'thought_delta':
        frame.thoughtText = ((frame.thoughtText ?? '') + event.text).slice(
          -MAX_THOUGHT_CHARS,
        );
        break;
      case 'step':
        live.steps.set(event.step.id, event.step);
        // Bounded: the oldest steps go first (an update keeps its place).
        for (const id of live.steps.keys()) {
          if (live.steps.size <= MAX_RUN_STEPS) break;
          live.steps.delete(id);
        }
        frame.steps = [...live.steps.values()].slice(-MAX_FRAME_STEPS);
        break;
      case 'permission_request':
        frame.permission = event.prompt;
        live.run.status = 'awaiting_approval';
        void this.persist(state).catch(() => {});
        break;
      case 'permission_resolved':
        if (frame.permission?.requestId === event.requestId) {
          delete frame.permission;
          live.run.status = 'running';
          void this.persist(state).catch(() => {});
        }
        live.pendingPermissions.delete(event.requestId);
        live.voterContexts.delete(event.requestId);
        if (live.remote) {
          live.remote.decisions = live.remote.decisions.filter(
            (decision) => decision.requestId !== event.requestId,
          );
        }
        break;
      case 'usage':
        live.totalTokens = event.totalTokens;
        frame.totalTokens = event.totalTokens;
        break;
      case 'session_send':
        void this.queueSessionSend(state, live, event.text).catch(() => {});
        break;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
    this.publish(live);
  }

  /**
   * Chains one `session_send` post behind the run's earlier ones. The
   * returned promise reports this post's outcome; a failure is also shown on
   * the run frame.
   */
  private queueSessionSend(
    state: SessionState,
    live: LiveRun,
    text: string,
  ): Promise<void> {
    const done = live.sendChain.then(() =>
      this.handleSessionSend(state, live, text),
    );
    live.sendChain = done.catch((error) => {
      live.frame.error = getErrorMessage(error);
      this.publish(live);
    });
    return done;
  }

  /**
   * An agent posted into the chat session with `session_send`: recorded as
   * an `agent_mention` authored by that agent, then routed like a reply.
   */
  private async handleSessionSend(
    state: SessionState,
    live: LiveRun,
    text: string,
  ): Promise<void> {
    if (isBlankAgentText(text)) return;
    // A Host relays a remote agent's post unchecked; the HTTP entry points
    // refuse the same text (see postFromAgent), and the record could not
    // hold it.
    if (text.length > MAX_MENTION_TEXT_CHARS) {
      throw new SessionAgentError(
        400,
        'invalid_text',
        `A session_send post of ${text.length.toLocaleString('en-US')} characters was not posted: the limit is ${MAX_MENTION_TEXT_CHARS.toLocaleString('en-US')}.`,
      );
    }
    const roster = await this.readAgents(this.workspaceCwd);
    const targets = resolveMentionTargetsWithSquads(
      text,
      roster,
      await this.loadSquads(),
      live.run.agentId,
    );
    const squadTargets = this.agentSquadTargets(
      state,
      live.run.agentId,
      targets.squads,
      roster,
    );
    assertMentionFitsRecord(targets.agents.length, squadTargets.length);
    const squadError =
      targets.unavailableSquads.length > 0
        ? squadUnavailableError(targets.unavailableSquads)
        : undefined;
    // A handoff that reaches no one says why, so its author can tell.
    const postError = joinErrors(
      squadError,
      targets.agents.length === 0 && squadTargets.length === 0
        ? unreachedAgentsError(targets.unavailable, targets.unknown)
        : undefined,
    );
    const squadMembers = await this.squadMembersFor(live);
    live.sendCount += 1;
    const recordKey = `send:${live.run.id}:${live.sendCount}`;
    let record: SessionExternalRecordResponse;
    try {
      record = await this.appendRecord(state.sessionId, {
        kind: 'agent_mention',
        recordKey,
        modelText: formatAgentMentionModelText(
          text,
          [
            ...targets.agents.map((agent) => agent.name),
            ...squadTargets.map(({ squad }) => squad.name),
          ],
          { authorName: live.author.name },
        ),
        payload: {
          displayText: text,
          mentionedAgentIds: targets.agents.map((agent) => agent.id),
          ...(squadTargets.length > 0
            ? { mentionedSquadIds: squadTargets.map(({ squad }) => squad.id) }
            : {}),
          author: live.author,
          ...(postError ? { error: postError } : {}),
        },
      });
    } catch (error) {
      throw recordWriteError(error);
    }
    if (postError) {
      live.frame.error = postError;
      this.publish(live);
    }
    const triggerId = triggerIdFor(record, recordKey);
    if (record.deferred) {
      this.addPendingPost({
        sessionId: state.sessionId,
        id: triggerId,
        kind: 'agent_mention',
        speaker: `${live.author.name} (agent)`,
        text,
        authorAgentId: live.run.agentId,
        createdAt: this.now(),
      });
    }
    const limitError = this.routeMentions(
      state,
      live,
      targets.agents,
      triggerId,
      squadMembers,
      squadTargets,
    );
    if (limitError) {
      live.frame.error = limitError;
      this.publish(live);
    }
  }

  /**
   * Starts follow-up runs for agents and squads an agent addressed. Returns
   * the chain limit error when the hop is refused, undefined otherwise.
   */
  private routeMentions(
    state: SessionState,
    author: LiveRun,
    agents: readonly WorkspaceAgent[],
    recordId: string,
    squadMembers?: ReadonlySet<string>,
    squads: readonly SquadTarget[] = [],
  ): string | undefined {
    if ((agents.length === 0 && squads.length === 0) || this.stopped) {
      return undefined;
    }
    const names = [
      ...agents.map((agent) => agent.name),
      ...squads.map(({ squad }) => squad.name),
    ];
    const depth = nextChainDepth({
      kind: 'agent',
      chainDepth: author.run.chainDepth,
    });
    const limit = normalizeAgentChainLimit(this.chainLimit());
    if (!isWithinChainLimit(depth, limit)) {
      return chainLimitError(limit, names);
    }
    const budget = normalizeAgentTokenBudget(this.tokenBudget());
    if (!isWithinTokenBudget(state.file.chainTokens ?? 0, budget)) {
      return tokenBudgetError(budget, names);
    }
    // Squads first, so a leader also named directly runs in squad mode.
    for (const { squad, leader } of squads) {
      this.startEngagement(state, squad, recordId);
      this.enqueue(state, leader, recordId, depth, squad.id);
    }
    for (const agent of agents) {
      const summary = this.enqueue(state, agent, recordId, depth);
      if (squadMembers?.has(agent.id)) {
        this.trackDelegation(state, author.run.squadId, summary.runId);
      }
    }
    void this.persist(state)
      .catch(() => {})
      .then(() => {
        for (const { leader } of squads) this.pumpAgent(leader.id);
        for (const agent of agents) this.pumpAgent(agent.id);
      });
    return undefined;
  }

  private async cancelLive(state: SessionState, live: LiveRun): Promise<void> {
    const { run } = live;
    if (isTerminalSessionAgentRunStatus(run.status)) return;
    if (run.status === 'queued') {
      // Never started: nothing to write into the transcript, so the final
      // frame carries no `recorded` (contract: the client drops the card).
      run.status = 'cancelled';
      run.endedAt = this.now();
      this.live.delete(run.id);
      this.releaseOutstanding(state, run.id);
      this.settleEngagements(state);
      this.publish(live);
      this.hub.forgetRun(state.sessionId, run.id);
      this.republishQueued(run.agentId);
      await this.persist(state).catch(() => {});
      return;
    }
    if (live.remote) {
      // From here on the Host's renew / events / result calls answer
      // `cancelled`: it aborts the turn and posts no result.
      this.rememberCancelledLease(state.sessionId, run);
      await live.sendChain;
      await this.finishRun(state, live, {
        status: 'cancelled',
        outputText: live.frame.outputText ?? '',
      });
      return;
    }
    live.abortReason = 'cancelled';
    for (const pending of live.pendingPermissions.values()) {
      pending.reject(new Error('cancelled'));
    }
    live.pendingPermissions.clear();
    // The card stops asking at once; the run ends when its turn winds down.
    if (live.frame.permission || run.status === 'awaiting_approval') {
      delete live.frame.permission;
      run.status = 'running';
      this.publish(live);
    }
    live.controller?.abort();
  }

  /**
   * Closes a run: writes its `agent_message` record, updates the binding,
   * persists, publishes the terminal frame, routes @-mentions in the reply,
   * and starts the agent's next queued run.
   */
  private async finishRun(
    state: SessionState,
    live: LiveRun,
    outcome: FinishOutcome,
  ): Promise<void> {
    const { run } = live;
    if (isTerminalSessionAgentRunStatus(run.status)) return;
    // Mark first so a concurrent sweep / cancel cannot finish it twice.
    run.status = outcome.status;
    run.endedAt = this.now();
    const runtimeId = live.remote?.hostId ?? LOCAL_SESSION_AGENT_RUNTIME_ID;
    for (const pending of live.pendingPermissions.values()) {
      pending.reject(new Error('run ended'));
    }
    live.pendingPermissions.clear();

    const replyText = !isBlankAgentText(outcome.outputText)
      ? outcome.outputText
      : outcome.status === 'completed'
        ? ''
        : (live.frame.outputText ?? '');
    // Only whitespace or invisible characters (a leader's U+200B) is no
    // reply: a squad leader's `no_action`, never a blank message.
    const displayText = isBlankAgentText(replyText)
      ? ''
      : clipReplyText(replyText);
    // A remote run whose Host went away, or a local one the daemon stopped
    // with: no record yet. It is offered for retry like a run a restart cut
    // short; dismissing it lets it go.
    const retryable =
      outcome.status === 'offline' || live.abortReason === 'shutdown';
    const nativeSessionId = outcome.nativeSessionId ?? live.nativeSessionId;
    const totalTokens = outcome.totalTokens ?? live.totalTokens;
    /** What this turn costs the session's agent token budget. */
    const chargedTokens = totalTokens ?? UNREPORTED_TURN_TOKENS;

    // Route before writing so a refused hop is recorded on the message.
    let followUps: WorkspaceAgent[] = [];
    /** Squads the reply addressed: each starts (or joins) an engagement. */
    let squadFollowUps: SquadTarget[] = [];
    let error = outcome.error;
    if (outcome.status === 'completed' && displayText.trim() && !this.stopped) {
      try {
        const roster = await this.readAgents(this.workspaceCwd);
        const targets = resolveMentionTargetsWithSquads(
          displayText,
          roster,
          await this.loadSquads(),
          run.agentId,
        );
        followUps = targets.agents;
        squadFollowUps = this.agentSquadTargets(
          state,
          run.agentId,
          targets.squads,
          roster,
        );
        if (targets.unavailableSquads.length > 0) {
          error = joinErrors(
            error,
            squadUnavailableError(targets.unavailableSquads),
          );
        }
        const names = [
          ...followUps.map((agent) => agent.name),
          ...squadFollowUps.map(({ squad }) => squad.name),
        ];
        const depth = nextChainDepth({
          kind: 'agent',
          chainDepth: run.chainDepth,
        });
        const limit = normalizeAgentChainLimit(this.chainLimit());
        const budget = normalizeAgentTokenBudget(this.tokenBudget());
        // This run's tokens count before its own mentions are routed.
        const spent = (state.file.chainTokens ?? 0) + chargedTokens;
        if (names.length > 0 && !isWithinChainLimit(depth, limit)) {
          error = joinErrors(error, chainLimitError(limit, names));
          followUps = [];
          squadFollowUps = [];
        } else if (names.length > 0 && !isWithinTokenBudget(spent, budget)) {
          error = joinErrors(error, tokenBudgetError(budget, names));
          followUps = [];
          squadFollowUps = [];
        }
      } catch (routeError) {
        error = `Could not route mentions: ${getErrorMessage(routeError)}`;
        followUps = [];
        squadFollowUps = [];
      }
    }

    // A squad leader's delegations: the follow-ups that are its members are
    // tracked, so their replies wake it again.
    const squadMembers =
      followUps.length > 0 ? await this.squadMembersFor(live) : undefined;
    // A member its leader is waiting on: wake the leader, which is one more
    // hop and is charged to the budget like any other.
    const wakes: Array<{ squadId: string; leader: WorkspaceAgent }> = [];
    const waiting = this.releaseOutstanding(state, run.id);
    if (!run.squadId && waiting.length > 0) live.memberSquadId = waiting[0];
    const memberSquadName = live.memberSquadId
      ? this.squadNames.get(live.memberSquadId)
      : undefined;
    // A run a person stopped does not wake anyone.
    if (waiting.length > 0 && outcome.status !== 'cancelled' && !this.stopped) {
      try {
        const roster = await this.readAgents(this.workspaceCwd);
        const depth = nextChainDepth({
          kind: 'agent',
          chainDepth: run.chainDepth,
        });
        const limit = normalizeAgentChainLimit(this.chainLimit());
        const budget = normalizeAgentTokenBudget(this.tokenBudget());
        const spent = (state.file.chainTokens ?? 0) + chargedTokens;
        for (const squadId of waiting) {
          const leaderId = state.file.squads?.[squadId]?.leaderAgentId;
          const leader = roster.find((agent) => agent.id === leaderId);
          if (!leader || !isAgentAddressable(leader)) {
            error = joinErrors(
              error,
              `Squad @${this.squadNames.get(squadId) ?? squadId} stops here: its leader is unavailable.`,
            );
          } else if (!isWithinChainLimit(depth, limit)) {
            error = joinErrors(error, chainLimitError(limit, [leader.name]));
          } else if (!isWithinTokenBudget(spent, budget)) {
            error = joinErrors(error, tokenBudgetError(budget, [leader.name]));
          } else {
            wakes.push({ squadId, leader });
          }
        }
      } catch (wakeError) {
        error = joinErrors(
          error,
          `Could not wake the squad leader: ${getErrorMessage(wakeError)}`,
        );
      }
    }

    const payload: AgentMessageRecordPayload = {
      displayText,
      author: {
        ...this.authorOf(live),
        runtimeId,
        // A member's reply carries its squad for display; `squadName` stays
        // the leader's mark.
        ...(memberSquadName ? { memberSquadName } : {}),
      },
      runId: run.id,
      status: outcome.status,
      ...(error ? { error } : {}),
      ...(live.steps.size > 0
        ? { steps: recordSteps(live.steps.values()) }
        : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(run.triggerRecordIds.length > 0
        ? { triggerRecordId: run.triggerRecordIds.at(-1) }
        : {}),
      // A leader with nothing to do replies with nothing: recorded, shown
      // as one muted line.
      ...(run.squadId &&
      outcome.status === 'completed' &&
      displayText.trim().length === 0
        ? { squadOutcome: 'no_action' as const }
        : {}),
    };
    // The trigger id follow-ups read this reply by (`pending:` while the
    // record is not yet in the transcript).
    let recordId: string | undefined;
    /** The record's uuid once it is in the transcript. */
    let landedRecordId: string | undefined;
    const recordKey = `agent:${run.id}`;
    const request: RecordRequest = {
      kind: 'agent_message',
      recordKey,
      modelText: formatAgentMessageModelText(payload),
      payload,
    };
    let watch = false;
    if (!retryable) {
      try {
        const written = await this.appendRecord(state.sessionId, request);
        recordId = triggerIdFor(written, recordKey);
        if (written.deferred || !written.recordId) {
          watch = true;
          if (displayText.trim()) {
            this.addPendingPost({
              sessionId: state.sessionId,
              id: recordId,
              kind: 'agent_message',
              speaker: `${live.author.name} (agent)`,
              text: displayText,
              authorAgentId: run.agentId,
              runId: run.id,
              createdAt: this.now(),
            });
          }
        } else {
          landedRecordId = written.recordId;
        }
      } catch (writeError) {
        const refusal = recordWriteError(writeError);
        error = `Could not record the reply: ${refusal.message}`;
        followUps = [];
        squadFollowUps = [];
        // A managed session refuses every write; anything else is retried by
        // the record watcher, which also reports when it lands.
        watch = refusal.code !== 'managed_session_unsupported';
      }
    }
    const nextDepth = nextChainDepth({
      kind: 'agent',
      chainDepth: run.chainDepth,
    });
    // What the leaders this reply owes a wake read it by. A reply whose write
    // is being retried wakes them once it lands (see watchRecord); one that
    // will never be recorded is carried to them as a post, with the error.
    let wakeTrigger = recordId;
    if (!wakeTrigger && wakes.length > 0 && !watch) {
      wakeTrigger = this.addUnrecordedReply(
        state.sessionId,
        run.id,
        this.authorOf(live),
        displayText,
        error,
      );
    }

    const binding = state.file.bindings[run.agentId] ?? {
      agentId: run.agentId,
    };
    if (nativeSessionId) {
      binding.nativeSessionId = nativeSessionId;
      binding.runtimeId = runtimeId;
      if (live.author.program) binding.program = live.author.program;
    }
    if (outcome.resumeRejected && !live.offeredFreshPrompt) {
      // A fresh native session holds none of the earlier conversation: drop
      // the cursor so the next prompt carries the history again (bounded by
      // AGENT_INPUT_CHAR_BUDGET). When this turn already sent the
      // from-the-start prompt, the new session has it; advance as usual.
      delete binding.readThroughRecordId;
    } else if (outcome.status === 'completed' && live.lastRecordId) {
      // Advance the cursor only when the agent answered: a failed or
      // cancelled run's input is offered again next time.
      binding.readThroughRecordId = live.lastRecordId;
    }
    state.file.bindings[run.agentId] = binding;
    if (error) run.error = error;
    else delete run.error;
    if (landedRecordId) run.recorded = true;
    else if (watch || retryable) run.recorded = false;
    else delete run.recorded;
    if (totalTokens !== undefined) run.totalTokens = totalTokens;
    state.file.chainTokens = (state.file.chainTokens ?? 0) + chargedTokens;
    // Kept on a remote run cancelled here, so a restarted daemon can still
    // answer its Host `cancelled` (see adopt).
    if (!(outcome.status === 'cancelled' && live.remote)) delete run.lease;
    state.file.runs = trimTerminalRuns(state.file.runs);

    live.frame.error = error;
    if (!error) delete live.frame.error;
    delete live.frame.permission;
    if (landedRecordId) {
      live.frame.recorded = true;
      live.frame.recordId = landedRecordId;
    } else if (watch || retryable) {
      live.frame.recorded = false;
    }
    if (retryable) live.frame.retryable = true;
    this.publish(live);
    this.hub.forgetRun(state.sessionId, run.id);
    this.live.delete(run.id);
    if (retryable) {
      this.addSettled(run.id, {
        sessionId: state.sessionId,
        frame: this.buildFrame(live),
      });
    } else if (watch) {
      this.addSettled(run.id, {
        sessionId: state.sessionId,
        frame: this.buildFrame(live),
        request,
        ...(payload.error ? { recordedError: payload.error } : {}),
        ...(!wakeTrigger && wakes.length > 0
          ? {
              wakes: wakes.map(({ squadId, leader }) => ({
                squadId,
                leader,
                chainDepth: nextDepth,
              })),
            }
          : {}),
      });
      this.watchRecord(run.id);
    }

    if (recordId) {
      // Squads first, so a leader also named directly runs in squad mode.
      for (const { squad, leader } of squadFollowUps) {
        this.startEngagement(state, squad, recordId);
        this.enqueue(state, leader, recordId, nextDepth, squad.id);
      }
      for (const agent of followUps) {
        const summary = this.enqueue(state, agent, recordId, nextDepth);
        if (squadMembers?.has(agent.id)) {
          this.trackDelegation(state, run.squadId, summary.runId);
        }
      }
    }
    if (wakeTrigger) {
      for (const { squadId, leader } of wakes) {
        this.enqueue(state, leader, wakeTrigger, nextDepth, squadId);
      }
    }
    this.settleEngagements(state);
    await this.persist(state).catch(() => {});
    this.pumpAgent(run.agentId);
    for (const { leader } of squadFollowUps) this.pumpAgent(leader.id);
    for (const agent of followUps) this.pumpAgent(agent.id);
    if (wakeTrigger) for (const { leader } of wakes) this.pumpAgent(leader.id);
  }

  /**
   * A member reply that will never be in the transcript (its write was
   * refused, or its watcher gave up): carried as a pending post so the
   * leader still reads it, and why it is missing. Returns its trigger id.
   * TODO(multi-agent): model-facing text — needs eval before release.
   */
  private addUnrecordedReply(
    sessionId: string,
    runId: string,
    author: SessionAgentAuthor,
    displayText: string,
    error: string | undefined,
  ): string {
    const id = `pending:unrecorded:${runId}`;
    const note = error
      ? `[This reply is not in the conversation record: ${error}]`
      : '[This reply is not in the conversation record.]';
    this.addPendingPost({
      sessionId,
      id,
      kind: 'agent_message',
      speaker: `${author.name} (agent)`,
      text: `${displayText.trim() ? displayText : '(no reply text)'}\n\n${note}`,
      authorAgentId: author.agentId,
      runId,
      createdAt: this.now(),
    });
    return id;
  }

  /**
   * Wakes the leaders a member reply owed once its record settled (see
   * {@link SettledRun.wakes}). Synchronous up to the enqueue, so no settle
   * can end the engagement in between; a person who stopped everything
   * meanwhile already dropped the wakes.
   */
  private wakeLeaders(
    sessionId: string,
    wakes: readonly PendingWake[],
    triggerId: string,
  ): void {
    const state = this.states.get(sessionId);
    if (!state || this.stopped) return;
    const woken: string[] = [];
    for (const { squadId, leader, chainDepth } of wakes) {
      if (!state.file.squads?.[squadId]?.active) continue;
      this.enqueue(state, leader, triggerId, chainDepth, squadId);
      woken.push(leader.id);
    }
    this.settleEngagements(state);
    void this.persist(state)
      .catch(() => {})
      .then(() => {
        for (const agentId of woken) this.pumpAgent(agentId);
      });
  }

  private addPendingPost(post: PendingPost): void {
    this.pendingPosts.set(`${post.sessionId}\u0000${post.id}`, post);
  }

  /**
   * Deferred posts another agent should see, dropping those that have since
   * landed in `records` (matched by kind, text, author and, for a reply, its
   * run id; records do not carry their `recordKey`).
   */
  private pendingFor(
    sessionId: string,
    agentId: string,
    records: readonly ConversationRecordLike[],
  ): Array<{ id: string; speaker: string; text: string }> {
    const now = this.now();
    const out: Array<{ id: string; speaker: string; text: string }> = [];
    for (const [key, post] of [...this.pendingPosts]) {
      if (post.sessionId !== sessionId) continue;
      const landed = records.some((record) => {
        if (record.subtype !== post.kind) return false;
        const payload = record.systemPayload as
          | {
              displayText?: unknown;
              runId?: unknown;
              author?: { agentId?: unknown };
            }
          | undefined;
        return (
          payload?.displayText === post.text &&
          (post.runId === undefined || payload.runId === post.runId) &&
          (payload.author?.agentId ?? undefined) === post.authorAgentId
        );
      });
      if (landed || now - post.createdAt > PENDING_POST_TTL_MS) {
        this.pendingPosts.delete(key);
        continue;
      }
      if (post.authorAgentId === agentId) continue;
      out.push({ id: post.id, speaker: post.speaker, text: post.text });
    }
    return out;
  }

  /**
   * Writes an external record, restoring the chat session once when it is
   * not live (closed by the idle reaper while an agent worked), the way
   * create-sub-session.ts delivers to a parent that is no longer resident
   * (a standalone chat session through its own service, see
   * {@link SessionAgentOrchestratorOptions.restoreSession}).
   */
  private async appendRecord(
    sessionId: string,
    request: Parameters<SessionAgentRecordWriter['appendExternalRecord']>[1],
  ): Promise<SessionExternalRecordResponse> {
    try {
      return await this.bridge.appendExternalRecord(sessionId, request);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      await this.restoreSession(sessionId);
      return this.bridge.appendExternalRecord(sessionId, request);
    }
  }

  private fence(
    hostId: string,
    runId: string,
    attempt: number,
    leaseId: string,
    sessionId?: string,
  ): { ok: true; live: LiveRun } | Extract<HostAck, { ok: false }> {
    // Checked first: a cancel answers `cancelled` while it is finishing too.
    const cancelled = this.cancelledLeases.get(runId);
    if (
      cancelled &&
      cancelled.hostId === hostId &&
      cancelled.leaseId === leaseId &&
      cancelled.attempt === attempt &&
      (sessionId === undefined || cancelled.sessionId === sessionId)
    ) {
      return { ok: false, reason: 'cancelled', cancelled: true };
    }
    const live = this.live.get(runId);
    if (!live || (sessionId !== undefined && live.sessionId !== sessionId)) {
      return { ok: false, reason: 'unknown_run' };
    }
    const lease = live.run.lease;
    if (
      !live.remote ||
      !lease ||
      !isExecutingRun(live.run) ||
      lease.hostId !== hostId ||
      lease.leaseId !== leaseId ||
      lease.attempt !== attempt
    ) {
      return { ok: false, reason: 'lease_mismatch' };
    }
    return { ok: true, live };
  }

  private rememberCancelledLease(
    sessionId: string,
    run: SessionAgentRun,
  ): void {
    if (!run.lease) return;
    this.cancelledLeases.set(run.id, {
      sessionId,
      hostId: run.lease.hostId,
      leaseId: run.lease.leaseId,
      attempt: run.lease.attempt,
      at: run.endedAt ?? this.now(),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* session_send tokens                                                    */
  /* ---------------------------------------------------------------------- */

  private sendKey(sessionId: string, agentId: string): string {
    return `${sessionId}\u0000${agentId}`;
  }

  /** The binding's endpoint, when this daemon can offer `session_send`. */
  private sendUrlFor(sessionId: string, agentId: string): string | undefined {
    const url = this.sessionSendUrl?.(sessionId, agentId);
    return url && isLoopbackUrl(url) ? url : undefined;
  }

  /**
   * Mints the binding's next token (the previous one stops working) and
   * returns the stdio server carrying it; undefined (and no token) when the
   * daemon cannot offer the tool.
   */
  private rotateSendToken(
    sessionId: string,
    agentId: string,
  ): AgentAdapterTurnInput['sessionSendServer'] {
    const key = this.sendKey(sessionId, agentId);
    const url = this.sendUrlFor(sessionId, agentId);
    if (!url) {
      this.sendTokens.delete(key);
      return undefined;
    }
    const token = randomBytes(32).toString('hex');
    this.sendTokens.set(key, token);
    return buildSessionSendServer(url, token);
  }

  /** False when a live session may carry a token this daemon lost. */
  private sendTokenIsCurrent(sessionId: string, agentId: string): boolean {
    if (!this.sendUrlFor(sessionId, agentId)) return true;
    return this.sendTokens.has(this.sendKey(sessionId, agentId));
  }

  /* ---------------------------------------------------------------------- */
  /* Record watch and settled runs                                          */
  /* ---------------------------------------------------------------------- */

  /** Keeps a terminal run in the snapshot; evicts the oldest past the cap. */
  private addSettled(runId: string, settled: SettledRun): void {
    this.settled.set(runId, settled);
    while (this.settled.size > MAX_SETTLED_RUNS) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.settled.get(oldest);
      if (evicted?.timer) clearTimeout(evicted.timer);
      this.settled.delete(oldest);
    }
  }

  /**
   * Forgets a settled run and publishes its final frame without `recorded`
   * or `retryable` (the client drops the card), merged with `extra`.
   */
  private dropSettled(
    runId: string,
    extra: Partial<SessionAgentRunFrame>,
  ): void {
    const settled = this.settled.get(runId);
    if (!settled) return;
    if (settled.timer) clearTimeout(settled.timer);
    this.settled.delete(runId);
    const frame: SessionAgentRunFrame = { ...settled.frame, ...extra };
    delete frame.recorded;
    delete frame.retryable;
    this.hub.publish(frame);
    this.hub.forgetRun(settled.sessionId, runId);
  }

  /**
   * Re-sends a pending `agent_message` record until it is in the transcript,
   * then publishes the run's frame with `recorded: true`. The child is
   * idempotent on `recordKey`: a still-deferred record answers `deferred`
   * again, a landed one answers its uuid. Only when the chat session is not
   * live (its deferred records died with it) is the transcript checked, and
   * the record written again (restoring the session) if it is not there.
   * Backs off from {@link recordWatchMs} to 15s; gives up after
   * {@link RECORD_WATCH_MAX_MS}, leaving the run in the snapshot with
   * `recorded: false`. Either way, the squad leaders the reply owes a wake
   * ({@link SettledRun.wakes}) are woken then.
   */
  private watchRecord(runId: string): void {
    const settled = this.settled.get(runId);
    const request = settled?.request;
    if (!settled || (!request && !settled.recovered)) return;
    const { sessionId } = settled;
    const startedAt = this.now();
    const maxMs = request ? RECORD_WATCH_MAX_MS : RECORD_RECOVERY_WATCH_MAX_MS;
    let delayMs = this.recordWatchMs;
    const check = async (): Promise<void> => {
      settled.timer = undefined;
      if (this.stopped || this.settled.get(runId) !== settled) return;
      let recordId: string | undefined;
      if (!request) {
        recordId = await this.findAgentMessageRecord(sessionId, runId).catch(
          () => undefined,
        );
      } else {
        try {
          const response = await this.bridge.appendExternalRecord(
            sessionId,
            request,
          );
          if (!response.deferred && response.recordId) {
            recordId = response.recordId;
          }
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            try {
              recordId = await this.findAgentMessageRecord(sessionId, runId);
              if (!recordId) {
                const response = await this.appendRecord(sessionId, request);
                if (!response.deferred && response.recordId) {
                  recordId = response.recordId;
                }
              }
            } catch {
              // Retried on the next check.
            }
          }
        }
      }
      if (this.stopped || this.settled.get(runId) !== settled) return;
      if (recordId) {
        this.settled.delete(runId);
        const frame: SessionAgentRunFrame = {
          ...settled.frame,
          recorded: true,
          recordId,
        };
        delete frame.retryable;
        if (settled.recordedError) frame.error = settled.recordedError;
        else delete frame.error;
        this.hub.publish(frame);
        this.hub.forgetRun(sessionId, runId);
        this.markRecorded(sessionId, runId);
        if (settled.wakes) this.wakeLeaders(sessionId, settled.wakes, recordId);
        return;
      }
      if (this.now() - startedAt >= maxMs) {
        // Given up: the leaders it owed a wake still get the reply, and why
        // it is not recorded, so they can decide. A run adopted after a
        // restart has no request: its reply text died with that daemon.
        const wakes = settled.wakes;
        if (wakes) {
          delete settled.wakes;
          const reply =
            request?.kind === 'agent_message' ? request.payload : undefined;
          const trigger = this.addUnrecordedReply(
            sessionId,
            runId,
            reply?.author ?? settled.frame.author,
            reply?.displayText ?? '',
            settled.frame.error,
          );
          this.wakeLeaders(sessionId, wakes, trigger);
        }
        return;
      }
      delayMs = Math.min(delayMs * 2, RECORD_WATCH_MAX_INTERVAL_MS);
      schedule();
    };
    const schedule = () => {
      settled.timer = setTimeout(() => void check(), delayMs);
      settled.timer.unref?.();
    };
    schedule();
  }

  /** Persists that run `runId`'s record is in the transcript. */
  private markRecorded(sessionId: string, runId: string): void {
    const state = this.states.get(sessionId);
    const run = state?.file.runs.find((candidate) => candidate.id === runId);
    if (!state || !run || run.recorded === true) return;
    run.recorded = true;
    void this.persist(state).catch(() => {});
  }

  /** uuid of run `runId`'s `agent_message` record in the transcript. */
  private async findAgentMessageRecord(
    sessionId: string,
    runId: string,
  ): Promise<string | undefined> {
    const records = await this.loadRecords(sessionId);
    return records.find(
      (record) =>
        record.subtype === AGENT_MESSAGE_SUBTYPE &&
        (record.systemPayload as { runId?: unknown } | undefined)?.runId ===
          runId,
    )?.uuid;
  }

  /* ---------------------------------------------------------------------- */
  /* Frames                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * 1-based position among the agent's queued runs in EVERY chat session
   * (runs start oldest first across sessions, up to `maxConcurrentRuns`).
   */
  private buildFrame(live: LiveRun): SessionAgentRunFrame {
    const position = queuePosition(
      [...this.live.values()].map((candidate) => candidate.run),
      live.run,
    );
    const frame: SessionAgentRunFrame = {
      ...live.frame,
      author: this.authorOf(live),
      status: live.run.status,
      ...(live.frame.steps ? { steps: [...live.frame.steps] } : {}),
    };
    if (position !== undefined) frame.queuePosition = position;
    else delete frame.queuePosition;
    const squadId =
      live.run.squadId ?? this.memberSquadOf(live) ?? live.memberSquadId;
    const squadName = squadId ? this.squadNames.get(squadId) : undefined;
    if (squadId) frame.squadId = squadId;
    else delete frame.squadId;
    if (squadName) frame.squadName = squadName;
    else delete frame.squadName;
    return frame;
  }

  /* ---------------------------------------------------------------------- */
  /* Squads                                                                 */
  /* ---------------------------------------------------------------------- */

  /** The workspace's squads; an unreadable file reads as none (logged). */
  private async loadSquads(): Promise<SessionSquad[]> {
    try {
      const squads = await this.readSquads(this.workspaceCwd);
      for (const squad of squads) this.squadNames.set(squad.id, squad.name);
      return squads;
    } catch (error) {
      writeStderrLine(
        `qwen serve: could not read squads in ${this.workspaceCwd}: ${getErrorMessage(error)}`,
      );
      return [];
    }
  }

  /** The author a run is shown and recorded under: a leader names its squad. */
  private authorOf(live: LiveRun): SessionAgentAuthor {
    const squadId = live.run.squadId;
    const squadName =
      squadId === undefined
        ? undefined
        : (live.squadName ?? this.squadNames.get(squadId));
    return squadName ? { ...live.author, squadName } : live.author;
  }

  /** Opens (or keeps) the squad's engagement in this chat session. */
  private startEngagement(
    state: SessionState,
    squad: SessionSquad,
    triggerId: string,
  ): void {
    const engagements = (state.file.squads ??= {});
    const existing = engagements[squad.id];
    if (existing?.active) {
      existing.leaderAgentId = squad.leaderAgentId;
      return;
    }
    engagements[squad.id] = {
      leaderAgentId: squad.leaderAgentId,
      startedByRecordId: triggerId,
      outstandingRunIds: [],
      active: true,
    };
  }

  /**
   * The squads an agent's post starts (or joins) an engagement for, with
   * their leaders: agents may @-mention squads, as in Multica's comment
   * triggers. Not a squad the author leads (it would wake itself), nor one
   * whose engagement is active while the author is a member of it (its reply
   * wakes the leader through the member rule when the leader waits on it).
   */
  private agentSquadTargets(
    state: SessionState,
    authorAgentId: string,
    squads: readonly SessionSquad[],
    roster: readonly WorkspaceAgent[],
  ): SquadTarget[] {
    return squads.flatMap((squad) => {
      if (squad.leaderAgentId === authorAgentId) return [];
      if (
        state.file.squads?.[squad.id]?.active &&
        squad.members.some((member) => member.agentId === authorAgentId)
      ) {
        return [];
      }
      const leader = roster.find((agent) => agent.id === squad.leaderAgentId);
      return leader ? [{ squad, leader }] : [];
    });
  }

  /** An active engagement in this session led by `agentId`, if any. */
  private activeSquadLedBy(
    state: SessionState,
    agentId: string,
  ): string | undefined {
    for (const [squadId, engagement] of Object.entries(
      state.file.squads ?? {},
    )) {
      if (engagement.active && engagement.leaderAgentId === agentId) {
        return squadId;
      }
    }
    return undefined;
  }

  /** The engagement whose leader waits on this (member) run. */
  private memberSquadOf(live: LiveRun): string | undefined {
    const engagements = this.states.get(live.sessionId)?.file.squads;
    for (const [squadId, engagement] of Object.entries(engagements ?? {})) {
      if (engagement.outstandingRunIds.includes(live.run.id)) return squadId;
    }
    return undefined;
  }

  /** Member agent ids of the squad `live` leads (itself excluded). */
  private async squadMembersFor(
    live: LiveRun,
  ): Promise<ReadonlySet<string> | undefined> {
    const squadId = live.run.squadId;
    if (!squadId) return undefined;
    const squad = (await this.loadSquads()).find(
      (candidate) => candidate.id === squadId,
    );
    if (!squad) return undefined;
    return new Set(
      squad.members
        .map((member) => member.agentId)
        .filter((agentId) => agentId !== live.run.agentId),
    );
  }

  /** The leader delegated to a member: wait for that run's reply. */
  private trackDelegation(
    state: SessionState,
    squadId: string | undefined,
    runId: string,
  ): void {
    const engagement = squadId ? state.file.squads?.[squadId] : undefined;
    if (!engagement?.active) return;
    if (!engagement.outstandingRunIds.includes(runId)) {
      engagement.outstandingRunIds.push(runId);
    }
    const live = this.live.get(runId);
    if (live) this.publish(live);
  }

  /**
   * Stops waiting on a finished (or dropped) run. Returns the squads whose
   * leader was waiting on it.
   */
  private releaseOutstanding(state: SessionState, runId: string): string[] {
    const released: string[] = [];
    for (const [squadId, engagement] of Object.entries(
      state.file.squads ?? {},
    )) {
      if (!engagement.outstandingRunIds.includes(runId)) continue;
      engagement.outstandingRunIds = engagement.outstandingRunIds.filter(
        (id) => id !== runId,
      );
      if (engagement.active) released.push(squadId);
    }
    return released;
  }

  /**
   * Ends every engagement of this session with nothing outstanding and no
   * leader run queued or executing for it. Outstanding ids of runs that are
   * no longer live (ended without a wake: a restart, a cancel) are dropped
   * first. Also saves which member replies still owe each leader a wake
   * (`pendingWakeRunIds`, from {@link SettledRun.wakes}), so a restart
   * restores them (see restorePendingWakes). Returns whether anything changed.
   */
  private settleEngagements(state: SessionState): boolean {
    let changed = false;
    for (const [squadId, engagement] of Object.entries(
      state.file.squads ?? {},
    )) {
      const owed: string[] = [];
      for (const [runId, settled] of this.settled) {
        if (
          settled.sessionId === state.sessionId &&
          settled.wakes?.some((wake) => wake.squadId === squadId) === true
        ) {
          owed.push(runId);
        }
      }
      const saved = engagement.pendingWakeRunIds ?? [];
      if (
        saved.length !== owed.length ||
        saved.some((runId, index) => runId !== owed[index])
      ) {
        if (owed.length > 0) engagement.pendingWakeRunIds = owed;
        else delete engagement.pendingWakeRunIds;
        changed = true;
      }
      if (!engagement.active) continue;
      const outstanding = engagement.outstandingRunIds.filter(
        (runId) => this.live.get(runId)?.sessionId === state.sessionId,
      );
      if (outstanding.length !== engagement.outstandingRunIds.length) {
        engagement.outstandingRunIds = outstanding;
        changed = true;
      }
      if (outstanding.length > 0) continue;
      const leading = [...this.live.values()].some(
        (live) =>
          live.sessionId === state.sessionId &&
          live.run.squadId === squadId &&
          !isTerminalSessionAgentRunStatus(live.run.status),
      );
      if (leading) continue;
      // A member reply still being recorded will wake the leader.
      if (owed.length > 0) continue;
      engagement.active = false;
      changed = true;
    }
    return changed;
  }

  /**
   * The squad briefing for a leader run (`run.squadId`), or undefined when
   * the run is not a leader's or the squad is gone. Members that cannot run
   * (disabled, retired, missing) are left out.
   */
  private async squadBriefingFor(
    live: LiveRun,
    roster: readonly WorkspaceAgent[],
  ): Promise<SquadBriefing | undefined> {
    const squadId = live.run.squadId;
    if (!squadId) return undefined;
    const squad = (await this.loadSquads()).find(
      (candidate) => candidate.id === squadId,
    );
    if (!squad) return undefined;
    live.squadName = squad.name;
    const byId = new Map(roster.map((agent) => [agent.id, agent]));
    return {
      name: squad.name,
      ...(squad.instructions ? { instructions: squad.instructions } : {}),
      members: squad.members.flatMap((member) => {
        const agent = byId.get(member.agentId);
        if (
          !agent ||
          agent.id === live.run.agentId ||
          !isAgentAddressable(agent)
        ) {
          return [];
        }
        const program = programForAgent(agent);
        return [
          {
            name: agent.name,
            ...(member.role ? { role: member.role } : {}),
            ...(agent.description ? { description: agent.description } : {}),
            ...(program ? { program: PROGRAM_LABELS[program] } : {}),
            runtime:
              agent.execution?.mode === 'managed-host'
                ? `remote runtime ${agent.execution.hostIds.join(', ')}`
                : 'this computer',
          },
        ];
      }),
    };
  }

  private publish(live: LiveRun, options: { immediate?: boolean } = {}): void {
    live.frame.status = live.run.status;
    live.frame.author = live.author;
    this.hub.publish(this.buildFrame(live), options);
  }

  /** Serialized whole-file write of the in-memory state. */
  private persist(state: SessionState): Promise<void> {
    const next = state.writeChain.then(async () => {
      await writeSessionAgents(this.workspaceCwd, state.file);
    });
    state.writeChain = next.catch((error) => {
      writeStderrLine(
        `qwen serve: could not save session agents for ${state.sessionId}: ${getErrorMessage(error)}`,
      );
    });
    return next;
  }
}

/* ------------------------------------------------------------------------ */
/* One orchestrator per workspace                                           */
/* ------------------------------------------------------------------------ */

const orchestrators = new Map<string, SessionAgentOrchestrator>();

export function getSessionAgentOrchestrator(
  workspaceCwd: string,
): SessionAgentOrchestrator | undefined {
  return orchestrators.get(workspaceCwd);
}

/**
 * The workspace's orchestrator, created on first use. A runtime whose bridge
 * was replaced gets a fresh one; the old one's runs are stopped.
 */
export function ensureSessionAgentOrchestrator(
  options: SessionAgentOrchestratorOptions,
): SessionAgentOrchestrator {
  const existing = orchestrators.get(options.workspaceCwd);
  if (existing && existing.bridge === options.bridge) return existing;
  if (existing) void existing.dispose('runtime_replaced');
  const created = new SessionAgentOrchestrator(options);
  orchestrators.set(options.workspaceCwd, created);
  return created;
}

export async function disposeSessionAgentOrchestrator(
  workspaceCwd: string,
  reason: SessionAgentStopReason = 'shutdown',
): Promise<void> {
  const existing = orchestrators.get(workspaceCwd);
  if (!existing) return;
  orchestrators.delete(workspaceCwd);
  await existing.dispose(reason);
}

export async function disposeAllSessionAgentOrchestrators(
  reason: SessionAgentStopReason = 'shutdown',
): Promise<void> {
  const all = [...orchestrators.keys()];
  await Promise.all(
    all.map((cwd) => disposeSessionAgentOrchestrator(cwd, reason)),
  );
}
