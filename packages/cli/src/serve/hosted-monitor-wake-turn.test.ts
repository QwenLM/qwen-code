/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import {
  createMonitorWakeRunTurn,
  withChildAgentConsumption,
} from './hosted-monitor-wake-turn.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import {
  HostedMonitorWakeScheduler,
  type HostedMonitorWakeTurn,
} from './hosted-monitor-wake.js';
import type { HostedChildAgentSession } from './hosted-child-agent-session.js';

function world() {
  const agents = {
    markConsumed: vi.fn(async (_childRunId: string) => null),
  };
  const session = {
    blocked: false,
    childAgents: agents as unknown as HostedChildAgentSession,
    managed: {
      sink: {
        project: vi.fn(async () => [] as ChatRecord[]),
        write: vi.fn(async () => undefined),
      },
    },
  };
  return { session, agents };
}

const TURN: HostedMonitorWakeTurn = {
  turnId: 'run-1:accept:notify',
  text: 'the audit finished',
  source: 'child_agent',
};

function harness(
  session: ReturnType<typeof world>['session'],
  run: () => Promise<unknown>,
) {
  return createMonitorWakeRunTurn({
    session,
    sessionId: 'session-1',
    cwd: '/work',
    executeHostedTurn: () => run(),
    busy: () => false,
    needsRecovery: (cause) => cause instanceof HostedToolRecoveryRequiredError,
    writeStderr: () => {},
  });
}

describe('withChildAgentConsumption', () => {
  it('settles a queued cancellation without entering the model', async () => {
    const { session } = world();
    const execute = vi.fn();
    const runTurn = createMonitorWakeRunTurn({
      session,
      sessionId: 'session-1',
      cwd: '/work',
      executeHostedTurn: execute,
      busy: () => false,
      needsRecovery: () => false,
      writeStderr: () => {},
      cancelled: () => true,
    });
    await expect(runTurn(TURN)).resolves.toBe('settled_incomplete');
    expect(execute).not.toHaveBeenCalled();
    expect(session.managed.sink.write).toHaveBeenCalledOnce();
    expect(session.managed.sink.write).toHaveBeenCalledWith(
      expect.objectContaining({
        subtype: 'turn_result',
        systemPayload: expect.objectContaining({
          promptId: TURN.turnId,
          state: 'cancelled',
        }),
      }),
    );
  });

  it('rechecks cancellation after awaiting the attempt read', async () => {
    const { session } = world();
    let cancelled = false;
    session.managed.sink.project.mockImplementationOnce(async () => {
      cancelled = true;
      return [];
    });
    const execute = vi.fn();
    const runTurn = createMonitorWakeRunTurn({
      session,
      sessionId: 'session-1',
      cwd: '/work',
      executeHostedTurn: execute,
      busy: () => false,
      needsRecovery: () => false,
      writeStderr: () => {},
      cancelled: () => cancelled,
    });
    await expect(runTurn(TURN)).resolves.toBe('settled_incomplete');
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries a failed queued-cancel commit through the scheduler and continues later work', async () => {
    const { session } = world();
    const queue = [TURN, { ...TURN, turnId: 'later-turn' }];
    session.managed.sink.write
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockImplementationOnce(async () => {
        queue.shift();
      });
    const execute = vi.fn(async () => {
      queue.shift();
      return { systemPayload: { state: 'completed' } };
    });
    const writeStderr = vi.fn();
    const runTurn = createMonitorWakeRunTurn({
      session,
      sessionId: 'session-1',
      cwd: '/work',
      executeHostedTurn: execute,
      busy: () => false,
      needsRecovery: () => false,
      writeStderr,
      cancelled: (turn) => turn.turnId === TURN.turnId,
    });
    const failed = vi.fn(() => {
      session.blocked = true;
    });
    const scheduler = new HostedMonitorWakeScheduler(
      {
        next: async () => queue[0],
        state: () => (session.blocked ? 'blocked' : 'idle'),
        runTurn,
        failed,
      },
      10,
    );
    vi.useFakeTimers();
    try {
      scheduler.kick();
      await vi.advanceTimersByTimeAsync(50);
      expect(session.blocked).toBe(false);
      expect(failed).not.toHaveBeenCalled();
      expect(queue).toEqual([]);
      expect(session.managed.sink.write).toHaveBeenCalledTimes(2);
      expect(session.managed.sink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPayload: expect.objectContaining({
            promptId: TURN.turnId,
            state: 'cancelled',
          }),
        }),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        'later-turn',
        TURN.text,
        expect.any(AbortController),
      );
      expect(writeStderr).toHaveBeenCalledWith(
        expect.stringContaining('store unavailable'),
      );
    } finally {
      scheduler.close();
      vi.useRealTimers();
    }
  });

  it('marks the result consumed after the wake turn settles durably', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => ({
        systemPayload: { state: 'completed' },
      })),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('settled');
    expect(agents.markConsumed).toHaveBeenCalledWith('run-1');
    expect(agents.markConsumed).toHaveBeenCalledTimes(1);
  });

  // #13803 (K2): a workflow child's acceptance notification consumes
  // through the same gate — its wake source names the record's own kind.
  it('marks a workflow child result consumed the same way', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => ({
        systemPayload: { state: 'completed' },
      })),
      session,
    );
    await expect(turn({ ...TURN, source: 'workflow' })).resolves.toBe(
      'settled',
    );
    expect(agents.markConsumed).toHaveBeenCalledWith('run-1');
    expect(agents.markConsumed).toHaveBeenCalledTimes(1);
  });

  // R1-74: a cancelled or errored wake burns the input, so the pump still
  // advances — but the acceptance stays at accepting: the consumption
  // gate only fires for a turn that actually completed.
  it('consumes nothing when the wake settles cancelled', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => ({
        systemPayload: { state: 'cancelled' },
      })),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('settled_incomplete');
    expect(session.blocked).toBe(false);
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });

  // R1-4's sibling arm: a rejected consume commit must never turn the
  // completed wake into a Session block — the acceptance stays owed and
  // the refusal only logs.
  it('isolates a rejected consume commit behind the settled wake', async () => {
    const { session, agents } = world();
    agents.markConsumed.mockRejectedValueOnce(new Error('store lost'));
    const lines: string[] = [];
    const turn = withChildAgentConsumption(
      harness(session, async () => ({
        systemPayload: { state: 'completed' },
      })),
      session,
      (line) => lines.push(line),
    );
    await expect(turn(TURN)).resolves.toBe('settled');
    expect(session.blocked).toBe(false);
    expect(lines.join('\n')).toContain('consumption faltered');
  });

  it('consumes nothing when the helper parks the turn for recovery', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => {
        throw new HostedToolRecoveryRequiredError(new Error('tool lost'));
      }),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('recovery');
    expect(session.blocked).toBe(true);
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });

  it('consumes nothing when a prior attempt already ran and died', async () => {
    const { session, agents } = world();
    session.managed.sink.project.mockResolvedValue([
      { daemonPromptId: TURN.turnId } as unknown as ChatRecord,
    ]);
    const turn = withChildAgentConsumption(
      harness(session, async () => {
        throw new Error('never driven');
      }),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('recovery');
    expect(session.blocked).toBe(true);
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });

  it('never consumes a non-notification source or a plain answer', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => ({
        systemPayload: { state: 'completed' },
      })),
      session,
    );
    await expect(turn({ ...TURN, source: 'monitor' })).resolves.toBe('settled');
    await expect(turn({ ...TURN, turnId: 'run-1' })).resolves.toBe('settled');
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });
});
