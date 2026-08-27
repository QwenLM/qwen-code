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
  markUserAutoMemoryDreamRunning,
  readUserAutoMemoryMetadata,
  recordUserAutoMemoryMutation,
  runManagedUserAutoMemoryDream,
} from './user-dream.js';

vi.mock('./user-dream-agent-planner.js', () => ({
  planUserAutoMemoryDreamByAgent: vi.fn(),
}));

import { planUserAutoMemoryDreamByAgent } from './user-dream-agent-planner.js';
import { AUTO_MEMORY_SCHEMA_VERSION } from './types.js';
import { DREAM_OPERATIONS_FILENAME } from './dream-operations.js';

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
        lastDreamAt: 'not-a-date',
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
        '---\ntype: user\nname: Role\ndescription: Durable role\nkeywords:\n  - platform engineer\n---\n\nThe user is a platform engineer.\n',
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
});
