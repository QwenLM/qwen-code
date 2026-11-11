/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TeamCoordinationHarness } from './test-utils/coordination-harness.js';
import { Storage } from '../../config/storage.js';
import { AgentStatus } from '../runtime/agent-types.js';
import { TeamEventType } from './team-events.js';
import { writeMessage } from './mailbox.js';

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

describe('TeamManager leader inbox polling', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function createHarness(): Promise<TeamCoordinationHarness> {
    const h = await TeamCoordinationHarness.create();
    (
      Storage as unknown as { __setMockGlobalDir: (d: string) => void }
    ).__setMockGlobalDir(h.tmpDir);
    harness = h;
    return h;
  }

  it('reports polling state through isLeaderInboxPolling', async () => {
    const h = await createHarness();
    expect(h.teamManager.isLeaderInboxPolling()).toBe(false);

    await h.spawnTeammate('worker');
    expect(h.teamManager.isLeaderInboxPolling()).toBe(true);

    h.teamManager.stopLeaderInboxPolling();
    expect(h.teamManager.isLeaderInboxPolling()).toBe(false);
  });

  it('keeps polling and delivers a report written after the empty read when the teammate then terminates', async () => {
    const h = await createHarness();
    const worker = await h.spawnTeammate('worker');
    h.teamManager.stopLeaderInboxPolling();
    worker.setStatus(AgentStatus.RUNNING);

    const delivered: string[] = [];
    h.teamManager.setLeaderMessageCallback((message) => {
      delivered.push(message);
    });
    const terminated = vi.fn();
    h.teamManager
      .getEventEmitter()
      .on(TeamEventType.ALL_TEAMMATES_TERMINATED, terminated);

    // The teammate writes its final report and exits right after the
    // leader's inbox read came back empty.
    const manager = h.teamManager as unknown as {
      consumeLeaderInbox: () => Promise<unknown[]>;
    };
    const realConsume = manager.consumeLeaderInbox.bind(manager);
    vi.spyOn(manager, 'consumeLeaderInbox').mockImplementationOnce(async () => {
      const snapshot = await realConsume();
      await writeMessage(h.teamName, 'leader', {
        from: 'worker',
        text: 'final report',
        timestamp: new Date().toISOString(),
        read: false,
      });
      worker.setStatus(AgentStatus.COMPLETED);
      return snapshot;
    });

    await h.teamManager.drainLeaderInbox();
    expect(delivered).toEqual([]);
    expect(terminated).not.toHaveBeenCalled();

    await h.teamManager.drainLeaderInbox();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('final report');
    expect(terminated).not.toHaveBeenCalled();

    await h.teamManager.drainLeaderInbox();
    expect(terminated).toHaveBeenCalledTimes(1);
    expect(h.teamManager.isLeaderInboxPolling()).toBe(false);
  });

  it('keeps polling when a new teammate is spawned while consumeLeaderInbox is awaiting', async () => {
    const h = await createHarness();
    const worker = await h.spawnTeammate('worker');
    expect(h.teamManager.isLeaderInboxPolling()).toBe(true);
    worker.setStatus(AgentStatus.COMPLETED);

    h.teamManager.setLeaderMessageCallback(() => {});
    const terminated = vi.fn();
    h.teamManager
      .getEventEmitter()
      .on(TeamEventType.ALL_TEAMMATES_TERMINATED, terminated);

    const manager = h.teamManager as unknown as {
      consumeLeaderInbox: () => Promise<unknown[]>;
    };
    const realConsume = manager.consumeLeaderInbox.bind(manager);
    vi.spyOn(manager, 'consumeLeaderInbox').mockImplementationOnce(async () => {
      const snapshot = await realConsume();
      await h.spawnTeammate('worker2');
      return snapshot;
    });

    await h.teamManager.drainLeaderInbox();
    expect(h.teamManager.isLeaderInboxPolling()).toBe(true);
    expect(terminated).not.toHaveBeenCalled();
  });
});
