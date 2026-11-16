/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a real `TeamManager` — real mailbox files, real 500 ms poll — through
 * the quiesce/resume pair a reversible session close depends on. The ACP-side
 * cases in `Session.test.ts` inject a fake manager and call the leader callback
 * directly, so they cannot see a poll that was stopped and never restarted;
 * these cases can. Reviewers of this PR asked for both halves: a poll that gets
 * stopped needs a matching resume, and at least one case has to drive the real
 * manager instead of a stand-in.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamCoordinationHarness } from './test-utils/coordination-harness.js';
import { writeMessage, type MailboxMessage } from './mailbox.js';
import { LEADER_NAME } from './types.js';
import { AgentStatus } from '../runtime/agent-types.js';

const report = (text: string): MailboxMessage => ({
  from: 'security',
  text,
  timestamp: new Date().toISOString(),
  read: false,
});

// Structural on purpose: `vi.spyOn(globalThis, 'setInterval')` resolves to an
// overloaded signature that `ReturnType<typeof vi.spyOn>` does not accept.
const pollIntervals = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => call[1] === 500).length;

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('leader inbox intake across quiesce and resume', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    vi.restoreAllMocks();
  });

  it('delivers a report written while intake was quiesced for a rolled-back close', async () => {
    harness = await TeamCoordinationHarness.create();
    await harness.spawnTeammate('security');
    const delivered: string[] = [];
    harness.teamManager.setLeaderMessageCallback((message) => {
      delivered.push(message);
    });

    // A closing session quiesces intake, and the report lands while it is down.
    await harness.teamManager.quiesceLeaderInbox();
    await writeMessage(harness.teamName, LEADER_NAME, report('after rollback'));
    await settle(700);
    expect(delivered).toEqual([]);

    // The close is rolled back: resuming intake must deliver it through the
    // same poll path, within one interval, or the report is marked read on disk
    // and lost for the rest of the session.
    harness.teamManager.resumeLeaderInboxPolling();
    await vi.waitFor(() => expect(delivered).toHaveLength(1), {
      timeout: 4000,
    });
    expect(delivered[0]).toContain('after rollback');
  });

  it('does not double the poll or redeliver a report it already consumed', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    harness = await TeamCoordinationHarness.create();
    await harness.spawnTeammate('security');
    const delivered: string[] = [];
    harness.teamManager.setLeaderMessageCallback((message) => {
      delivered.push(message);
    });
    await writeMessage(harness.teamName, LEADER_NAME, report('only once'));

    await vi.waitFor(() => expect(delivered).toHaveLength(1), {
      timeout: 4000,
    });
    const startedBySpawn = pollIntervals(intervals);
    expect(startedBySpawn).toBe(1);

    // Resuming intake that never stopped adds no second interval, and a row the
    // poll already consumed is not delivered again.
    harness.teamManager.resumeLeaderInboxPolling();
    harness.teamManager.resumeLeaderInboxPolling();
    await settle(1200);
    expect(delivered).toHaveLength(1);
    expect(pollIntervals(intervals)).toBe(startedBySpawn);
  });

  it('stays a no-op once every teammate is terminal', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    harness = await TeamCoordinationHarness.create();
    await harness.spawnTeammate('security');
    harness.teamManager.setLeaderMessageCallback(() => {});
    await harness.teamManager.quiesceLeaderInbox();
    const before = pollIntervals(intervals);

    harness.getAgent('security').setStatus(AgentStatus.COMPLETED);
    harness.teamManager.resumeLeaderInboxPolling();
    await settle(700);

    // Restarting a poll for a team that is gone would only re-publish
    // ALL_TEAMMATES_TERMINATED, so the resume has to decline.
    expect(pollIntervals(intervals)).toBe(before);
  });
});
