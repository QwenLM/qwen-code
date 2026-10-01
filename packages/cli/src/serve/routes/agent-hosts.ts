/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { HostRunResult } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  parseHostRunSteps,
  applyHostRunResult,
  reportHostRunProgress,
  pickupRunForHost,
  renewRunLease,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/host-lease.js';
import {
  authenticateAgentHost,
  enrollAgentHost,
  heartbeatAgentHost,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { AGENT_HOST_CREDENTIAL_REJECTED } from '@qwen-code/qwen-code-core/agents/workspace-agents/types.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { requireTrustedWorkspaceRuntime } from '../workspace-route-runtime.js';
import type { RateLimiterInstance } from '../rate-limit.js';

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

/** A result's summary may be as long as the progress text it replaces. */
const MAX_RESULT_SUMMARY = 262_144;
const MAX_RESULT_ERROR = 4_096;
/** The thought stream a progress flush carries is shorter than its output. */
const MAX_PROGRESS_THOUGHT = 65_536;

/**
 * A Host's reported spend: absent, or a whole non-negative number. The cap is
 * far above any real turn and only keeps a hostile value out of the ledger.
 */
function readHostTokens(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000
    ? value
    : 'invalid';
}

function readHostResult(
  input: Record<string, unknown>,
  hostId: string,
): HostRunResult | undefined {
  const threadId = input['threadId'];
  const runId = input['runId'];
  const leaseId = input['leaseId'];
  const attempt = input['attempt'];
  const status = input['status'];
  const error = input['error'];
  const rawClose = input['close'];
  const tokens = readHostTokens(input['tokens']);
  if (
    tokens === 'invalid' ||
    typeof threadId !== 'string' ||
    typeof runId !== 'string' ||
    typeof leaseId !== 'string' ||
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    (status !== 'completed' && status !== 'failed' && status !== 'cancelled') ||
    (error !== undefined && typeof error !== 'string')
  ) {
    return undefined;
  }
  const errorText =
    typeof error === 'string' ? error.slice(0, MAX_RESULT_ERROR) : undefined;
  let close: HostRunResult['close'];
  if (rawClose !== undefined) {
    if (typeof rawClose !== 'object' || rawClose === null) return undefined;
    const value = rawClose as Record<string, unknown>;
    if (
      value['kind'] === 'review' &&
      typeof value['summary'] === 'string' &&
      value['summary'].trim() &&
      value['summary'].length <= MAX_RESULT_SUMMARY
    ) {
      close = { kind: 'review', summary: value['summary'].trim() };
    } else {
      return undefined;
    }
  }
  if (status !== 'completed' && close !== undefined) return undefined;
  return {
    threadId,
    runId,
    hostId,
    leaseId,
    attempt,
    status,
    ...(close ? { close } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

export function registerAgentHostTransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
  rateLimiter: Pick<RateLimiterInstance, 'checkRate'> | undefined,
  isEnabledFor: (workspaceCwd: string) => boolean,
): void {
  const json = express.json({ limit: '16kb' });
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
      : req.originalUrl.endsWith('/progress')
        ? 'progress'
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

  app.post(
    '/agent-hosts/:workspaceId/:hostId/progress',
    authenticated,
    express.json({ limit: '2mb' }),
    async (req, res) => {
      const { workspaceId, hostId } = req.params;
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      const {
        threadId,
        runId,
        leaseId,
        attempt,
        sequence,
        stage,
        detail,
        outputText,
        thoughtText,
        steps: rawSteps,
        tokens: rawTokens,
      } = body(req);
      const steps = parseHostRunSteps(rawSteps);
      const tokens = readHostTokens(rawTokens);
      if (
        tokens === 'invalid' ||
        typeof threadId !== 'string' ||
        typeof runId !== 'string' ||
        typeof leaseId !== 'string' ||
        typeof attempt !== 'number' ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        typeof stage !== 'string' ||
        ![
          'starting',
          'resuming',
          'waiting',
          'thinking',
          'tool',
          'responding',
        ].includes(stage) ||
        typeof detail !== 'string' ||
        detail.length > 1200 ||
        (outputText !== undefined &&
          (typeof outputText !== 'string' ||
            outputText.length > MAX_RESULT_SUMMARY)) ||
        (thoughtText !== undefined &&
          (typeof thoughtText !== 'string' ||
            thoughtText.length > MAX_PROGRESS_THOUGHT)) ||
        steps === 'invalid'
      ) {
        res.status(400).json({ error: 'Invalid progress.' });
        return;
      }
      const result = await reportHostRunProgress(runtime.workspaceCwd, {
        threadId,
        runId,
        hostId,
        leaseId,
        attempt,
        sequence,
        stage,
        detail,
        outputText,
        thoughtText,
        ...(steps ? { steps } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      });
      res.status(result.ok ? 200 : 409).json(result);
    },
  );

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

  app.post(
    '/agent-hosts/:workspaceId/:hostId/heartbeat',
    json,
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const secret = hostSecret(req);
      const input = body(req);
      const workspaceCwd = input['workspaceCwd'];
      const providers = input['providers'];
      const enrollmentToken = input['enrollmentToken'];
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
          },
        );
        if (!host) {
          res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
          return;
        }
        if (input['run'] !== undefined) {
          const run = input['run'];
          if (!run || typeof run !== 'object' || Array.isArray(run)) {
            res.status(400).json({ error: 'Invalid Agent Host lease.' });
            return;
          }
          const { threadId, runId, leaseId, attempt } = run as Record<
            string,
            unknown
          >;
          if (
            typeof threadId !== 'string' ||
            typeof runId !== 'string' ||
            typeof leaseId !== 'string' ||
            typeof attempt !== 'number' ||
            !Number.isSafeInteger(attempt) ||
            attempt < 1
          ) {
            res.status(400).json({ error: 'Invalid Agent Host lease.' });
            return;
          }
          const renewed = await renewRunLease(runtime.workspaceCwd, {
            threadId,
            runId,
            leaseId,
            attempt,
            hostId,
          });
          if (!renewed.ok) {
            res.status(409).json({ error: renewed.reason });
            return;
          }
          res.json({ host, lease: renewed.value });
          return;
        }
        res.json({ host });
      } catch {
        res.status(400).json({ error: 'Agent Host heartbeat refused.' });
      }
    },
  );

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
      try {
        const deadline = Date.now() + waitMs;
        // An empty poll backs off: every pickup scan walks the agent store
        // under its transaction, so a fixed 250ms cadence makes each idle
        // Host hammer that lock ~4x/second doing nothing. Doubling to a 2s
        // cap still answers fresh work promptly while an idle Host costs
        // about one scan every other second. The cadence resets per request,
        // so a Host that just received work re-polls hot.
        let pollIntervalMs = 250;
        for (;;) {
          // A Host that hung up must not have a run claimed for it here.
          if (req.socket.destroyed || res.writableEnded) return;
          if (runtimeFor(workspaceRegistry, workspaceId) !== runtime) {
            res.status(404).json({ error: 'Workspace not found.' });
            return;
          }
          if (!requireEnabled(runtime.workspaceCwd, res)) return;
          if (
            !(await authenticateAgentHost(runtime.workspaceCwd, hostId, secret))
          ) {
            res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
            return;
          }
          if (req.socket.destroyed || res.writableEnded) return;
          if (runtimeFor(workspaceRegistry, workspaceId) !== runtime) {
            res.status(404).json({ error: 'Workspace not found.' });
            return;
          }
          if (!requireEnabled(runtime.workspaceCwd, res)) return;
          const assignment = await pickupRunForHost(
            runtime.workspaceCwd,
            hostId,
          );
          if (
            assignment &&
            !(await authenticateAgentHost(runtime.workspaceCwd, hostId, secret))
          ) {
            res.status(401).json({ error: AGENT_HOST_CREDENTIAL_REJECTED });
            return;
          }
          if (req.socket.destroyed || res.writableEnded) return;
          if (runtimeFor(workspaceRegistry, workspaceId) !== runtime) {
            res.status(404).json({ error: 'Workspace not found.' });
            return;
          }
          if (!requireEnabled(runtime.workspaceCwd, res)) return;
          if (assignment) {
            res.json({ assignment });
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            res.status(204).end();
            return;
          }
          await delay(Math.min(pollIntervalMs, remaining));
          pollIntervalMs = Math.min(pollIntervalMs * 2, 2000);
        }
      } catch (error) {
        // The store's message can name coordinator-side paths, so it stays
        // off the wire, same as the fixed answers enroll and heartbeat give.
        debugLogger.warn('Agent Host pickup failed:', error);
        if (isStoreBusy(error)) {
          // 409 reads as permanent to the client; a busy store is transient.
          res.status(503).json({ error: 'Agent Host store busy.' });
          return;
        }
        res.status(409).json({ error: 'Agent Host pickup refused.' });
      }
    },
  );

  app.post(
    '/agent-hosts/:workspaceId/:hostId/result',
    authenticated,
    // Carries the whole answer, which easily passes 16 KB.
    express.json({ limit: '2mb' }),
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      const input = readHostResult(body(req), hostId);
      if (!input) {
        res.status(400).json({ error: 'Invalid Agent Host result.' });
        return;
      }
      try {
        const result = await applyHostRunResult(runtime.workspaceCwd, input);
        if (!result.ok) {
          const status = result.reason === 'no_such_run' ? 404 : 409;
          res.status(status).json({ error: result.reason });
          return;
        }
        res.json({
          threadId: result.value.thread.id,
          status: result.value.thread.status,
          alreadyApplied: result.value.alreadyApplied,
        });
      } catch (error) {
        // The store's message can name coordinator-side paths, so it stays
        // off the wire, same as the fixed answers enroll and heartbeat give.
        debugLogger.warn('Agent Host result failed:', error);
        if (isStoreBusy(error)) {
          // 409 reads as permanent to the client: it would rewrite a
          // finished answer as failed — or give up and let the still-held
          // lease hand the run to the next pickup, silently re-running it.
          res.status(503).json({ error: 'Agent Host store busy.' });
          return;
        }
        res.status(409).json({ error: 'Agent Host result refused.' });
      }
    },
  );
}
