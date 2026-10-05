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
 * Concurrency rule (plan §8-3): per (chat session, agent) at most one
 * executing run and at most one queued run (see run-queue.ts), so a native
 * session is never driven by two processes.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { getErrorMessage } from '@qwen-code/qwen-code-core/utils/errors.js';
import {
  isAgentAddressable,
  readWorkspaceAgents,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import type { WorkspaceAgent } from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  AGENT_INPUT_CHAR_BUDGET,
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
  nextChainDepth,
  normalizeAgentChainLimit,
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
import type { QwenAcpAdapterBridge } from './adapters/qwen-acp.js';
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

export interface SessionAgentMentionResult {
  /** uuid of the `agent_mention` record; empty while it is deferred. */
  recordId: string;
  /** The ACP child holds the record until the main-model turn settles. */
  deferred?: boolean;
  runs: SessionAgentRunSummary[];
}

export type HostAck =
  | { ok: true; duplicate?: boolean; leaseExpiresAt?: number }
  | { ok: false; reason: 'unknown_run' | 'lease_mismatch' };

export interface SessionAgentOrchestratorOptions {
  workspaceCwd: string;
  bridge: SessionAgentBridge;
  hub?: SessionAgentEventHub;
  /** `experimental.agentChainLimit` for this workspace, read per use. */
  chainLimit?: () => number;
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
  /**
   * The loopback URL of this daemon's per-run `session_send` endpoint
   * (`POST .../sessions/:sessionId/runs/:runId/send`). Undefined (or not
   * loopback) means local turns are not offered the `session_send` tool.
   */
  sessionSendUrl?: (sessionId: string, runId: string) => string | undefined;
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
  /**
   * Bearer token of this run's `session_send` endpoint (32 random bytes,
   * hex). Lives only in memory and only while the run is live.
   */
  sendToken?: string;
  /** Serializes `session_send` handling so records keep their order. */
  sendChain: Promise<void>;
  remote?: {
    hostId: string;
    program: SessionAgentProgram;
    lastSequence: number;
    decisions: HostPermissionDecision[];
  };
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

function chainLimitError(limit: number, names: string[]): string {
  return `Agent chain limit (${limit}) reached; not started: ${names
    .map((name) => `@${name}`)
    .join(', ')}.`;
}

export class SessionAgentOrchestrator {
  readonly workspaceCwd: string;
  readonly bridge: SessionAgentBridge;
  private readonly hub: SessionAgentEventHub;
  private readonly chainLimit: () => number;
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
    runId: string,
  ) => string | undefined;
  private readonly sessions = new Map<string, Promise<SessionState>>();
  /** States adopted by startup recovery; `session()` hands these out. */
  private readonly startupStates = new Map<string, SessionState>();
  private readonly live = new Map<string, LiveRun>();
  private readonly pendingPosts = new Map<string, PendingPost>();
  private readonly recovered: Promise<void>;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(options: SessionAgentOrchestratorOptions) {
    this.workspaceCwd = options.workspaceCwd;
    this.bridge = options.bridge;
    this.hub = options.hub ?? getSessionAgentEventHub(options.workspaceCwd);
    this.chainLimit = options.chainLimit ?? (() => 0);
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
    const runs = targets.agents.map((agent) =>
      this.enqueue(state, agent, triggerId, nextChainDepth({ kind: 'human' })),
    );
    // The runs are already queued in memory and the record is written, so a
    // failed save is logged (by persist) rather than reported as a refusal;
    // a local run re-saves before it starts and fails there if it cannot.
    await this.persist(state).catch(() => {});
    for (const agent of targets.agents) this.pump(state, agent.id);
    return {
      recordId: record.recordId,
      ...(record.deferred ? { deferred: true } : {}),
      runs,
    };
  }

  /** Cancels one run (queued or executing). False when it is not live. */
  async cancel(sessionId: string, runId: string): Promise<boolean> {
    const live = this.live.get(runId);
    if (!live || live.sessionId !== sessionId) return false;
    const state = await this.session(sessionId);
    await this.cancelLive(state, live);
    return true;
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
      if (
        !live.remote.decisions.some(
          (decision) => decision.requestId === requestId,
        )
      ) {
        live.remote.decisions.push({
          runId,
          attempt: live.run.attempts,
          requestId,
          optionId,
        });
      }
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
   * An agent of a live local run posted `text` with its `session_send` tool
   * (the MCP child calls the run's endpoint with the run's token). Resolves
   * once the post is recorded and routed; rejects with a SessionAgentError.
   */
  async postFromAgent(
    sessionId: string,
    runId: string,
    token: string,
    text: unknown,
  ): Promise<void> {
    this.assertRunning();
    const live = this.live.get(runId);
    // One answer for "no such run" and "wrong token": the route is not
    // behind the daemon bearer.
    if (
      !live ||
      live.sessionId !== sessionId ||
      live.remote ||
      !live.sendToken ||
      !tokensMatch(live.sendToken, token)
    ) {
      throw new SessionAgentError(
        401,
        'invalid_session_send_token',
        'Unknown run or invalid session_send token.',
      );
    }
    if (!isExecutingRun(live.run)) {
      throw new SessionAgentError(
        409,
        'run_not_running',
        'The run is not running.',
      );
    }
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > MAX_MENTION_TEXT_CHARS
    ) {
      throw new SessionAgentError(400, 'invalid_text', 'text is required.');
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
    const state = this.sessions.has(sessionId)
      ? await this.session(sessionId)
      : undefined;
    return [...this.live.values()]
      .filter((live) => live.sessionId === sessionId)
      .map((live) => this.buildFrame(live, state));
  }

  /** Stops every run in every session and the timers. Idempotent. */
  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const sessionIds = new Set(
      [...this.live.values()].map((live) => live.sessionId),
    );
    for (const sessionId of sessionIds) {
      await this.stopAll(sessionId).catch(() => []);
    }
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
    for (const live of [...this.live.values()]) {
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
      const program = programForAgent(agent, programs);
      if (!program) continue;
      const state = await this.session(live.sessionId);
      if (run.status !== 'queued') continue;
      if (nextRunnable(state.file.runs, agent.id)?.id !== run.id) continue;

      // Claim synchronously: a concurrent pickup sees `running` and skips.
      const now = this.now();
      run.status = 'running';
      run.attempts += 1;
      run.startedAt = now;
      delete run.error;
      const lease = {
        hostId,
        leaseId: randomUUID(),
        attempt: run.attempts,
        expiresAt: now + this.leaseMs,
      };
      run.lease = lease;
      live.author = authorFor(agent, hostId, program);
      live.remote = { hostId, program, lastSequence: 0, decisions: [] };
      live.frame.activityAt = now;
      try {
        const binding = state.file.bindings[agent.id] ?? { agentId: agent.id };
        const records = await this.loadRecords(live.sessionId);
        const input = buildAgentInput({
          records,
          readThroughRecordId: binding.readThroughRecordId,
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
        const nativeSessionId =
          binding.runtimeId === hostId ? binding.nativeSessionId : undefined;
        await this.persist(state);
        this.publish(live, state);
        return {
          protocol: HOST_PROTOCOL_VERSION,
          sessionId: live.sessionId,
          runId: run.id,
          attempt: lease.attempt,
          leaseId: lease.leaseId,
          // Renewals before this returns are not reflected; fine for a lease
          // this fresh.
          leaseExpiresAt: lease.expiresAt,
          // TODO(multi-agent): a linked definition (`agentType`) is not
          // resolved for remote turns; only the record's own instructions
          // and model travel.
          agent: {
            ...live.author,
            ...(agent.instructions ? { instructions: agent.instructions } : {}),
            ...(agent.model ? { model: agent.model } : {}),
          },
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

  /** Extends a Host's lease on a run it is executing. */
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

  /** Folds an ordered event batch from a Host, like a local turn's events. */
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
    const remote = live.remote!;
    if (batch.sequence <= remote.lastSequence) {
      return { ok: true, duplicate: true };
    }
    // TODO(multi-agent): a gap in `sequence` is accepted as-is; a Host that
    // dropped a batch loses those deltas from the live frame only (the final
    // text comes with the result).
    remote.lastSequence = batch.sequence;
    const lease = live.run.lease!;
    lease.expiresAt = this.now() + this.leaseMs;
    void this.session(live.sessionId).then((state) => {
      for (const event of batch.events) this.applyEvent(state, live, event);
    });
    return { ok: true, leaseExpiresAt: lease.expiresAt };
  }

  /** A Host finished a turn. */
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
   * belong to a previous daemon (one daemon per workspace), so they are
   * closed: local ones `failed` with "daemon restarted", leased remote ones
   * `offline`. Queued runs of managed-host agents stay queued for pickup when
   * `roster` is given; every other queued run is failed too.
   * TODO(multi-agent): offer "retry" on runs failed by a restart.
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
    const now = this.now();
    let changed = false;
    for (const run of file.runs) {
      if (isTerminalSessionAgentRunStatus(run.status)) continue;
      if (this.live.has(run.id)) continue;
      const agent = roster?.find((candidate) => candidate.id === run.agentId);
      if (
        run.status === 'queued' &&
        agent &&
        agent.execution?.mode === 'managed-host'
      ) {
        this.live.set(run.id, this.newLive(file.sessionId, run, agent));
        continue;
      }
      run.status = run.lease ? 'offline' : 'failed';
      run.error = SESSION_AGENT_RESTARTED_ERROR;
      run.endedAt = now;
      delete run.lease;
      changed = true;
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
      if (
        file.runs.every((run) => isTerminalSessionAgentRunStatus(run.status))
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
    this.publish(live, state);
    return {
      runId: outcome.run.id,
      agentId: agent.id,
      status: outcome.run.status,
    };
  }

  /** Starts the agent's next queued run if it is local and idle. */
  private pump(state: SessionState, agentId: string): void {
    if (this.stopped) return;
    const run = nextRunnable(state.file.runs, agentId);
    if (!run) return;
    const live = this.live.get(run.id);
    if (!live) return;
    // Remote runs wait for a Host's pickup.
    if (live.author.runtimeId !== LOCAL_SESSION_AGENT_RUNTIME_ID) return;
    void this.runLocal(state, live).catch((error) => {
      writeStderrLine(
        `qwen serve: session agent run ${run.id} crashed: ${getErrorMessage(error)}`,
      );
    });
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
    this.publish(live, state);

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
      const binding = state.file.bindings[agent.id] ?? { agentId: agent.id };
      const records = await this.loadRecords(state.sessionId);
      const input = buildAgentInput({
        records,
        readThroughRecordId: binding.readThroughRecordId,
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
      live.sendToken = randomBytes(32).toString('hex');
      const sendUrl = this.sessionSendUrl?.(state.sessionId, run.id);
      const sessionSendServer =
        sendUrl && isLoopbackUrl(sendUrl)
          ? buildSessionSendServer(sendUrl, live.sendToken)
          : undefined;
      const adapter = this.adapterFor(program, {
        workspaceCwd: this.workspaceCwd,
        bridge: this.bridge,
        agentId: agent.id,
        permissionVoteContext: (requestId) => live.voterContexts.get(requestId),
      });
      const result = await adapter.runTurn({
        prompt: input.prompt,
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(nativeSessionId ? { nativeSessionId } : {}),
        cwd: this.workspaceCwd,
        // The qwen adapter cannot use it yet (see qwen-acp.ts).
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
      };
      // TODO(multi-agent): on `resumeRejected` the native session is new and
      // has none of the earlier context; consider resetting the read cursor
      // so the next turn gets a longer history.
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
    this.publish(live, state);
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
      this.publish(live, state);
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
      this.publish(live, state);
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
    for (const agent of agents) this.enqueue(state, agent, recordId, depth);
    void this.persist(state)
      .catch(() => {})
      .then(() => {
        for (const agent of agents) this.pump(state, agent.id);
      });
    return undefined;
  }

  private async cancelLive(state: SessionState, live: LiveRun): Promise<void> {
    const { run } = live;
    if (isTerminalSessionAgentRunStatus(run.status)) return;
    if (run.status === 'queued') {
      // Never started: nothing to write into the transcript.
      // TODO(multi-agent): the client drops a terminal frame with no record
      // on its own; confirm with the web-shell side.
      run.status = 'cancelled';
      run.endedAt = this.now();
      this.live.delete(run.id);
      this.publish(live, state);
      this.hub.forgetRun(state.sessionId, run.id);
      await this.persist(state).catch(() => {});
      return;
    }
    if (live.remote) {
      // TODO(multi-agent): tell the Host to stop (today it learns from the
      // lease mismatch on its next events / renew call).
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
    delete live.sendToken;
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
        if (followUps.length > 0 && !isWithinChainLimit(depth, limit)) {
          error = chainLimitError(
            limit,
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
    let recordId: string | undefined;
    const recordKey = `agent:${run.id}`;
    try {
      const written = await this.appendRecord(state.sessionId, {
        kind: 'agent_message',
        recordKey,
        modelText: formatAgentMessageModelText(payload),
        payload,
      });
      recordId = triggerIdFor(written, recordKey);
      if (written.deferred && displayText.trim()) {
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
    } catch (writeError) {
      // TODO(multi-agent): retry the record write; today the reply survives
      // only in the run frame and the agent's native session.
      error = `Could not record the reply: ${recordWriteError(writeError).message}`;
      followUps = [];
    }

    const binding = state.file.bindings[run.agentId] ?? {
      agentId: run.agentId,
    };
    if (nativeSessionId) {
      binding.nativeSessionId = nativeSessionId;
      binding.runtimeId = runtimeId;
    }
    // Advance the cursor only when the agent answered: a failed or cancelled
    // run's input is offered again next time.
    if (outcome.status === 'completed' && live.lastRecordId) {
      binding.readThroughRecordId = live.lastRecordId;
    }
    state.file.bindings[run.agentId] = binding;
    if (error) run.error = error;
    else delete run.error;
    if (totalTokens !== undefined) run.totalTokens = totalTokens;
    delete run.lease;
    state.file.runs = trimTerminalRuns(state.file.runs);

    live.frame.error = error;
    if (!error) delete live.frame.error;
    delete live.frame.permission;
    this.publish(live, state);
    this.hub.forgetRun(state.sessionId, run.id);
    this.live.delete(run.id);

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
    this.pump(state, run.agentId);
    for (const agent of followUps) this.pump(state, agent.id);
  }

  private addPendingPost(post: PendingPost): void {
    this.pendingPosts.set(`${post.sessionId}\u0000${post.id}`, post);
  }

  /**
   * Deferred posts another agent should see, dropping those that have since
   * landed in `records` (matched by kind, text, author and run).
   * TODO(multi-agent): match by recordKey once records carry it.
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
  ):
    | { ok: true; live: LiveRun }
    | { ok: false; reason: 'unknown_run' | 'lease_mismatch' } {
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

  private buildFrame(
    live: LiveRun,
    state: SessionState | undefined,
  ): SessionAgentRunFrame {
    const position = state
      ? queuePosition(state.file.runs, live.run)
      : undefined;
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

  private publish(live: LiveRun, state: SessionState): void {
    live.frame.status = live.run.status;
    live.frame.author = live.author;
    this.hub.publish(this.buildFrame(live, state));
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
