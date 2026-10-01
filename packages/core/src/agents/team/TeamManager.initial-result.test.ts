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
import type { FakeAgent } from './test-utils/fake-agent.js';
import { Storage } from '../../config/storage.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { AgentEventType } from '../runtime/agent-events.js';
import { TeamEventType, type MessageSentEvent } from './team-events.js';

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

async function runUntilLeaderMessages(
  h: TeamCoordinationHarness,
  expectedCount: number,
  action: () => Promise<unknown>,
) {
  const emitter = h.teamManager.getEventEmitter();
  let observedCount = 0;
  let resolveMessages!: () => void;
  const messagesSent = new Promise<void>((resolve) => {
    resolveMessages = resolve;
  });
  const onMessageSent = (event: MessageSentEvent) => {
    if (event.to !== 'leader') return;
    observedCount += 1;
    if (observedCount === expectedCount) resolveMessages();
  };
  emitter.on(TeamEventType.MESSAGE_SENT, onMessageSent);

  try {
    await action();
    await messagesSent;
    return h.teamManager.getLeaderMessages();
  } finally {
    emitter.off(TeamEventType.MESSAGE_SENT, onMessageSent);
  }
}

/** Emit one ROUND_TEXT event the way AgentCore does at the end of a turn. */
function emitRound(agent: FakeAgent, text: string, round = 1, thought = '') {
  agent.getEventEmitter().emit(AgentEventType.ROUND_TEXT, {
    subagentId: agent.agentId,
    round,
    text,
    thoughtText: thought,
    timestamp: Date.now(),
  });
}

/** onStart script for a pre-attach initial round: RUNNING, texts, IDLE. */
function initialRound(...texts: string[]) {
  return (agent: FakeAgent) => {
    agent.setStatus(AgentStatus.RUNNING);
    for (const text of texts) emitRound(agent, text);
    agent.setStatus(AgentStatus.IDLE);
  };
}

/** Exactly once: after coordination settles, no further report arrives. */
async function expectNoMoreReports(h: TeamCoordinationHarness) {
  await settleAsyncWork();
  expect(await h.teamManager.getLeaderMessages()).toEqual([]);
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
    // TeamManager.setupEventBridge() subscribes: final round text and IDLE
    // land while spawnAgent() is still resolving (the race from the issue).
    const messages = await runUntilLeaderMessages(h, 1, () =>
      h.spawnTeammate('worker', { onStart: initialRound('initial result') }),
    );

    expect(messages).toEqual([
      expect.objectContaining({ from: 'worker', text: 'initial result' }),
    ]);
    await expectNoMoreReports(h);
  });

  it('does not re-report the initial result when a later round completes live', async () => {
    const h = await createHarness();

    const initialMessages = await runUntilLeaderMessages(h, 1, () =>
      h.spawnTeammate('worker', {
        onStart: initialRound('initial result'),
        onMessage: (_message, agent) => emitRound(agent, 'follow-up result', 2),
      }),
    );

    expect(initialMessages).toEqual([
      expect.objectContaining({ text: 'initial result' }),
    ]);

    const followUpMessages = await runUntilLeaderMessages(h, 1, () =>
      h.teamManager.sendMessage('worker', 'next task', 'leader'),
    );

    // The live second round reports its own text exactly once; the
    // pre-attach initial result must not be reported again.
    expect(followUpMessages).toEqual([
      expect.objectContaining({ text: 'follow-up result' }),
    ]);
    await expectNoMoreReports(h);
  });

  it('does not report anything at spawn when no round ran before the bridge attached', async () => {
    const h = await createHarness();

    // Plain spawn: IDLE at attach time but no pre-attach round text. The
    // attach-time reconciliation must not invent a report.
    await h.spawnTeammate('worker');
    await expectNoMoreReports(h);

    // The live path still works afterwards.
    const messages = await runUntilLeaderMessages(h, 1, () =>
      h.teamManager.sendMessage('worker', 'task', 'leader'),
    );
    expect(messages).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          'completed a turn without a model-visible final answer',
        ),
      }),
    ]);
  });

  it('still reports the recovered result when the teammate sent an explicit leader message pre-attach', async () => {
    const h = await createHarness();

    // The default initialTask prompt has teammates report via
    // send_message(to: "leader"), which goes through TeamManager.sendMessage
    // synchronously (no bridge needed) and marks the sender as having
    // reported explicitly. The seed must clear that flag like the live
    // onRoundText handler does, or the replayed IDLE settlement skips the
    // recovered answer and the leader gets no automatic report at all.
    const messages = await runUntilLeaderMessages(h, 2, () =>
      h.spawnTeammate('worker', {
        onStart: async (agent) => {
          agent.setStatus(AgentStatus.RUNNING);
          await h.teamManager.sendMessage('leader', 'progress note', 'worker');
          emitRound(agent, 'initial result');
          agent.setStatus(AgentStatus.IDLE);
        },
      }),
    );

    expect(messages).toEqual([
      expect.objectContaining({ from: 'worker', text: 'progress note' }),
      expect.objectContaining({ from: 'worker', text: 'initial result' }),
    ]);
    // Exactly once: the explicit note plus one automatic forwarding.
    await expectNoMoreReports(h);
  });

  it('reports the last pre-attach round text when the round had multiple turns', async () => {
    const h = await createHarness();

    // A multi-turn pre-attach round emits several ROUND_TEXT events; the
    // recovery scan walks the history backwards so the most recent non-empty
    // visible answer wins, not the earliest one.
    const messages = await runUntilLeaderMessages(h, 1, () =>
      h.spawnTeammate('worker', {
        onStart: initialRound('early turn answer', 'final turn answer'),
      }),
    );

    expect(messages).toEqual([
      expect.objectContaining({ from: 'worker', text: 'final turn answer' }),
    ]);
    // The earlier turn text must never be reported on its own.
    await expectNoMoreReports(h);
  });

  it('never reports thought-only round text, falling back to the earlier visible answer', async () => {
    const h = await createHarness();

    // AgentCore emits ROUND_TEXT whenever roundThoughtText is non-empty, so
    // a trailing thought-only event is a reachable pre-attach shape. Recovery
    // must skip it and never surface internal reasoning as the final answer.
    const messages = await runUntilLeaderMessages(h, 1, () =>
      h.spawnTeammate('worker', {
        onStart: (agent) => {
          agent.setStatus(AgentStatus.RUNNING);
          emitRound(agent, 'visible answer');
          emitRound(agent, '', 1, 'internal reasoning about the task');
          agent.setStatus(AgentStatus.IDLE);
        },
      }),
    );

    expect(messages).toEqual([
      expect.objectContaining({ from: 'worker', text: 'visible answer' }),
    ]);
    // Nothing else, in particular no thought content, may arrive.
    await expectNoMoreReports(h);
  });
});
