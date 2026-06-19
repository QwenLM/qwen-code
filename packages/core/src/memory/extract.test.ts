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
import type { Content } from '@google/genai';
import { getAutoMemoryExtractCursorPath } from './paths.js';
import { runAutoMemoryExtract } from './extract.js';
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

  describe('#5147 OOM regression', () => {
    /**
     * A1: cursor-first — runAutoMemoryExtract only processes the unread
     * portion of history. The first call processes all messages; the second
     * call (with only a few new messages appended) should NOT reprocess
     * the already-processed prefix.
     */
    it('only processes unread messages via cursor-first ordering', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      // Build 20 messages (10 turns of user+model)
      const history: Content[] = [];
      for (let i = 0; i < 20; i++) {
        history.push({
          role: i % 2 === 0 ? 'user' : 'model',
          parts: [
            { text: `[MSG${i}] `.padEnd(16, '-') + `content for message ${i}` },
          ],
        });
      }

      // First extract: processes all 20 messages
      const first = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });
      expect(first.cursor.processedOffset).toBe(20);
      expect(runAutoMemoryExtractionByAgent).toHaveBeenCalledTimes(1);

      // Add 2 new messages (1 turn)
      history.push(
        { role: 'user', parts: [{ text: 'new user question?' }] },
        { role: 'model', parts: [{ text: 'new assistant answer.' }] },
      );

      // Second extract: should detect only the 2 new messages
      const agentCallsBefore = vi.mocked(runAutoMemoryExtractionByAgent).mock
        .calls.length;
      const second = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      // Fork agent should have been called again (new user message found)
      expect(vi.mocked(runAutoMemoryExtractionByAgent).mock.calls.length).toBe(
        agentCallsBefore + 1,
      );
      // Cursor advances to full history length
      expect(second.cursor.processedOffset).toBe(22);
    });

    /**
     * A2: when the cursor is already at the end of history (no new user
     * messages), runAutoMemoryExtract skips without calling the fork agent.
     */
    it('skips extract when cursor is already up to date', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ];

      // First extract: cursor → 2
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      const agentCallsBefore = vi.mocked(runAutoMemoryExtractionByAgent).mock
        .calls.length;

      // Second extract with same 2 messages: no new user messages
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      // Fork agent should NOT be called again
      expect(vi.mocked(runAutoMemoryExtractionByAgent).mock.calls.length).toBe(
        agentCallsBefore,
      );
      expect(result.touchedTopics).toEqual([]);
      expect(result.cursor.processedOffset).toBe(2);
    });

    /**
     * A3: a huge single message does not OOM the cursor scan. The cursor
     * path no longer stringifies history with the global whitespace regex;
     * it only does a bounded partToString().trim() on the unprocessed slice
     * to detect new user content. A 5MB message must be handled without the
     * old full-history .replace(/\s+/g) blow-up.
     */
    it('handles a huge single message without OOM in the cursor scan', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      const hugeText = 'x '.repeat(2_500_000); // ~5MB with whitespace
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [{ role: 'user', parts: [{ text: hugeText }] }],
      });

      // New user content detected → fork agent invoked, cursor advanced.
      expect(runAutoMemoryExtractionByAgent).toHaveBeenCalled();
      expect(result.cursor.processedOffset).toBe(1);
    });

    /**
     * A4: when the session ID changes between extracts, the cursor from the
     * old session is ignored, and the full history is treated as unprocessed.
     */
    it('reprocesses full history when session changes', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first session query' }] },
        { role: 'model', parts: [{ text: 'first session answer' }] },
      ];

      // Session 1: cursor advances to 2
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      const agentCallsBefore = vi.mocked(runAutoMemoryExtractionByAgent).mock
        .calls.length;

      // Session 2: cursor ignored, full history treated as unprocessed
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-2',
        config: mockConfig,
        history: [...history],
      });

      // Fork agent called again (session changed, so messages are "new")
      expect(vi.mocked(runAutoMemoryExtractionByAgent).mock.calls.length).toBe(
        agentCallsBefore + 1,
      );
    });

    /**
     * A5: verify that cursor-first ordering prevents OOM by processing only
     * the unread portion. Constructs a large history where most messages
     * have already been processed, then verifies that the extract completes
     * without processing the full-history text through .replace().
     */
    it('avoids full-history regex replace when most messages are already processed', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      // Build 50 messages, each with unique text to prevent string interning.
      const history: Content[] = [];
      for (let i = 0; i < 50; i++) {
        const prefix = `[MSG${i}] `.padEnd(16, '-');
        history.push({
          role: i % 2 === 0 ? 'user' : 'model',
          parts: [{ text: prefix + `${i}: the quick brown fox `.repeat(200) }],
        });
      }

      // Process all 50 in the first extract
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      // Add 2 more messages — only these need processing
      history.push(
        { role: 'user', parts: [{ text: 'final question?'.repeat(50) }] },
        { role: 'model', parts: [{ text: 'final answer.'.repeat(50) }] },
      );

      const agentCallsBefore = vi.mocked(runAutoMemoryExtractionByAgent).mock
        .calls.length;

      // This should complete without OOM — it only processes 2 messages,
      // not the full 52.
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      expect(vi.mocked(runAutoMemoryExtractionByAgent).mock.calls.length).toBe(
        agentCallsBefore + 1,
      );
      expect(result.cursor.processedOffset).toBe(52);
    });

    /**
     * A6: the cursor scan must not count empty or whitespace-only user
     * messages as "new user content". The partToString().trim().length > 0
     * filter should cause the extract to be skipped, just like the old
     * buildTranscriptMessages().filter() did.
     */
    it('skips extract when unprocessed user messages are whitespace-only', async () => {
      const history: Content[] = [{ role: 'user', parts: [{ text: '   ' }] }];
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
      expect(result.touchedTopics).toEqual([]);
    });

    it('skips extract when unprocessed user messages have empty parts', async () => {
      const history: Content[] = [{ role: 'user', parts: [] }];
      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...history],
      });

      expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
      expect(result.touchedTopics).toEqual([]);
    });

    /**
     * A7: when history shrinks between extract calls (e.g. compression
     * reduces 50 → 17 entries), the stored processedOffset (50) exceeds
     * history.length (17). The cursor-first logic must reset startOffset
     * to 0 rather than passing 50 to history.slice(), which would return
     * [] and permanently skip new messages.
     */
    it('re-scans full history when stored offset exceeds current length (compression)', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: true,
        touchedUserScope: false,
        systemMessage: undefined,
      });

      // First extract: 20 messages, cursor advances to 20.
      const fullHistory: Content[] = [];
      for (let i = 0; i < 20; i++) {
        fullHistory.push({
          role: i % 2 === 0 ? 'user' : 'model',
          parts: [{ text: `compression msg ${i}` }],
        });
      }
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...fullHistory],
      });

      // Simulate compression: history shrinks from 20 to 5, but cursor
      // still says processedOffset = 20. Then a new user message is added.
      const compressedHistory = fullHistory.slice(0, 5);
      compressedHistory.push({
        role: 'user',
        parts: [{ text: 'new question after compression' }],
      });

      const agentCallsBefore = vi.mocked(runAutoMemoryExtractionByAgent).mock
        .calls.length;

      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...compressedHistory], // 6 messages, cursor says 20
      });

      // The new user message must be detected — startOffset was clamped to 0
      // instead of using the stale 20 that exceeds history.length (6).
      expect(vi.mocked(runAutoMemoryExtractionByAgent).mock.calls.length).toBe(
        agentCallsBefore + 1,
      );
      expect(result.cursor.processedOffset).toBe(compressedHistory.length);
    });
  });
});
