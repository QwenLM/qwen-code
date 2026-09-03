/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AgentViewSessionSnapshot } from '../../agent-view/protocol.js';
import { registerBackgroundAgentRoutes } from './background-agents.js';

const SESSION = '0f8e1c42-9d3a-4d21-8f77-2b6a7c9e0c31';

function snapshot(
  over: Partial<AgentViewSessionSnapshot> = {},
): AgentViewSessionSnapshot {
  const base = {
    schemaVersion: 1 as const,
    sessionId: SESSION,
    ownership: 'managed' as const,
    sessionState: 'needs_input' as const,
    processState: 'alive' as const,
    attachState: 'detached' as const,
    projectCwd: '/w/app',
    originalCwd: '/w/app',
    activeCwd: '/w/app',
    createdAt: '2026-09-04T11:58:00Z',
    updatedAt: '2026-09-04T11:59:00Z',
    worktree: { mode: 'none' as const },
  };
  return { sessionId: base.sessionId, state: base, ...over };
}

function appWith(listSnapshots: () => Promise<AgentViewSessionSnapshot[]>) {
  const app = express();
  registerBackgroundAgentRoutes(app, {
    listSnapshots: listSnapshots as never,
  });
  return app;
}

describe('GET /background-agents', () => {
  it('reports the sessions the supervisor is running', async () => {
    const response = await request(
      appWith(async () => [
        snapshot({
          rosterEntry: {
            sessionId: SESSION,
            projectCwd: '/w/app',
            activeCwd: '/w/app',
            displayName: 'release audit',
            createdAt: '2026-09-04T11:58:00Z',
            updatedAt: '2026-09-04T11:59:00Z',
          },
          worker: {
            schemaVersion: 1,
            workerPid: 777,
            protocolVersion: 1,
            platform: 'linux',
            recentOutputBytes: 0,
          },
        }),
      ]),
    ).get('/background-agents');

    expect(response.status).toBe(200);
    expect(response.body.agents).toEqual([
      {
        sessionId: SESSION,
        name: 'release audit',
        state: 'needs input',
        cwd: '/w/app',
        pid: 777,
        startedAt: '2026-09-04T11:58:00.000Z',
      },
    ]);
  });

  it('labels a failed session as failed, not as completed', async () => {
    // The roster's display group folds ready/stopped/failed together; a
    // client rendering this route has no icon tone to carry the
    // difference, so the label must.
    const response = await request(
      appWith(async () => [
        snapshot({ state: { ...snapshot().state, sessionState: 'failed' } }),
      ]),
    ).get('/background-agents');

    expect(response.body.agents[0].state).toBe('failed');
  });

  it('omits pid and startedAt rather than inventing them', async () => {
    const response = await request(
      appWith(async () => [
        snapshot({ state: { ...snapshot().state, createdAt: 'not-a-date' } }),
      ]),
    ).get('/background-agents');

    const agent = response.body.agents[0];
    expect(agent).not.toHaveProperty('pid');
    expect(agent).not.toHaveProperty('startedAt');
  });

  it('returns an empty list when nothing is running', async () => {
    const response = await request(appWith(async () => [])).get(
      '/background-agents',
    );
    expect(response.status).toBe(200);
    expect(response.body.agents).toEqual([]);
  });

  it('fails with 503 rather than reporting an unreadable store as empty', async () => {
    // A client that cannot tell "no agents" from "cannot look" would show
    // an empty list to someone whose agent is waiting for an answer.
    const response = await request(
      appWith(async () => {
        throw new Error('EACCES: permission denied');
      }),
    ).get('/background-agents');

    expect(response.status).toBe(503);
    // The daemon's error envelope: the human message under `error`, the
    // machine key under `code`, as in every other serve 503 a client can
    // classify by `body.code`.
    expect(response.body.error).toBe('Background agents are unavailable.');
    expect(response.body.code).toBe('background_agents_unavailable');
    expect(response.body.message).toContain('EACCES');
  });

  it('refuses to list anything for an untrusted workspace', async () => {
    // No injected responder: the gate must answer with the daemon's
    // canonical 403 envelope itself, or the request would hang.
    const app = express();
    registerBackgroundAgentRoutes(app, {
      listSnapshots: (async () => [snapshot()]) as never,
      isWorkspaceTrusted: () => false,
    });

    const response = await request(app).get('/background-agents');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(response.body).not.toHaveProperty('agents');
  });
});
