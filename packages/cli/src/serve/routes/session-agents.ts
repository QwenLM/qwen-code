/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP surface of session multi-agent collaboration (agents answering
 * @-mentions inside an ordinary chat session). Mounted next to
 * `registerWorkspaceAgentRoutes` under the same prefix, opt-in and gates:
 * bearer auth (global), trusted workspace, per-workspace
 * `experimental.agentCollaboration` (404 `agent_collaboration_disabled`),
 * and strict `mutate` on every POST.
 *
 *   GET  /workspaces/:workspace/agent/sessions/:sessionId/runs
 *   GET  /workspaces/:workspace/agent/session-events?sessionId=
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/mentions
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/runs/:runId/cancel
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/runs/:runId/retry
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/stop
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/runs/:runId/permission/:requestId
 *
 * Mounted separately, BEFORE the daemon bearer gate (see
 * {@link registerSessionAgentSendRoute}), authenticated by the
 * (chat session, agent) binding's `session_send` token:
 *
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/agents/:agentId/send
 */

import express from 'express';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { SessionAgentEventFrame } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import {
  isTerminalSessionAgentRunStatus,
  isValidSessionAgentsSessionId,
} from '@qwen-code/qwen-code-core/agents/session-agents/binding-store.js';
import {
  disposeAllSessionAgentOrchestrators,
  disposeSessionAgentOrchestrator,
  ensureSessionAgentOrchestrator,
  getSessionAgentOrchestrator,
  SessionAgentError,
  type SessionAgentOrchestrator,
  type SessionAgentStopReason,
} from '../session-agents/orchestrator.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import { detectFromLoopback } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { RateLimiterInstance } from '../rate-limit.js';
import type { StandaloneSessionService } from '../conversations/standalone-session-service.js';
import { isLoopbackAddress } from '../loopback-binds.js';

let orchestratorFactory:
  | ((runtime: WorkspaceRuntime) => SessionAgentOrchestrator | undefined)
  | undefined;

/**
 * The workspace's orchestrator, created on demand with the same wiring the
 * session-agent routes use. Host transport routes call this rather than
 * `getSessionAgentOrchestrator`, so a Host renewing a lease right after a
 * daemon restart reaches the orchestrator whose startup recovery re-adopts
 * that run, instead of being told every lease is gone.
 */
export function ensureSessionAgentOrchestratorForRuntime(
  runtime: WorkspaceRuntime,
): SessionAgentOrchestrator | undefined {
  return orchestratorFactory?.(runtime);
}

export interface RegisterSessionAgentRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /** Same per-workspace opt-in check `registerWorkspaceAgentRoutes` uses. */
  isAgentCollaborationEnabledFor: (workspaceCwd: string) => boolean;
  /** `experimental.agentChainLimit` for a workspace; absent means unlimited. */
  agentChainLimitFor?: (workspaceCwd: string) => number;
  /** `experimental.agentTokenBudget` per workspace (default 1M, 0 = unlimited). */
  agentTokenBudgetFor?: (workspaceCwd: string) => number;
  /**
   * This daemon's loopback base URL (e.g. `http://127.0.0.1:<port>`), where
   * a program's `session_send` MCP child reaches the binding's send route.
   * Absent (or not loopback) means local turns (qwen, Claude, Codex) get no
   * `session_send` tool.
   * server.ts passes `relayBaseUrl(...)`, which is undefined for a bind to
   * one non-loopback address or under TLS.
   * TODO(multi-agent): confirm on a live daemon that `hostAllowlist` accepts
   * `Host: 127.0.0.1:<port>` for a wildcard or `localhost` bind.
   */
  daemonLoopbackBaseUrl?: () => string | undefined;
  /**
   * The daemon's standalone (daemon-owned) chat session service, when it has
   * one. Those sessions live in the Conversations runtime and are restored
   * through it (pinned working directory), not with `bridge.resumeSession`.
   */
  standaloneSessionService?: () =>
    | Pick<StandaloneSessionService, 'resume'>
    | undefined;
}

/**
 * Path of one (chat session, agent) binding's `session_send` endpoint,
 * relative to the daemon.
 */
export function sessionSendPath(
  workspaceId: string,
  sessionId: string,
  agentId: string,
): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(
    sessionId,
  )}/agents/${encodeURIComponent(agentId)}/send`;
}

const TEARDOWN_CHECK_MS = 5_000;
const SSE_HEARTBEAT_MS = 20_000;

export function registerSessionAgentRoutes(
  app: Application,
  deps: RegisterSessionAgentRoutesDeps,
): void {
  const prefix = '/workspaces/:workspace/agent';
  /** Which runtime each live orchestrator was built for. */
  const owners = new Map<
    string,
    {
      bridge: WorkspaceRuntime['bridge'];
      generationGuard: WorkspaceRuntime['generationGuard'];
    }
  >();

  const runtimeFor = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return undefined;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return undefined;
    if (!deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd)) {
      res.status(404).json({ error: 'agent_collaboration_disabled' });
      return undefined;
    }
    if (runtime.generationGuard?.closed) {
      res.status(503).json({ error: 'workspace_runtime_closed' });
      return undefined;
    }
    return runtime;
  };

  const orchestratorFor = (
    runtime: WorkspaceRuntime,
  ): SessionAgentOrchestrator => {
    const workspaceCwd = runtime.workspaceCwd;
    const workspaceId = runtime.workspaceId;
    const orchestrator = ensureSessionAgentOrchestrator({
      workspaceCwd,
      bridge: runtime.bridge,
      chainLimit: () => deps.agentChainLimitFor?.(workspaceCwd) ?? 0,
      ...(deps.agentTokenBudgetFor
        ? { tokenBudget: () => deps.agentTokenBudgetFor!(workspaceCwd) }
        : {}),
      sessionSendUrl: (sessionId, agentId) => {
        const base = deps.daemonLoopbackBaseUrl?.();
        if (!base) return undefined;
        return `${base.replace(/\/+$/, '')}${sessionSendPath(workspaceId, sessionId, agentId)}`;
      },
      restoreSession: async (sessionId) => {
        // The Conversations runtime owns the standalone chat sessions; it
        // restores one the way create-sub-session.ts restores a parent (the
        // attached client is left to the idle reaper).
        const standalone =
          runtime.provenance === 'live-conversation'
            ? deps.standaloneSessionService?.()
            : undefined;
        if (standalone) {
          await standalone.resume(sessionId);
          return;
        }
        await runtime.bridge.resumeSession({ sessionId, workspaceCwd });
      },
    });
    owners.set(workspaceCwd, {
      bridge: runtime.bridge,
      generationGuard: runtime.generationGuard,
    });
    return orchestrator;
  };
  orchestratorFactory = (runtime) =>
    deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd) &&
    !runtime.generationGuard?.closed
      ? orchestratorFor(runtime)
      : undefined;

  const sessionIdParam = (req: Request, res: Response): string | undefined => {
    const sessionId = req.params['sessionId'];
    if (!isValidSessionAgentsSessionId(sessionId)) {
      res.status(400).json({ error: 'invalid_session_id' });
      return undefined;
    }
    return sessionId;
  };

  const fail = (res: Response, error: unknown) => {
    if (error instanceof SessionAgentError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/lock file is already being held/i.test(message)) {
      res
        .set('Retry-After', '11')
        .status(503)
        .json({ error: 'workspace_busy' });
      return;
    }
    res.status(500).json({ error: message });
  };

  /**
   * Stops a workspace's agents when its runtime goes away, is replaced,
   * becomes untrusted, or opts out. Mirrors the recovery sweep in
   * `registerWorkspaceAgentRoutes`, which additionally closes every
   * `sourceType: 'agent'` session (hidden session-agent sessions included)
   * when collaboration is turned off.
   */
  const teardownCheck = () => {
    const runtimes = deps.workspaceRegistry.list();
    // Bring up each enabled workspace's orchestrator without waiting for a
    // first mention: its startup recovery closes runs a previous daemon left
    // live and makes queued remote runs available to Host pickup.
    for (const runtime of runtimes) {
      if (owners.has(runtime.workspaceCwd)) continue;
      try {
        if (
          runtime.trusted &&
          !runtime.generationGuard?.closed &&
          deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd)
        ) {
          orchestratorFor(runtime);
        }
      } catch {
        // Retried on the next tick.
      }
    }
    for (const [workspaceCwd, owner] of [...owners]) {
      const runtime = runtimes.find(
        (candidate) => candidate.workspaceCwd === workspaceCwd,
      );
      // Why the orchestrator stops: the error its interrupted runs show.
      let reason: SessionAgentStopReason | undefined;
      try {
        if (!runtime || runtime.generationGuard?.closed === true) {
          reason = 'workspace_closed';
        } else if (!runtime.trusted) {
          reason = 'workspace_untrusted';
        } else if (
          runtime.bridge !== owner.bridge ||
          runtime.generationGuard !== owner.generationGuard
        ) {
          reason = 'runtime_replaced';
        } else if (!deps.isAgentCollaborationEnabledFor(workspaceCwd)) {
          reason = 'collaboration_disabled';
        }
      } catch {
        reason = 'shutdown';
      }
      if (!reason) continue;
      owners.delete(workspaceCwd);
      void disposeSessionAgentOrchestrator(workspaceCwd, reason).catch(
        () => {},
      );
    }
  };
  const teardownTimer = setInterval(teardownCheck, TEARDOWN_CHECK_MS);
  teardownTimer.unref?.();
  teardownCheck();
  app.locals['stopSessionAgentOrchestrators'] = () => {
    clearInterval(teardownTimer);
    owners.clear();
    void disposeAllSessionAgentOrchestrators().catch(() => {});
  };

  app.get(
    `${prefix}/sessions/:sessionId/runs`,
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      // A read never creates an orchestrator: no orchestrator, no runs.
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      try {
        res.json({
          frames: orchestrator ? await orchestrator.snapshot(sessionId) : [],
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * Live run frames for one chat session. Nothing is replayed: the stream
   * opens with the current snapshot, then follows. A congested client skips
   * intermediate streaming frames (the next one carries the whole text) but
   * never a status change.
   */
  app.get(`${prefix}/session-events`, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const sessionId = req.query['sessionId'];
    if (!isValidSessionAgentsSessionId(sessionId)) {
      res.status(400).json({ error: 'invalid_session_id' });
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let closed = false;
    let congested = false;
    const lastStatus = new Map<string, string>();
    const stop = (endResponse = false) => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (endResponse && !res.writableEnded) res.end();
    };
    res.on('drain', () => {
      congested = false;
    });
    const send = (frame: SessionAgentEventFrame) => {
      if (runtime.generationGuard?.closed) {
        stop(true);
        return;
      }
      if (closed) return;
      if (frame.type === 'run') {
        const statusChanged = lastStatus.get(frame.runId) !== frame.status;
        if (congested && !statusChanged) return;
        if (isTerminalSessionAgentRunStatus(frame.status)) {
          lastStatus.delete(frame.runId);
        } else {
          lastStatus.set(frame.runId, frame.status);
        }
      }
      congested = !res.write(
        `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
      );
    };
    const heartbeat = setInterval(() => {
      if (runtime.generationGuard?.closed) stop(true);
      else if (!closed) res.write(': ping\n\n');
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    // Subscribe before the snapshot so nothing falls between the two; a
    // frame seen twice is harmless (the client keys frames by runId).
    const unsubscribe = getSessionAgentEventHub(runtime.workspaceCwd).subscribe(
      send,
      sessionId,
    );
    req.on('close', () => stop());
    const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
    if (!orchestrator) return;
    try {
      for (const frame of await orchestrator.snapshot(sessionId)) send(frame);
    } catch {
      // The snapshot is a convenience; the stream itself is still valid.
    }
  });

  app.post(
    `${prefix}/sessions/:sessionId/mentions`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      const orchestrator = orchestratorFor(runtime);
      const body = (req.body ?? {}) as {
        text?: unknown;
        clientMessageId?: unknown;
      };
      try {
        // TODO(multi-agent): attachments on an @-mention are refused for now
        // (session-multi-agent design §8-6); the body carries text only.
        const result = await orchestrator.mention(sessionId, {
          text: body.text,
          clientMessageId: body.clientMessageId,
        });
        res.status(202).json(result);
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/sessions/:sessionId/runs/:runId/cancel`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      try {
        const cancelled = orchestrator
          ? await orchestrator.cancel(sessionId, req.params['runId'] ?? '')
          : false;
        if (!cancelled) {
          res.status(404).json({ error: 'run_not_found' });
          return;
        }
        res.json({ cancelled: true });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * Re-queues a failed / offline run (one a daemon restart interrupted shows
   * `retryable: true` on its frame) as a new run. 202 `{runId, agentId,
   * status}`; 404 `run_not_found`; 409 `run_not_retryable` /
   * `run_already_retried` / `agent_unavailable`.
   */
  app.post(
    `${prefix}/sessions/:sessionId/runs/:runId/retry`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      const orchestrator = orchestratorFor(runtime);
      try {
        const run = await orchestrator.retry(
          sessionId,
          req.params['runId'] ?? '',
        );
        res.status(202).json(run);
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/sessions/:sessionId/stop`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      try {
        const runIds = orchestrator
          ? await orchestrator.stopAll(sessionId)
          : [];
        res.json({ stopped: runIds });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.post(
    `${prefix}/sessions/:sessionId/runs/:runId/permission/:requestId`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const sessionId = sessionIdParam(req, res);
      if (!sessionId) return;
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      const body = (req.body ?? {}) as { optionId?: unknown };
      try {
        // Only the loopback bit travels: the hidden session validates client
        // ids against its own registry, where this browser is not attached.
        orchestrator.resolvePermission(
          sessionId,
          req.params['runId'] ?? '',
          req.params['requestId'] ?? '',
          body.optionId,
          { fromLoopback: detectFromLoopback(req) },
        );
        res.json({});
      } catch (error) {
        fail(res, error);
      }
    },
  );
}

export interface RegisterSessionAgentSendRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  isAgentCollaborationEnabledFor: (workspaceCwd: string) => boolean;
  rateLimiter?: Pick<RateLimiterInstance, 'checkRate'>;
}

const SESSION_SEND_AUTH = /^Bearer ([0-9a-f]{64})$/;

/**
 * `POST /workspaces/:workspace/agent/sessions/:sessionId/agents/:agentId/send`
 * `{ text }` — a session agent's `session_send` tool call, made by the
 * `qwen agents session-send-mcp` child of a local run (the hidden qwen
 * session's MCP server, or a Claude / Codex process's).
 *
 * Authenticated by the (chat session, agent) binding's bearer token (minted
 * by the orchestrator when it creates the native session or process),
 * NOT by the daemon bearer, which that child does not hold; the post goes
 * to the agent's current executing run in that session. So this must be
 * mounted BEFORE `app.use(authenticate)` in server.ts, next to
 * `registerAgentHostTransportRoutes`, and only when agent collaboration is
 * enabled anywhere. It never creates an orchestrator.
 *
 * 200 `{sent: true}`; 401 `invalid_session_send_token`; 403
 * `loopback_only`; 400 `invalid_text`; 409 `run_not_running`; 429.
 */
export function registerSessionAgentSendRoute(
  app: Application,
  deps: RegisterSessionAgentSendRouteDeps,
): void {
  const json = express.json({ limit: '512kb' });
  // Token shape first, so a request without one is never parsed.
  const tokenGate: RequestHandler = (req, res, next) => {
    const source = req.ip || req.socket.remoteAddress || 'unknown';
    if (
      deps.rateLimiter &&
      !deps.rateLimiter.checkRate(`session-send:${source}`, 'mutation')
    ) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'rate_limit_exceeded',
        tier: 'mutation',
      });
      return;
    }
    // The MCP child runs on this machine (same rule as the Host relay).
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    if (!isLoopbackAddress(peer)) {
      res.status(403).json({ error: 'loopback_only' });
      return;
    }
    const match = SESSION_SEND_AUTH.exec(req.get('authorization') ?? '');
    if (!match) {
      res.status(401).json({ error: 'invalid_session_send_token' });
      return;
    }
    res.locals['sessionSendToken'] = match[1];
    next();
  };
  app.post(
    '/workspaces/:workspace/agent/sessions/:sessionId/agents/:agentId/send',
    tokenGate,
    json,
    async (req: Request, res: Response) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime) return;
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
      if (!deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd)) {
        res.status(404).json({ error: 'agent_collaboration_disabled' });
        return;
      }
      const sessionId = req.params['sessionId'];
      if (!isValidSessionAgentsSessionId(sessionId)) {
        res.status(400).json({ error: 'invalid_session_id' });
        return;
      }
      const orchestrator = getSessionAgentOrchestrator(runtime.workspaceCwd);
      if (!orchestrator) {
        res.status(401).json({ error: 'invalid_session_send_token' });
        return;
      }
      const body = (
        typeof req.body === 'object' && req.body !== null ? req.body : {}
      ) as { text?: unknown };
      try {
        await orchestrator.postFromAgent(
          sessionId,
          req.params['agentId'] ?? '',
          String(res.locals['sessionSendToken']),
          body.text,
        );
        res.json({ sent: true });
      } catch (error) {
        if (error instanceof SessionAgentError) {
          res.status(error.status).json({
            error: error.code,
            message: error.message,
            ...(error.details ?? {}),
          });
          return;
        }
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
