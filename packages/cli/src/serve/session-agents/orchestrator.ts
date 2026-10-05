/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Session multi-agent orchestrator, one per workspace.
 *
 * Owns, per chat session (plan §3.1): queueing and coalescing of agent runs,
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
 * at most one queued run (plan §8-3, run-queue.ts), so a native session is
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
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
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
  type ConversationRecordLike,
} from '@qwen-code/qwen-code-core/agents/session-agents/conversation-delta.js';
import {
  isWithinChainLimit,
  isWithinTokenBudget,
  nextChainDepth,
  normalizeAgentChainLimit,
  normalizeAgentTokenBudget,
  resolveMentionTargets,
} from '@qwen-code/qwen-code-core/agents/session-agents/chain.js';
import {
  SessionNotFoundError,
  type AcpSessionBridge,
  type BridgeClientRequestContext,
} from '../acp-session-bridge.js';
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
export const SESSION_AGENT_OFFLINE_ERROR = 'runtime went offline';
/** Remote turn lease; a Host renews it while it works. */
export const HOST_TURN_LEASE_MS = 60_000;
const SWEEP_INTERVAL_MS = 5_000;
const MAX_OUTPUT_CHARS = 262_144;
const MAX_THOUGHT_CHARS = 65_536;
const MAX_FRAME_STEPS = 8;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_MENTION_TEXT_CHARS = 100_000;
/** How long a deferred post is carried before it is assumed recorded. */
const PENDING_POST_TTL_MS = 60 * 60_000;
/** First re-check of a deferred / failed `agent_message` record write. */
export const RECORD_WATCH_INITIAL_MS = 1_000;
const RECORD_WATCH_MAX_INTERVAL_MS = 15_000;
/** How long a pending record is watched before the watcher gives up. */
export const RECORD_WATCH_MAX_MS = PENDING_POST_TTL_MS;
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
  abortReason?: 'cancelled' | 'stalled';
  pendingPermissions: Map<string, PendingPermission>;
  voterContexts: Map<string, BridgeClientRequestContext>;
  /** Newest chat record the run's prompt included (the next read cursor). */
  lastRecordId?: string;
  nativeSessionId?: string;
  totalTokens?: number;
  sendCount: number;
  /** Serializes `session_send` handling so records keep their order. */
  sendChain: Promise<void>;
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
  /** `error` to show once the record lands (a write error is cleared). */
  recordedError?: string;
  timer?: ReturnType<typeof setTimeout>;
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

  constructor(options: SessionAgentOrchestratorOptions) {
    this.workspaceCwd = options.workspaceCwd;
    this.bridge = options.bridge;
    this.hub = options.hub ?? getSessionAgentEventHub(options.workspaceCwd);
    this.chainLimit = options.chainLimit ?? (() => 0);
    this.tokenBudget =
      options.tokenBudget ?? (() => DEFAULT_AGENT_TOKEN_BUDGET);
    this.readAgents = options.readAgents ?? readWorkspaceAgents;
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
    const targets = resolveMentionTargets(text, roster);
    if (targets.agents.length === 0) {
      throw new SessionAgentError(
        400,
        'no_agents_mentioned',
        'The message does not @-mention any available agent.',
        {
          unavailable: targets.unavailable.map((agent) => agent.name),
          unknown: targets.unknown,
        },
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
        modelText: formatAgentMentionModelText(
          text,
          targets.agents.map((agent) => agent.name),
        ),
        payload: {
          displayText: text,
          mentionedAgentIds: targets.agents.map((agent) => agent.id),
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
    const runs = targets.agents.map((agent) =>
      this.enqueue(state, agent, triggerId, nextChainDepth({ kind: 'human' })),
    );
    // The runs are already queued in memory and the record is written, so a
    // failed save is logged (by persist) rather than reported as a refusal;
    // a local run re-saves before it starts and fails there if it cannot.
    await this.persist(state).catch(() => {});
    for (const agent of targets.agents) this.pumpAgent(agent.id);
    return {
      recordId: record.recordId,
      ...(record.deferred ? { deferred: true } : {}),
      runs,
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
      return true;
    }
    const state = await this.session(sessionId);
    await this.cancelLive(state, live);
    return true;
  }

  /**
   * Runs a `failed` or `offline` run again (typically one a daemon restart
   * interrupted): queues a NEW run with the same triggers and chain depth,
   * `retryOf: runId`, and, when the old run is still in the snapshot
   * (retryable, or its record pending), publishes its final frame with
   * `retriedAsRunId`; a run whose record already landed gets no frame. Refuses (SessionAgentError) when the run is unknown
   * (404 `run_not_found`), not failed/offline (409 `run_not_retryable`),
   * already retried (409 `run_already_retried`), or its agent can no longer
   * take work (409 `agent_unavailable`).
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
    if (run.status !== 'failed' && run.status !== 'offline') {
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
    // After the roster read, which another retry call may have raced.
    if (state.file.runs.some((candidate) => candidate.retryOf === runId)) {
      throw new SessionAgentError(
        409,
        'run_already_retried',
        'This run was already retried.',
      );
    }
    // A new run id: the record key is `agent:<runId>`, and the old run may
    // already own one, which would make the retry's reply a silent no-op.
    let summary: SessionAgentRunSummary | undefined;
    for (const trigger of run.triggerRecordIds) {
      summary = this.enqueue(state, agent, trigger, run.chainDepth);
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
    this.dropSettled(runId, { retriedAsRunId: retried.id });
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
    const runs = [...this.live.values()].filter(
      (live) => live.sessionId === sessionId,
    );
    if (runs.length === 0) return [];
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
      this.publish(live);
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
      text.trim().length === 0 ||
      text.length > MAX_MENTION_TEXT_CHARS
    ) {
      throw new SessionAgentError(400, 'invalid_text', 'text is required.');
    }
    const live = [...this.live.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.run.agentId === agentId &&
        !candidate.remote &&
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
   * Stops this daemon's local runs (queued and executing) and the timers.
   * Remote runs are left on disk as they are (queued, or executing under
   * their lease with the last accepted sequence), so the next orchestrator
   * for this workspace (after a restart, or a replaced bridge) re-adopts
   * them and their Host carries on. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const settled of this.settled.values()) {
      if (settled.timer) clearTimeout(settled.timer);
    }
    const local = [...this.live.values()].filter(
      (live) =>
        !live.remote && live.author.runtimeId === LOCAL_SESSION_AGENT_RUNTIME_ID,
    );
    // Queued first, so finishing an executing run cannot start one of them.
    local.sort(
      (a, b) => Number(isExecutingRun(a.run)) - Number(isExecutingRun(b.run)),
    );
    for (const live of local) {
      const state = this.states.get(live.sessionId);
      if (state) await this.cancelLive(state, live).catch(() => {});
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
        // A native session lives on one runtime. On a different Host the
        // agent starts a fresh one that has seen nothing, so it gets the
        // conversation from the start (bounded by the budget), not the delta
        // after the old runtime's cursor.
        const sameRuntime =
          binding.runtimeId === hostId &&
          canReuseNativeSession(binding, hostId, program);
        const input = buildAgentInput({
          records,
          readThroughRecordId: sameRuntime
            ? binding.readThroughRecordId
            : undefined,
          trigger: {
            agentId: agent.id,
            agentName: agent.name,
            recordIds: run.triggerRecordIds,
          },
          budgetChars: AGENT_INPUT_CHAR_BUDGET,
          pendingMessages: this.pendingFor(live.sessionId, agent.id, records),
        });
        live.lastRecordId = input.lastRecordId;
        // A native session lives on one runtime; resume only there.
        const nativeSessionId = sameRuntime
          ? binding.nativeSessionId
          : undefined;
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
          agent: { ...live.author, ...persona },
          program,
          prompt: input.prompt,
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
      delete run.lease;
      changed = true;
      const author: SessionAgentAuthor = agent
        ? authorFor(
            agent,
            remoteAgent ? undefined : LOCAL_SESSION_AGENT_RUNTIME_ID,
            programForAgent(agent),
          )
        : { agentId: run.agentId, name: run.agentId };
      this.addSettled(run.id, {
        sessionId: file.sessionId,
        frame: {
          type: 'run',
          sessionId: file.sessionId,
          runId: run.id,
          author,
          status: 'failed',
          error: SESSION_AGENT_RESTARTED_ERROR,
          activityAt: now,
          recorded: false,
          retryable: true,
        },
      });
    }
    if (changed) void this.persist(state).catch(() => {});
    return state;
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
      // Nothing to adopt: no live run, and no remote run cancelled while
      // its Host ran it (whose Host must still be told).
      if (
        file.runs.every(
          (run) =>
            isTerminalSessionAgentRunStatus(run.status) &&
            !(run.status === 'cancelled' && run.lease),
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

  private enqueue(
    state: SessionState,
    agent: WorkspaceAgent,
    recordId: string,
    chainDepth: number,
  ): SessionAgentRunSummary {
    const outcome = enqueueTrigger(state.file.runs, {
      agentId: agent.id,
      recordId,
      chainDepth,
      now: this.now(),
      newRunId: () => `sr_${randomUUID()}`,
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
      // The agent's native session is reusable only on the runtime and with
      // the program that created it. After a move (remote -> local) or a
      // program change it starts fresh, so it gets the conversation from the
      // start (bounded by the budget), not the delta after the old cursor.
      const sameNativeSession = canReuseNativeSession(
        binding,
        LOCAL_SESSION_AGENT_RUNTIME_ID,
        program,
      );
      const input = buildAgentInput({
        records,
        readThroughRecordId: sameNativeSession
          ? binding.readThroughRecordId
          : undefined,
        trigger: {
          agentId: agent.id,
          agentName: agent.name,
          recordIds: run.triggerRecordIds,
        },
        budgetChars: AGENT_INPUT_CHAR_BUDGET,
        pendingMessages: this.pendingFor(state.sessionId, agent.id, records),
      });
      live.lastRecordId = input.lastRecordId;
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
    if (text.trim().length === 0) return;
    const roster = await this.readAgents(this.workspaceCwd);
    const targets = resolveMentionTargets(text, roster, live.run.agentId);
    live.sendCount += 1;
    const recordKey = `send:${live.run.id}:${live.sendCount}`;
    let record: SessionExternalRecordResponse;
    try {
      record = await this.appendRecord(state.sessionId, {
        kind: 'agent_mention',
        recordKey,
        modelText: formatAgentMentionModelText(
          text,
          targets.agents.map((agent) => agent.name),
          { authorName: live.author.name },
        ),
        payload: {
          displayText: text,
          mentionedAgentIds: targets.agents.map((agent) => agent.id),
          author: live.author,
        },
      });
    } catch (error) {
      throw recordWriteError(error);
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
    );
    if (limitError) {
      live.frame.error = limitError;
      this.publish(live);
    }
  }

  /**
   * Starts follow-up runs for agents an agent addressed. Returns the chain
   * limit error when the hop is refused, undefined otherwise.
   */
  private routeMentions(
    state: SessionState,
    author: LiveRun,
    agents: readonly WorkspaceAgent[],
    recordId: string,
  ): string | undefined {
    if (agents.length === 0 || this.stopped) return undefined;
    const depth = nextChainDepth({
      kind: 'agent',
      chainDepth: author.run.chainDepth,
    });
    const limit = normalizeAgentChainLimit(this.chainLimit());
    if (!isWithinChainLimit(depth, limit)) {
      return chainLimitError(
        limit,
        agents.map((agent) => agent.name),
      );
    }
    const budget = normalizeAgentTokenBudget(this.tokenBudget());
    if (!isWithinTokenBudget(state.file.chainTokens ?? 0, budget)) {
      return tokenBudgetError(
        budget,
        agents.map((agent) => agent.name),
      );
    }
    for (const agent of agents) this.enqueue(state, agent, recordId, depth);
    void this.persist(state)
      .catch(() => {})
      .then(() => {
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

    const displayText = outcome.outputText.trim()
      ? outcome.outputText
      : outcome.status === 'completed'
        ? ''
        : (live.frame.outputText ?? '');
    const nativeSessionId = outcome.nativeSessionId ?? live.nativeSessionId;
    const totalTokens = outcome.totalTokens ?? live.totalTokens;

    // Route before writing so a refused hop is recorded on the message.
    let followUps: WorkspaceAgent[] = [];
    let error = outcome.error;
    if (outcome.status === 'completed' && displayText.trim() && !this.stopped) {
      try {
        const roster = await this.readAgents(this.workspaceCwd);
        followUps = resolveMentionTargets(
          displayText,
          roster,
          run.agentId,
        ).agents;
        const depth = nextChainDepth({
          kind: 'agent',
          chainDepth: run.chainDepth,
        });
        const limit = normalizeAgentChainLimit(this.chainLimit());
        const budget = normalizeAgentTokenBudget(this.tokenBudget());
        // This run's tokens count before its own mentions are routed.
        const spent =
          (state.file.chainTokens ?? 0) +
          (outcome.totalTokens ?? live.totalTokens ?? 0);
        if (followUps.length > 0 && !isWithinChainLimit(depth, limit)) {
          error = chainLimitError(
            limit,
            followUps.map((agent) => agent.name),
          );
          followUps = [];
        } else if (
          followUps.length > 0 &&
          !isWithinTokenBudget(spent, budget)
        ) {
          error = tokenBudgetError(
            budget,
            followUps.map((agent) => agent.name),
          );
          followUps = [];
        }
      } catch (routeError) {
        error = `Could not route mentions: ${getErrorMessage(routeError)}`;
      }
    }

    const payload: AgentMessageRecordPayload = {
      displayText,
      author: { ...live.author, runtimeId },
      runId: run.id,
      status: outcome.status,
      ...(error ? { error } : {}),
      ...(live.steps.size > 0 ? { steps: [...live.steps.values()] } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(run.triggerRecordIds.length > 0
        ? { triggerRecordId: run.triggerRecordIds.at(-1) }
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
      // A managed session refuses every write; anything else is retried by
      // the record watcher, which also reports when it lands.
      watch = refusal.code !== 'managed_session_unsupported';
    }

    const binding = state.file.bindings[run.agentId] ?? {
      agentId: run.agentId,
    };
    if (nativeSessionId) {
      binding.nativeSessionId = nativeSessionId;
      binding.runtimeId = runtimeId;
      if (live.author.program) binding.program = live.author.program;
    }
    if (outcome.resumeRejected) {
      // A fresh native session holds none of the earlier conversation: drop
      // the cursor so the next prompt carries the history again (bounded by
      // AGENT_INPUT_CHAR_BUDGET).
      delete binding.readThroughRecordId;
    } else if (outcome.status === 'completed' && live.lastRecordId) {
      // Advance the cursor only when the agent answered: a failed or
      // cancelled run's input is offered again next time.
      binding.readThroughRecordId = live.lastRecordId;
    }
    state.file.bindings[run.agentId] = binding;
    if (error) run.error = error;
    else delete run.error;
    if (totalTokens !== undefined) {
      run.totalTokens = totalTokens;
      state.file.chainTokens = (state.file.chainTokens ?? 0) + totalTokens;
    }
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
    } else if (watch) {
      live.frame.recorded = false;
    }
    this.publish(live);
    this.hub.forgetRun(state.sessionId, run.id);
    this.live.delete(run.id);
    if (watch) {
      this.addSettled(run.id, {
        sessionId: state.sessionId,
        frame: this.buildFrame(live),
        request,
        ...(payload.error ? { recordedError: payload.error } : {}),
      });
      this.watchRecord(run.id);
    }

    if (recordId && followUps.length > 0) {
      const depth = nextChainDepth({
        kind: 'agent',
        chainDepth: run.chainDepth,
      });
      for (const agent of followUps) {
        this.enqueue(state, agent, recordId, depth);
      }
    }
    await this.persist(state).catch(() => {});
    this.pumpAgent(run.agentId);
    for (const agent of followUps) this.pumpAgent(agent.id);
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
   * create-sub-session.ts delivers to a parent that is no longer resident.
   * TODO(multi-agent): standalone (daemon-owned) chat sessions restore
   * through their own service, not `resumeSession`; not handled here.
   */
  private async appendRecord(
    sessionId: string,
    request: Parameters<SessionAgentRecordWriter['appendExternalRecord']>[1],
  ): Promise<SessionExternalRecordResponse> {
    try {
      return await this.bridge.appendExternalRecord(sessionId, request);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      await this.bridge.resumeSession({
        sessionId,
        workspaceCwd: this.workspaceCwd,
      });
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
   * `recorded: false`.
   */
  private watchRecord(runId: string): void {
    const settled = this.settled.get(runId);
    if (!settled?.request) return;
    const request = settled.request;
    const { sessionId } = settled;
    const startedAt = this.now();
    let delayMs = this.recordWatchMs;
    const check = async (): Promise<void> => {
      settled.timer = undefined;
      if (this.stopped || this.settled.get(runId) !== settled) return;
      let recordId: string | undefined;
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
      if (this.stopped || this.settled.get(runId) !== settled) return;
      if (recordId) {
        this.settled.delete(runId);
        const frame: SessionAgentRunFrame = {
          ...settled.frame,
          recorded: true,
          recordId,
        };
        if (settled.recordedError) frame.error = settled.recordedError;
        else delete frame.error;
        this.hub.publish(frame);
        this.hub.forgetRun(sessionId, runId);
        return;
      }
      if (this.now() - startedAt >= RECORD_WATCH_MAX_MS) return;
      delayMs = Math.min(delayMs * 2, RECORD_WATCH_MAX_INTERVAL_MS);
      schedule();
    };
    const schedule = () => {
      settled.timer = setTimeout(() => void check(), delayMs);
      settled.timer.unref?.();
    };
    schedule();
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
      author: live.author,
      status: live.run.status,
      ...(live.frame.steps ? { steps: [...live.frame.steps] } : {}),
    };
    if (position !== undefined) frame.queuePosition = position;
    else delete frame.queuePosition;
    return frame;
  }

  private publish(live: LiveRun): void {
    live.frame.status = live.run.status;
    live.frame.author = live.author;
    this.hub.publish(this.buildFrame(live));
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
  if (existing) void existing.dispose();
  const created = new SessionAgentOrchestrator(options);
  orchestrators.set(options.workspaceCwd, created);
  return created;
}

export async function disposeSessionAgentOrchestrator(
  workspaceCwd: string,
): Promise<void> {
  const existing = orchestrators.get(workspaceCwd);
  if (!existing) return;
  orchestrators.delete(workspaceCwd);
  await existing.dispose();
}

export async function disposeAllSessionAgentOrchestrators(): Promise<void> {
  const all = [...orchestrators.keys()];
  await Promise.all(all.map((cwd) => disposeSessionAgentOrchestrator(cwd)));
}
