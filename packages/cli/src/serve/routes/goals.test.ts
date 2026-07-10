/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
}));

import type {
  BridgeSessionGoal,
  BridgeSessionSummary,
} from '@qwen-code/acp-bridge';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { registerGoalsRoutes, type GoalsSessionBridge } from './goals.js';

const WORKSPACE = '/w';

const summary = (
  sessionId: string,
  overrides: Partial<BridgeSessionSummary> = {},
): BridgeSessionSummary => ({
  sessionId,
  workspaceCwd: WORKSPACE,
  createdAt: new Date(0).toISOString(),
  clientCount: 1,
  hasActivePrompt: false,
  ...overrides,
});

const activeGoal = (
  condition: string,
  overrides: Partial<NonNullable<BridgeSessionGoal['active']>> = {},
): BridgeSessionGoal => ({
  active: { condition, iterations: 0, setAt: 1000, ...overrides },
});

const noGoal: BridgeSessionGoal = { active: null };

function makeApp(bridge: GoalsSessionBridge) {
  const app = express();
  registerGoalsRoutes(app, { boundWorkspace: WORKSPACE, bridge });
  return app;
}

describe('GET /goals', () => {
  it('returns an empty list when no session has a goal', async () => {
    const app = makeApp({
      listWorkspaceSessions: () => [summary('s1'), summary('s2')],
      getSessionGoal: async () => noGoal,
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ v: 1, goals: [], droppedCount: 0 });
  });

  it('projects each active goal onto its session, newest first', async () => {
    const goals: Record<string, BridgeSessionGoal> = {
      s1: activeGoal('fix flaky tests', {
        iterations: 3,
        setAt: 1000,
        lastReason: 'two tests still fail',
      }),
      s2: activeGoal('raise coverage', { setAt: 2000 }),
    };
    const app = makeApp({
      listWorkspaceSessions: () => [
        summary('s1', { displayName: 'fix-ci' }),
        summary('s2', { hasActivePrompt: true }),
      ],
      getSessionGoal: async (id) => goals[id],
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    expect(res.body.goals).toEqual([
      {
        sessionId: 's2',
        displayName: null,
        condition: 'raise coverage',
        iterations: 0,
        setAt: 2000,
        hasActivePrompt: true,
      },
      {
        sessionId: 's1',
        displayName: 'fix-ci',
        condition: 'fix flaky tests',
        iterations: 3,
        setAt: 1000,
        lastReason: 'two tests still fail',
        hasActivePrompt: false,
      },
    ]);
  });

  it('drops a session whose probe rejects rather than failing the whole list', async () => {
    vi.mocked(writeStderrLine).mockClear();
    const app = makeApp({
      listWorkspaceSessions: () => [summary('dead'), summary('alive')],
      getSessionGoal: async (id) => {
        if (id === 'dead') throw new Error('Session not found: dead');
        return activeGoal('keep going');
      },
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    expect(res.body.goals).toEqual([
      {
        sessionId: 'alive',
        displayName: null,
        condition: 'keep going',
        iterations: 0,
        setAt: 1000,
        hasActivePrompt: false,
      },
    ]);

    // An empty page and a page whose probes all failed look identical to the
    // client, so the drop must not be silent.
    expect(res.body.droppedCount).toBe(1);
    const logged = vi.mocked(writeStderrLine).mock.calls.map((c) => c[0]);
    expect(logged.join('\n')).toContain('could not probe 1 of 2 session(s)');
    expect(logged.join('\n')).toContain('dead: Session not found: dead');
  });

  it('reports a total brownout as dropped rather than as an empty workspace', async () => {
    // Without droppedCount the client cannot tell "no goals" from "we could not
    // ask", and users re-create goals that are already running.
    const app = makeApp({
      listWorkspaceSessions: () => [summary('a'), summary('b')],
      getSessionGoal: async () => {
        throw new Error('agent channel closed');
      },
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ v: 1, goals: [], droppedCount: 2 });
  });

  it('does not log when every probe succeeds', async () => {
    vi.mocked(writeStderrLine).mockClear();
    const app = makeApp({
      listWorkspaceSessions: () => [summary('s1')],
      getSessionGoal: async () => noGoal,
    });

    await request(app).get('/goals');

    expect(writeStderrLine).not.toHaveBeenCalled();
  });

  it('probes the live sessions concurrently, one call each', async () => {
    const getSessionGoal = vi.fn(async (_sessionId: string) => noGoal);
    const app = makeApp({
      listWorkspaceSessions: () => [
        summary('s1'),
        summary('s2'),
        summary('s3'),
      ],
      getSessionGoal,
    });

    await request(app).get('/goals');

    expect(getSessionGoal).toHaveBeenCalledTimes(3);
    expect(getSessionGoal.mock.calls.map((c) => c[0])).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('scopes the listing to the bound workspace', async () => {
    const listWorkspaceSessions = vi.fn(() => []);
    const app = makeApp({
      listWorkspaceSessions,
      getSessionGoal: async () => noGoal,
    });

    await request(app).get('/goals');

    expect(listWorkspaceSessions).toHaveBeenCalledWith(WORKSPACE);
  });

  it('returns 500 when enumerating sessions throws', async () => {
    const app = makeApp({
      listWorkspaceSessions: () => {
        throw new Error('bridge is shutting down');
      },
      getSessionGoal: async () => noGoal,
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('goals_read_failed');
  });

  it('caps how many sessions it probes at once', async () => {
    // Every probe is an IPC round-trip to a separate child process. A
    // workspace with many live sessions would otherwise open one per session
    // on every 10s poll from the Goals page.
    const sessions = Array.from({ length: 25 }, (_, i) => summary(`s${i}`));
    let inFlight = 0;
    let peak = 0;

    const app = makeApp({
      listWorkspaceSessions: () => sessions,
      getSessionGoal: async (id) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Yield so every probe the pool started is counted as concurrent.
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return activeGoal(`goal ${id}`);
      },
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    // All 25 are still probed — the cap bounds the burst, not the coverage.
    expect(res.body.goals).toHaveLength(25);
    expect(peak).toBe(10);
  });

  it('keeps a rejection attributed to the session that caused it', async () => {
    // Index alignment is what lets the drop log name the bad session. A
    // concurrency-limited fan-out that collects results out of order would
    // silently misattribute them.
    const sessions = [summary('good-1'), summary('bad'), summary('good-2')];
    const app = makeApp({
      listWorkspaceSessions: () => sessions,
      getSessionGoal: async (id) => {
        if (id === 'bad') throw new Error('child is wedged');
        return activeGoal(`goal ${id}`);
      },
    });

    const res = await request(app).get('/goals');

    expect(res.status).toBe(200);
    expect(res.body.droppedCount).toBe(1);
    expect(
      res.body.goals.map((g: { sessionId: string }) => g.sessionId),
    ).toEqual(expect.arrayContaining(['good-1', 'good-2']));
    expect(res.body.goals).toHaveLength(2);
  });
});
