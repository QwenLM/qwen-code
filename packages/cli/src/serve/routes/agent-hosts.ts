/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Coordinator side of the Agent Host protocol (v2).
 *
 * A Host (a remote `qwen serve` that joined this workspace) talks to these
 * routes over outbound HTTP: enroll once, then heartbeat (presence, program
 * probe, lease renewal and cancellation, permission decisions), long-poll
 * pickup for a session turn, long-poll decisions while a turn waits on a
 * person, stream ordered event batches, and post the turn's result. Work
 * comes from the workspace's session-agent orchestrator (its remote queue);
 * these handlers only authenticate, validate and translate.
 */

import express from 'express';
import type { Application, Request, RequestHandler, Response } from 'express';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  authenticateAgentHost,
  enrollAgentHost,
  heartbeatAgentHost,
  normalizeHostProgramProbes,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import {
  AGENT_HOST_CREDENTIAL_REJECTED,
  AGENT_HOST_REPLACEMENT_REQUIRED,
  hostAvailablePrograms,
  type AgentHostView,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import {
  HOST_PROTOCOL_VERSION,
  type AgentAdapterEvent,
  type AgentAdapterTurnResult,
  type HostLeaseStatus,
  type HostProgramProbe,
  type HostTurnAssignment,
  type HostTurnEventBatch,
  type HostTurnResult,
  type SessionAgentPermissionPrompt,
  type SessionAgentProgram,
  type SessionAgentStep,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { isTerminalSessionAgentRunStatus } from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';
import type {
  RateLimiterInstance,
  RateLimitTierConfig,
} from '../rate-limit.js';
import { getSessionAgentOrchestrator } from '../session-agents/orchestrator.js';
import { ensureSessionAgentOrchestratorForRuntime } from './session-agents.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import { createHostProgramAgentEnsurer } from '../agent-host-program-agents.js';
import {
  decisionsForAwaited,
  type HostAwaitedPermission,
} from '../agent-host-decisions.js';

const debugLogger = createDebugLogger('AGENT_HOSTS');

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body : {};
}

/** proper-lockfile's lock contention: transient busy, never a refusal. */
function isStoreBusy(error: unknown): boolean {
  return (error as { code?: string }).code === 'ELOCKED';
}

function runtimeFor(registry: WorkspaceRegistry, workspaceId: string) {
  return registry.list().find((runtime) => runtime.workspaceId === workspaceId);
}

function hostSecret(req: Request): string | undefined {
  const match = /^AgentHost ([A-Za-z0-9_-]{32,})$/.exec(
    req.get('authorization') ?? '',
  );
  return match?.[1];
}

function readWaitMs(value: unknown): number | undefined {
  if (value === undefined) return 25_000;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 25_000
    ? value
    : undefined;
}

/** Same bounds the orchestrator keeps for a live frame / final record. */
const MAX_OUTPUT_TEXT = 262_144;
const MAX_ERROR_TEXT = 4_096;
const MAX_EVENT_TEXT = 262_144;
const MAX_EVENTS_PER_BATCH = 2_000;
const MAX_RUNS_PER_HEARTBEAT = 64;
const MAX_ID = 256;
/** Backstop between pickup scans; queued work wakes the poll sooner. */
const PICKUP_MAX_INTERVAL_MS = 5_000;
/** Backstop between decision scans; a recorded decision wakes the poll. */
const DECISIONS_INTERVAL_MS = 1_000;
const MAX_AWAITED = 16;
const MAX_SEEN_PER_AWAITED = 8;
const MAX_DECISION_KEY = 300;
/** A response that neither finished nor closed by then is given up on. */
const DELIVERY_TIMEOUT_MS = 30_000;

/**
 * Per-Host budget for everything after authentication (heartbeat, pickup,
 * decisions, events, result), keyed by host id. A Host flushes events every
 * 250 ms for each of up to 4 turns (~960 a minute) plus a heartbeat every
 * 5 s; this leaves 2.5x headroom. The daemon's general `read` tier (120 a
 * minute per source) would throttle one busy Host.
 */
export const AGENT_HOST_RATE_LIMIT: RateLimitTierConfig = {
  windowMs: 60_000,
  max: 2_400,
};

/**
 * Reads an orchestrator ack, whichever way it says "cancelled": a refusal
 * with `reason: 'cancelled'`, or a `cancelled` flag.
 */
export function readHostAck(ack: unknown): {
  ok: boolean;
  reason?: string;
  cancelled: boolean;
} {
  const loose = (typeof ack === 'object' && ack !== null ? ack : {}) as {
    ok?: unknown;
    reason?: unknown;
    cancelled?: unknown;
  };
  const cancelled = loose.cancelled === true || loose.reason === 'cancelled';
  return {
    // A cancelled run is never ok, whatever else the ack says.
    ok: loose.ok === true && !cancelled,
    ...(typeof loose.reason === 'string' ? { reason: loose.reason } : {}),
    cancelled,
  };
}

/** The 409 body for a refused ack; `cancelled: true` tells the Host to stop. */
function refusal(ack: ReturnType<typeof readHostAck>): Record<string, unknown> {
  return {
    error: ack.reason ?? (ack.cancelled ? 'cancelled' : 'lease_mismatch'),
    ...(ack.cancelled ? { cancelled: true } : {}),
  };
}

/**
 * Orchestrator hook: hands a turn that was claimed for `hostId` but never
 * reached it back to the queue (the next pickup is attempt + 1). Looked up
 * at run time so this compiles with and without it.
 */
interface HostAssignmentRelease {
  releaseHostAssignment(
    hostId: string,
    ref: Pick<
      HostTurnAssignment,
      'sessionId' | 'runId' | 'attempt' | 'leaseId'
    >,
  ): unknown;
}

function releaseAssignment(
  orchestrator: object,
  hostId: string,
  assignment: HostTurnAssignment,
): void {
  const release = (orchestrator as Partial<HostAssignmentRelease>)
    .releaseHostAssignment;
  if (typeof release !== 'function') {
    debugLogger.warn(
      `Agent Host ${hostId} did not receive run ${assignment.runId}; it ends offline when its lease runs out.`,
    );
    return;
  }
  const ref = {
    sessionId: assignment.sessionId,
    runId: assignment.runId,
    attempt: assignment.attempt,
    leaseId: assignment.leaseId,
  };
  try {
    void Promise.resolve(release.call(orchestrator, hostId, ref)).catch(
      (error: unknown) =>
        debugLogger.warn('Could not release an undelivered assignment:', error),
    );
  } catch (error) {
    debugLogger.warn('Could not release an undelivered assignment:', error);
  }
}

/**
 * Writes `body` and resolves true once the response is flushed to the
 * socket, false when the connection closed or failed first. `finish` means
 * handed to the kernel, not received: a connection lost after that still
 * falls to lease expiry.
 */
function deliver(res: Response, body: unknown): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const settle = (delivered: boolean) => {
      clearTimeout(timer);
      res.off('finish', onFinish);
      res.off('close', onClose);
      res.off('error', onError);
      resolve(delivered);
    };
    const onFinish = () => settle(true);
    const onClose = () => settle(res.writableFinished);
    const onError = () => settle(false);
    res.once('finish', onFinish);
    res.once('close', onClose);
    res.once('error', onError);
    const timer = setTimeout(
      () => settle(res.writableFinished),
      DELIVERY_TIMEOUT_MS,
    );
    timer.unref?.();
    try {
      res.json(body);
    } catch {
      settle(false);
    }
  });
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
  );
}

function isAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000
  );
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/**
 * Display text (a title, a preview, an option label) is clipped, not refused:
 * one refused event sinks its whole batch, and a lost `permission_request`
 * leaves the turn waiting on a question nobody is asked.
 */
const MAX_TITLE = 1_200;
const MAX_LABEL = 256;
const MAX_INPUT_PREVIEW = 16_384;

function clipped(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function readStep(value: unknown): SessionAgentStep | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, status } = value as Record<string, unknown>;
  const title = clipped((value as Record<string, unknown>)['title'], MAX_TITLE);
  if (
    !isId(id) ||
    title === undefined ||
    (status !== 'running' && status !== 'completed' && status !== 'failed')
  ) {
    return undefined;
  }
  return { id, title, status };
}

const PERMISSION_OPTION_KINDS = new Set([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

function readPermissionPrompt(
  value: unknown,
): SessionAgentPermissionPrompt | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const { requestId, options } = raw;
  const title = clipped(raw['title'], MAX_TITLE);
  const toolName = clipped(raw['toolName'], MAX_LABEL);
  const inputPreview = clipped(raw['inputPreview'], MAX_INPUT_PREVIEW);
  if (
    !isId(requestId) ||
    title === undefined ||
    (raw['toolName'] !== undefined && toolName === undefined) ||
    (raw['inputPreview'] !== undefined && inputPreview === undefined) ||
    !Array.isArray(options) ||
    options.length === 0 ||
    options.length > 16
  ) {
    return undefined;
  }
  const parsed: SessionAgentPermissionPrompt['options'] = [];
  for (const option of options) {
    if (typeof option !== 'object' || option === null) return undefined;
    const { optionId, kind } = option as Record<string, unknown>;
    const name = clipped(
      (option as Record<string, unknown>)['name'],
      MAX_LABEL,
    );
    if (
      !isId(optionId) ||
      name === undefined ||
      typeof kind !== 'string' ||
      !PERMISSION_OPTION_KINDS.has(kind)
    ) {
      return undefined;
    }
    parsed.push({
      optionId,
      name,
      kind: kind as SessionAgentPermissionPrompt['options'][number]['kind'],
    });
  }
  return {
    requestId,
    title,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(inputPreview !== undefined ? { inputPreview } : {}),
    options: parsed,
  };
}

/** One adapter event from a Host, validated field by field. */
export function readHostEvent(value: unknown): AgentAdapterEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { type, text, nativeSessionId, step, prompt, requestId, totalTokens } =
    value as Record<string, unknown>;
  switch (type) {
    case 'native_session':
      return isId(nativeSessionId)
        ? { type: 'native_session', nativeSessionId }
        : undefined;
    case 'text_delta':
      return boundedString(text, MAX_EVENT_TEXT)
        ? { type: 'text_delta', text }
        : undefined;
    case 'thought_delta':
      return boundedString(text, MAX_EVENT_TEXT)
        ? { type: 'thought_delta', text }
        : undefined;
    case 'session_send':
      return boundedString(text, MAX_EVENT_TEXT) && text.trim()
        ? { type: 'session_send', text }
        : undefined;
    case 'step': {
      const parsed = readStep(step);
      return parsed ? { type: 'step', step: parsed } : undefined;
    }
    case 'permission_request': {
      const parsed = readPermissionPrompt(prompt);
      return parsed
        ? { type: 'permission_request', prompt: parsed }
        : undefined;
    }
    case 'permission_resolved':
      return isId(requestId)
        ? { type: 'permission_resolved', requestId }
        : undefined;
    case 'usage':
      return isTokenCount(totalTokens)
        ? { type: 'usage', totalTokens }
        : undefined;
    default:
      return undefined;
  }
}

export function readHostEventBatch(
  input: Record<string, unknown>,
): HostTurnEventBatch | undefined {
  const { sessionId, runId, attempt, leaseId, sequence, events } = input;
  if (
    !isId(sessionId) ||
    !isId(runId) ||
    !isAttempt(attempt) ||
    !isId(leaseId) ||
    !isAttempt(sequence) ||
    !Array.isArray(events) ||
    events.length > MAX_EVENTS_PER_BATCH
  ) {
    return undefined;
  }
  const parsed: AgentAdapterEvent[] = [];
  for (const raw of events) {
    const event = readHostEvent(raw);
    if (!event) return undefined;
    parsed.push(event);
  }
  return { sessionId, runId, attempt, leaseId, sequence, events: parsed };
}

export function readHostTurnResult(
  input: Record<string, unknown>,
): HostTurnResult | undefined {
  const { sessionId, runId, attempt, leaseId, result } = input;
  if (
    !isId(sessionId) ||
    !isId(runId) ||
    !isAttempt(attempt) ||
    !isId(leaseId) ||
    typeof result !== 'object' ||
    result === null
  ) {
    return undefined;
  }
  const {
    status,
    outputText,
    error,
    nativeSessionId,
    resumeRejected,
    totalTokens,
  } = result as Record<string, unknown>;
  if (
    (status !== 'completed' && status !== 'failed' && status !== 'cancelled') ||
    !boundedString(outputText, MAX_OUTPUT_TEXT) ||
    (error !== undefined && typeof error !== 'string') ||
    (nativeSessionId !== undefined && !isId(nativeSessionId)) ||
    (resumeRejected !== undefined && typeof resumeRejected !== 'boolean') ||
    (totalTokens !== undefined && !isTokenCount(totalTokens))
  ) {
    return undefined;
  }
  const turn: AgentAdapterTurnResult = {
    status,
    outputText,
    ...(typeof error === 'string' && error
      ? { error: error.slice(0, MAX_ERROR_TEXT) }
      : {}),
    ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    ...(resumeRejected !== undefined ? { resumeRejected } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return { sessionId, runId, attempt, leaseId, result: turn };
}

function readLeaseRefs(
  value: unknown,
): Array<{ runId: string; attempt: number; leaseId: string }> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RUNS_PER_HEARTBEAT) {
    return undefined;
  }
  const refs: Array<{ runId: string; attempt: number; leaseId: string }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { runId, attempt, leaseId } = entry as Record<string, unknown>;
    if (!isId(runId) || !isAttempt(attempt) || !isId(leaseId)) {
      return undefined;
    }
    refs.push({ runId, attempt, leaseId });
  }
  return refs;
}

/** `awaiting` of a decisions poll: the requests a Host waits on. */
export function readAwaitedPermissions(
  value: unknown,
): HostAwaitedPermission[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_AWAITED) return undefined;
  const awaited: HostAwaitedPermission[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { runId, attempt, requestId, seen } = entry as Record<
      string,
      unknown
    >;
    const keys = seen ?? [];
    if (
      !isId(runId) ||
      !isAttempt(attempt) ||
      !isId(requestId) ||
      !Array.isArray(keys) ||
      keys.length > MAX_SEEN_PER_AWAITED ||
      !keys.every((key) => boundedString(key, MAX_DECISION_KEY))
    ) {
      return undefined;
    }
    awaited.push({ runId, attempt, requestId, seen: keys as string[] });
  }
  return awaited;
}

/** Programs a Host may be handed turns for: v2 Hosts only. */
function pickupPrograms(host: AgentHostView): SessionAgentProgram[] {
  // A v1 Host cannot execute a v2 assignment; handing it one would hold the
  // lease until it rots to `offline`. Its heartbeat is refused (426), so it
  // goes offline; this keeps a stale record from being handed work anyway.
  if (host.protocol !== HOST_PROTOCOL_VERSION) return [];
  return hostAvailablePrograms(host);
}

export function registerAgentHostTransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
  rateLimiter: Pick<RateLimiterInstance, 'checkRate'> | undefined,
  isEnabledFor: (workspaceCwd: string) => boolean,
  /**
   * Budget per authenticated Host (see {@link AGENT_HOST_RATE_LIMIT}); its
   * `read` tier is used. Undefined leaves authenticated Host traffic
   * unthrottled.
   */
  hostRateLimiter?: Pick<RateLimiterInstance, 'checkRate'>,
): void {
  const json = express.json({ limit: '16kb' });
  const ensureProgramAgents = createHostProgramAgentEnsurer();
  const requireEnabled = (workspaceCwd: string, res: Response): boolean => {
    if (isEnabledFor(workspaceCwd)) return true;
    res.status(404).json({ error: 'Workspace not found.' });
    return false;
  };
  const sourceOf = (req: Request) =>
    req.ip || req.socket.remoteAddress || 'unknown';
  const tooMany = (res: Response, tier: string) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'rate_limit_exceeded',
      tier,
    });
  };
  /**
   * A credential rejection. Failed attempts are throttled per source (the
   * per-Host budget only applies once a Host has proved who it is), so
   * guessing secrets stays bounded.
   */
  const rejectCredential = (req: Request, res: Response) => {
    if (
      rateLimiter &&
      !rateLimiter.checkRate(
        `agent-host:auth-failure:${sourceOf(req)}`,
        'mutation',
      )
    ) {
      tooMany(res, 'mutation');
      return;
    }
    res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
  };
  /**
   * A refusal before the Host has proved who it is (a malformed request, an
   * unknown, untrusted or collaboration-disabled workspace, an unsupported
   * protocol). Charged per source like a failed credential, so neither the
   * requests nor the workspace probing their answers allow are unlimited.
   * An authenticated Host only ever spends its own budget (`allowHost`).
   */
  const refuse = (req: Request, res: Response, send: () => void) => {
    if (
      rateLimiter &&
      !rateLimiter.checkRate(`agent-host:refused:${sourceOf(req)}`, 'read')
    ) {
      tooMany(res, 'read');
      return;
    }
    send();
  };
  /** The workspace a Host route names; undefined once refused. */
  const hostRuntime = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const runtime = runtimeFor(
      workspaceRegistry,
      String(req.params['workspaceId']),
    );
    if (runtime && !runtime.trusted) {
      refuse(req, res, () => sendUntrustedWorkspaceResponse(res));
      return undefined;
    }
    if (!runtime || !isEnabledFor(runtime.workspaceCwd)) {
      refuse(req, res, () =>
        res.status(404).json({ error: 'Workspace not found.' }),
      );
      return undefined;
    }
    return runtime;
  };
  /** The authenticated Host's own budget; false (and 429 sent) when spent. */
  const allowHost = (req: Request, res: Response): boolean => {
    if (
      !hostRateLimiter ||
      hostRateLimiter.checkRate(
        `agent-host:${String(req.params['workspaceId'])}:${String(req.params['hostId'])}`,
        'read',
      )
    ) {
      return true;
    }
    tooMany(res, 'agent-host');
    return false;
  };

  // Runs before the large-body routes parse anything, so a request with a
  // wrong secret never gets 2 MB read on its behalf. It is also the only place
  // those routes check trust, the collaboration setting and the credential:
  // the handlers below resolve the workspace again just to read its cwd.
  const authenticated: RequestHandler = async (req, res, next) => {
    const runtime = hostRuntime(req, res);
    if (!runtime) return;
    const secret = hostSecret(req);
    if (
      !secret ||
      !(await authenticateAgentHost(
        runtime.workspaceCwd,
        String(req.params['hostId']),
        secret,
      ))
    ) {
      rejectCredential(req, res);
      return;
    }
    if (!allowHost(req, res)) return;
    next();
  };

  // Enrollment is throttled per source before anything else. Every other
  // route is throttled per Host once it authenticates (`allowHost`), and its
  // refusals before that per source (`refuse`, `rejectCredential`).
  app.use('/agent-hosts/enroll', (req, res, next) => {
    if (
      rateLimiter &&
      !rateLimiter.checkRate(
        `agent-host:enrollment:${sourceOf(req)}`,
        'mutation',
      )
    ) {
      tooMany(res, 'mutation');
      return;
    }
    next();
  });

  app.post('/agent-hosts/enroll', json, async (req: Request, res: Response) => {
    const input = body(req);
    const workspaceId = input['workspaceId'];
    const token = input['token'];
    const name = input['name'];
    const workspaceCwd = input['workspaceCwd'];
    const providers = input['providers'];
    if (
      typeof workspaceId !== 'string' ||
      typeof token !== 'string' ||
      typeof name !== 'string' ||
      typeof workspaceCwd !== 'string' ||
      !Array.isArray(providers) ||
      !providers.every((provider) => typeof provider === 'string')
    ) {
      res.status(400).json({ error: 'Invalid Agent Host enrollment.' });
      return;
    }
    const runtime = runtimeFor(workspaceRegistry, workspaceId);
    if (!runtime) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
    if (!requireEnabled(runtime.workspaceCwd, res)) return;
    try {
      const enrolled = await enrollAgentHost(runtime.workspaceCwd, {
        token,
        name,
        workspaceCwd,
        providers,
      });
      res.status(201).json(enrolled);
    } catch {
      // Unauthenticated: the store's message can name file paths.
      res.status(401).json({ error: 'Agent Host enrollment refused.' });
    }
  });

  /**
   * `{workspaceCwd, providers, programs?, protocol?, enrollmentToken?, runs?}`
   * → `{host, leases: HostLeaseStatus[], decisions}`. Records presence and
   * the program probe, renews each listed lease (or reports it cancelled),
   * hands back pending permission decisions, and adds an agent per newly
   * offered program.
   */
  app.post(
    '/agent-hosts/:workspaceId/:hostId/heartbeat',
    json,
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const secret = hostSecret(req);
      const input = body(req);
      const workspaceCwd = input['workspaceCwd'];
      const providers = input['providers'] ?? [];
      const enrollmentToken = input['enrollmentToken'];
      const rawPrograms = input['programs'];
      const rawProtocol = input['protocol'];
      const protocol = isAttempt(rawProtocol) ? rawProtocol : undefined;
      if (
        !workspaceId ||
        !hostId ||
        !secret ||
        typeof workspaceCwd !== 'string' ||
        !Array.isArray(providers) ||
        !providers.every((provider) => typeof provider === 'string') ||
        (enrollmentToken !== undefined && typeof enrollmentToken !== 'string')
      ) {
        refuse(req, res, () =>
          res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED }),
        );
        return;
      }
      const programs: HostProgramProbe[] | undefined =
        rawPrograms === undefined
          ? undefined
          : normalizeHostProgramProbes(rawPrograms);
      const runs = readLeaseRefs(input['runs']);
      if (
        (rawPrograms !== undefined && programs === undefined) ||
        (rawProtocol !== undefined && protocol === undefined) ||
        runs === undefined
      ) {
        refuse(req, res, () =>
          res.status(400).json({ error: 'Invalid Agent Host heartbeat.' }),
        );
        return;
      }
      // Refused before the store records it, so an older (v1, no
      // `protocol`) Host goes offline in the roster and says why, instead
      // of showing online while it can never be handed a turn. Not a 401:
      // that would read as a revocation and delete the Host's credential.
      if (protocol !== HOST_PROTOCOL_VERSION) {
        refuse(req, res, () =>
          res.status(426).json({
            error: `This coordinator speaks Agent Host protocol ${HOST_PROTOCOL_VERSION}; this Host speaks ${protocol ?? 1}. Upgrade qwen on the older side.`,
          }),
        );
        return;
      }
      const runtime = hostRuntime(req, res);
      if (!runtime) return;
      try {
        const host = await heartbeatAgentHost(
          runtime.workspaceCwd,
          hostId,
          secret,
          {
            workspaceCwd,
            providers,
            ...(typeof enrollmentToken === 'string' ? { enrollmentToken } : {}),
            ...(programs !== undefined ? { programs } : {}),
            ...(protocol !== undefined ? { protocol } : {}),
          },
        );
        if (!host) {
          rejectCredential(req, res);
          return;
        }
        if (!allowHost(req, res)) return;
        // No orchestrator means no live runs in this daemon (it restarted or
        // the workspace's agents are stopping): every lease is gone.
        const orchestrator =
          ensureSessionAgentOrchestratorForRuntime(runtime) ??
          getSessionAgentOrchestrator(runtime.workspaceCwd);
        // Startup recovery re-adopts leased runs; renewing before it ends
        // would answer `unknown_run` and make the Host drop a live turn.
        await orchestrator?.ready();
        const leases = runs.map((run): HostLeaseStatus => {
          const ack = readHostAck(
            orchestrator?.renewLease(
              hostId,
              run.runId,
              run.attempt,
              run.leaseId,
            ),
          );
          return {
            runId: run.runId,
            ok: ack.ok,
            // The person stopped it: the Host aborts the turn, no result.
            ...(ack.cancelled ? { cancelled: true } : {}),
          };
        });
        if (host.protocol === HOST_PROTOCOL_VERSION) {
          try {
            const added = await ensureProgramAgents(runtime.workspaceCwd, host);
            if (added.length > 0) {
              getSessionAgentEventHub(runtime.workspaceCwd).publish({
                type: 'changed',
                scope: 'agents',
              });
            }
          } catch (error) {
            // Retried on the next heartbeat (the ensurer only remembers
            // programs it finished).
            debugLogger.warn('Could not add agents for Agent Host:', error);
          }
        }
        res.json({
          host,
          leases,
          decisions: orchestrator?.decisionsForHost(hostId) ?? [],
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === AGENT_HOST_REPLACEMENT_REQUIRED
        ) {
          res.status(409).json({ error: AGENT_HOST_REPLACEMENT_REQUIRED });
          return;
        }
        if (isStoreBusy(error)) {
          res.status(503).json({ error: 'Agent Host store busy.' });
          return;
        }
        refuse(req, res, () =>
          res.status(400).json({ error: 'Agent Host heartbeat refused.' }),
        );
      }
    },
  );

  /**
   * `{waitMs ≤ 25000}` → `{assignment: HostTurnAssignment}` or 204. Long
   * polls; a run frame that queues or ends work (or a roster change) wakes
   * the poll early, with a slow backstop scan in between.
   */
  app.post(
    '/agent-hosts/:workspaceId/:hostId/pickup',
    json,
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const secret = hostSecret(req);
      const waitMs = readWaitMs(body(req)['waitMs']);
      if (!workspaceId || !hostId || !secret) {
        refuse(req, res, () =>
          res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED }),
        );
        return;
      }
      if (waitMs === undefined) {
        refuse(req, res, () =>
          res.status(400).json({ error: 'Invalid Agent Host pickup.' }),
        );
        return;
      }
      const runtime = hostRuntime(req, res);
      if (!runtime) return;
      let wake: (() => void) | undefined;
      const unsubscribe = getSessionAgentEventHub(
        runtime.workspaceCwd,
      ).subscribe((frame) => {
        // Text deltas are the bulk of the traffic and never make work
        // runnable; a queued run, a run ending (the next queued one for that
        // agent becomes runnable) or a roster change can.
        if (
          frame.type !== 'run' ||
          frame.status === 'queued' ||
          isTerminalSessionAgentRunStatus(frame.status)
        ) {
          wake?.();
        }
      });
      const onClose = () => wake?.();
      req.on('close', onClose);
      try {
        const deadline = Date.now() + waitMs;
        let pollIntervalMs = 250;
        let counted = false;
        for (;;) {
          // A Host that hung up must not have a run claimed for it here.
          if (req.socket.destroyed || res.writableEnded) return;
          if (runtimeFor(workspaceRegistry, workspaceId) !== runtime) {
            res.status(404).json({ error: 'Workspace not found.' });
            return;
          }
          if (!requireEnabled(runtime.workspaceCwd, res)) return;
          const host = await authenticateAgentHost(
            runtime.workspaceCwd,
            hostId,
            secret,
          );
          if (!host) {
            rejectCredential(req, res);
            return;
          }
          // One request, one unit of the Host's budget, however often the
          // poll rescans.
          if (!counted) {
            counted = true;
            if (!allowHost(req, res)) return;
          }
          if (req.socket.destroyed || res.writableEnded) return;
          const programs = pickupPrograms(host);
          const orchestrator =
            ensureSessionAgentOrchestratorForRuntime(runtime) ??
            getSessionAgentOrchestrator(runtime.workspaceCwd);
          await orchestrator?.ready();
          const assignment =
            orchestrator && programs.length > 0
              ? await orchestrator.pickupForHost(hostId, programs)
              : undefined;
          if (assignment) {
            // A Host that hung up while the turn was being claimed, or a
            // write that fails, gives the turn straight back to the queue
            // instead of holding it until its lease (60 s) runs out.
            const delivered =
              !req.socket.destroyed &&
              !res.writableEnded &&
              !res.destroyed &&
              (await deliver(res, { assignment }));
            if (!delivered && orchestrator) {
              releaseAssignment(orchestrator, hostId, assignment);
            }
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            res.status(204).end();
            return;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              resolve,
              Math.min(pollIntervalMs, remaining),
            );
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
          pollIntervalMs = Math.min(pollIntervalMs * 2, PICKUP_MAX_INTERVAL_MS);
        }
      } catch (error) {
        // The store's message can name coordinator-side paths, so it stays
        // off the wire, same as the fixed answers enroll and heartbeat give.
        debugLogger.warn('Agent Host pickup failed:', error);
        if (res.headersSent) return;
        // 409 reads as permanent to the client; a failed scan is transient.
        res.status(503).json({ error: 'Agent Host pickup unavailable.' });
      } finally {
        wake = undefined;
        unsubscribe();
        req.off('close', onClose);
      }
    },
  );

  /**
   * `{waitMs ≤ 25000, awaiting: [{runId, attempt, requestId, seen}]}` →
   * `{decisions}`. The Host keeps one open while a turn waits on a person;
   * it answers as soon as a decision for an awaited request exists whose key
   * is not in that request's `seen`, else empty at `waitMs`. A run frame of
   * this Host's (the orchestrator publishes one when it records a decision)
   * wakes the poll, with a short in-memory backstop scan in between.
   */
  app.post(
    '/agent-hosts/:workspaceId/:hostId/decisions',
    authenticated,
    express.json({ limit: '64kb' }),
    async (req: Request, res: Response) => {
      const workspaceId = String(req.params['workspaceId']);
      const hostId = String(req.params['hostId']);
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      const input = body(req);
      const waitMs = readWaitMs(input['waitMs']);
      const awaited = readAwaitedPermissions(input['awaiting']);
      if (waitMs === undefined || awaited === undefined) {
        res.status(400).json({ error: 'Invalid Agent Host decisions poll.' });
        return;
      }
      let wake: (() => void) | undefined;
      const unsubscribe = getSessionAgentEventHub(
        runtime.workspaceCwd,
      ).subscribe((frame) => {
        if (frame.type === 'run' && frame.author.runtimeId === hostId) {
          wake?.();
        }
      });
      const onClose = () => wake?.();
      req.on('close', onClose);
      try {
        const deadline = Date.now() + waitMs;
        for (;;) {
          if (req.socket.destroyed || res.writableEnded) return;
          if (runtimeFor(workspaceRegistry, workspaceId) !== runtime) {
            res.status(404).json({ error: 'Workspace not found.' });
            return;
          }
          if (!requireEnabled(runtime.workspaceCwd, res)) return;
          const decisions = decisionsForAwaited(
            getSessionAgentOrchestrator(runtime.workspaceCwd)?.decisionsForHost(
              hostId,
            ) ?? [],
            awaited,
          );
          const remaining = deadline - Date.now();
          if (decisions.length > 0 || remaining <= 0) {
            res.json({ decisions });
            return;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              resolve,
              Math.min(DECISIONS_INTERVAL_MS, remaining),
            );
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
        }
      } finally {
        wake = undefined;
        unsubscribe();
        req.off('close', onClose);
      }
    },
  );

  /**
   * A `HostTurnEventBatch` → `{ok, duplicate?, leaseExpiresAt, decisions}`;
   * 409 `{error: 'unknown_run' | 'lease_mismatch'}` when the lease is stale,
   * 409 `{error, cancelled: true}` when the person stopped the run.
   */
  app.post(
    '/agent-hosts/:workspaceId/:hostId/events',
    authenticated,
    // A batch can carry a long text delta.
    express.json({ limit: '2mb' }),
    async (req: Request, res: Response) => {
      const workspaceId = String(req.params['workspaceId']);
      const hostId = String(req.params['hostId']);
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      const batch = readHostEventBatch(body(req));
      if (!batch) {
        res.status(400).json({ error: 'Invalid Agent Host events.' });
        return;
      }
      const orchestrator =
        ensureSessionAgentOrchestratorForRuntime(runtime) ??
        getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(409).json({ error: 'unknown_run' });
        return;
      }
      await orchestrator.ready();
      const raw = orchestrator.acceptHostEvents(hostId, batch);
      const ack = readHostAck(raw);
      if (!ack.ok) {
        res.status(409).json(refusal(ack));
        return;
      }
      res.json({ ...raw, decisions: orchestrator.decisionsForHost(hostId) });
    },
  );

  /**
   * A `HostTurnResult` → `{ok: true}`; 409 when the lease is stale or the run
   * was cancelled (the Host discards the result), 503 when finishing failed
   * transiently.
   */
  app.post(
    '/agent-hosts/:workspaceId/:hostId/result',
    authenticated,
    // Carries the whole answer, which easily passes 16 KB.
    express.json({ limit: '2mb' }),
    async (req: Request, res: Response) => {
      const workspaceId = String(req.params['workspaceId']);
      const hostId = String(req.params['hostId']);
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      const input = readHostTurnResult(body(req));
      if (!input) {
        res.status(400).json({ error: 'Invalid Agent Host result.' });
        return;
      }
      const orchestrator =
        ensureSessionAgentOrchestratorForRuntime(runtime) ??
        getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(409).json({ error: 'unknown_run' });
        return;
      }
      await orchestrator.ready();
      try {
        const ack = readHostAck(
          await orchestrator.completeHostTurn(hostId, input),
        );
        if (!ack.ok) {
          res.status(409).json(refusal(ack));
          return;
        }
        res.json({ ok: true });
      } catch (error) {
        // The message can name coordinator-side paths; it stays off the wire.
        // 503 so the Host retries: a 409 would make it drop a finished answer.
        debugLogger.warn('Agent Host result failed:', error);
        res.status(503).json({ error: 'Agent Host result not applied.' });
      }
    },
  );
}
