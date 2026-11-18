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
 * statement of intended behaviour. Scope: it builds a TeamManager directly,
 * below tool registration. M4 as specified gates registration
 * (`isAgentTeamEnabled()` behind `registerLazy(TEAM_CREATE)` in config.ts),
 * which is upstream of this harness, so landing M4 flips no row here: the
 * sinkless scenarios become unreachable and those rows get deleted, and the
 * registration gate needs its own test against a Config.
 *
 * Host classes (A4 in the issue):
 *   wired         - leader sink attached (TUI, nonInteractiveCli); the row
 *                   also runs nonInteractiveCli's final drainLeaderInbox()
 *   listener-only - a TEAMMATE_APPROVAL_REQUEST listener, no leader sink
 *   bare          - no listener, no sink: approval requests are void-emitted
 *                   (acp-integration, acp-bridge, serve, web-shell at the
 *                   time of writing)
 *
 * The four observations per class:
 *   delivered  - teammate reports handed to the leader sink. `null` for a
 *                sinkless class: there is no sink to observe, so the cell
 *                has no value to pin (0 would be unfalsifiable there).
 *   displayed  - the sink's second (on-screen) channel, which the TUI
 *                renders as one notification line per batch; `null` when
 *                sinkless
 *   unread     - reports still unread in the leader inbox afterwards
 *   terminated - ALL_TEAMMATES_TERMINATED events a subscribed host saw.
 *                The wired row sees two: the poll emits once, and the final
 *                drain re-enters the terminal branch and emits again.
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
import { getInboxesDir } from './teamHelpers.js';

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
  displayed: string[] | null;
  unread: number;
  terminated: number;
  pollArmed: boolean;
}

type HostClass = 'wired' | 'listener-only' | 'bare';

interface Row {
  host: HostClass;
  today: Observation;
}

/** Expectations, one row per host class. */
const ROWS: Row[] = [
  {
    host: 'wired',
    today: {
      delivered: 2,
      displayed: ['**worker** reported back'],
      unread: 0,
      terminated: 2,
      pollArmed: false,
    },
  },
  {
    host: 'listener-only',
    today: {
      delivered: null,
      displayed: null,
      unread: 2,
      terminated: 0,
      pollArmed: true,
    },
  },
  {
    host: 'bare',
    today: {
      delivered: null,
      displayed: null,
      unread: 2,
      terminated: 0,
      pollArmed: true,
    },
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
    // Pin the redirect through the real resolver: if the mailbox root ever
    // stops flowing through the mocked static, fail here instead of
    // reading and draining a real ~/.qwen/teams inbox.
    expect(getInboxesDir(h.teamName).startsWith(h.tmpDir)).toBe(true);
    const manager = h.teamManager;

    const sinkCalls: Array<{ model: string; display: string }> = [];
    if (host === 'wired') {
      manager.setLeaderMessageCallback((model, display) => {
        sinkCalls.push({ model, display });
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
      REPORTS.filter((text) =>
        sinkCalls.some((call) => call.model.includes(text)),
      ).length;

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
    // nonInteractiveCli awaits a final drain after its termination wait
    // loop (a last report can land between polls). The terminal branch is
    // not guarded by "polling was armed", so this emits a second time.
    if (host === 'wired') {
      await manager.drainLeaderInbox();
    }

    const pollArmed =
      (manager as unknown as { pollingInterval: unknown }).pollingInterval !==
      null;
    // Draining here is the measurement of "left unread"; do it last.
    const unread = (await manager.getLeaderMessages()).length;

    // Anything else on the sink is extra traffic the substring filter
    // would hide, e.g. a fireAndForget `<team_error>` envelope.
    expect(sinkCalls.filter((c) => c.model.includes('<team_error>'))).toEqual(
      [],
    );

    return {
      delivered: host === 'wired' ? deliveredCount() : null,
      displayed: host === 'wired' ? sinkCalls.map((c) => c.display) : null,
      unread,
      terminated,
      pollArmed,
    };
  }

  it.each(ROWS)('$host host matches today column', async ({ host, today }) => {
    expect(await observe(host)).toEqual(today);
  });
});
