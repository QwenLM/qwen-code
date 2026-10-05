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
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/stop
 *   POST /workspaces/:workspace/agent/sessions/:sessionId/runs/:runId/permission/:requestId
 */

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

export interface RegisterSessionAgentRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /** Same per-workspace opt-in check `registerWorkspaceAgentRoutes` uses. */
  isAgentCollaborationEnabledFor: (workspaceCwd: string) => boolean;
  /** `experimental.agentChainLimit` for a workspace; absent means unlimited. */
  agentChainLimitFor?: (workspaceCwd: string) => number;
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
    const orchestrator = ensureSessionAgentOrchestrator({
      workspaceCwd,
      bridge: runtime.bridge,
      chainLimit: () => deps.agentChainLimitFor?.(workspaceCwd) ?? 0,
    });
    owners.set(workspaceCwd, {
      bridge: runtime.bridge,
      generationGuard: runtime.generationGuard,
    });
    return orchestrator;
  };

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
      let gone = true;
      try {
        gone =
          !runtime ||
          !runtime.trusted ||
          runtime.generationGuard?.closed === true ||
          runtime.bridge !== owner.bridge ||
          runtime.generationGuard !== owner.generationGuard ||
          !deps.isAgentCollaborationEnabledFor(workspaceCwd);
      } catch {
        gone = true;
      }
      if (!gone) continue;
      owners.delete(workspaceCwd);
      void disposeSessionAgentOrchestrator(workspaceCwd).catch(() => {});
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
        // (plan §8-6); the body carries text only.
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
        const runIds = orchestrator ? await orchestrator.stopAll(sessionId) : [];
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
