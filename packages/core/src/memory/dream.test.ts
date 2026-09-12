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
import { runManagedAutoMemoryDream, snapshotDreamFiles } from './dream.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  getAutoMemoryIndexPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
} from './paths.js';
import type { AutoMemoryMetadata } from './types.js';
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
      getMemoryRecallMode: vi.fn().mockReturnValue('legacy'),
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
          '---\ntype: user\nname: Preferences\ndescription: Style\ncategory: communication_preference\nkeywords:\n  - concise responses\n  - response style\nusage_scenarios:\n  - Writing responses\n---\n\nBe concise.\n',
        );
        const referenceFile = path.join(memoryRoot, 'reference', 'dash.md');
        await fs.mkdir(path.dirname(referenceFile), { recursive: true });
        await fs.writeFile(
          referenceFile,
          '---\ntype: reference\nname: Dashboard\ndescription: Metrics\ncategory: tool_experience\nkeywords:\n  - metrics dashboard\n  - dashboard reference\nusage_scenarios:\n  - Checking metrics\n---\n\nUse the metrics dashboard.\n',
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
          '---\ntype: project\nname: Canonical\ndescription: Complete fact\ncategory: project_introduction\nkeywords:\n  - canonical fact\n  - complete context\nusage_scenarios:\n  - Recalling the fact\n---\n\nSame fact with full context.\n',
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
      '---\ntype: project\nname: Keep\ndescription: Keep\ncategory: project_introduction\nkeywords:\n  - keep memory\n  - retained fact\nusage_scenarios:\n  - Recalling the fact\n---\n\nKeep this fact.\n',
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

  it('rejects changed memories missing structured metadata', async () => {
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
          '---\ntype: project\nname: Decision\ndescription: Updated\nkeywords:\n  - updated decision\n---\n\nUpdated fact.\n',
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

  it('does not attribute a concurrent writer change to the dream', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const concurrentFile = path.join(memoryRoot, 'project', 'concurrent.md');
    await fs.mkdir(path.dirname(concurrentFile), { recursive: true });
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(concurrentFile, 'written by another task');
        return {
          status: 'completed',
          filesTouched: [],
          filesWritten: [],
        };
      },
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    expect(result.createdEntries).toBe(0);
    await expect(fs.readFile(concurrentFile, 'utf-8')).resolves.toBe(
      'written by another task',
    );
  });

  it('skips directory-shaped and symlinked entries when snapshotting', async () => {
    // A cloned repo (QWEN_CODE_MEMORY_LOCAL=1 layout) can ship a directory
    // named `*.md` or a symlink pointing outside the memory root; the dream
    // must skip both instead of dying on EISDIR or reading out-of-root bytes.
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const projectDir = path.join(memoryRoot, 'project');
    await fs.mkdir(path.join(projectDir, 'notes.md'), { recursive: true });
    const outsideFile = path.join(tempDir, 'outside.md');
    await fs.writeFile(
      outsideFile,
      '---\ntype: project\nname: Outside\ndescription: private\n---\nsecret\n',
    );
    await fs.symlink(outsideFile, path.join(projectDir, 'link.md'), 'file');
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    expect(result.createdEntries).toBe(0);
    expect(result.updatedEntries).toBe(0);
    const snapshot = await snapshotDreamFiles(memoryRoot);
    expect(snapshot.has('project/notes.md')).toBe(false);
    expect(snapshot.has('project/link.md')).toBe(false);
  });

  it('rebuilds the index after deleting memories with unparseable frontmatter', async () => {
    // Frontmatter-malformed files are never migration candidates and carry no
    // type, so deleting them produces no touched topic — the rebuild gate must
    // still fire or MEMORY.md keeps pointing at files that no longer exist.
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const topicDir = path.join(memoryRoot, 'project');
    await fs.mkdir(topicDir, { recursive: true });
    await fs.writeFile(
      path.join(topicDir, 'stale-a.md'),
      '---\ntype: project\nunclosed\n',
    );
    await fs.writeFile(
      path.join(topicDir, 'stale-b.md'),
      '---\ntype: project\nunclosed\n',
    );
    await fs.writeFile(
      getAutoMemoryIndexPath(projectRoot),
      '- [stale a](project/stale-a.md) — hook\n- [stale b](project/stale-b.md) — hook\n',
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        await fs.writeFile(
          path.join(memoryRoot, DREAM_OPERATIONS_FILENAME),
          JSON.stringify({
            version: 1,
            delete: ['project/stale-a.md', 'project/stale-b.md'],
            operations: [],
          }),
        );
        return {
          status: 'completed',
          finalText: 'Deleted stale memories.',
          filesTouched: [],
        };
      },
    );

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
      undefined,
      { recordMetadata: true },
    );

    expect(result.deletedEntries).toBe(2);
    const index = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    expect(index).not.toContain('stale-a');
    expect(index).not.toContain('stale-b');
    const metadata = JSON.parse(
      await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
    ) as AutoMemoryMetadata;
    expect(metadata.lastDreamStatus).toBe('updated');
  });

  it('skips manual dream while metadata migration is pending', async () => {
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const memoryFile = path.join(memoryRoot, 'project', 'legacy.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    const legacy = '---\ntype: project\n---\nLegacy fact.\n';
    await fs.writeFile(memoryFile, legacy);

    await expect(
      runManagedAutoMemoryDream(
        projectRoot,
        new Date('2026-04-02T00:00:00.000Z'),
        mockConfig,
        undefined,
        { trigger: 'manual', recordMetadata: true },
      ),
    ).resolves.toMatchObject({
      touchedTopics: [],
      dedupedEntries: 0,
      systemMessage: expect.stringContaining('migration is pending'),
    });
    expect(planManagedAutoMemoryDreamByAgent).not.toHaveBeenCalled();
    await expect(fs.readFile(memoryFile, 'utf-8')).resolves.toBe(legacy);
  });

  it('runs a manual dream in structured recall mode despite a legacy candidate', async () => {
    // In structured mode the migration the skip message points at can never
    // be scheduled and the mode cannot be left in-process, so gating the
    // manual dream on candidates there is a dead end — the dream itself is
    // the only in-product repair for an invalid document.
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const memoryFile = path.join(memoryRoot, 'project', 'invalid.md');
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, 'not a memory document');
    vi.mocked(mockConfig.getMemoryRecallMode).mockReturnValue('structured');
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      filesTouched: [],
      filesWritten: [],
    });

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
      undefined,
      { trigger: 'manual', recordMetadata: true },
    );

    expect(planManagedAutoMemoryDreamByAgent).toHaveBeenCalled();
    expect(result.systemMessage).not.toContain('migration is pending');
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
