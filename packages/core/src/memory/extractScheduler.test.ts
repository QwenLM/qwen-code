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
import { createManagedAutoMemoryExtractRuntimeForTests } from './extractScheduler.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { getAutoMemoryFilePath } from './paths.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { markExtractRunning, resetAutoMemoryStateForTests } from './state.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

describe('managed auto-memory extraction runtime', () => {
  let tempDir: string;
  let projectRoot: string;
  let mockConfig: Config;
  let extractionCount: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-extract-runtime-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    } as unknown as Config;
    vi.clearAllMocks();
    extractionCount = 0;
    vi.mocked(runAutoMemoryExtractionByAgent).mockImplementation(
      async (_config: Config, root: string) => {
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
            ? 'https://grafana.example/d/api'
            : 'User prefers terse responses.';
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
          systemMessage: undefined,
        };
      },
    );
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('queues a trailing extraction while another extraction is running', async () => {
    const runtime = createManagedAutoMemoryExtractRuntimeForTests();

    const firstPromise = runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      ],
    });

    const queued = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        { role: 'model', parts: [{ text: 'Done.' }] },
        {
          role: 'user',
          parts: [
            { text: 'The latency dashboard is https://grafana.example/d/api' },
          ],
        },
      ],
    });

    expect(queued.skippedReason).toBe('queued');

    const first = await firstPromise;
    expect(first.touchedTopics).toEqual(['user']);

    const drained = await runtime.drain({ timeoutMs: 1_000 });
    expect(drained).toBe(true);

    const docs = await scanAutoMemoryTopicDocuments(projectRoot);
    expect(docs.find((doc) => doc.type === 'reference')?.body).toContain(
      'grafana.example/d/api',
    );

    const tasks = runtime.listTasks(projectRoot);
    expect(tasks.some((task) => task.status === 'completed')).toBe(true);
    expect(tasks.some((task) => task.metadata?.['trailing'] === true)).toBe(
      true,
    );
  });

  it('returns already_running when extraction state is externally locked', async () => {
    markExtractRunning(projectRoot);
    const runtime = createManagedAutoMemoryExtractRuntimeForTests();

    const result = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [
        { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      ],
    });

    expect(result.skippedReason).toBe('already_running');
  });
});
