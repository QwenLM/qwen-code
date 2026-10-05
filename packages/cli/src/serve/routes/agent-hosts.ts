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
 * probe, lease renewal, permission decisions), long-poll pickup for a session
 * turn, stream ordered event batches, and post the turn's result. Work comes
 * from the workspace's session-agent orchestrator (its remote queue); these
 * handlers only authenticate, validate and translate.
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
  type HostProgramProbe,
  type HostTurnEventBatch,
  type HostTurnResult,
  type SessionAgentPermissionPrompt,
  type SessionAgentProgram,
  type SessionAgentStep,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { isTerminalSessionAgentRunStatus } from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { requireTrustedWorkspaceRuntime } from '../workspace-route-runtime.js';
import type { RateLimiterInstance } from '../rate-limit.js';
import { getSessionAgentOrchestrator } from '../session-agents/orchestrator.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import { createHostProgramAgentEnsurer } from '../agent-host-program-agents.js';

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

function readStep(value: unknown): SessionAgentStep | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, title, status } = value as Record<string, unknown>;
  if (
    !isId(id) ||
    !boundedString(title, 1_200) ||
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
  const { requestId, title, toolName, inputPreview, options } = value as Record<
    string,
    unknown
  >;
  if (
    !isId(requestId) ||
    !boundedString(title, 1_200) ||
    (toolName !== undefined && !boundedString(toolName, 256)) ||
    (inputPreview !== undefined && !boundedString(inputPreview, 16_384)) ||
    !Array.isArray(options) ||
    options.length === 0 ||
    options.length > 16
  ) {
    return undefined;
  }
  const parsed: SessionAgentPermissionPrompt['options'] = [];
  for (const option of options) {
    if (typeof option !== 'object' || option === null) return undefined;
    const { optionId, name, kind } = option as Record<string, unknown>;
    if (
      !isId(optionId) ||
      !boundedString(name, 256) ||
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

/** Programs a Host may be handed turns for: v2 Hosts only. */
function pickupPrograms(host: AgentHostView): SessionAgentProgram[] {
  // A v1 Host cannot execute a v2 assignment; handing it one would hold the
  // lease until it rots to `offline`. It keeps polling and gets nothing.
  if (host.protocol !== HOST_PROTOCOL_VERSION) return [];
  return hostAvailablePrograms(host);
}

export function registerAgentHostTransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
  rateLimiter: Pick<RateLimiterInstance, 'checkRate'> | undefined,
  isEnabledFor: (workspaceCwd: string) => boolean,
): void {
  const json = express.json({ limit: '16kb' });
  const ensureProgramAgents = createHostProgramAgentEnsurer();
  const requireEnabled = (workspaceCwd: string, res: Response): boolean => {
    if (isEnabledFor(workspaceCwd)) return true;
    res.status(404).json({ error: 'Workspace not found.' });
    return false;
  };
  // Runs before the large-body routes parse anything, so a request with a
  // wrong secret never gets 2 MB read on its behalf. It is also the only place
  // those routes check trust, the collaboration setting and the credential:
  // the handlers below resolve the workspace again just to read its cwd.
  const authenticated: RequestHandler = async (req, res, next) => {
    const runtime = runtimeFor(
      workspaceRegistry,
      String(req.params['workspaceId']),
    );
    if (!runtime) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
    if (!requireEnabled(runtime.workspaceCwd, res)) return;
    const secret = hostSecret(req);
    if (
      !secret ||
      !(await authenticateAgentHost(
        runtime.workspaceCwd,
        String(req.params['hostId']),
        secret,
      ))
    ) {
      res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
      return;
    }
    next();
  };

  app.use('/agent-hosts', (req, res, next) => {
    const enrollment = req.originalUrl.startsWith('/agent-hosts/enroll');
    const category = enrollment
      ? 'enrollment'
      : req.originalUrl.endsWith('/events')
        ? 'events'
        : 'control';
    const tier = enrollment ? 'mutation' : 'read';
    const source = req.ip || req.socket.remoteAddress || 'unknown';
    if (
      rateLimiter &&
      !rateLimiter.checkRate(`agent-host:${category}:${source}`, tier)
    ) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'rate_limit_exceeded',
        tier,
      });
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
   * → `{host, leases: [{runId, ok}], decisions}`. Records presence and the
   * program probe, renews each listed lease, hands back pending permission
   * decisions, and adds an agent per newly offered program.
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
        res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
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
        res.status(400).json({ error: 'Invalid Agent Host heartbeat.' });
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
          res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
          return;
        }
        // No orchestrator means no live runs in this daemon (it restarted or
        // the workspace's agents are stopping): every lease is gone.
        const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
        const leases = runs.map((run) => ({
          runId: run.runId,
          ok:
            orchestrator?.renewLease(
              hostId,
              run.runId,
              run.attempt,
              run.leaseId,
            ).ok ?? false,
        }));
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
        res.status(400).json({ error: 'Agent Host heartbeat refused.' });
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
        res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
        return;
      }
      if (waitMs === undefined) {
        res.status(400).json({ error: 'Invalid Agent Host pickup.' });
        return;
      }
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
      if (!requireEnabled(runtime.workspaceCwd, res)) return;
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
            res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
            return;
          }
          if (req.socket.destroyed || res.writableEnded) return;
          const programs = pickupPrograms(host);
          const orchestrator = getSessionAgentOrchestrator(
            runtime.workspaceCwd,
          );
          const assignment =
            orchestrator && programs.length > 0
              ? await orchestrator.pickupForHost(hostId, programs)
              : undefined;
          if (assignment) {
            if (req.socket.destroyed || res.writableEnded) {
              // TODO(multi-agent): the claim cannot be handed back; the run
              // ends `offline` when its lease (60 s) runs out.
              return;
            }
            res.json({ assignment });
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
   * A `HostTurnEventBatch` → `{ok, duplicate?, leaseExpiresAt, decisions}`;
   * 409 `{error: 'unknown_run' | 'lease_mismatch'}` when the lease is stale.
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
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(409).json({ error: 'unknown_run' });
        return;
      }
      const ack = orchestrator.acceptHostEvents(hostId, batch);
      if (!ack.ok) {
        res.status(409).json({ error: ack.reason });
        return;
      }
      res.json({ ...ack, decisions: orchestrator.decisionsForHost(hostId) });
    },
  );

  /**
   * A `HostTurnResult` → `{ok: true}`; 409 when the lease is stale (the
   * Host discards the result), 503 when finishing failed transiently.
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
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(409).json({ error: 'unknown_run' });
        return;
      }
      try {
        const ack = await orchestrator.completeHostTurn(hostId, input);
        if (!ack.ok) {
          res.status(409).json({ error: ack.reason });
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
