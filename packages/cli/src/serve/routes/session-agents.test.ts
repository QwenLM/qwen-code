/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  disposeSessionAgentOrchestrator,
  SessionAgentError,
} from '../session-agents/orchestrator.js';
import {
  registerSessionAgentRoutes,
  registerSessionAgentSendRoute,
  sessionSendPath,
} from './session-agents.js';

const { orchestrator, getOrchestrator, ensureOrchestrator } = vi.hoisted(() => {
  const orchestrator = {
    snapshot: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
    mention: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    cancel: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
    retry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    stopAll: vi.fn<(...args: unknown[]) => Promise<string[]>>(),
    resolvePermission: vi.fn<(...args: unknown[]) => void>(),
    postFromAgent: vi.fn<(...args: unknown[]) => Promise<void>>(),
  };
  return {
    orchestrator,
    getOrchestrator: vi.fn<() => typeof orchestrator | undefined>(),
    ensureOrchestrator: vi.fn<(...args: unknown[]) => typeof orchestrator>(),
  };
});

vi.mock('../session-agents/orchestrator.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../session-agents/orchestrator.js')
  >()),
  getSessionAgentOrchestrator: getOrchestrator,
  ensureSessionAgentOrchestrator: ensureOrchestrator,
  disposeSessionAgentOrchestrator: vi.fn(async () => {}),
  disposeAllSessionAgentOrchestrators: vi.fn(async () => {}),
}));

vi.mock('../workspace-route-runtime.js', () => ({
  resolveWorkspaceRuntimeFromParam: (
    registry: WorkspaceRegistry,
    req: express.Request,
    res: express.Response,
  ) => {
    const runtime = registry
      .list()
      .find((candidate) => candidate.workspaceId === req.params['workspace']);
    if (!runtime) {
      res.status(404).json({ error: 'workspace_not_found' });
      return null;
    }
    return runtime;
  },
  requireTrustedWorkspaceRuntime: (
    runtime: WorkspaceRuntime,
    res: express.Response,
  ) => {
    if (runtime.trusted) return true;
    res.status(403).json({ code: 'untrusted_workspace' });
    return false;
  },
}));

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = `/workspaces/ws/agent/sessions/${SESSION}`;

let apps: express.Application[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  getOrchestrator.mockReturnValue(orchestrator);
  ensureOrchestrator.mockReturnValue(orchestrator);
});

afterEach(() => {
  for (const app of apps) {
    (
      app.locals['stopSessionAgentOrchestrators'] as (() => void) | undefined
    )?.();
  }
  apps = [];
});

function setup(options: { enabled?: boolean; trusted?: boolean } = {}) {
  const runtime = {
    workspaceId: 'ws',
    workspaceCwd: '/work/ws',
    trusted: options.trusted ?? true,
    bridge: {},
  } as unknown as WorkspaceRuntime;
  const registry = { list: () => [runtime] } as unknown as WorkspaceRegistry;
  const enabled = () => options.enabled ?? true;
  const mutate: () => RequestHandler = () => (_req, _res, next) => next();
  const app = express();
  registerSessionAgentSendRoute(app, {
    workspaceRegistry: registry,
    isAgentCollaborationEnabledFor: enabled,
  });
  app.use(express.json());
  registerSessionAgentRoutes(app, {
    workspaceRegistry: registry,
    mutate,
    isAgentCollaborationEnabledFor: enabled,
    daemonLoopbackBaseUrl: () => 'http://127.0.0.1:4170/',
  });
  apps.push(app);
  return app;
}

describe('session agent routes', () => {
  it('returns the run snapshot', async () => {
    orchestrator.snapshot.mockResolvedValue([{ type: 'run', runId: 'r1' }]);
    const res = await request(setup()).get(`${BASE}/runs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ frames: [{ type: 'run', runId: 'r1' }] });
    expect(orchestrator.snapshot).toHaveBeenCalledWith(SESSION);
  });

  it('refuses when collaboration is off, the workspace untrusted, or the id bad', async () => {
    expect(
      (await request(setup({ enabled: false })).get(`${BASE}/runs`)).body,
    ).toEqual({ error: 'agent_collaboration_disabled' });
    expect(
      (await request(setup({ trusted: false })).get(`${BASE}/runs`)).status,
    ).toBe(403);
    const bad = await request(setup()).get(
      '/workspaces/ws/agent/sessions/not-a-session/runs',
    );
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_session_id' });
  });

  it('posts a mention and maps orchestrator refusals', async () => {
    const app = setup();
    orchestrator.mention.mockResolvedValue({ recordId: 'rec-1', runs: [] });
    const ok = await request(app)
      .post(`${BASE}/mentions`)
      .send({ text: '@a hi', clientMessageId: 'm1' });
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ recordId: 'rec-1', runs: [] });
    expect(orchestrator.mention).toHaveBeenCalledWith(SESSION, {
      text: '@a hi',
      clientMessageId: 'm1',
    });
    // The orchestrator handed to the route is told how to reach the
    // binding's `session_send` endpoint on loopback.
    const options = ensureOrchestrator.mock.calls.at(-1)![0] as {
      sessionSendUrl(sessionId: string, agentId: string): string;
    };
    expect(options.sessionSendUrl(SESSION, 'ag_1')).toBe(
      `http://127.0.0.1:4170${sessionSendPath('ws', SESSION, 'ag_1')}`,
    );

    orchestrator.mention.mockRejectedValue(
      new SessionAgentError(400, 'no_agents_mentioned', 'No agents.', {
        unknown: ['x'],
      }),
    );
    const refused = await request(app)
      .post(`${BASE}/mentions`)
      .send({ text: 'hi', clientMessageId: 'm2' });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: 'no_agents_mentioned',
      message: 'No agents.',
      unknown: ['x'],
    });
  });

  it('cancels, retries, stops and answers permissions', async () => {
    const app = setup();
    orchestrator.cancel.mockResolvedValueOnce(true);
    expect((await request(app).post(`${BASE}/runs/r1/cancel`)).body).toEqual({
      cancelled: true,
    });
    orchestrator.cancel.mockResolvedValueOnce(false);
    expect((await request(app).post(`${BASE}/runs/r2/cancel`)).status).toBe(
      404,
    );

    orchestrator.retry.mockResolvedValueOnce({
      runId: 'r9',
      agentId: 'ag_1',
      status: 'queued',
    });
    const retried = await request(app).post(`${BASE}/runs/r1/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body).toEqual({
      runId: 'r9',
      agentId: 'ag_1',
      status: 'queued',
    });
    expect(orchestrator.retry).toHaveBeenCalledWith(SESSION, 'r1');
    orchestrator.retry.mockRejectedValueOnce(
      new SessionAgentError(409, 'run_already_retried', 'Already.'),
    );
    const again = await request(app).post(`${BASE}/runs/r1/retry`);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'run_already_retried' });

    orchestrator.stopAll.mockResolvedValueOnce(['r1', 'r2']);
    expect((await request(app).post(`${BASE}/stop`)).body).toEqual({
      stopped: ['r1', 'r2'],
    });

    const vote = await request(app)
      .post(`${BASE}/runs/r1/permission/p1`)
      .send({ optionId: 'yes' });
    expect(vote.status).toBe(200);
    expect(orchestrator.resolvePermission).toHaveBeenCalledWith(
      SESSION,
      'r1',
      'p1',
      'yes',
      { fromLoopback: true },
    );
  });

  it('authenticates session_send by the binding token on loopback', async () => {
    const app = setup();
    const path = sessionSendPath('ws', SESSION, 'ag_1');
    const token = 'a'.repeat(64);

    const missing = await request(app).post(path).send({ text: 'hi' });
    expect(missing.status).toBe(401);
    expect(orchestrator.postFromAgent).not.toHaveBeenCalled();

    const sent = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hi' });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ sent: true });
    expect(orchestrator.postFromAgent).toHaveBeenCalledWith(
      SESSION,
      'ag_1',
      token,
      'hi',
    );

    orchestrator.postFromAgent.mockRejectedValueOnce(
      new SessionAgentError(409, 'run_not_running', 'Not running.'),
    );
    const idle = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hi' });
    expect(idle.status).toBe(409);
    expect(idle.body).toMatchObject({ error: 'run_not_running' });

    getOrchestrator.mockReturnValueOnce(undefined);
    const none = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hi' });
    expect(none.status).toBe(401);
  });

  it('tells the orchestrator why it is torn down', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let enabled = true;
      const runtime = {
        workspaceId: 'ws',
        workspaceCwd: '/work/ws',
        trusted: true,
        bridge: {},
      };
      const app = express();
      registerSessionAgentRoutes(app, {
        workspaceRegistry: {
          list: () => [runtime as unknown as WorkspaceRuntime],
        } as unknown as WorkspaceRegistry,
        mutate: () => (_req, _res, next) => next(),
        isAgentCollaborationEnabledFor: () => enabled,
      });
      apps.push(app);
      // Brought up at registration.
      expect(ensureOrchestrator).toHaveBeenCalledTimes(1);

      enabled = false;
      vi.advanceTimersByTime(5_000);
      expect(disposeSessionAgentOrchestrator).toHaveBeenCalledTimes(1);
      expect(disposeSessionAgentOrchestrator).toHaveBeenCalledWith(
        '/work/ws',
        'collaboration_disabled',
      );

      enabled = true;
      vi.advanceTimersByTime(5_000);
      expect(ensureOrchestrator).toHaveBeenCalledTimes(2);
      runtime.trusted = false;
      vi.advanceTimersByTime(5_000);
      expect(disposeSessionAgentOrchestrator).toHaveBeenCalledTimes(2);
      expect(disposeSessionAgentOrchestrator).toHaveBeenLastCalledWith(
        '/work/ws',
        'workspace_untrusted',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
