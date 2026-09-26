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
import { planManagedAutoMemoryDreamByAgent } from './dreamAgentPlanner.js';
import { MemoryManager } from './manager.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryFilePath,
  getAutoMemoryIndexPath,
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

/** A topic file: frontmatter followed by a blank line and the body lines. */
const memoryDoc = (
  type: string,
  name: string,
  description: string,
  ...body: string[]
) =>
  [
    '---',
    `type: ${type}`,
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    ...body,
  ].join('\n');

async function writeMemoryDoc(
  root: string,
  relativePath: string,
  content: string,
) {
  const filePath = getAutoMemoryFilePath(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

const userTurn = (text: string) => ({ role: 'user', parts: [{ text }] });

describe('managed auto-memory lifecycle integration', () => {
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
    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    mockConfig = {
      getSessionId: () => 'session-1',
      getModel: () => 'qwen3-coder-plus',
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
        const description =
          topic === 'reference'
            ? 'https://grafana.example/d/api-latency'
            : 'I prefer terse responses.';
        await writeMemoryDoc(
          root,
          relativePath,
          memoryDoc(
            topic,
            topic === 'reference' ? 'Latency Dashboard' : 'Terse Responses',
            description,
            description,
            '',
          ),
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
    vi.mocked(planManagedAutoMemoryDreamByAgent).mockResolvedValue({
      status: 'completed',
      finalText: 'Consolidated memory files and updated the index.',
      filesTouched: [
        getAutoMemoryFilePath(
          projectRoot,
          path.join('user', 'terse-responses.md'),
        ),
        getAutoMemoryFilePath(
          projectRoot,
          path.join('reference', 'latency-dashboard.md'),
        ),
      ],
    });
  });

  /**
   * Writes 200 filler reference docs plus a target doc with the oldest mtime,
   * and checks that the capped scan drops the target.
   */
  async function seedTargetBeyondScanCap(
    fillerBody: string,
    targetDescription: string,
  ) {
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeMemoryDoc(
          projectRoot,
          `reference/filler-${String(index).padStart(3, '0')}.md`,
          memoryDoc(
            'reference',
            `Filler ${index}`,
            'Unrelated historical note',
            fillerBody,
          ),
        ),
      ),
    );

    const targetPath = await writeMemoryDoc(
      projectRoot,
      'reference/overflow-target.md',
      memoryDoc(
        'reference',
        'Overflow Zephyr Marker',
        targetDescription,
        'The saved codeword is OVERFLOW-ZEPHYR-7040.',
      ),
    );
    // Oldest mtime, so the target ranks 201st and the capped scan drops it.
    await fs.utimes(targetPath, new Date(0), new Date(0));

    const cappedDocs = await scanAutoMemoryTopicDocuments(projectRoot);
    expect(cappedDocs).toHaveLength(200);
    expect(cappedDocs.some((doc) => doc.filePath === targetPath)).toBe(false);
    return targetPath;
  }

  afterEach(async () => {
    mgr.resetExtractStateForTests();
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
      history: [userTurn('I prefer terse responses.')],
    });

    const queuedExtraction = await mgr.scheduleExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        userTurn('I prefer terse responses.'),
        { role: 'model', parts: [{ text: 'Understood.' }] },
        userTurn(
          'The latency dashboard is https://grafana.example/d/api-latency',
        ),
      ],
    });

    expect(queuedExtraction.skippedReason).toBe('queued');

    const firstResult = await firstExtraction;
    expect(firstResult.touchedTopics).toEqual(['user']);

    const drained = await mgr.drain({
      timeoutMs: 1_000,
    });
    expect(drained).toBe(true);

    const latency =
      'The latency dashboard is https://grafana.example/d/api-latency';
    await writeMemoryDoc(
      projectRoot,
      path.join('project', 'latency-dashboard.md'),
      memoryDoc(
        'project',
        'Latency Dashboard',
        latency,
        latency,
        '',
        'Why: This is temporary for this task.',
      ),
    );
    await rebuildManagedAutoMemoryIndex(projectRoot);

    await writeMemoryDoc(
      projectRoot,
      path.join('user', 'terse-duplicate.md'),
      memoryDoc(
        'user',
        'User Memory Duplicate',
        'Duplicate terse preference',
        'I prefer terse responses.',
        '',
        'Why: User repeatedly asks for concise replies.',
      ),
    );
    await rebuildManagedAutoMemoryIndex(projectRoot);

    const dreamResult = await runManagedAutoMemoryDream(
      projectRoot,
      new Date('2026-04-01T03:00:00.000Z'),
      mockConfig,
    );
    expect(dreamResult.touchedTopics).toContain('user');
    expect(dreamResult.dedupedEntries).toBe(0);

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
    );
    expect(recall.strategy).toBe('heuristic');
    expect(recall.prompt).toContain('## Relevant memory');
    expect(recall.prompt).toContain('user/');
    expect(recall.prompt).toContain('reference/');
  });

  it('recalls a relevant topic beyond the general 200-document scan cap', async () => {
    const targetPath = await seedTargetBeyondScanCap(
      'No matching content.',
      'Unique recall target beyond the general scan cap',
    );

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
      const targetPath = await seedTargetBeyondScanCap(
        'Unrelated historical note.',
        'Unique forget target beyond the general scan cap',
      );

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
