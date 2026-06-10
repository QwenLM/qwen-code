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
import { getAutoMemoryExtractCursorPath } from './paths.js';
import {
  buildTranscriptMessages,
  loadUnprocessedTranscriptSlice,
  runAutoMemoryExtract,
} from './extract.js';
import { runAutoMemoryExtractionByAgent } from './extractionAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';

vi.mock('./extractionAgentPlanner.js', () => ({
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

vi.mock('./indexer.js', () => ({
  rebuildManagedAutoMemoryIndex: vi.fn().mockResolvedValue(''),
  rebuildUserAutoMemoryIndex: vi.fn().mockResolvedValue(''),
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

    const slice = loadUnprocessedTranscriptSlice('session-1', transcript, {
      sessionId: 'session-1',
      processedOffset: 2,
      updatedAt: new Date().toISOString(),
    });

    expect(slice.messages).toHaveLength(1);
    expect(slice.messages[0]?.text).toBe('I prefer terse responses.');
    expect(slice.nextProcessedOffset).toBe(3);
  });

  it('updates cursor and avoids duplicate writes for repeated extraction', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
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
        history: [
          { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
        ],
      }),
    ).rejects.toThrow('Managed auto-memory extraction requires config');
  });

  describe('rebuild failure isolation (asymmetric)', () => {
    const newHistory = [
      { role: 'user' as const, parts: [{ text: 'I prefer terse responses.' }] },
    ];

    async function readCursor() {
      return JSON.parse(
        await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
      ) as { processedOffset?: number; sessionId?: string };
    }

    it('project-scope rebuild failure bubbles up so the cursor is NOT advanced (retry on next session)', async () => {
      // Pre-PR Promise.all behaviour: a project-level rebuild failure threw,
      // the cursor never advanced, and the same slice was re-extracted on
      // the next session — that durability guarantee is the whole point of
      // the cursor. The user-level layer must isolate its OWN failures, but
      // it cannot weaken the project-level retry contract.
      const cursorBefore = await readCursor();
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });
      vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValueOnce(
        new Error('EACCES: project memory index write failed'),
      );

      await expect(
        runAutoMemoryExtract({
          projectRoot,
          sessionId: 'session-1',
          config: mockConfig,
          history: [...newHistory],
        }),
      ).rejects.toThrow('EACCES: project memory index write failed');

      const cursorAfter = await readCursor();
      expect(cursorAfter).toEqual(cursorBefore);
    });

    it('user-scope rebuild failure is logged and swallowed; project rebuild + cursor advance still happen', async () => {
      // User-level memory is best-effort: a read-only `~/.qwen/memories/`
      // must not prevent the project layer from making progress.
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: true,
        systemMessage: undefined,
      });
      vi.mocked(rebuildManagedAutoMemoryIndex).mockResolvedValueOnce('');
      vi.mocked(rebuildUserAutoMemoryIndex).mockRejectedValueOnce(
        new Error('EACCES: user memory index write failed'),
      );

      await expect(
        runAutoMemoryExtract({
          projectRoot,
          sessionId: 'session-1',
          config: mockConfig,
          history: [...newHistory],
        }),
      ).resolves.toBeDefined();

      expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);

      const cursor = await readCursor();
      expect(cursor.sessionId).toBe('session-1');
      expect(cursor.processedOffset).toBe(1);
    });

    it('both rebuilds run in parallel when both scopes are touched', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user', 'project'],
        touchedProjectScope: true,
        touchedUserScope: true,
        systemMessage: undefined,
      });

      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...newHistory],
      });

      expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledTimes(1);
    });

    it('defensive fallback rebuilds the project index when neither scope flag is set but topics were touched', async () => {
      // Mirrors the planner-was-stale-during-rollout safety net in extract.ts.
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: false,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...newHistory],
      });

      expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledTimes(1);
      expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
    });
  });
});
