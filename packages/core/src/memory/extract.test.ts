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
import {
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
} from './paths.js';
import { runAutoMemoryExtract } from './extract.js';
import {
  AutoMemoryExtractionError,
  runAutoMemoryExtractionByAgent,
} from './extractionAgentPlanner.js';
import { ensureAutoMemoryScaffold } from './store.js';
import {
  rebuildManagedAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import { refreshMemoryInstruction } from './refresh.js';
import { getCacheSafeParamsSessionId } from '../agents/forkedAgent.js';
import { CACHE_SAFE_HISTORY_TAIL_ENTRIES } from '../agents/cache-safe-history.js';
import { composePostCompactHistory } from '../services/postCompactAttachments.js';

vi.mock('./extractionAgentPlanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extractionAgentPlanner.js')>()),
  runAutoMemoryExtractionByAgent: vi.fn(),
}));

vi.mock('../agents/forkedAgent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agents/forkedAgent.js')>()),
  getCacheSafeParamsSessionId: vi.fn(),
}));

vi.mock('./indexer.js', () => ({
  rebuildManagedAutoMemoryIndex: vi.fn().mockResolvedValue(''),
  rebuildUserAutoMemoryIndex: vi.fn().mockResolvedValue(''),
}));

vi.mock('./refresh.js', () => ({
  refreshMemoryInstruction: vi.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForMockCall(mock: { mock: { calls: unknown[] } }) {
  // Wall-clock deadline, not a fixed tick count: the mock is invoked after
  // real async work (index reads, cursor I/O), and ten zero-delay turns can
  // elapse before that work completes on a loaded CI runner — the poll spun
  // through its turns without waiting any actual time.
  const deadline = Date.now() + 2000;
  for (;;) {
    if (mock.mock.calls.length > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('Expected mock to be called');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    vi.mocked(getCacheSafeParamsSessionId).mockReturnValue('session-1');
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
      hasToolActivity: true,
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
    expect(first.extractorRan).toBe(true);
    expect(second.extractorRan).toBeUndefined();
    expect(refreshMemoryInstruction).not.toHaveBeenCalled();

    const cursor = JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ) as {
      processedOffset: number;
      sessionId: string;
      processedHistoryHash?: string;
    };

    expect(cursor.sessionId).toBe('session-1');
    expect(cursor.processedOffset).toBe(2);
    expect(cursor.processedHistoryHash).toBeUndefined();
  });

  it('skips a session mismatch without advancing the cursor', async () => {
    vi.mocked(getCacheSafeParamsSessionId)
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('session-2');
    const cursorBefore = await fs.readFile(
      getAutoMemoryExtractCursorPath(projectRoot),
      'utf-8',
    );

    const result = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
    });

    expect(result.skippedReason).toBe('session_mismatch');
    expect(result.cursor.processedOffset).toBeUndefined();
    expect(result.extractorRan).toBeUndefined();
    expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
    expect(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ).toBe(cursorBefore);
  });

  it('skips an existing session mismatch before scaffold IO', async () => {
    vi.mocked(getCacheSafeParamsSessionId).mockReturnValue('session-2');
    const uncreatedProjectRoot = path.join(tempDir, 'not-created');

    const result = await runAutoMemoryExtract({
      projectRoot: uncreatedProjectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
    });

    expect(result.skippedReason).toBe('session_mismatch');
    await expect(fs.stat(uncreatedProjectRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
  });

  it('preserves the empty-cache failure path', async () => {
    vi.mocked(getCacheSafeParamsSessionId).mockReturnValue(undefined);
    vi.mocked(runAutoMemoryExtractionByAgent).mockRejectedValueOnce(
      new Error('no cache-safe params'),
    );

    await expect(
      runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
      }),
    ).rejects.toThrow('no cache-safe params');
    expect(runAutoMemoryExtractionByAgent).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'recovers failed fork writes without advancing the cursor (window: %s)',
    async (preserveUnprocessedHistory) => {
      const cursorBefore = await fs.readFile(
        getAutoMemoryExtractCursorPath(projectRoot),
        'utf-8',
      );
      const metadataBefore = await fs.readFile(
        getAutoMemoryMetadataPath(projectRoot),
        'utf-8',
      );
      const failure = new AutoMemoryExtractionError('MAX_TURNS', {
        touchedTopics: ['project', 'user'],
        touchedProjectScope: true,
        touchedUserScope: true,
        hasToolActivity: true,
      });
      vi.mocked(runAutoMemoryExtractionByAgent).mockRejectedValueOnce(failure);

      await expect(
        runAutoMemoryExtract({
          projectRoot,
          sessionId: 'session-1',
          config: mockConfig,
          history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
          preserveUnprocessedHistory,
        }),
      ).rejects.toBe(failure);

      expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledOnce();
      expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledOnce();
      expect(refreshMemoryInstruction).toHaveBeenCalledOnce();
      expect(
        await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
      ).toBe(cursorBefore);
      expect(
        await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
      ).toBe(metadataBefore);
    },
  );

  it('retains failed fork writes and both causes when project recovery fails', async () => {
    const result = {
      touchedTopics: ['user' as const],
      touchedProjectScope: true,
      touchedUserScope: true,
      hasToolActivity: true,
    };
    const failure = new AutoMemoryExtractionError('MAX_TURNS', result);
    const rebuildFailure = new Error('EISDIR: project index');
    vi.mocked(runAutoMemoryExtractionByAgent).mockRejectedValueOnce(failure);
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValueOnce(
      rebuildFailure,
    );
    const cursorBefore = await fs.readFile(
      getAutoMemoryExtractCursorPath(projectRoot),
      'utf-8',
    );

    const error = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(AutoMemoryExtractionError);
    expect(error).toMatchObject({
      result,
      cause: { errors: [failure, rebuildFailure] },
    });
    expect(rebuildUserAutoMemoryIndex).toHaveBeenCalledOnce();
    expect(refreshMemoryInstruction).not.toHaveBeenCalled();
    expect(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ).toBe(cursorBefore);
  });

  it('retains successful fork write scope when project indexing fails', async () => {
    const result = {
      touchedTopics: ['user' as const],
      touchedProjectScope: true,
      touchedUserScope: true,
      hasToolActivity: true,
    };
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValueOnce(result);
    const rebuildFailure = new Error('EISDIR: project index');
    vi.mocked(rebuildManagedAutoMemoryIndex).mockRejectedValueOnce(
      rebuildFailure,
    );

    await expect(
      runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
      }),
    ).rejects.toMatchObject({ result, cause: rebuildFailure });
  });

  it('does not recover reads as writes after a failed fork', async () => {
    const failure = new AutoMemoryExtractionError('timeout', {
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: true,
    });
    vi.mocked(runAutoMemoryExtractionByAgent).mockRejectedValueOnce(failure);

    await expect(
      runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
      }),
    ).rejects.toBe(failure);

    expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
    expect(refreshMemoryInstruction).not.toHaveBeenCalled();
  });

  it('rebuilds a failed fork index-only write without claiming touched topics', async () => {
    const failure = new AutoMemoryExtractionError('MAX_TURNS', {
      touchedTopics: [],
      touchedProjectScope: true,
      touchedUserScope: false,
      hasToolActivity: true,
    });
    vi.mocked(runAutoMemoryExtractionByAgent).mockRejectedValueOnce(failure);

    await expect(
      runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [{ role: 'user', parts: [{ text: 'Remember this.' }] }],
      }),
    ).rejects.toBe(failure);

    expect(rebuildManagedAutoMemoryIndex).toHaveBeenCalledOnce();
    expect(rebuildUserAutoMemoryIndex).not.toHaveBeenCalled();
    expect(refreshMemoryInstruction).toHaveBeenCalledOnce();
  });

  it('extracts skipped history before a large ending turn and leaves the remainder pending', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: true,
    });
    const prefix: Content[] = [
      { role: 'user', parts: [{ text: 'Already processed.' }] },
    ];
    const params = {
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      preserveUnprocessedHistory: true,
    };
    await runAutoMemoryExtract({ ...params, history: prefix });
    const skippedFact: Content = {
      role: 'user',
      parts: [{ text: 'Remember: production uses pnpm.' }],
    };
    const history = [
      ...prefix,
      skippedFact,
      ...Array.from(
        { length: CACHE_SAFE_HISTORY_TAIL_ENTRIES },
        (_, i): Content =>
          i % 2 === 0
            ? {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: `read-${i / 2}`,
                      name: 'read_file',
                      args: {},
                    },
                  },
                ],
              }
            : {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: `read-${(i - 1) / 2}`,
                      name: 'read_file',
                      response: { output: 'Read complete.' },
                    },
                  },
                ],
              },
      ),
      {
        role: 'user',
        parts: [{ text: 'Another durable fact in the remainder.' }],
      },
    ];
    expect(history.slice(-CACHE_SAFE_HISTORY_TAIL_ENTRIES)).not.toContain(
      skippedFact,
    );

    const first = await runAutoMemoryExtract({ ...params, history });
    const boundary = prefix.length + CACHE_SAFE_HISTORY_TAIL_ENTRIES;
    // The naive boundary lands on the open functionCall at i=38 (the skipped
    // fact shifted the alternating pairs by one), so the cut retreats one
    // entry: the window ends before the open call and the cursor stops
    // there, keeping the call and its response together for the next run.
    const aligned = boundary - 1;
    // The aligned window does not reach the end of history, so the run is
    // stamped as a historical segment for the planner prompt.
    expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
      mockConfig,
      projectRoot,
      history.slice(prefix.length, aligned),
      { windowAsOf: expect.any(String) },
    );
    expect(first.cursor.processedOffset).toBe(aligned);
    const persisted = JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    );
    expect(persisted.processedOffset).toBe(aligned);

    const second = await runAutoMemoryExtract({ ...params, history });
    expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
      mockConfig,
      projectRoot,
      history.slice(aligned),
      undefined,
    );
    expect(second.cursor.processedOffset).toBe(history.length);
  });

  it('backs the pending-window cut off a model functionCall so the response is never orphaned', async () => {
    // A plain-index cut can land between a model functionCall and its
    // functionResponse: the trailing repair would fabricate a response
    // reusing the real call's id, and the next window would open on the
    // orphaned true output, which no run ever sees. The cut must retreat to
    // the turn boundary: the window ends before the open call, the cursor
    // stops there, and the next run's window starts on it.
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: true,
    });
    const params = {
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      preserveUnprocessedHistory: true,
    };
    const prefix: Content[] = [
      { role: 'user', parts: [{ text: 'Already processed.' }] },
    ];
    await runAutoMemoryExtract({ ...params, history: prefix });

    // Entry at the naive cut (startOffset + CACHE_SAFE_HISTORY_TAIL_ENTRIES)
    // is a model functionCall; its response follows it.
    const boundary = prefix.length + CACHE_SAFE_HISTORY_TAIL_ENTRIES;
    const history: Content[] = [
      ...prefix,
      { role: 'user', parts: [{ text: 'Pending user fact.' }] },
      ...Array.from(
        { length: CACHE_SAFE_HISTORY_TAIL_ENTRIES - 2 },
        (_, i): Content => ({
          role: 'model',
          parts: [{ text: `Filler turn ${i}.` }],
        }),
      ),
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'call-open', name: 'read_file', args: {} } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-open',
              name: 'read_file',
              response: { output: 'the real file bytes' },
            },
          },
        ],
      },
      { role: 'user', parts: [{ text: 'A durable fact in the remainder.' }] },
    ];
    expect(history[boundary - 1]?.parts?.[0]).toHaveProperty('functionCall');

    const first = await runAutoMemoryExtract({ ...params, history });
    // The cut retreated one entry: the window ends before the open call.
    // That window is a historical segment, so the planner gets windowAsOf.
    expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
      mockConfig,
      projectRoot,
      history.slice(prefix.length, boundary - 1),
      { windowAsOf: expect.any(String) },
    );
    expect(first.cursor.processedOffset).toBe(boundary - 1);

    const second = await runAutoMemoryExtract({ ...params, history });
    // The next window opens on the call, so call and response are extracted
    // together — and it reaches the end of history, so no segment stamp.
    expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
      mockConfig,
      projectRoot,
      history.slice(boundary - 1),
      undefined,
    );
    expect(second.cursor.processedOffset).toBe(history.length);
  });

  it('does not mark a user fact beyond an empty pending window processed', async () => {
    await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      preserveUnprocessedHistory: true,
      history: [],
    });
    const history: Content[] = [
      ...Array.from(
        { length: CACHE_SAFE_HISTORY_TAIL_ENTRIES },
        (): Content => ({ role: 'model', parts: [{ text: 'No user fact.' }] }),
      ),
      { role: 'user', parts: [{ text: 'Remember: use pnpm.' }] },
    ];
    const result = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      preserveUnprocessedHistory: true,
      history,
    });
    expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
    expect(result.cursor.processedOffset).toBe(CACHE_SAFE_HISTORY_TAIL_ENTRIES);
    expect(result.extractorRan).toBeUndefined();
  });

  it.each([
    {
      label: 'reminder only',
      userParts: [
        { text: '<system-reminder>Continue the task.</system-reminder>' },
      ],
      extractorRan: undefined,
    },
    {
      label: 'reminder and user text in one part',
      userParts: [
        {
          text: '<system-reminder>Continue the task.</system-reminder>\nRemember: use isolated runtimes.',
        },
      ],
      extractorRan: true,
    },
    {
      label: 'unclosed reminder and user text in separate parts',
      userParts: [
        { text: '<system-reminder>Continue the task.' },
        { text: 'Remember: use isolated runtimes.' },
      ],
      extractorRan: true,
    },
    {
      label: 'hidden reasoning only',
      userParts: [{ thought: true, text: 'Hidden reasoning.' }],
      extractorRan: undefined,
    },
  ])(
    'ignores runtime reminders while preserving user text: $label',
    async ({ userParts, extractorRan }) => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        hasToolActivity: true,
      });
      await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        preserveUnprocessedHistory: true,
        history: [],
      });
      const history: Content[] = Array.from(
        { length: CACHE_SAFE_HISTORY_TAIL_ENTRIES / 2 },
        (_, i): Content[] => [
          {
            role: 'model',
            parts: [{ functionCall: { id: `read-${i}`, name: 'read_file' } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: `read-${i}`,
                  name: 'read_file',
                  response: { output: 'Read-only result.' },
                },
              },
              ...userParts,
            ],
          },
        ],
      ).flat();
      history.push({
        role: 'user',
        parts: [{ text: 'A later durable fact.' }],
      });

      const result = await runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        preserveUnprocessedHistory: true,
        history,
      });

      expect(result.cursor.processedOffset).toBe(
        CACHE_SAFE_HISTORY_TAIL_ENTRIES,
      );
      expect(result.extractorRan).toBe(extractorRan);
      expect(runAutoMemoryExtractionByAgent).toHaveBeenCalledTimes(
        extractorRan ? 1 : 0,
      );
    },
  );

  it('windowed arm: a no-progress run advances the pending window instead of freezing it', async () => {
    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: false,
      systemMessage: undefined,
    });
    const params = {
      projectRoot,
      sessionId: 'session-1',
      config: mockConfig,
      preserveUnprocessedHistory: true,
    };
    await runAutoMemoryExtract({ ...params, history: [] });
    const history: Content[] = Array.from(
      { length: CACHE_SAFE_HISTORY_TAIL_ENTRIES },
      (_, i): Content => ({
        role: 'user',
        parts: [{ text: `Pending fact ${i}.` }],
      }),
    );
    const lateFact: Content = {
      role: 'user',
      parts: [{ text: 'Remember: the late fact stated after the cap.' }],
    };
    history.push(
      lateFact,
      { role: 'model', parts: [{ text: 'Noted.' }] },
      { role: 'user', parts: [{ text: 'And one more newer fact.' }] },
      { role: 'model', parts: [{ text: 'Noted too.' }] },
    );

    const first = await runAutoMemoryExtract({ ...params, history });
    // The first window does not reach the end of history, so it is stamped
    // as a historical segment for the planner prompt.
    expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
      mockConfig,
      projectRoot,
      history.slice(0, CACHE_SAFE_HISTORY_TAIL_ENTRIES),
      { windowAsOf: expect.any(String) },
    );
    // No genuine progress, but the capped window must still advance: holding
    // the cursor at startOffset recomputes a byte-identical slice next turn
    // (endOffset is capped relative to startOffset), freezing the window for
    // the rest of the session and never arming the no-op cooldown.
    expect(first.cursor.processedOffset).toBe(CACHE_SAFE_HISTORY_TAIL_ENTRIES);

    const second = await runAutoMemoryExtract({ ...params, history });
    const secondWindow = vi.mocked(runAutoMemoryExtractionByAgent).mock
      .calls[1]?.[2];
    expect(secondWindow).toEqual(
      history.slice(CACHE_SAFE_HISTORY_TAIL_ENTRIES),
    );
    expect(secondWindow).toContainEqual(lateFact);
    expect(second.cursor.processedOffset).toBe(CACHE_SAFE_HISTORY_TAIL_ENTRIES);

    vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
      touchedTopics: [],
      touchedProjectScope: false,
      touchedUserScope: false,
      hasToolActivity: true,
      systemMessage: undefined,
    });
    const verified = await runAutoMemoryExtract({ ...params, history });
    expect(verified.cursor.processedOffset).toBe(history.length);
  });

  describe('window history identity', () => {
    function toolPairs(count: number): Content[] {
      return Array.from({ length: count }, (_, i): Content[] => [
        {
          role: 'model',
          parts: [{ functionCall: { id: `tool-${i}`, name: 'read_file' } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: `tool-${i}`,
                name: 'read_file',
                response: { output: 'Read.' },
              },
            },
          ],
        },
      ]).flat();
    }

    function longTurn(): Content[] {
      return [
        { role: 'user', parts: [{ text: 'Remember: use pnpm.' }] },
        { role: 'model', parts: [{ text: 'Noted.' }] },
        ...toolPairs(39),
      ];
    }

    function params() {
      return {
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        preserveUnprocessedHistory: true,
      };
    }

    function compressedPrefix(): Content[] {
      return [
        { role: 'user', parts: [{ text: 'Summary. Resume the prior task.' }] },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
        {
          role: 'user',
          parts: [
            {
              text: 'Recently accessed file (full current content embedded):\n```ts\nconst embedded = true;\n```',
            },
          ],
        },
      ];
    }

    beforeEach(() => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        hasToolActivity: true,
      });
    });

    it('bootstraps a legal new session at its current user turn, not inherited history', async () => {
      const inherited = longTurn();
      await runAutoMemoryExtract({
        ...params(),
        preserveUnprocessedHistory: false,
        history: inherited,
      });
      vi.mocked(mockConfig.getSessionId).mockReturnValue('session-2');
      vi.mocked(getCacheSafeParamsSessionId).mockReturnValue('session-2');
      const current: Content[] = [
        { role: 'user', parts: [{ text: 'Remember: use isolated runtimes.' }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ];

      await runAutoMemoryExtract({
        ...params(),
        sessionId: 'session-2',
        history: [...inherited, ...current],
      });

      expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
        mockConfig,
        projectRoot,
        current,
        undefined,
      );
    });

    it('retains the opening preference on a fresh long tool turn', async () => {
      const history = longTurn();
      const first = await runAutoMemoryExtract({ ...params(), history });
      expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
        mockConfig,
        projectRoot,
        history.slice(0, 40),
        { windowAsOf: expect.any(String) },
      );
      expect(first.cursor.processedOffset).toBe(history.length);
      expect(first.cursor.processedHistoryHash).toMatch(/^[a-f0-9]{64}$/);
      const second = await runAutoMemoryExtract({ ...params(), history });
      expect(second.extractorRan).toBeUndefined();
      expect(second.cursor.processedOffset).toBe(80);
      expect(second.cursor.processedHistoryHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('consumes an entirely ineligible tail without a fork', async () => {
      await runAutoMemoryExtract({ ...params(), history: [] });
      const history = toolPairs(45);
      history
        .at(-1)!
        .parts!.push(
          { text: '<system-reminder>Continue the task.</system-reminder>' },
          { thought: true, text: 'Hidden reasoning.' },
        );

      const result = await runAutoMemoryExtract({ ...params(), history });

      expect(result.cursor.processedOffset).toBe(history.length);
      expect(result.extractorRan).toBeUndefined();
      expect(runAutoMemoryExtractionByAgent).not.toHaveBeenCalled();
    });

    it('keeps the capped boundary when a zero-tool run leaves an ineligible tail', async () => {
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        hasToolActivity: false,
      });
      const history = longTurn();

      const result = await runAutoMemoryExtract({ ...params(), history });

      expect(result.cursor.processedOffset).toBe(40);
      expect(result.extractorRan).toBe(true);
      expect(runAutoMemoryExtractionByAgent).toHaveBeenCalledOnce();
    });

    it('attests a freely consumed tail before an asynchronous extraction', async () => {
      const history = longTurn();
      const completion =
        deferred<Awaited<ReturnType<typeof runAutoMemoryExtractionByAgent>>>();
      vi.mocked(runAutoMemoryExtractionByAgent).mockReturnValueOnce(
        completion.promise,
      );
      const pending = runAutoMemoryExtract({ ...params(), history });
      await waitForMockCall(vi.mocked(runAutoMemoryExtractionByAgent));
      const correction: Content = {
        role: 'user',
        parts: [{ text: 'Correction: prefer npm.' }],
      };
      history[60] = correction;
      completion.resolve({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        hasToolActivity: true,
      });

      expect((await pending).cursor.processedOffset).toBe(80);
      const restarted = await runAutoMemoryExtract({ ...params(), history });
      expect(restarted.cursor.processedOffset).toBe(40);
      await runAutoMemoryExtract({ ...params(), history });
      expect(
        vi.mocked(runAutoMemoryExtractionByAgent).mock.lastCall?.[2],
      ).toContainEqual(correction);
    });

    it('excludes compressed summaries and full-file attachments with a legacy stale cursor', async () => {
      await fs.writeFile(
        getAutoMemoryExtractCursorPath(projectRoot),
        JSON.stringify({
          sessionId: 'session-1',
          processedOffset: 400,
          updatedAt: new Date(0).toISOString(),
        }),
      );
      const realHistory = longTurn();
      const result = await runAutoMemoryExtract({
        ...params(),
        history: [...compressedPrefix(), ...realHistory],
      });
      expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
        mockConfig,
        projectRoot,
        realHistory.slice(0, 40),
        { windowAsOf: expect.any(String) },
      );
      expect(result.cursor.processedOffset).toBe(83);
    });

    it('keeps facts before the stale offset reachable after unobserved shrink and regrowth', async () => {
      const oldHistory = longTurn();
      await runAutoMemoryExtract({ ...params(), history: oldHistory });
      await runAutoMemoryExtract({ ...params(), history: oldHistory });
      vi.mocked(runAutoMemoryExtractionByAgent).mockClear();
      const middleFact: Content = {
        role: 'user',
        parts: [{ text: 'Remember: prefer zsh.' }],
      };
      const history: Content[] = [
        ...compressedPrefix(),
        {
          role: 'user',
          parts: [{ text: 'Remember: keep runtime data isolated.' }],
        },
        { role: 'model', parts: [{ text: 'Noted.' }] },
        ...toolPairs(32),
        middleFact,
        { role: 'model', parts: [{ text: 'Understood.' }] },
        ...toolPairs(13),
        { role: 'user', parts: [{ text: 'Remember: use targeted tests.' }] },
        { role: 'model', parts: [{ text: 'Noted.' }] },
      ];
      expect(history.indexOf(middleFact)).toBeLessThan(80);
      expect(history.length).toBeGreaterThan(80);

      await runAutoMemoryExtract({ ...params(), history });
      await runAutoMemoryExtract({ ...params(), history });

      const windows = vi
        .mocked(runAutoMemoryExtractionByAgent)
        .mock.calls.flatMap((call) => call[2] ?? []);
      expect(windows).toContainEqual(middleFact);
      expect(windows).not.toContainEqual(history[0]);
      expect(windows).not.toContainEqual(history[2]);
    });

    it('detects replaced content even when length and the cursor boundary entry match', async () => {
      const history = longTurn();
      await runAutoMemoryExtract({ ...params(), history });
      await runAutoMemoryExtract({ ...params(), history });
      const changedFact: Content = {
        role: 'user',
        parts: [{ text: 'Correction: prefer npm.' }],
      };
      history[0] = changedFact;
      expect(history).toHaveLength(80);
      await runAutoMemoryExtract({ ...params(), history });
      expect(
        vi.mocked(runAutoMemoryExtractionByAgent).mock.lastCall?.[2],
      ).toContainEqual(changedFact);
    });

    it('does not replay processed facts after a startup reminder refresh', async () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            { text: '<system-reminder>Old environment.</system-reminder>' },
          ],
        },
        ...longTurn(),
      ];
      await runAutoMemoryExtract({ ...params(), history });
      await runAutoMemoryExtract({ ...params(), history });
      history[0] = {
        role: 'user',
        parts: [
          { text: '<system-reminder>New environment.</system-reminder>' },
        ],
      };
      const latest: Content = {
        role: 'user',
        parts: [{ text: 'Remember: prefer focused tests.' }],
      };
      history.push(latest);
      await runAutoMemoryExtract({ ...params(), history });
      expect(runAutoMemoryExtractionByAgent).toHaveBeenLastCalledWith(
        mockConfig,
        projectRoot,
        [latest],
        undefined,
      );
    });

    it('attests the history observed before an asynchronous zero-tool extraction', async () => {
      const history = longTurn();
      await runAutoMemoryExtract({ ...params(), history });
      await runAutoMemoryExtract({ ...params(), history });
      history.push({
        role: 'user',
        parts: [{ text: 'Remember: use isolated runtimes.' }],
      });
      vi.mocked(runAutoMemoryExtractionByAgent).mockClear();
      const completion =
        deferred<Awaited<ReturnType<typeof runAutoMemoryExtractionByAgent>>>();
      vi.mocked(runAutoMemoryExtractionByAgent).mockReturnValueOnce(
        completion.promise,
      );
      const pending = runAutoMemoryExtract({ ...params(), history });
      await waitForMockCall(vi.mocked(runAutoMemoryExtractionByAgent));
      const replacement: Content = {
        role: 'user',
        parts: [{ text: 'Correction: prefer npm.' }],
      };
      history[0] = replacement;
      completion.resolve({
        touchedTopics: [],
        touchedProjectScope: false,
        touchedUserScope: false,
        hasToolActivity: false,
      });
      expect((await pending).cursor.processedOffset).toBe(80);
      await runAutoMemoryExtract({ ...params(), history });
      expect(
        vi.mocked(runAutoMemoryExtractionByAgent).mock.lastCall?.[2],
      ).toContainEqual(replacement);
    });

    it.each([false, true])(
      'preserves a compressed trailing call and response (attachments: %s)',
      async (planModeActive) => {
        const call: Content = {
          role: 'model',
          parts: [{ functionCall: { id: 'pending', name: 'read_file' } }],
        };
        const prefix = await composePostCompactHistory([call], 'Summary.', {
          maxFiles: 0,
          maxImages: 0,
          planModeActive,
        });
        const response: Content = {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'pending',
                name: 'read_file',
                response: { output: 'Read.' },
              },
            },
          ],
        };
        const fact: Content = {
          role: 'user',
          parts: [{ text: 'Remember: use pnpm.' }],
        };
        await runAutoMemoryExtract({
          ...params(),
          history: [...prefix, response, fact],
        });
        const selected = vi.mocked(runAutoMemoryExtractionByAgent).mock
          .lastCall?.[2];
        expect(selected?.[0]?.parts).toContainEqual(call.parts![0]);
        expect(selected).toContainEqual(response);
        expect(selected).toContainEqual(fact);
        expect(selected).not.toContainEqual(prefix[0]);
        if (planModeActive) expect(selected).not.toContainEqual(prefix[2]);
      },
    );
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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

    it('refreshes the live instruction after touched topics are indexed', async () => {
      const projectRebuild = deferred<string>();
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['project'],
        touchedProjectScope: true,
        touchedUserScope: false,
        hasToolActivity: true,
        systemMessage: undefined,
      });
      vi.mocked(rebuildManagedAutoMemoryIndex).mockReturnValueOnce(
        projectRebuild.promise,
      );

      const extractPromise = runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...newHistory],
      });
      await waitForMockCall(vi.mocked(rebuildManagedAutoMemoryIndex));

      expect(refreshMemoryInstruction).not.toHaveBeenCalled();

      projectRebuild.resolve('');
      await extractPromise;

      expect(refreshMemoryInstruction).toHaveBeenCalledWith(mockConfig, {
        logContext: 'managed auto-memory extraction',
      });
    });

    it('refreshes user-scope-only updates after the user index is rebuilt', async () => {
      const userRebuild = deferred<string>();
      vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
        touchedTopics: ['user'],
        touchedProjectScope: false,
        touchedUserScope: true,
        hasToolActivity: true,
        systemMessage: undefined,
      });
      vi.mocked(rebuildUserAutoMemoryIndex).mockReturnValueOnce(
        userRebuild.promise,
      );

      const extractPromise = runAutoMemoryExtract({
        projectRoot,
        sessionId: 'session-1',
        config: mockConfig,
        history: [...newHistory],
      });
      await waitForMockCall(vi.mocked(rebuildUserAutoMemoryIndex));

      expect(rebuildManagedAutoMemoryIndex).not.toHaveBeenCalled();
      expect(refreshMemoryInstruction).not.toHaveBeenCalled();

      userRebuild.resolve('');
      await extractPromise;

      expect(refreshMemoryInstruction).toHaveBeenCalledWith(mockConfig, {
        logContext: 'managed auto-memory extraction',
      });
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
        hasToolActivity: true,
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
    it.each([false, true])(
      'BUG #6311: should NOT advance cursor when agent makes zero tool calls (preserve history: %s)',
      async (preserveUnprocessedHistory) => {
        vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
          touchedTopics: [],
          touchedProjectScope: false,
          touchedUserScope: false,
          hasToolActivity: false,
          systemMessage: undefined,
        });

        const history = [
          {
            role: 'user' as const,
            parts: [{ text: 'Remember that I prefer pnpm over npm.' }],
          },
        ];

        const result = await runAutoMemoryExtract({
          projectRoot,
          sessionId: 'session-1',
          config: mockConfig,
          preserveUnprocessedHistory,
          history: [...history],
        });

        expect(result.cursor.processedOffset).toBe(0);
      },
    );
    it.each([false, true])(
      'should advance cursor on legitimate noop (preserve history: %s)',
      async (preserveUnprocessedHistory) => {
        vi.mocked(runAutoMemoryExtractionByAgent).mockResolvedValue({
          touchedTopics: [],
          touchedProjectScope: false,
          touchedUserScope: false,
          hasToolActivity: true,
          systemMessage: undefined,
        });

        const history = [{ role: 'user' as const, parts: [{ text: 'hello' }] }];

        const result = await runAutoMemoryExtract({
          projectRoot,
          sessionId: 'session-1',
          config: mockConfig,
          preserveUnprocessedHistory,
          history: [...history],
        });

        expect(result.cursor.processedOffset).toBe(1);
        expect(result.extractorRan).toBe(true);
      },
    );
  });
});
