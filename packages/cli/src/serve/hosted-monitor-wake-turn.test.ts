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
      harness(session, async () => undefined),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('settled');
    expect(agents.markConsumed).toHaveBeenCalledWith('run-1');
    expect(agents.markConsumed).toHaveBeenCalledTimes(1);
  });

  it('consumes nothing when the helper parks the turn for recovery', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => {
        throw new HostedToolRecoveryRequiredError(new Error('tool lost'));
      }),
      session,
    );
    await expect(turn(TURN)).resolves.toBe('settled');
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
    await expect(turn(TURN)).resolves.toBe('settled');
    expect(session.blocked).toBe(true);
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });

  it('never consumes a non-notification source or a plain answer', async () => {
    const { session, agents } = world();
    const turn = withChildAgentConsumption(
      harness(session, async () => undefined),
      session,
    );
    await expect(turn({ ...TURN, source: 'monitor' })).resolves.toBe('settled');
    await expect(turn({ ...TURN, turnId: 'run-1' })).resolves.toBe('settled');
    expect(agents.markConsumed).not.toHaveBeenCalled();
  });
});
