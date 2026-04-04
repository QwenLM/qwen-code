/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentStatus } from '../../runtime/agent-types.js';
import { TeamCoordinationHarness } from './coordination-harness.js';
import { createTask } from '../tasks.js';
import { sendStructuredMessage } from '../mailbox.js';

// Mock Storage so all file I/O uses the harness's temp dir.
vi.mock('../../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../config/storage.js')>();
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

import { Storage } from '../../../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as {
      __setMockGlobalDir: (d: string) => void;
    }
  ).__setMockGlobalDir(dir);
}

// ─── Tests ────────────────────────────────────────────────────

describe('TeamCoordinationHarness', () => {
  let harness: TeamCoordinationHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = undefined;
    }
  });

  // Helper to create harness with Storage mock wired up.
  async function createHarness() {
    const h = await TeamCoordinationHarness.create();
    setMockDir(h.tmpDir);
    harness = h;
    return h;
  }

  // ─── 1. Message routing ────────────────────────────────────

  describe('message routing', () => {
    it('sends message from leader to teammate', async () => {
      const h = await createHarness();
      const worker = await h.spawnTeammate('worker');

      await h.teamManager.sendMessage('worker', 'do the thing', 'leader');

      await h.waitForMessages('worker', 1);
      expect(worker.getReceivedMessages()).toEqual(['do the thing']);
    });

    it('sends message to busy agent (queued, delivered on idle)', async () => {
      const h = await createHarness();
      const worker = await h.spawnTeammate('worker', {
        onMessage: () => 'stay_running',
      });

      // First message makes worker RUNNING.
      await h.teamManager.sendMessage('worker', 'first', 'leader');
      await h.waitForMessages('worker', 1);

      // Second message should queue.
      await h.teamManager.sendMessage('worker', 'second', 'leader');
      expect(worker.getReceivedMessages()).toEqual(['first']);

      // Go idle → queued message delivered.
      worker.goIdle();
      await h.waitForMessages('worker', 2);
      expect(worker.getReceivedMessages()).toEqual(['first', 'second']);
    });

    it('throws for unknown teammate', async () => {
      const h = await createHarness();
      await expect(
        h.teamManager.sendMessage('nobody', 'hello', 'leader'),
      ).rejects.toThrow('not found');
    });
  });

  // ─── 2. Idle detection + auto task claiming ────────────────

  describe('idle detection + auto task claiming', () => {
    it('idle teammate claims pending task', async () => {
      const h = await createHarness();
      await h.spawnTeammate('worker', {
        onMessage: () => {},
      });

      // Create a pending task — this triggers
      // notifyTasksUpdated, which TeamManager listens to.
      await createTask(h.teamName, {
        subject: 'Fix bug',
        description: 'Fix the login bug',
      });

      // Give the async scan a tick to run.
      await h.waitForMessages('worker', 1);
      const msgs = h.getAgent('worker').getReceivedMessages();
      expect(msgs[0]).toContain('Fix bug');
    });

    it('does not claim task if agent is busy', async () => {
      const h = await createHarness();
      await h.spawnTeammate('worker', {
        onMessage: () => 'stay_running',
      });

      // Make the worker busy.
      await h.teamManager.sendMessage('worker', 'work', 'leader');
      await h.waitForMessages('worker', 1);

      // Create a task while worker is busy.
      await createTask(h.teamName, {
        subject: 'Idle only',
        description: 'Should not be claimed yet',
      });

      // Give async scan time.
      await new Promise((r) => setTimeout(r, 50));

      // Worker only has the original message.
      expect(h.getAgent('worker').getReceivedMessages()).toEqual(['work']);
    });
  });

  // ─── 3. Message priority ───────────────────────────────────

  describe('message priority', () => {
    it('prioritizes shutdown over peer messages', async () => {
      const h = await createHarness();
      const worker = await h.spawnTeammate('worker', {
        onMessage: () => 'stay_running',
      });

      // First message starts the agent RUNNING.
      await h.teamManager.sendMessage('worker', 'initial', 'leader');
      await h.waitForMessages('worker', 1);

      // Queue peer and leader messages while busy.
      await h.teamManager.sendMessage('worker', 'peer msg', 'other-worker');
      await h.teamManager.sendMessage('worker', 'leader msg', 'leader');

      // Send shutdown via mailbox.
      await sendStructuredMessage(h.teamName, 'worker', {
        from: 'leader',
        type: 'shutdown_request',
        text: 'Please shut down now.',
      });
      h.teamManager.markShutdownRequested();

      // Go idle → shutdown should be delivered first.
      worker.goIdle();
      await h.waitForMessages('worker', 2);
      expect(worker.getReceivedMessages()[1]).toContain('shut down');
    });

    it('prioritizes leader over peer messages', async () => {
      const h = await createHarness();
      const worker = await h.spawnTeammate('worker', {
        onMessage: () => 'stay_running',
      });

      // Make worker busy.
      await h.teamManager.sendMessage('worker', 'initial', 'leader');
      await h.waitForMessages('worker', 1);

      // Queue peer first, then leader.
      await h.teamManager.sendMessage('worker', 'peer msg', 'other-worker');
      await h.teamManager.sendMessage('worker', 'leader msg', 'leader');

      // Go idle → leader message delivered first.
      worker.goIdle();
      await h.waitForMessages('worker', 2);
      expect(worker.getReceivedMessages()[1]).toBe('leader msg');
    });
  });

  // ─── 4. Shutdown protocol ─────────────────────────────────

  describe('shutdown protocol', () => {
    it('cooperative shutdown: request → approve → cleanup', async () => {
      const h = await createHarness();
      await h.spawnTeammate('worker', {
        onMessage: (msg, agent) => {
          if (msg.includes('shut down')) {
            agent.setStatus(AgentStatus.COMPLETED);
          }
        },
      });

      await h.teamManager.requestShutdown('worker');
      await h.waitForStatus('worker', AgentStatus.COMPLETED);
    });
  });

  // ─── 5. Broadcast ─────────────────────────────────────────

  describe('broadcast', () => {
    it('reaches all teammates except sender', async () => {
      const h = await createHarness();
      const w1 = await h.spawnTeammate('worker-1');
      const w2 = await h.spawnTeammate('worker-2');

      await h.teamManager.broadcast('status update', 'worker-1');

      await h.waitForMessages('worker-2', 1);
      expect(w2.getReceivedMessages()).toEqual(['status update']);
      expect(w1.getReceivedMessages()).toEqual([]);
    });

    it('broadcast with 3 agents skips sender', async () => {
      const h = await createHarness();
      const w1 = await h.spawnTeammate('w1');
      const w2 = await h.spawnTeammate('w2');
      const w3 = await h.spawnTeammate('w3');

      await h.teamManager.broadcast('hello all', 'w2');

      await h.waitForMessages('w1', 1);
      await h.waitForMessages('w3', 1);

      expect(w1.getReceivedMessages()).toEqual(['hello all']);
      expect(w2.getReceivedMessages()).toEqual([]);
      expect(w3.getReceivedMessages()).toEqual(['hello all']);
    });
  });

  // ─── 6. Concurrent task claiming ──────────────────────────

  describe('concurrent task claiming', () => {
    it('only one worker claims a single task', async () => {
      const h = await createHarness();

      // Spawn 5 workers that stay running on message.
      const workers = [];
      for (let i = 0; i < 5; i++) {
        const w = await h.spawnTeammate(`worker-${i}`, {
          onMessage: () => 'stay_running',
        });
        workers.push(w);
      }

      // Make all workers busy (so auto-claim doesn't fire
      // during spawn).
      for (const w of workers) {
        await h.teamManager.sendMessage(w.agentName, 'hold', 'leader');
      }
      // Wait for all to receive the hold message.
      for (const w of workers) {
        await w.waitForMessageCount(1);
      }

      // Create a single task.
      await createTask(h.teamName, {
        subject: 'Only one',
        description: 'Only one worker should get this',
      });

      // Release all workers simultaneously → they all go
      // idle and compete to claim.
      for (const w of workers) {
        w.goIdle();
      }

      // Wait for the dust to settle.
      await new Promise((r) => setTimeout(r, 200));

      // Exactly one worker should have received the task.
      const claimers = workers.filter(
        (w) => w.getReceivedMessages().length > 1,
      );
      expect(claimers.length).toBe(1);
      expect(claimers[0]!.getReceivedMessages()[1]).toContain('Only one');
    });
  });

  // ─── Misc ──────────────────────────────────────────────────

  describe('team file', () => {
    it('tracks spawned members', async () => {
      const h = await createHarness();
      await h.spawnTeammate('alice');
      await h.spawnTeammate('bob');

      const tf = h.teamManager.getTeamFile();
      expect(tf.members).toHaveLength(2);
      expect(tf.members[0]!.name).toBe('alice');
      expect(tf.members[1]!.name).toBe('bob');
      expect(tf.members[0]!.color).toBeDefined();
    });
  });

  describe('waitForStatus', () => {
    it('rejects on timeout', async () => {
      const h = await createHarness();
      await h.spawnTeammate('worker');

      await expect(
        h.waitForStatus('worker', AgentStatus.COMPLETED, 50),
      ).rejects.toThrow('Timeout');
    });
  });
});
