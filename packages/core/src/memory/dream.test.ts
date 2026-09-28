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
import { getAutoMemoryIndexPath, getAutoMemoryRoot } from './paths.js';
import { registerMemoryChangedListener } from './memory-file-change.js';

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
    vi.unstubAllEnvs();
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

  it('returns touched topics derived from files touched by the dream agent', async () => {
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Merged duplicate user memories.',
      filesTouched: [
        path.join(projectRoot, '.qwen', 'memory', 'user', 'prefs.md'),
        path.join(projectRoot, '.qwen', 'memory', 'reference', 'dash.md'),
      ],
    });

    const result = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-02T00:00:00.000Z'),
      mockConfig,
    );

    expect(result.touchedTopics).toEqual(
      expect.arrayContaining(['user', 'reference']),
    );
    expect(result.dedupedEntries).toBe(0);
    expect(result.systemMessage).toContain(
      'Managed auto-memory dream (agent):',
    );
  });

  it('keeps a symlink index update with the dreaming session and its signal', async () => {
    vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', path.join(tempDir, 'memories'));
    await fs.mkdir(path.join(projectRoot, '.git'));
    await ensureAutoMemoryScaffold(projectRoot);
    const topicPath = path.join(
      getAutoMemoryRoot(projectRoot),
      'project',
      'routing.md',
    );
    await fs.mkdir(path.dirname(topicPath), { recursive: true });
    await fs.writeFile(
      topicPath,
      '---\nname: Routing memory\ndescription: Owner routing\ntype: project\n---\nKeep session ownership.\n',
    );
    const indexPath = getAutoMemoryIndexPath(projectRoot);
    const target = path.join(tempDir, 'index.md');
    await fs.writeFile(target, 'stale index');
    await fs.rm(indexPath);
    await fs.symlink(target, indexPath);
    const owner = vi.fn();
    const sibling = vi.fn();
    const unregisterOwner = registerMemoryChangedListener(projectRoot, owner);
    const unregisterSibling = registerMemoryChangedListener(
      projectRoot,
      sibling,
    );
    mockConfig.getMemoryHookDeliveryId = () => unregisterOwner.id;
    const controller = new AbortController();
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Updated routing memory.',
      filesTouched: [topicPath],
    });
    try {
      await runManagedAutoMemoryDream(
        projectRoot,
        new Date(),
        mockConfig,
        controller.signal,
      );
      expect(await fs.readFile(target, 'utf-8')).toContain('Routing memory');
      expect.soft(sibling).not.toHaveBeenCalled();
      expect.soft(owner).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scope: 'project',
          operation: 'update',
          relativePaths: ['MEMORY.md'],
        }),
        controller.signal,
      );
    } finally {
      unregisterOwner();
      unregisterSibling();
      vi.unstubAllEnvs();
    }
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
