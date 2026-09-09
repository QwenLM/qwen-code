/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application, Request, Response } from 'express';
import {
  applyHostRunResult,
  authenticateAgentHost,
  enrollAgentHost,
  heartbeatAgentHost,
  pickupRunForHost,
  type HostRunResult,
} from '@qwen-code/qwen-code-core';
import type { WorkspaceRegistry } from '../workspace-registry.js';

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body : {};
}

function runtimeFor(registry: WorkspaceRegistry, workspaceId: string) {
  return registry
    .listAll()
    .find((runtime) => runtime.workspaceId === workspaceId);
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
  if (
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
  let close: HostRunResult['close'];
  if (rawClose !== undefined) {
    if (typeof rawClose !== 'object' || rawClose === null) return undefined;
    const value = rawClose as Record<string, unknown>;
    if (value['kind'] === 'waiting') {
      close = { kind: 'waiting' };
    } else if (
      value['kind'] === 'blocked' &&
      typeof value['question'] === 'string' &&
      value['question'].trim()
    ) {
      close = { kind: 'blocked', question: value['question'].trim() };
    } else if (
      value['kind'] === 'review' &&
      typeof value['summary'] === 'string' &&
      value['summary'].trim()
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
    ...(error ? { error } : {}),
  };
}

export function registerAgentHostTransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
): void {
  const json = express.json({ limit: '16kb' });

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
    if (!runtime.primary && !runtime.trusted) {
      res.status(403).json({ error: 'Workspace is not trusted.' });
      return;
    }
    try {
      const enrolled = await enrollAgentHost(runtime.workspaceCwd, {
        token,
        name,
        workspaceCwd,
        providers,
      });
      res.status(201).json(enrolled);
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : String(error),
      });
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
      if (
        !workspaceId ||
        !hostId ||
        !secret ||
        typeof workspaceCwd !== 'string' ||
        !Array.isArray(providers) ||
        !providers.every((provider) => typeof provider === 'string')
      ) {
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
        return;
      }
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime || (!runtime.primary && !runtime.trusted)) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      try {
        const host = await heartbeatAgentHost(
          runtime.workspaceCwd,
          hostId,
          secret,
          { workspaceCwd, providers },
        );
        if (!host) {
          res.status(401).json({ error: 'Invalid Agent Host credential.' });
          return;
        }
        res.json({ host });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
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
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
        return;
      }
      if (waitMs === undefined) {
        res.status(400).json({ error: 'Invalid Agent Host pickup.' });
        return;
      }
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime || (!runtime.primary && !runtime.trusted)) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      if (
        !(await authenticateAgentHost(runtime.workspaceCwd, hostId, secret))
      ) {
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
        return;
      }
      try {
        const deadline = Date.now() + waitMs;
        for (;;) {
          const assignment = await pickupRunForHost(
            runtime.workspaceCwd,
            hostId,
          );
          if (assignment) {
            res.json({ assignment });
            return;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            res.status(204).end();
            return;
          }
          await delay(Math.min(250, remaining));
        }
      } catch (error) {
        res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.post(
    '/agent-hosts/:workspaceId/:hostId/result',
    json,
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const secret = hostSecret(req);
      if (!workspaceId || !hostId || !secret) {
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
        return;
      }
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime || (!runtime.primary && !runtime.trusted)) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      if (
        !(await authenticateAgentHost(runtime.workspaceCwd, hostId, secret))
      ) {
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
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
        res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
