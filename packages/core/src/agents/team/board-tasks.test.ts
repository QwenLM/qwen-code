/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createBoardTask,
  getBoardTask,
  listBoardTasks,
  claimBoardTask,
  blockBoardTask,
  blockedTasks,
  updateBoardTask,
  releaseBoardTask,
  TaskClaimedError,
  TaskCompletedError,
  TaskNotOwnedError,
} from './board-tasks.js';

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

import { Storage } from '../../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (d: string) => void }
  ).__setMockGlobalDir(dir);
}

const BOARD = 'demo';

describe('board tasks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-tasks-test-'));
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates pending and unowned by default', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 'check api' });
    expect(t.id).toBe('t-1');
    expect(t.status).toBe('pending');
    expect(t.owner).toBeNull();
  });

  // Naming an owner records who is expected to take the work. Only claiming
  // binds it — that distinction is what keeps the board from being a hierarchy.
  it('treats a named owner as a proposal, not a claim', async () => {
    const t = await createBoardTask({
      board: BOARD,
      subject: 'check web',
      owner: 'web-worker',
    });
    expect(t.owner).toBe('web-worker');
    expect(t.status).toBe('pending');
  });

  it('claims, completes and releases', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 's' });
    expect((await claimBoardTask(BOARD, t.id, 'api')).status).toBe(
      'in_progress',
    );
    const done = await updateBoardTask(BOARD, t.id, {
      status: 'completed',
      note: 'it is an int',
      by: 'api',
    });
    expect(done.status).toBe('completed');
    expect(done.notes).toEqual(['it is an int']);

    const t2 = await createBoardTask({ board: BOARD, subject: 's2' });
    await claimBoardTask(BOARD, t2.id, 'api');
    const released = await releaseBoardTask(BOARD, t2.id);
    expect(released.owner).toBeNull();
    expect(released.status).toBe('pending');
  });

  it('refuses a claim on work someone else is doing', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 's' });
    await claimBoardTask(BOARD, t.id, 'api');
    await expect(claimBoardTask(BOARD, t.id, 'web')).rejects.toBeInstanceOf(
      TaskClaimedError,
    );
    // Re-claiming your own is a no-op, so a retry does not have to special-case.
    await expect(claimBoardTask(BOARD, t.id, 'api')).resolves.toBeDefined();
  });

  // Ids are short and typeable by design, so a mistyped one is likely. Silently
  // reopening finished work and reassigning it is the worst way to surface that.
  it('refuses a claim on completed work rather than reopening it', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 's' });
    await claimBoardTask(BOARD, t.id, 'api');
    await updateBoardTask(BOARD, t.id, { status: 'completed', by: 'api' });

    await expect(claimBoardTask(BOARD, t.id, 'web')).rejects.toBeInstanceOf(
      TaskCompletedError,
    );
    expect((await getBoardTask(BOARD, t.id))?.owner).toBe('api');
  });

  it('refuses to complete work owned by someone else', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 's' });
    await claimBoardTask(BOARD, t.id, 'api');
    await expect(
      updateBoardTask(BOARD, t.id, { status: 'completed', by: 'web' }),
    ).rejects.toBeInstanceOf(TaskNotOwnedError);
    expect((await getBoardTask(BOARD, t.id))?.status).toBe('in_progress');
  });

  // A note or a re-owner stays open to anyone: those are how a stuck board
  // gets unstuck, and neither destroys work.
  it('lets anyone add a note or hand the task on', async () => {
    const t = await createBoardTask({ board: BOARD, subject: 's' });
    await claimBoardTask(BOARD, t.id, 'api');
    await expect(
      updateBoardTask(BOARD, t.id, { note: 'context', by: 'web' }),
    ).resolves.toBeDefined();
    await expect(
      updateBoardTask(BOARD, t.id, { owner: 'web', by: 'web' }),
    ).resolves.toBeDefined();
  });

  it('filters by owner and status, and ignores non-items', async () => {
    const a = await createBoardTask({ board: BOARD, subject: 'a' });
    await createBoardTask({ board: BOARD, subject: 'b' });
    await claimBoardTask(BOARD, a.id, 'api');
    await fs.writeFile(
      path.join(tmpDir, 'boards', BOARD, 'tasks', 'notes-2026.md'),
      'not an item',
    );

    expect(
      (await listBoardTasks(BOARD, { owner: 'api' })).map((t) => t.id),
    ).toEqual(['t-1']);
    expect(
      (await listBoardTasks(BOARD, { statuses: ['pending'] })).map((t) => t.id),
    ).toEqual(['t-2']);
    expect((await listBoardTasks(BOARD)).length).toBe(2);
  });

  it('returns an empty list for a board that does not exist', async () => {
    expect(await listBoardTasks('never-used')).toEqual([]);
  });

  it('rejects names that could escape the board root', async () => {
    await expect(
      createBoardTask({ board: '../escape', subject: 's' }),
    ).rejects.toThrow(/Invalid board name/);
  });

  describe('dependencies', () => {
    it('writes both halves of an edge', async () => {
      const a = await createBoardTask({ board: BOARD, subject: 'a' });
      const b = await createBoardTask({ board: BOARD, subject: 'b' });
      await blockBoardTask(BOARD, b.id, a.id);

      expect((await getBoardTask(BOARD, b.id))?.blockedBy).toEqual([a.id]);
      expect((await getBoardTask(BOARD, a.id))?.blocks).toEqual([b.id]);
    });

    it('is idempotent and refuses self-blocking', async () => {
      const a = await createBoardTask({ board: BOARD, subject: 'a' });
      const b = await createBoardTask({ board: BOARD, subject: 'b' });
      await blockBoardTask(BOARD, b.id, a.id);
      await blockBoardTask(BOARD, b.id, a.id);
      expect((await getBoardTask(BOARD, b.id))?.blockedBy).toEqual([a.id]);

      await expect(blockBoardTask(BOARD, a.id, a.id)).rejects.toThrow(
        /cannot block itself/,
      );
    });

    it('clears the block when the blocker completes', async () => {
      const a = await createBoardTask({ board: BOARD, subject: 'a' });
      const b = await createBoardTask({ board: BOARD, subject: 'b' });
      await blockBoardTask(BOARD, b.id, a.id);

      expect(
        blockedTasks(await listBoardTasks(BOARD)).map((t) => t.id),
      ).toEqual([b.id]);

      await claimBoardTask(BOARD, a.id, 'api');
      await updateBoardTask(BOARD, a.id, { status: 'completed', by: 'api' });
      expect(blockedTasks(await listBoardTasks(BOARD))).toEqual([]);
    });

    // A blocker that was pruned should not wedge the board forever.
    it('treats a missing blocker as satisfied', async () => {
      const b = await createBoardTask({ board: BOARD, subject: 'b' });
      await updateBoardTask(BOARD, b.id, { note: 'x' });
      const withGhost = (await listBoardTasks(BOARD)).map((t) => ({
        ...t,
        blockedBy: ['t-999'],
      }));
      expect(blockedTasks(withGhost)).toEqual([]);
    });
  });
});
