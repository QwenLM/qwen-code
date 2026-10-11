/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type { SessionAgentEventFrame } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import { registerSessionAgentSquadRoutes } from './session-agent-squads.js';

const store = vi.hoisted(() => ({
  listSquadViews: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  createSquad: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateSquad: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  retireSquad: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/agents/session-agents/squad-store.js')
    >()),
    ...store,
  }),
);

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

const SQUAD_ID = 'sq_0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = '/workspaces/ws/agent/squads';
const CWD = '/work/squads-ws';

beforeEach(() => {
  vi.clearAllMocks();
});

function setup(
  options: {
    enabled?: boolean;
    trusted?: boolean;
    strictCalls?: string[];
  } = {},
) {
  const runtime = {
    workspaceId: 'ws',
    workspaceCwd: CWD,
    trusted: options.trusted ?? true,
    bridge: {},
  } as unknown as WorkspaceRuntime;
  const registry = { list: () => [runtime] } as unknown as WorkspaceRegistry;
  const mutate =
    (opts?: { strict?: boolean }): RequestHandler =>
    (req, _res, next) => {
      if (opts?.strict) options.strictCalls?.push(`${req.method} ${req.path}`);
      next();
    };
  const app = express();
  app.use(express.json());
  registerSessionAgentSquadRoutes(app, {
    workspaceRegistry: registry,
    mutate,
    isAgentCollaborationEnabledFor: () => options.enabled ?? true,
  });
  return app;
}

function changedFrames(): SessionAgentEventFrame[] {
  const frames: SessionAgentEventFrame[] = [];
  getSessionAgentEventHub(CWD).subscribe((frame) => {
    if (frame.type === 'changed') frames.push(frame);
  });
  return frames;
}

describe('squad routes', () => {
  it('lists squads as the store resolves them', async () => {
    store.listSquadViews.mockResolvedValue([{ id: SQUAD_ID, name: 'crew' }]);
    const response = await request(setup()).get(BASE);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ squads: [{ id: SQUAD_ID, name: 'crew' }] });
    expect(store.listSquadViews).toHaveBeenCalledWith(CWD);
  });

  it('is gated like the session-agent routes', async () => {
    expect((await request(setup({ enabled: false })).get(BASE)).body).toEqual({
      error: 'agent_collaboration_disabled',
    });
    expect((await request(setup({ trusted: false })).get(BASE)).status).toBe(
      403,
    );
    expect(store.listSquadViews).not.toHaveBeenCalled();
  });

  it('creates, updates and retires under strict mutate, announcing each change', async () => {
    const strictCalls: string[] = [];
    const app = setup({ strictCalls });
    const frames = changedFrames();
    store.createSquad.mockResolvedValue({ id: SQUAD_ID, name: 'crew' });
    store.updateSquad.mockResolvedValue({ id: SQUAD_ID, name: 'crew2' });
    store.retireSquad.mockResolvedValue({ id: SQUAD_ID, retiredAt: 1 });

    const created = await request(app)
      .post(BASE)
      .send({
        name: 'crew',
        leaderAgentId: 'ag_lead',
        members: [{ agentId: 'ag_a', role: 'tests' }],
        extra: 'ignored',
      });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ squad: { id: SQUAD_ID, name: 'crew' } });
    expect(store.createSquad).toHaveBeenCalledWith(CWD, {
      name: 'crew',
      description: undefined,
      instructions: undefined,
      leaderAgentId: 'ag_lead',
      members: [{ agentId: 'ag_a', role: 'tests' }],
    });

    const patched = await request(app)
      .patch(`${BASE}/${SQUAD_ID}`)
      .send({ name: 'crew2', description: null });
    expect(patched.status).toBe(200);
    // Only the fields sent are passed on; null clears.
    expect(store.updateSquad).toHaveBeenCalledWith(CWD, SQUAD_ID, {
      name: 'crew2',
      description: null,
    });

    const retired = await request(app).delete(`${BASE}/${SQUAD_ID}`);
    expect(retired.status).toBe(200);
    expect(store.retireSquad).toHaveBeenCalledWith(CWD, SQUAD_ID);

    expect(strictCalls).toEqual([
      `POST ${BASE}`,
      `PATCH ${BASE}/${SQUAD_ID}`,
      `DELETE ${BASE}/${SQUAD_ID}`,
    ]);
    expect(frames).toEqual([
      { type: 'changed', scope: 'squads' },
      { type: 'changed', scope: 'squads' },
      { type: 'changed', scope: 'squads' },
    ]);
  });

  it('maps store refusals to their status and code, and rejects bad ids', async () => {
    const { SquadStoreError } = await import(
      '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js'
    );
    store.createSquad.mockRejectedValue(
      new SquadStoreError(409, 'name_taken', '"bob" is already taken.'),
    );
    const app = setup();
    const refused = await request(app)
      .post(BASE)
      .send({ name: 'bob', leaderAgentId: 'ag_lead' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'name_taken',
      message: '"bob" is already taken.',
    });

    const badId = await request(app).patch(`${BASE}/not-a-squad`).send({});
    expect(badId.status).toBe(404);
    expect(store.updateSquad).not.toHaveBeenCalled();
  });
});
