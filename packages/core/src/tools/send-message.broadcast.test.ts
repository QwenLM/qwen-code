/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Broadcast delivery-outcome contract for send_message(to: "*") — #10072.
 *
 * Uses the real TeamManager (via TeamCoordinationHarness) so a delivery
 * rejects the same way it does in production: a recipient terminates
 * between the member snapshot and the send, its per-agent queue is
 * dropped, and sendMessage refuses the delivery.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SendMessageTool } from './send-message.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import type { ApprovalMode, Config } from '../config/config.js';
import type { TeamManager } from '../agents/team/TeamManager.js';
import { TeamCoordinationHarness } from '../agents/team/test-utils/coordination-harness.js';

// Mock Storage so all file I/O uses the harness's temp dir.
vi.mock('../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../config/storage.js')>();
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

import { Storage } from '../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

function makeConfig(teamManager: TeamManager): Config {
  return {
    getTeamManager: () => teamManager,
    getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
    getApprovalMode: () => 'default' as ApprovalMode,
  } as unknown as Config;
}

describe('SendMessageTool — broadcast delivery outcomes (#10072)', () => {
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

  function broadcastInvocation(h: TeamCoordinationHarness) {
    const tool = new SendMessageTool(makeConfig(h.teamManager));
    return tool.build({ to: '*', message: 'sync for everyone' });
  }

  it('does not claim complete success when a delivery is rejected', async () => {
    const h = await createHarness();
    await h.spawnTeammate('alice');
    const bob = await h.spawnTeammate('bob');

    // bob terminates between the member snapshot and the send: its
    // queue is dropped, so its delivery rejects while alice's lands.
    await bob.shutdown();

    const result = await broadcastInvocation(h).execute(
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    // Must not claim that every teammate received the message…
    expect(result.llmContent).not.toBe('Message broadcast to all teammates.');
    // …and must name the recipient that was not reached.
    expect(String(result.llmContent)).toContain('bob');
  });

  it('still reports complete success when every delivery lands', async () => {
    const h = await createHarness();
    const alice = await h.spawnTeammate('alice');
    await h.spawnTeammate('bob');

    const result = await broadcastInvocation(h).execute(
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toBe('Message broadcast to all teammates.');
    await h.waitForMessages('alice', 1);
    await h.waitForMessages('bob', 1);
    expect(alice.getReceivedMessages()).toHaveLength(1);
  });

  it('reports failure when no delivery lands', async () => {
    const h = await createHarness();
    const alice = await h.spawnTeammate('alice');
    const bob = await h.spawnTeammate('bob');
    await alice.shutdown();
    await bob.shutdown();

    const result = await broadcastInvocation(h).execute(
      new AbortController().signal,
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).not.toBe('Message broadcast to all teammates.');
    expect(String(result.llmContent)).toContain('alice');
    expect(String(result.llmContent)).toContain('bob');
  });
});
