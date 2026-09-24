/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core/services/session-registry.js';
import type { AgentViewSessionSnapshot } from '../../agent-view/protocol.js';
import { registerBackgroundAgentRoutes } from './background-agents.js';

const SESSION = '0f8e1c42-9d3a-4d21-8f77-2b6a7c9e0c31';

/**
 * A pid that is genuinely running, because `managedSessionRows` verifies
 * liveness before reporting one: a hardcoded number is a dead process on
 * any machine that happens not to be running it, and the row would
 * arrive with no pid at all. Using this process's own pid tests the real
 * path instead of stubbing the check away.
 */
const LIVE_PID = process.pid;

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

/** A live-session registry record; the pid is live for the reason above. */
function record(
  over: Partial<SessionRegistryRecord> = {},
): SessionRegistryRecord {
  return {
    schemaVersion: 1,
    pid: LIVE_PID,
    procStart: null,
    pidNs: null,
    sessionId: SESSION,
    cwd: '/w/app',
    name: 'app-ab',
    startedAt: Date.parse('2026-09-04T11:58:00Z'),
    qwenVersion: '1.0.0',
    ...over,
  };
}

function appWith(
  listSnapshots: () => Promise<AgentViewSessionSnapshot[]>,
  // Empty by default, so a case that does not care about the registry
  // cannot pick up sessions live on the machine running the suite.
  listRecords: () => Promise<SessionRegistryRecord[]> = async () => [],
) {
  const app = express();
  registerBackgroundAgentRoutes(app, {
    listSnapshots: listSnapshots as never,
    listRecords: listRecords as never,
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
            workerPid: LIVE_PID,
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
        taskState: 'waiting',
        cwd: '/w/app',
        pid: LIVE_PID,
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

    expect(response.body.agents[0].taskState).toBe('failed');
  });

  it('reports a session whose worker is gone as failed, not as waiting', async () => {
    // The store outlives the supervisor and nothing reaps it, so a row can
    // still claim `needs_input` with no process behind it. A client
    // rendering this route would then tell the user an agent is waiting on
    // them when there is nothing left to answer. The supervisor's own heal
    // reaches the same verdict from the same evidence.
    const response = await request(appWith(async () => [snapshot()])).get(
      '/background-agents',
    );

    expect(response.body.agents[0].taskState).toBe('failed');
    expect(response.body.agents[0]).not.toHaveProperty('pid');
  });

  it('keeps the pid a live registry record proves, as `sessions ps` does', async () => {
    // The store has no pid yet — the launch window, or a `worker.json`
    // read that failed soft — while the worker has registered and is
    // alive. Reconciled without the merge, the row loses that pid and
    // reads `failed`, contradicting the CLI on the same session.
    const response = await request(
      appWith(
        async () => [
          snapshot({
            state: { ...snapshot().state, sessionState: 'working' },
          }),
        ],
        async () => [record()],
      ),
    ).get('/background-agents');

    expect(response.body.agents).toHaveLength(1);
    expect(response.body.agents[0].taskState).toBe('running');
    expect(response.body.agents[0].pid).toBe(LIVE_PID);
  });

  it('does not list an interactive session the merge appends', async () => {
    // `mergeSessionRows` appends every registry record no managed row
    // claimed; this route reports background agents only.
    const response = await request(
      appWith(
        async () => [],
        async () => [record({ sessionId: 'sess-interactive' })],
      ),
    ).get('/background-agents');

    expect(response.body.agents).toEqual([]);
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

  it('omits startedAt but keeps pid when only the stamp is unusable', async () => {
    // `pid` and `startedAt` are derived from independent sources in
    // `managedSessionRows`; a partial store write can spoil one without
    // the other, and the guards must not fail together.
    const response = await request(
      appWith(async () => [
        snapshot({
          state: { ...snapshot().state, createdAt: 'not-a-date' },
          worker: {
            schemaVersion: 1,
            workerPid: LIVE_PID,
            protocolVersion: 1,
            platform: 'linux',
            recentOutputBytes: 0,
          },
        }),
      ]),
    ).get('/background-agents');

    const agent = response.body.agents[0];
    expect(agent.pid).toBe(LIVE_PID);
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
