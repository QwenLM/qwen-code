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
import {
  drainManagedAutoMemoryExtractTasks,
  resetManagedAutoMemoryExtractRuntimeForTests,
  scheduleManagedAutoMemoryExtract,
} from './extractScheduler.js';
import { rebuildManagedAutoMemoryIndex } from './indexer.js';
import { getAutoMemoryFilePath, getAutoMemoryIndexPath } from './paths.js';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { resetAutoMemoryStateForTests } from './state.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

describe('managed auto-memory lifecycle integration', () => {
  let tempDir: string;
  let projectRoot: string;
  let mockConfig: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-lifecycle-int-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
    mockConfig = {
      getSessionId: () => 'session-1',
      getModel: () => 'qwen3-coder-plus',
    } as Config;
    vi.clearAllMocks();
    vi.mocked(runAutoMemoryExtractionByAgent).mockImplementation(
      async (_config, root, messages) => {
        const lastUserText = messages
          .filter((message) => message.role === 'user')
          .at(-1)?.text;
        const topic = lastUserText?.includes('grafana.example/d/api-latency')
          ? 'reference'
          : 'user';
        const relativePath =
          topic === 'reference'
            ? path.join('reference', 'latency-dashboard.md')
            : path.join('user', 'terse-responses.md');
        const filePath = getAutoMemoryFilePath(root, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          filePath,
          [
            '---',
            `type: ${topic}`,
            `name: ${topic === 'reference' ? 'Latency Dashboard' : 'Terse Responses'}`,
            `description: ${lastUserText ?? 'I prefer terse responses.'}`,
            '---',
            '',
            lastUserText ?? 'I prefer terse responses.',
            '',
          ].join('\n'),
          'utf-8',
        );

        return {
          patches: [
            {
              topic,
              summary: lastUserText ?? 'I prefer terse responses.',
              sourceOffset: messages.at(-1)?.offset ?? 0,
            },
          ],
          touchedTopics: [topic],
          systemMessage: undefined,
        };
      },
    );
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    resetManagedAutoMemoryExtractRuntimeForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('supports a Claude-style durable memory lifecycle across extraction, recall, and dream', async () => {
    const firstExtraction = scheduleManagedAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [{ role: 'user', parts: [{ text: 'I prefer terse responses.' }] }],
    });

    const queuedExtraction = await scheduleManagedAutoMemoryExtract({
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

    const drained = await drainManagedAutoMemoryExtractTasks({ timeoutMs: 1_000 });
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
    );
    expect(dreamResult.touchedTopics).toContain('user');
    expect(dreamResult.dedupedEntries).toBeGreaterThan(0);

    const indexContent = await fs.readFile(
      getAutoMemoryIndexPath(projectRoot),
      'utf-8',
    );
    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    const userDoc = docs.find((doc) => doc.type === 'user');
    const projectDoc = docs.find((doc) => doc.type === 'project');
    const referenceDoc = docs.find((doc) => doc.type === 'reference');

    expect(userDoc?.body).toContain('I prefer terse responses.');
    expect(userDoc?.body).toContain('Why: User repeatedly asks for concise replies.');
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
});