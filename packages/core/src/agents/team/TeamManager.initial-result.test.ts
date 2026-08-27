/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for #10211: the initial teammate round can complete
 * (final round text + IDLE) before TeamManager.setupEventBridge attaches,
 * because spawnTeammate awaits backend.spawnAgent() first and the emitter
 * does not buffer events for late subscribers. The leader must still
 * receive the initial round's result exactly once.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TeamCoordinationHarness } from './test-utils/coordination-harness.js';
import { Storage } from '../../config/storage.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { AgentEventType } from '../runtime/agent-events.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

/** Let queued fire-and-forget coordination work settle. */
async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('initial teammate result before event bridge attachment (#10211)', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function createHarness(): Promise<TeamCoordinationHarness> {
    const h = await TeamCoordinationHarness.create();
    setMockDir(h.tmpDir);
    harness = h;
    return h;
  }

  it('reports final text to the leader when the initial round completes before spawnAgent resolves', async () => {
    const h = await createHarness();

    // onStart runs inside FakeBackend.spawnAgent(), i.e. before
    // TeamManager.setupEventBridge() subscribes. Emits the final round
    // text and settles IDLE while spawnAgent() is still resolving —
    // the in-process race from the issue.
    await h.spawnTeammate('worker', {
      onStart: (agent) => {
        agent.setStatus(AgentStatus.RUNNING);
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'initial result',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.setStatus(AgentStatus.IDLE);
      },
    });

    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({
          from: 'worker',
          text: 'initial result',
        }),
      ]);
    });

    // Exactly once: after coordination settles, no duplicate report
    // for the same round may arrive.
    await settleAsyncWork();
    expect(await h.teamManager.getLeaderMessages()).toEqual([]);
  });

  it('does not re-report the initial result when a later round completes live', async () => {
    const h = await createHarness();

    await h.spawnTeammate('worker', {
      onStart: (agent) => {
        agent.setStatus(AgentStatus.RUNNING);
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'initial result',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.setStatus(AgentStatus.IDLE);
      },
      onMessage: (_message, agent) => {
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 2,
          text: 'follow-up result',
          thoughtText: '',
          timestamp: Date.now(),
        });
      },
    });

    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({ text: 'initial result' }),
      ]);
    });

    await h.teamManager.sendMessage('worker', 'next task', 'leader');
    await h.waitForStatus('worker', AgentStatus.IDLE);

    // The live second round reports its own text exactly once; the
    // pre-attach initial result must not be reported again.
    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({ text: 'follow-up result' }),
      ]);
    });

    await settleAsyncWork();
    expect(await h.teamManager.getLeaderMessages()).toEqual([]);
  });

  it('does not report anything at spawn when no round ran before the bridge attached', async () => {
    const h = await createHarness();

    // Plain spawn: the harness agent is IDLE at attach time but never
    // emitted round text (no pre-attach round). The attach-time
    // reconciliation must not invent a report.
    await h.spawnTeammate('worker');
    await settleAsyncWork();

    expect(await h.teamManager.getLeaderMessages()).toEqual([]);

    // The live path still works afterwards.
    await h.teamManager.sendMessage('worker', 'task', 'leader');
    await h.waitForStatus('worker', AgentStatus.IDLE);
    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(
            'completed a turn without a model-visible final answer',
          ),
        }),
      ]);
    });
  });

  it('still reports the recovered result when the teammate sent an explicit leader message pre-attach', async () => {
    const h = await createHarness();

    // The default initialTask prompt instructs teammates to report via
    // send_message(to: "leader"). Such a send goes through
    // TeamManager.sendMessage synchronously — no event bridge needed —
    // and marks the sender as having reported explicitly. The seed must
    // clear that flag exactly like the live onRoundText handler does,
    // or the replayed IDLE settlement skips the recovered answer and
    // the leader receives zero automatic reports of the initial result.
    await h.spawnTeammate('worker', {
      onStart: async (agent) => {
        agent.setStatus(AgentStatus.RUNNING);
        await h.teamManager.sendMessage('leader', 'progress note', 'worker');
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'initial result',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.setStatus(AgentStatus.IDLE);
      },
    });

    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({ from: 'worker', text: 'progress note' }),
        expect.objectContaining({ from: 'worker', text: 'initial result' }),
      ]);
    });

    // Exactly once: the explicit note plus one automatic forwarding.
    await settleAsyncWork();
    expect(await h.teamManager.getLeaderMessages()).toEqual([]);
  });

  it('reports the last pre-attach round text when the round had multiple turns', async () => {
    const h = await createHarness();

    // A multi-turn pre-attach round emits several ROUND_TEXT events;
    // the recovery scan must walk the history backwards so the most
    // recent non-empty visible answer wins, not the earliest one.
    await h.spawnTeammate('worker', {
      onStart: (agent) => {
        agent.setStatus(AgentStatus.RUNNING);
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'early turn answer',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'final turn answer',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.setStatus(AgentStatus.IDLE);
      },
    });

    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({
          from: 'worker',
          text: 'final turn answer',
        }),
      ]);
    });

    // The earlier turn text must never be reported on its own.
    await settleAsyncWork();
    expect(await h.teamManager.getLeaderMessages()).toEqual([]);
  });

  it('never reports thought-only round text, falling back to the earlier visible answer', async () => {
    const h = await createHarness();

    // AgentCore emits ROUND_TEXT whenever roundThoughtText is
    // non-empty, so a trailing thought-only event is a reachable
    // pre-attach shape. The recovery must skip thought messages and
    // never surface internal reasoning as the round's final answer.
    await h.spawnTeammate('worker', {
      onStart: (agent) => {
        agent.setStatus(AgentStatus.RUNNING);
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: 'visible answer',
          thoughtText: '',
          timestamp: Date.now(),
        });
        agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
          subagentId: agent.agentId,
          round: 1,
          text: '',
          thoughtText: 'internal reasoning about the task',
          timestamp: Date.now(),
        });
        agent.setStatus(AgentStatus.IDLE);
      },
    });

    await vi.waitFor(async () => {
      expect(await h.teamManager.getLeaderMessages()).toEqual([
        expect.objectContaining({ from: 'worker', text: 'visible answer' }),
      ]);
    });

    // Nothing else — in particular no thought content — may arrive.
    await settleAsyncWork();
    expect(await h.teamManager.getLeaderMessages()).toEqual([]);
  });
});
