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
import type { HostedMonitorWakeTurn } from './hosted-monitor-wake.js';
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
