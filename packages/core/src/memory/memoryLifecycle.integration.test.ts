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
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { runManagedAutoMemoryDream } from './dream.js';
import { DREAM_OPERATIONS_FILENAME } from './dream-operations.js';
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { MemoryManager } from './manager.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryFilePath,
  getAutoMemoryIndexPath,
  getAutoMemoryRoot,
} from './paths.js';
import {
  forgetManagedAutoMemoryMatches,
  selectManagedAutoMemoryForgetCandidates,
} from './forget.js';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

vi.mock('./dreamAgentPlanner.js', () => ({
  planManagedAutoMemoryDreamByAgent: vi.fn(),
}));

describe('managed auto-memory lifecycle integration', () => {
  const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string;
  let projectRoot: string;
  let mockConfig: Config;
  let extractionCount: number;
  let mgr: MemoryManager;

  beforeEach(async () => {
    mgr = new MemoryManager();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-lifecycle-int-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    mockConfig = {
      getSessionId: () => 'session-1',
      getModel: () => 'qwen3-coder-plus',
      getMemoryRecallMode: () => 'structured',
      isTrustedFolder: () => true,
    } as Config;
    vi.clearAllMocks();
    extractionCount = 0;
    vi.mocked(runAutoMemoryExtractionByAgent).mockImplementation(
      async (_config, root: string) => {
        extractionCount += 1;
        const topic = extractionCount > 1 ? 'reference' : 'user';
        const relativePath =
          topic === 'reference'
            ? path.join('reference', 'latency-dashboard.md')
            : path.join('user', 'terse-responses.md');
        const filePath = getAutoMemoryFilePath(root, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const description =
          topic === 'reference'
            ? 'https://grafana.example/d/api-latency'
            : 'I prefer terse responses.';
        await fs.writeFile(
          filePath,
          [
            '---',
            `type: ${topic}`,
            `name: ${topic === 'reference' ? 'Latency Dashboard' : 'Terse Responses'}`,
            `description: ${description}`,
            '---',
            '',
            description,
            '',
          ].join('\n'),
          'utf-8',
        );

        return {
          touchedTopics: [topic],
          touchedProjectScope: true,
          touchedUserScope: false,
          hasToolActivity: true,
          systemMessage: undefined,
        };
      },
    );
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockImplementation(
      async () => {
        const canonicalPath = getAutoMemoryFilePath(
          projectRoot,
          path.join('user', 'terse-responses.md'),
        );
        await fs.writeFile(
          canonicalPath,
          [
            '---',
            'type: user',
            'name: Terse Responses',
            'description: I prefer terse responses.',
            'keywords:',
            '  - concise responses',
            '---',
            '',
            'I prefer terse responses.',
            '',
            'Why: User repeatedly asks for concise replies.',
          ].join('\n'),
          'utf-8',
        );
        await fs.writeFile(
          path.join(getAutoMemoryRoot(projectRoot), DREAM_OPERATIONS_FILENAME),
          `${JSON.stringify({
            version: 1,
            delete: ['user/terse-duplicate.md'],
            operations: [
              {
                type: 'dedupe',
                sources: ['user/terse-duplicate.md'],
                target: 'user/terse-responses.md',
              },
            ],
          })}\n`,
          'utf-8',
        );
        return {
          status: 'completed',
          finalText: 'Consolidated duplicate terse-response memories.',
          filesTouched: [canonicalPath],
        };
      },
    );
  });

  afterEach(async () => {
    mgr.resetExtractStateForTests();
    if (originalMemoryBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
    }
    clearAutoMemoryRootCache();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('supports a durable memory lifecycle across extraction, recall, and dream', async () => {
    const firstExtraction = mgr.scheduleExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      ],
    });

    const queuedExtraction = await mgr.scheduleExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
        {
          role: 'user',
          parts: [
            {
              text: 'The latency dashboard is https://grafana.example/d/api-latency',
            },
          ],
        },
      ],
    });

    expect(queuedExtraction.skippedReason).toBe('queued');

    const firstResult = await firstExtraction;
    expect(firstResult.touchedTopics).toEqual(['user']);

    const drained = await mgr.drain({
      timeoutMs: 1_000,
    });
    expect(drained).toBe(true);

    const projectPath = getAutoMemoryFilePath(
      projectRoot,
      path.join('project', 'latency-dashboard.md'),
    );
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(
      projectPath,
      [
        '---',
        'type: project',
        'name: Latency Dashboard',
        'description: The latency dashboard is https://grafana.example/d/api-latency',
        '---',
        '',
        'The latency dashboard is https://grafana.example/d/api-latency',
        '',
        'Why: This is temporary for this task.',
      ].join('\n'),
      'utf-8',
    );
    await rebuildManagedAutoMemoryIndex(projectRoot);

    const duplicateUserPath = getAutoMemoryFilePath(
      projectRoot,
      path.join('user', 'terse-duplicate.md'),
    );
    await fs.mkdir(path.dirname(duplicateUserPath), { recursive: true });
    await fs.writeFile(
      duplicateUserPath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'I prefer terse responses.',
        '',
        'Why: User repeatedly asks for concise replies.',
      ].join('\n'),
      'utf-8',
    );
    await rebuildManagedAutoMemoryIndex(projectRoot);

    const dreamResult = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-01T03:00:00.000Z'),
      mockConfig,
    );
    expect(dreamResult.touchedTopics).toContain('user');
    expect(dreamResult.dedupedEntries).toBe(1);
    await expect(fs.stat(duplicateUserPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const indexContent = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const userDoc = docs.find((doc) => doc.type === 'user');
    const projectDoc = docs.find((doc) => doc.type === 'project');
    const referenceDoc = docs.find((doc) => doc.type === 'reference');

    expect(userDoc?.body).toContain('I prefer terse responses.');
    expect(userDoc?.body).toContain(
      'Why: User repeatedly asks for concise replies.',
    );
    expect(referenceDoc?.body).toContain('grafana.example/d/api-latency');
    expect(projectDoc?.body).toContain('This is temporary for this task.');
    expect(indexContent).toContain('user/');

    const recall = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'Check the latency dashboard and use a terse answer.',
      { config: mockConfig },
    );
    expect(recall.strategy).toBe('heuristic');
    expect(recall.prompt).toContain('## Memory focus for this turn');
    expect(recall.prompt).toContain('project:user/terse-responses.md');
    expect(recall.prompt).toContain('project:reference/latency-dashboard.md');
    expect(recall.prompt).not.toContain('This is temporary for this task.');
    expect(recall.prompt).not.toContain('Why: User repeatedly asks');
  });

  it('recalls a relevant topic beyond the general 200-document scan cap', async () => {
    const referenceDir = path.dirname(
      getAutoMemoryFilePath(projectRoot, 'reference/filler-000.md'),
    );
    await fs.mkdir(referenceDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        fs.writeFile(
          path.join(
            referenceDir,
            `filler-${String(index).padStart(3, '0')}.md`,
          ),
          [
            '---',
            'type: reference',
            `name: Filler ${index}`,
            'description: Unrelated historical note',
            '---',
            '',
            'No matching content.',
          ].join('\n'),
          'utf-8',
        ),
      ),
    );

    const targetPath = getAutoMemoryFilePath(
      projectRoot,
      'reference/overflow-target.md',
    );
    await fs.writeFile(
      targetPath,
      [
        '---',
        'type: reference',
        'name: Overflow Zephyr Marker',
        'description: Unique recall target beyond the general scan cap',
        '---',
        '',
        'The saved codeword is OVERFLOW-ZEPHYR-7040.',
      ].join('\n'),
      'utf-8',
    );
    await fs.utimes(targetPath, new Date(0), new Date(0));

    const cappedDocs = await scanAutoMemoryTopicDocuments(projectRoot);
    expect(cappedDocs).toHaveLength(200);
    expect(cappedDocs.some((doc) => doc.filePath === targetPath)).toBe(false);

    const recall = await resolveRelevantAutoMemoryPromptForQuery(
      projectRoot,
      'What is the overflow zephyr codeword?',
    );

    expect(recall.strategy).toBe('heuristic');
    expect(recall.selectedDocs.map((doc) => doc.filePath)).toContain(
      targetPath,
    );
    expect(recall.prompt).toContain('OVERFLOW-ZEPHYR-7040');
  });

  it('forgets a topic beyond the general 200-document scan cap', async () => {
    // Hermetic: forget deletes files, so the user-level scan must never reach
    // the real `~/.qwen/memories`.
    const originalMemoryBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memory');
    clearAutoMemoryRootCache();
    try {
      await ensureAutoMemoryScaffold(
        projectRoot,
        new Date('2026-04-01T00:00:00.000Z'),
      );
      const referenceDir = path.dirname(
        getAutoMemoryFilePath(projectRoot, 'reference/filler-000.md'),
      );
      await fs.mkdir(referenceDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          fs.writeFile(
            path.join(
              referenceDir,
              `filler-${String(index).padStart(3, '0')}.md`,
            ),
            [
              '---',
              'type: reference',
              `name: Filler ${index}`,
              'description: Unrelated historical note',
              '---',
              '',
              'Unrelated historical note.',
            ].join('\n'),
            'utf-8',
          ),
        ),
      );

      const targetPath = getAutoMemoryFilePath(
        projectRoot,
        'reference/overflow-target.md',
      );
      await fs.writeFile(
        targetPath,
        [
          '---',
          'type: reference',
          'name: Overflow Zephyr Marker',
          'description: Unique forget target beyond the general scan cap',
          '---',
          '',
          'The saved codeword is OVERFLOW-ZEPHYR-7040.',
        ].join('\n'),
        'utf-8',
      );
      // Oldest mtime, so the target ranks 201st and the capped scan drops it.
      await fs.utimes(targetPath, new Date(0), new Date(0));

      const cappedDocs = await scanAutoMemoryTopicDocuments(projectRoot);
      expect(cappedDocs).toHaveLength(200);
      expect(cappedDocs.some((doc) => doc.filePath === targetPath)).toBe(false);

      // Recall can surface it (uncapped scan), so forget must be able to
      // remove it.
      const recall = await resolveRelevantAutoMemoryPromptForQuery(
        projectRoot,
        'What is the overflow zephyr codeword?',
      );
      expect(recall.selectedDocs.map((doc) => doc.filePath)).toContain(
        targetPath,
      );

      const selection = await selectManagedAutoMemoryForgetCandidates(
        projectRoot,
        'overflow-zephyr-7040',
      );
      expect(selection.matches.map((match) => match.filePath)).toContain(
        targetPath,
      );

      await forgetManagedAutoMemoryMatches(projectRoot, selection.matches);
      await expect(fs.access(targetPath)).rejects.toThrow();
    } finally {
      if (originalMemoryBase === undefined) {
        delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
      } else {
        process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBase;
      }
      clearAutoMemoryRootCache();
    }
  });
});
