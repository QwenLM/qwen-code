/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { getAutoMemoryRoot } from './paths.js';
import { DREAM_OPERATIONS_FILENAME } from './dream-operations.js';

vi.mock('./dreamAgentPlanner.js', () => ({
  planManagedAutoMemoryDreamByAgent: vi.fn(),
}));

import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';

describe('managed auto-memory dream', () => {
  let tempDir: string;
  let projectRoot: string;
  let mockConfig: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-dream-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockReset();
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen-test'),
      getApprovalMode: vi.fn(),
    } as unknown as Config;
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('throws when config is missing', async () => {
    await expect(runManagedAutoMemoryDream(projectRoot)).rejects.toThrow(
      'Managed auto-memory dream requires config',
    );
  });

  it('reports file changes and keyword backfills from filesystem snapshots', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const userFile = path.join(memoryRoot, 'user', 'prefs.md');
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(
      userFile,
      '---\ntype: user\nname: Preferences\ndescription: Style\n---\n\nBe concise.\n',
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(
          userFile,
          '---\ntype: user\nname: Preferences\ndescription: Style\nkeywords:\n  - concise responses\n---\n\nBe concise.\n',
        );
        const referenceFile = path.join(memoryRoot, 'reference', 'dash.md');
        await fs.mkdir(path.dirname(referenceFile), { recursive: true });
        await fs.writeFile(
          referenceFile,
          '---\ntype: reference\nname: Dashboard\ndescription: Metrics\nkeywords:\n  - metrics dashboard\n---\n\nUse the metrics dashboard.\n',
        );
        return {
          status: 'completed',
          finalText: 'Updated memories.',
          filesTouched: [userFile, referenceFile],
        };
      },
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'reference']),
    );
    expect(result.createdEntries).toBe(1);
    expect(result.updatedEntries).toBe(1);
    expect(result.keywordBackfilled).toBe(1);
    expect(result.dedupedEntries).toBe(0);
    expect(result.systemMessage).toContain(
      'Managed auto-memory dream (agent):',
    );
  });

  it('applies a validated dedupe manifest after the canonical file exists', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const topicDir = path.join(memoryRoot, 'project');
    const oldFile = path.join(topicDir, 'old.md');
    const canonicalFile = path.join(topicDir, 'canonical.md');
    await fs.mkdir(topicDir, { recursive: true });
    await fs.writeFile(
      oldFile,
      '---\ntype: project\nname: Old\ndescription: Duplicate\n---\n\nSame fact.\n',
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(
          canonicalFile,
          '---\ntype: project\nname: Canonical\ndescription: Complete fact\nkeywords:\n  - canonical fact\n---\n\nSame fact with full context.\n',
        );
        await fs.writeFile(
          path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
          JSON.stringify({
            version: 1,
            delete: ['project/old.md'],
            operations: [
              {
                type: 'dedupe',
                sources: ['project/old.md'],
                target: 'project/canonical.md',
              },
            ],
          }),
        );
        return {
          status: 'completed',
          finalText: 'Merged duplicate memories.',
          filesTouched: [oldFile, canonicalFile],
        };
      },
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    await expect(fs.stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.createdEntries).toBe(1);
    expect(result.deletedEntries).toBe(1);
    expect(result.dedupedEntries).toBe(1);
    await expect(
      fs.stat(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not apply a manifest left by an earlier run', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const memoryFile = path.join(memoryRoot, 'project', 'keep.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(
      memoryFile,
      '---\ntype: project\nname: Keep\ndescription: Keep\nkeywords:\n  - keep memory\n---\n\nKeep this fact.\n',
    );
    await fs.writeFile(
      path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
      JSON.stringify({
        version: 1,
        delete: ['project/keep.md'],
        operations: [],
      }),
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await expect(
          fs.stat(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        return {
          status: 'completed',
          finalText: 'No changes.',
          filesTouched: [],
        };
      },
    );

    await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    await expect(fs.readFile(memoryFile, 'utf-8')).resolves.toContain(
      'Keep this fact.',
    );
    await expect(
      fs.stat(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete sources when a replacement memory is invalid', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const source = path.join(memoryRoot, 'project', 'source.md');
    const invalidTarget = path.join(memoryRoot, 'project', 'invalid.md');
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(
      source,
      '---\ntype: project\nname: Source\ndescription: Source\n---\n\nFact.\n',
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(invalidTarget, 'not a memory document');
        await fs.writeFile(
          path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
          JSON.stringify({
            version: 1,
            delete: ['project/source.md'],
            operations: [],
          }),
        );
        return {
          status: 'completed',
          filesTouched: [source, invalidTarget],
        };
      },
    );

    await expect(
      runManagedAutoMemoryDream(
        projectRoot,
        new Date('2026-04-02T00:00:00.000Z'),
        mockConfig,
      ),
    ).rejects.toThrow('invalid memory document');
    await expect(fs.readFile(source, 'utf-8')).resolves.toContain('Fact');
    await expect(
      fs.stat(path.join(memoryRoot, DREAM_OPERATIONS_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed memories without a valid keyword', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const memoryFile = path.join(memoryRoot, 'project', 'decision.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(
      memoryFile,
      '---\ntype: project\nname: Decision\ndescription: Initial\n---\n\nInitial fact.\n',
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(
          memoryFile,
          '---\ntype: project\nname: Decision\ndescription: Updated\n---\n\nUpdated fact.\n',
        );
        return {
          status: 'completed',
          filesTouched: [memoryFile],
        };
      },
    );

    await expect(
      runManagedAutoMemoryDream(
        projectRoot,
        new Date('2026-04-02T00:00:00.000Z'),
        mockConfig,
      ),
    ).rejects.toThrow('invalid memory document');
  });

  it('propagates planner failures', async () => {
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockRejectedValue(
      new Error('agent failed'),
    );

    await expect(
      runManagedAutoMemoryDream(
        projectRoot,
        new Date('2026-04-02T00:00:00.000Z'),
        mockConfig,
      ),
    ).rejects.toThrow('agent failed');
  });
});
