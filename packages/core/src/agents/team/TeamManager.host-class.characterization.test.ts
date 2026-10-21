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
 *   delivered  - teammate reports handed to the leader sink. `null` for a
 *                sinkless class: there is no sink to observe, so the cell
 *                has no value to pin (0 would be unfalsifiable there).
 *   unread     - reports still unread in the leader inbox afterwards
 *   terminated - ALL_TEAMMATES_TERMINATED events a subscribed host saw
 *   pollArmed  - whether the 500ms leader poll is still running
 *
 * `terminated` is probed with a subscription in every class. The single
 * emit site sits after the null-sink guard in pollLeaderInbox, so
 * subscribing does not help a sinkless host.
 *
 * Timing: only setInterval/clearInterval are faked, so the two 500ms polls
 * are stepped explicitly and the real file I/O between them is awaited on a
 * settling condition. No assertion depends on a wall-clock margin.
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

/** The leader poll period in TeamManager. */
const POLL_MS = 500;
/** Upper bound for real file I/O to settle; only ever reached on failure. */
const SETTLE_DEADLINE_MS = 10_000;

const REPORTS = ['report one', 'report two'];

interface Observation {
  /** `null` = no sink attached, nothing to observe. */
  delivered: number | null;
  unread: number;
  terminated: number;
  pollArmed: boolean;
}

type HostClass = 'wired' | 'listener-only' | 'bare';

/**
 * #13785 acceptance for a sinkless host: it never sees team tools at all,
 * so there is no row to observe, rather than delivery parity with a wired
 * host.
 */
const NOT_ADVERTISED = 'team tools not advertised' as const;

interface Row {
  host: HostClass;
  today: Observation;
  /** Asserted nowhere; `observe()` has no path to produce `NOT_ADVERTISED`. */
  afterM4: Observation | typeof NOT_ADVERTISED;
}

/** Expectations, one row per host class. `afterM4` is not asserted. */
const ROWS: Row[] = [
  {
    host: 'wired',
    today: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
    afterM4: { delivered: 2, unread: 0, terminated: 1, pollArmed: false },
  },
  {
    host: 'listener-only',
    today: { delivered: null, unread: 2, terminated: 0, pollArmed: true },
    afterM4: NOT_ADVERTISED,
  },
  {
    host: 'bare',
    today: { delivered: null, unread: 2, terminated: 0, pollArmed: true },
    afterM4: NOT_ADVERTISED,
  },
];

describe('host-class characterization of leader delivery and terminal state (#13785)', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await harness?.cleanup();
    harness = undefined;
  });

  /** Let real file I/O finish; true polling on a condition, not a delay. */
  async function settle(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + SETTLE_DEADLINE_MS;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function observe(host: HostClass): Promise<Observation> {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

    const deliveredCount = () =>
      REPORTS.filter((text) => sinkCalls.some((call) => call.includes(text)))
        .length;

    // Poll 1 consumes the reports; poll 2 finds an empty inbox and, with
    // every teammate terminated, emits ALL_TEAMMATES_TERMINATED. A sinkless
    // host returns before any I/O, so stepping its ticks needs no settling.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    if (host === 'wired') {
      await settle(() => deliveredCount() === REPORTS.length);
    }
    await vi.advanceTimersByTimeAsync(POLL_MS);
    if (host === 'wired') {
      await settle(() => terminated === 1);
    }
    // One more tick: a sinkless host stays armed, a wired one is already
    // stopped, so this cannot flip any cell in the direction of a pass.
    await vi.advanceTimersByTimeAsync(POLL_MS);

    const pollArmed =
      (manager as unknown as { pollingInterval: unknown }).pollingInterval !==
      null;
    // Draining here is the measurement of "left unread"; do it last.
    const unread = (await manager.getLeaderMessages()).length;

    return {
      delivered: host === 'wired' ? deliveredCount() : null,
      unread,
      terminated,
      pollArmed,
    };
  }

  it.each(ROWS)('$host host matches today column', async ({ host, today }) => {
    expect(await observe(host)).toEqual(today);
  });
});
