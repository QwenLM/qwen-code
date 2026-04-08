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
import { getAutoMemoryExtractCursorPath, getAutoMemoryIndexPath } from './paths.js';
import {
  buildTranscriptMessages,
  loadUnprocessedTranscriptSlice,
  runAutoMemoryExtract,
} from './extract.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { resetAutoMemoryStateForTests } from './state.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

describe('auto-memory extraction', () => {
  let tempDir: string;
  let projectRoot: string;
  let mockConfig: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-extract-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
    mockConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
    } as unknown as Config;
    vi.clearAllMocks();
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

  it('builds transcript slices from history and cursor state', () => {
    const transcript = buildTranscriptMessages([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'world' }] },
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
    ]);

    const slice = loadUnprocessedTranscriptSlice(
      'session-1',
      transcript,
      {
        sessionId: 'session-1',
        processedOffset: 2,
        updatedAt: new Date().toISOString(),
      },
    );

    expect(slice.messages).toHaveLength(1);
    expect(slice.messages[0]?.text).toBe('I prefer terse responses.');
    expect(slice.nextProcessedOffset).toBe(3);
  });

  it('dedupes agent-reported patches while preserving touched topics', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      patches: [
        {
          topic: 'user',
          summary: 'User prefers terse responses.',
          sourceOffset: 0,
        },
        {
          topic: 'user',
          summary: 'User prefers terse responses.',
          sourceOffset: 0,
        },
      ],
      touchedTopics: ['user'],
      systemMessage: 'Managed auto-memory updated: user.md',
    });

    const result = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [{ role: 'user', parts: [{ text: 'I prefer terse responses.' }] }],
    });

    expect(result.patches).toEqual([
      {
        topic: 'user',
        summary: 'User prefers terse responses.',
        sourceOffset: 0,
      },
    ]);
    expect(result.touchedTopics).toEqual(['user']);
  });

  it('updates cursor and avoids duplicate writes for repeated extraction', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      patches: [
        {
          topic: 'user',
          summary: 'User prefers terse responses.',
          sourceOffset: 0,
        },
      ],
      touchedTopics: [],
      systemMessage: undefined,
    });

    const history = [
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
    ];

    const first = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [...history],
    });
    const second = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [...history],
    });

    expect(first.touchedTopics).toEqual([]);
    expect(second.touchedTopics).toEqual([]);

    const cursor = JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ) as { processedOffset: number; sessionId: string };

    expect(cursor.sessionId).toBe('session-1');
    expect(cursor.processedOffset).toBe(2);
  });

  it('throws when config is missing because heuristic fallback was removed', async () => {
    await expect(
      runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        history: [{ role: 'user', parts: [{ text: 'I prefer terse responses.' }] }],
      }),
    ).rejects.toThrow('Managed auto-memory extraction requires config');
  });
});