/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  clearAutoMemoryRootCache,
  getUserAutoMemoryMetadataPath,
  getUserAutoMemoryRoot,
} from './paths.js';
import {
  completeUserAutoMemoryDream,
  failUserAutoMemoryDream,
  markUserAutoMemoryDreamRunning,
  readUserAutoMemoryMetadata,
  recordUserAutoMemoryMutation,
  runManagedUserAutoMemoryDream,
} from './user-dream.js';

vi.mock('./user-dream-agent-planner.js', () => ({
  planUserAutoMemoryDreamByAgent: vi.fn(),
}));

import { planUserAutoMemoryDreamByAgent } from './user-dream-agent-planner.js';
import * as memoryScan from './scan.js';
import { AUTO_MEMORY_SCHEMA_VERSION } from './types.js';
import * as dreamOperations from './dream-operations.js';

const { DREAM_OPERATIONS_FILENAME } = dreamOperations;

const EMPTY_DREAM_RESULT = {
  touchedTopics: [],
  createdEntries: 0,
  updatedEntries: 0,
  deletedEntries: 0,
  dedupedEntries: 0,
  splitEntries: 0,
  keywordBackfilled: 0,
};

describe('User Memory dream', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'user-memory-dream-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    config = {
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
      logEvent: vi.fn(),
    } as unknown as Config;
    vi.mocked(planUserAutoMemoryDreamByAgent).mockReset();
  });

  afterEach(async () => {
    if (originalMemoryBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
    }
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('replaces a linked index without overwriting its external target', async () => {
    const root = getUserAutoMemoryRoot();
    await fs.mkdir(root, { recursive: true });
    const outside = path.join(tempDir, 'outside.md');
    await fs.writeFile(outside, 'outside sentinel');
    const index = path.join(root, 'MEMORY.md');
    await fs.symlink(outside, index, 'file');
    vi.mocked(planUserAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'No changes.',
      filesTouched: [],
    });

    await runManagedUserAutoMemoryDream(projectRoot, config);

    expect(await fs.readFile(outside, 'utf8')).toBe('outside sentinel');
    expect((await fs.lstat(index)).isSymbolicLink()).toBe(false);
  });

  it('marks the global state pending after ten successful mutations', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    for (let index = 0; index < 10; index += 1) {
      await recordUserAutoMemoryMutation(now);
    }

    const metadata = await readUserAutoMemoryMetadata(now);
    expect(metadata).toMatchObject({
      dirtyMutations: 10,
      status: 'pending',
      pendingReason: 'dirty_mutations',
    });
    expect(
      getUserAutoMemoryMetadataPath().startsWith(getUserAutoMemoryRoot()),
    ).toBe(false);
  });

  it('still records a mutation when the document count scan fails', async () => {
    // One unreadable subdirectory makes the scan reject. Every sibling caller
    // fails soft; if the counter did not, the mutation write path would throw
    // on every user memory write, and the completion path would lose the
    // throttle timestamp so the next dream would not be throttled either.
    const now = new Date('2026-08-01T00:00:00.000Z');
    const scan = vi
      .spyOn(memoryScan, 'scanUserAutoMemoryTopicDocuments')
      .mockRejectedValue(
        new Error(
          'memory scan is incomplete: a subdirectory could not be read',
        ),
      );
    try {
      await expect(recordUserAutoMemoryMutation(now)).resolves.toMatchObject({
        documentCount: 0,
      });
      // The mutation was recorded despite the unreadable corpus, and an
      // unmeasured count must not claim a document_limit.
      const metadata = await readUserAutoMemoryMetadata(now);
      expect(metadata).toMatchObject({ dirtyMutations: 1, status: 'idle' });
      expect(metadata.pendingReason).toBeUndefined();
    } finally {
      scan.mockRestore();
    }
  });

  it('preserves mutations that arrive while a dream is running', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    for (let index = 0; index < 10; index += 1) {
      await recordUserAutoMemoryMutation(now);
    }
    const running = await markUserAutoMemoryDreamRunning(now);
    await recordUserAutoMemoryMutation(now);
    await recordUserAutoMemoryMutation(now);

    const completed = await completeUserAutoMemoryDream(
      running.dirtyMutations,
      EMPTY_DREAM_RESULT,
      new Date('2026-08-02T00:00:00.000Z'),
    );

    expect(completed.dirtyMutations).toBe(2);
    expect(completed.lastDreamAt).toBe('2026-08-02T00:00:00.000Z');
    expect(completed.status).toBe('noop');
  });

  it('records a failed attempt without clearing pending work', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    for (let index = 0; index < 10; index += 1) {
      await recordUserAutoMemoryMutation(now);
    }

    const failed = await failUserAutoMemoryDream('failed', now);

    expect(failed).toMatchObject({
      status: 'failed',
      dirtyMutations: 10,
      pendingReason: 'dirty_mutations',
      lastAttemptAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('keeps user dream pending while the document limit is exceeded', async () => {
    const userRoot = path.join(getUserAutoMemoryRoot(), 'user');
    await fs.mkdir(userRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        fs.writeFile(
          path.join(userRoot, `${index}.md`),
          [
            '---',
            `name: Preference ${index}`,
            'description: Durable user preference',
            'type: user',
            'category: communication_preference',
            'keywords:',
            `  - preference ${index}`,
            'usage_scenarios:',
            '  - Personalizing responses',
            '---',
            `Preference ${index}.`,
          ].join('\n'),
        ),
      ),
    );
    const now = new Date('2026-08-01T00:00:00.000Z');

    const mutation = await recordUserAutoMemoryMutation(now);
    expect(mutation.metadata).toMatchObject({
      dirtyMutations: 1,
      status: 'pending',
      pendingReason: 'document_limit',
    });
    const completed = await completeUserAutoMemoryDream(
      1,
      EMPTY_DREAM_RESULT,
      new Date('2026-08-02T00:00:00.000Z'),
    );
    expect(completed).toMatchObject({
      dirtyMutations: 0,
      status: 'pending',
      pendingReason: 'document_limit',
    });
  });

  it('rejects malformed persistent scheduler metadata', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    await readUserAutoMemoryMetadata(now);
    await fs.writeFile(
      getUserAutoMemoryMetadataPath(),
      JSON.stringify({
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastDreamAt: now.toISOString(),
        lastAttemptAt: 'not-a-date',
        dirtyMutations: 10,
        status: 'running',
        pendingReason: 'dirty_mutations',
      }),
    );

    await expect(readUserAutoMemoryMetadata(now)).resolves.toMatchObject({
      version: AUTO_MEMORY_SCHEMA_VERSION,
      dirtyMutations: 0,
      status: 'idle',
    });
  });

  it('repairs a null persistent scheduler metadata value', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    await readUserAutoMemoryMetadata(now);
    await fs.writeFile(getUserAutoMemoryMetadataPath(), 'null');

    await expect(readUserAutoMemoryMetadata(now)).resolves.toMatchObject({
      version: AUTO_MEMORY_SCHEMA_VERSION,
      dirtyMutations: 0,
      status: 'idle',
    });
  });

  it('runs only against User Memory and reports real file changes', async () => {
    vi.mocked(planUserAutoMemoryDreamByAgent).mockImplementation(async () => {
      const filePath = path.join(getUserAutoMemoryRoot(), 'user', 'role.md');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        '---\ntype: user\nname: Role\ndescription: Durable role\ncategory: basic_information\nkeywords:\n  - platform engineer\n  - user role\nusage_scenarios:\n  - Personalizing technical answers\n---\n\nThe user is a platform engineer.\n',
      );
      return {
        status: 'completed',
        finalText: 'Created one atomic memory.',
        filesTouched: [filePath],
      };
    });

    const result = await runManagedUserAutoMemoryDream(projectRoot, config);

    expect(result.touchedTopics).toEqual(['user']);
    expect(result.createdEntries).toBe(1);
    expect(result.systemMessage).toContain('Managed User Memory dream');
  });

  it('does not apply a manifest left by an earlier run', async () => {
    const memoryFile = path.join(getUserAutoMemoryRoot(), 'user', 'keep.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(
      memoryFile,
      '---\ntype: user\nname: Keep\ndescription: Keep\nkeywords:\n  - keep preference\n---\n\nKeep this preference.\n',
    );
    await fs.writeFile(
      path.join(getUserAutoMemoryRoot(), DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['user/keep.md'],
        operations: [],
      }),
    );
    vi.mocked(planUserAutoMemoryDreamByAgent).mockImplementation(async () => {
      await expect(
        fs.stat(path.join(getUserAutoMemoryRoot(), DREAM_OPERATIONS_FILENAME)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      return {
        status: 'completed',
        finalText: 'No changes.',
        filesTouched: [],
      };
    });

    await runManagedUserAutoMemoryDream(projectRoot, config);

    await expect(fs.readFile(memoryFile, 'utf-8')).resolves.toContain(
      'Keep this preference.',
    );
  });

  it('does not apply a manifest after the run is cancelled', async () => {
    const memoryFile = path.join(getUserAutoMemoryRoot(), 'user', 'keep.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, 'Keep this preference.');
    const controller = new AbortController();
    const manifestPath = path.join(
      getUserAutoMemoryRoot(),
      DREAM_OPERATIONS_FILENAME,
    );
    const apply = vi.spyOn(dreamOperations, 'applyDreamOperations');
    try {
      vi.mocked(planUserAutoMemoryDreamByAgent).mockImplementation(async () => {
        await fs.writeFile(
          manifestPath,
          JSON.stringify({
            version: 1,
            delete: ['user/keep.md'],
            operations: [],
          }),
        );
        controller.abort();
        return {
          status: 'completed',
          finalText: 'Cancelled after planning.',
          filesTouched: [],
        };
      });

      await expect(
        runManagedUserAutoMemoryDream(projectRoot, config, controller.signal),
      ).rejects.toThrow();
      expect(apply).not.toHaveBeenCalled();
      await expect(fs.readFile(memoryFile, 'utf-8')).resolves.toContain(
        'Keep this preference.',
      );
      await expect(fs.stat(manifestPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      // Restored here so the next `vi.spyOn` on this member binds the real
      // export instead of this test's spy, and so a later case asserting a
      // call count does not inherit this one's records.
      apply.mockRestore();
    }
  });

  it('does not rebuild the user index after cancellation', async () => {
    const memoryRoot = getUserAutoMemoryRoot();
    const memoryFile = path.join(memoryRoot, 'user', 'keep.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(
      memoryFile,
      '---\ntype: user\nname: Keep\ndescription: Keep\nkeywords:\n  - keep preference\n---\n\nKeep this preference.\n',
    );
    const indexPath = path.join(memoryRoot, 'MEMORY.md');
    await fs.writeFile(indexPath, 'SENTINEL-INDEX-DO-NOT-OVERWRITE');
    const controller = new AbortController();
    // Captured before the spy below is installed, so the wrapper delegates
    // to the real export rather than to a spy leaked by an earlier case.
    // The assertion pins that intent: both cancellation cases restore their
    // spy in a `finally`, and without the earlier restore this capture
    // silently binds the previous case's spy while every assertion still
    // passes.
    const applyDreamOperations = dreamOperations.applyDreamOperations;
    expect(vi.isMockFunction(applyDreamOperations)).toBe(false);
    const apply = vi
      .spyOn(dreamOperations, 'applyDreamOperations')
      .mockImplementationOnce(async (...args) => {
        const result = await applyDreamOperations(...args);
        controller.abort();
        return result;
      });
    try {
      vi.mocked(planUserAutoMemoryDreamByAgent).mockImplementation(async () => {
        await fs.writeFile(
          path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
          JSON.stringify({ version: 1, delete: [], operations: [] }),
        );
        return {
          status: 'completed',
          finalText: 'No changes.',
          filesTouched: [],
        };
      });

      await runManagedUserAutoMemoryDream(
        projectRoot,
        config,
        controller.signal,
      );

      await expect(fs.readFile(indexPath, 'utf-8')).resolves.toBe(
        'SENTINEL-INDEX-DO-NOT-OVERWRITE',
      );
    } finally {
      apply.mockRestore();
    }
  });
});
