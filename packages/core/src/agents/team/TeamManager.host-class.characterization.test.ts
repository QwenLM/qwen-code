/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Characterization test for #13785 (M4): what a real TeamManager does for
 * each class of host once every teammate has reported and terminated.
 *
 * It pins TODAY's behaviour and passes on current main. It is not a
 * statement of intended behaviour: the `afterM4` column records what the
 * issue asks for, so the diff that lands M4 is the diff that flips the
 * sinkless rows, at row level, instead of a reviewer re-deriving which host
 * class regressed.
 *
 * Host classes (A4 in the issue):
 *   wired         - leader sink attached (TUI, nonInteractiveCli)
 *   listener-only - a TEAMMATE_APPROVAL_REQUEST listener, no leader sink
 *   bare          - no listener, no sink: approval requests are void-emitted
 *                   (acp-integration, acp-bridge, serve, web-shell at the
 *                   time of writing)
 *
 * The four observations per class:
 *   delivered  - teammate reports handed to the leader sink
 *   unread     - reports still unread in the leader inbox afterwards
 *   terminated - ALL_TEAMMATES_TERMINATED events a subscribed host saw
 *   pollArmed  - whether the 500ms leader poll is still running
 *
 * `terminated` is probed with a subscription in every class. The single
 * emit site sits after the null-sink guard in pollLeaderInbox, so
 * subscribing does not help a sinkless host.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TeamCoordinationHarness } from './test-utils/coordination-harness.js';
import { Storage } from '../../config/storage.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { TeamEventType } from './team-events.js';

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

/** Longer than two 500ms leader polls, so every poll that will fire has. */
const POLL_WINDOW_MS = 1300;

const REPORTS = ['report one', 'report two'];

interface Observation {
  delivered: number;
  unread: number;
  terminated: number;
  pollArmed: boolean;
}

type HostClass = 'wired' | 'listener-only' | 'bare';

interface Row {
  host: HostClass;
  today: Observation;
  afterM4: Observation;
}

/**
 * Expectations, one row per host class. `afterM4` is the target stated in
 * #13785: a sinkless host either does not advertise team tools (no row to
 * observe) or gets the same terminal signal as a wired one. It is recorded
 * here as the delivery-equivalent outcome and is not asserted.
 */
const ROWS: Row[] = [
  {
    host: 'wired',
    today: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
    afterM4: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
  },
  {
    host: 'listener-only',
    today: { delivered: 0, unread: 2, terminated: 0, pollArmed: true },
    afterM4: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
  },
  {
    host: 'bare',
    today: { delivered: 0, unread: 2, terminated: 0, pollArmed: true },
    afterM4: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
  },
];

describe('host-class characterization of leader delivery and terminal state (#13785)', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function observe(host: HostClass): Promise<Observation> {
    const h = await TeamCoordinationHarness.create();
    setMockDir(h.tmpDir);
    harness = h;
    const manager = h.teamManager;

    const sinkCalls: string[] = [];
    if (host === 'wired') {
      manager.setLeaderMessageCallback((formatted) => {
        sinkCalls.push(formatted);
      });
    }
    if (host === 'listener-only') {
      manager
        .getEventEmitter()
        .on(TeamEventType.TEAMMATE_APPROVAL_REQUEST, () => {});
    }

    let terminated = 0;
    manager.getEventEmitter().on(TeamEventType.ALL_TEAMMATES_TERMINATED, () => {
      terminated += 1;
    });

    const agent = await h.spawnTeammate('worker');
    for (const text of REPORTS) {
      await manager.sendMessage('leader', text, 'worker');
    }
    agent.setStatus(AgentStatus.COMPLETED);

    await new Promise((resolve) => setTimeout(resolve, POLL_WINDOW_MS));

    const pollArmed =
      (manager as unknown as { pollingInterval: unknown }).pollingInterval !==
      null;
    // Draining here is the measurement of "left unread"; do it last.
    const unread = (await manager.getLeaderMessages()).length;
    const delivered = REPORTS.filter((text) =>
      sinkCalls.some((call) => call.includes(text)),
    ).length;

    return { delivered, unread, terminated, pollArmed };
  }

  it.each(ROWS)('$host host matches today column', async ({ host, today }) => {
    expect(await observe(host)).toEqual(today);
  });
});
