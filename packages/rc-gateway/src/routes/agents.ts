/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { SessionDaemon } from '../daemonPool.js';
import type { AuditRecorder } from '../auditLog.js';
import {
  TERMINAL_AGENT_STATUSES,
  type AgentRecord,
  type AgentRegistry,
  type AgentStatus,
} from '../agents/agentRegistry.js';
import type { AgentLifecycle } from '../agents/agentLifecycle.js';
import { PromptQueue } from './promptQueue.js';

const AGENT_STATUSES: readonly AgentStatus[] = [
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];

export interface AgentRoutesDeps {
  daemon: SessionDaemon;
  registry: AgentRegistry;
  lifecycle: AgentLifecycle;
  audit?: AuditRecorder;
  /** Read-time cost rollup keyed by sessionId; absent → no costMicrocents. */
  costFor?: (sessionId: string) => number | undefined;
  /**
   * ms to wait for an EARLY prompt rejection before accepting the spawn.
   * daemon.prompt() is long-lived (resolves at end of turn), so a bounded
   * race is how "prompt SEND failed" is distinguished from "turn running".
   * Default 1000; tests inject 10–50 ms.
   */
  promptAcceptWindowMs?: number;
  /**
   * Per-session FIFO serialiser for daemon.prompt() calls (shared with
   * routes/prompt.ts's PromptQueue design). Ensures the spawn's initial
   * task prompt and any subsequent steer messages for the same agent
   * session never race the daemon concurrently. Injected by tests for
   * isolation; defaults to a module-level shared queue in production.
   */
  promptQueue?: PromptQueue;
}

/** Fallback queue when a route set is wired without an explicit promptQueue. */
const defaultPromptQueue = new PromptQueue();

/** ms to wait for the per-session prompt slot before giving up (generous —
 * agent turns are long-lived; this only guards against a stuck prior turn). */
const PROMPT_QUEUE_WAIT_MS = 10 * 60 * 1000;

/**
 * Send a prompt through the per-session FIFO slot so concurrent spawn/steer
 * calls against the same agent session never reach daemon.prompt() at once
 * (design: "steer prompts serialized" — a rapid second message, or a steer
 * racing the spawn's own initial prompt, must queue behind the in-flight
 * turn rather than interleave).
 */
function sendSerializedPrompt(
  deps: AgentRoutesDeps,
  sessionId: string,
  text: string,
): Promise<unknown> {
  const queue = deps.promptQueue ?? defaultPromptQueue;
  return (async () => {
    const release = await queue.acquire(sessionId, PROMPT_QUEUE_WAIT_MS);
    try {
      return await deps.daemon.prompt(sessionId, {
        prompt: [{ type: 'text', text }],
      });
    } finally {
      release();
    }
  })();
}

/** A record plus its read-time cost rollup (design: one source of truth). */
function withCost(
  rec: AgentRecord,
  costFor?: (sessionId: string) => number | undefined,
): AgentRecord & { costMicrocents?: number } {
  const cost = costFor?.(rec.sessionId);
  return cost !== undefined ? { ...rec, costMicrocents: cost } : { ...rec };
}

/**
 * POST /rc/agents — spawn saga (design: create session → register → send
 * prompt; a prompt-send failure ends the session and marks the record
 * failed — no half-spawned agents). WRITE scope enforced at the mount.
 */
export function createSpawnAgentRoute(deps: AgentRoutesDeps): RequestHandler {
  const acceptMs = deps.promptAcceptWindowMs ?? 1000;
  return async (req, res) => {
    const body = (req.body ?? {}) as {
      task?: unknown;
      agentType?: unknown;
      parentSessionId?: unknown;
      model?: unknown;
    };
    if (typeof body.task !== 'string' || body.task.length === 0) {
      res.status(400).json({ error: 'Invalid task', code: 'invalid_task' });
      return;
    }
    const task = body.task;
    const agentType =
      typeof body.agentType === 'string' && body.agentType.length > 0
        ? body.agentType
        : 'general';
    const parentSessionId =
      typeof body.parentSessionId === 'string' ? body.parentSessionId : null;
    const model = typeof body.model === 'string' ? body.model : undefined;

    // Saga leg 1: create a DEDICATED daemon session. sessionScope 'thread'
    // forces a distinct session (the daemon default 'single' would coalesce
    // the agent onto an existing session).
    let sessionId: string;
    try {
      const session = await deps.daemon.createOrAttachSession({
        sessionScope: 'thread',
        ...(model !== undefined ? { modelServiceId: model } : {}),
      });
      sessionId = session.sessionId;
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    // Saga leg 2: register.
    const record = await deps.registry.register({
      sessionId,
      parentSessionId,
      agentType,
      task,
      spawnedByTokenId: req.rcClient?.id ?? '',
      ...(req.rcClient?.subActor !== undefined
        ? { subActor: req.rcClient.subActor }
        : {}),
    });

    // Saga leg 3: send the task prompt. Race an early rejection against the
    // accept window; survival (or early resolution) accepts the spawn.
    const promptPromise = sendSerializedPrompt(deps, sessionId, task);
    let acceptTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      promptPromise.then(
        () => 'settled' as const,
        () => 'send_failed' as const,
      ),
      new Promise<'accepted'>((resolve) => {
        acceptTimer = setTimeout(() => resolve('accepted'), acceptMs);
        acceptTimer.unref?.();
      }),
    ]);
    clearTimeout(acceptTimer);

    if (outcome === 'send_failed') {
      // Rollback: no zombie sessions, no half-spawned agents.
      try {
        await deps.daemon.closeSession(sessionId);
      } catch {
        // Best-effort — the daemon may already have dropped the session.
      }
      await deps.registry.setStatus(record.agentId, 'failed');
      res
        .status(502)
        .json({ error: 'Prompt send failed', code: 'prompt_send_failed' });
      return;
    }

    // Spawned. The prompt's eventual settlement drives completed/failed.
    // (If it already resolved — 'settled' — these handlers fire immediately.)
    void promptPromise
      .then(
        () => deps.lifecycle.onPromptSettled(record.agentId, 'completed'),
        () => deps.lifecycle.onPromptSettled(record.agentId, 'failed'),
      )
      .catch(() => {});

    deps.lifecycle.emit('agent_spawned', deps.registry.get(record.agentId)!);
    void deps.audit?.record({
      action: 'agent_spawned',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: record.agentId,
      // NEVER the task text — ids and metadata only.
      detail: { sessionId, agentType, parentSessionId },
    });

    res.status(201).json({ agentId: record.agentId, sessionId });
  };
}

/**
 * GET /rc/agents?status=&parent= — SESSION_READ scope at the mount, which
 * admits a session-locked SHARE token (add-link-share: "session-locked" gets
 * `read` on `session_lock_id` ONLY and SHALL NOT access other sessions). This
 * is a workspace-wide list, so — mirroring routes/search.ts's confinement of
 * `sessionId` to `req.rcClient.sessionLockId` — a locked caller's results are
 * confined here, in-handler, to records tied to its one session: either the
 * agent's OWN session, or a session it was spawned FROM (`parentSessionId`).
 * Fail-closed: a record with neither tie to the lock is excluded. A
 * non-locked (owner/write) token is unaffected — full list, as before.
 */
export function createListAgentsRoute(deps: AgentRoutesDeps): RequestHandler {
  return (req, res) => {
    const statusRaw = req.query['status'];
    let status: AgentStatus | undefined;
    if (typeof statusRaw === 'string' && statusRaw.length > 0) {
      if (!AGENT_STATUSES.includes(statusRaw as AgentStatus)) {
        res
          .status(400)
          .json({ error: 'Invalid status', code: 'invalid_status' });
        return;
      }
      status = statusRaw as AgentStatus;
    }
    const parentRaw = req.query['parent'];
    const parent = typeof parentRaw === 'string' ? parentRaw : undefined;
    const lock = req.rcClient?.sessionLockId;
    const agents = deps.registry
      .list({ status, parent })
      .filter(
        (r) =>
          lock === undefined ||
          r.sessionId === lock ||
          r.parentSessionId === lock,
      )
      .map((r) => withCost(r, deps.costFor));
    res.status(200).json({ agents });
  };
}

/**
 * GET /rc/agents/:id — SESSION_READ scope at the mount, which admits a
 * session-locked SHARE token. Mirrors createListAgentsRoute's confinement: a
 * locked caller may only fetch a record tied to its ONE session (own
 * `sessionId`, or spawned FROM it via `parentSessionId`). A record that fails
 * both ties is reported 404 — the SAME shape as a missing id — so a locked
 * token cannot distinguish "exists in another session" from "doesn't exist".
 * A non-locked (owner/write) token is unaffected — full access, as before.
 */
export function createGetAgentRoute(deps: AgentRoutesDeps): RequestHandler {
  return (req, res) => {
    const rec = deps.registry.get(req.params.id);
    const lock = req.rcClient?.sessionLockId;
    const visible =
      rec !== undefined &&
      (lock === undefined ||
        rec.sessionId === lock ||
        rec.parentSessionId === lock);
    if (!visible) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    res.status(200).json(withCost(rec, deps.costFor));
  };
}

/**
 * POST /rc/agents/:id/message { content } — steer. Proxies content as a
 * prompt to the agent's own session. WRITE scope at the mount. Content is
 * NEVER audited (mirror prompt_sent).
 */
export function createAgentMessageRoute(deps: AgentRoutesDeps): RequestHandler {
  return async (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    if (TERMINAL_AGENT_STATUSES.has(rec.status)) {
      res
        .status(409)
        .json({ error: 'Agent not running', code: 'agent_not_running' });
      return;
    }
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string' || body.content.length === 0) {
      res
        .status(400)
        .json({ error: 'Invalid content', code: 'invalid_content' });
      return;
    }
    // Long-lived turn: fire, and let settlement drive the lifecycle. Queued
    // behind any in-flight prompt for this session (spawn's initial prompt
    // or a prior steer) so daemon.prompt() is never called concurrently for
    // the same session.
    void sendSerializedPrompt(deps, rec.sessionId, body.content)
      .then(
        () => deps.lifecycle.onPromptSettled(rec.agentId, 'completed'),
        () => deps.lifecycle.onPromptSettled(rec.agentId, 'failed'),
      )
      .catch(() => {});
    void deps.audit?.record({
      action: 'agent_message_sent',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: rec.agentId,
      detail: { sessionId: rec.sessionId, contentLength: body.content.length },
    });
    res.status(202).json({ agentId: rec.agentId, accepted: true });
  };
}

/**
 * POST /rc/agents/:id/cancel — proxies to the daemon's session end (the
 * same call sessionEnd.ts makes) and marks the record cancelled. WRITE
 * scope at the mount. 409 agent_not_running on terminal records.
 */
export function createAgentCancelRoute(deps: AgentRoutesDeps): RequestHandler {
  return async (req, res) => {
    const rec = deps.registry.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Unknown agent', code: 'agent_not_found' });
      return;
    }
    if (TERMINAL_AGENT_STATUSES.has(rec.status)) {
      res
        .status(409)
        .json({ error: 'Agent not running', code: 'agent_not_running' });
      return;
    }
    try {
      await deps.daemon.closeSession(rec.sessionId);
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }
    // Atomic terminal transition: two concurrent cancels can both pass the
    // pre-check above and both reach here. setStatus is the single source of
    // truth for "who won" — only the caller whose transition actually landed
    // (record was non-terminal at the moment of the CAS) audits/emits/200s;
    // the loser gets 409, matching the pre-check's terminal-status response.
    const transitioned = await deps.registry.setStatus(
      rec.agentId,
      'cancelled',
    );
    if (!transitioned) {
      res
        .status(409)
        .json({ error: 'Agent not running', code: 'agent_not_running' });
      return;
    }
    deps.lifecycle.emit('agent_cancelled', deps.registry.get(rec.agentId)!);
    void deps.audit?.record({
      action: 'agent_cancelled',
      actorTokenId: req.rcClient?.id,
      subActor: req.rcClient?.subActor,
      target: rec.agentId,
      detail: { sessionId: rec.sessionId },
    });
    res.status(200).json({ agentId: rec.agentId, status: 'cancelled' });
  };
}
