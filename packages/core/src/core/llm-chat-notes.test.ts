/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { LlmChat, StreamEventType } from './llm-chat.js';
import { CompressionStatus } from './turn.js';
import { ChatCompressionService } from '../services/chatCompressionService.js';
import { SessionNotesService } from '../services/session-notes-service.js';
import type { ChatRecordingService } from '../services/chatRecordingService.js';
import { SESSION_CONTEXT_TOOL_NAMES } from '../services/session-notes-state.js';
import * as sideQuery from '../utils/sideQuery.js';
import { estimateContentTokens } from '../services/tokenEstimation.js';
import {
  wrapUserPromptSubmitContext,
  createUserPromptSubmitContextPart,
} from '../hooks/user-prompt-submit-context.js';
import { getApiHistoryPromptId } from '../services/session-api-history.js';
import { markApiHistoryPrompt } from '../utils/api-history-metadata.js';

vi.mock('../telemetry/loggers.js');

describe('notes compaction commit boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture(strategy: 'notes' | 'summary' = 'notes') {
    const revision = {
      version: 1 as const,
      revision: 'note',
      windowId: 'window',
      sourceLeafUuid: 'source',
      text: '# Goal\nKeep <analysis>literal notes</analysis>. Next: inspect the output.',
    };
    const state = {
      windowId: 'later-window',
      sourceLeafUuid: 'later-source',
      notes: revision,
      latestUser: {
        uuid: 'request',
        text: 'Preserve the exact user constraint.',
      },
    };
    const pre = vi.fn().mockResolvedValue({
      getAdditionalContext: () => 'Preserve the hook context.',
    });
    const post = vi.fn().mockResolvedValue(undefined);
    const hookSystem = {
      firePreCompactEvent: pre,
      firePostCompactEvent: post,
      isManaged: vi.fn().mockReturnValue(false),
    };
    const invalidatePendingExtract = vi.fn();
    const recorder = {
      getSessionId: () => 'session',
      assertNotesWriterReady: vi.fn(),
      getSessionNotesState: () => structuredClone(state),
      refreshSessionNotesState: vi.fn(),
      recordChatCompressionStrict: vi.fn().mockResolvedValue('next-window'),
      recordChatCompression: vi.fn(),
    } as unknown as ChatRecordingService;
    const config = {
      getSessionId: () => 'session',
      getContentGeneratorConfig: () => ({
        model: 'test',
        contextWindowSize: 128000,
      }),
      getModel: () => 'test',
      getChatCompression: () => ({
        strategy,
        maxRecentFilesToRetain: 0,
        maxRecentImagesToRetain: 0,
      }),
      getAutoCompactThreshold: () => undefined,
      getToolRegistry: () => ({
        getTool: vi.fn(),
        getFunctionDeclarations: () =>
          SESSION_CONTEXT_TOOL_NAMES.map((name) => ({ name })),
      }),
      getMemoryManager: () => ({ invalidatePendingExtract }),
      getHookSystem: () => hookSystem,
      getApprovalMode: () => 'default',
      getTargetDir: () => '/tmp/notes-compaction-unit',
      getFileReadCache: () => ({ clear: vi.fn() }),
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;
    const original: Content[] = [
      { role: 'user', parts: [{ text: 'past evidence '.repeat(5000) }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'reset',
              name: 'new_context',
              args: { notes_revision: revision.revision },
            },
          },
        ],
      },
    ];
    const chat = new LlmChat(config, {}, original, recorder);
    chat.setLastPromptTokenCount(22000, false);
    vi.spyOn(
      SessionNotesService.prototype,
      'getNotesForHandoff',
    ).mockResolvedValue({
      notes: revision,
      latestUser: state.latestUser,
    });
    return {
      chat,
      config,
      recorder,
      original,
      pre,
      post,
      revision,
      invalidatePendingExtract,
      hookSystem,
    };
  }

  it('reports distinct automatic and hard headroom from the owning notes window', () => {
    const { chat, config } = fixture();
    config.getAutoCompactThreshold = () => 0.5;
    const result = chat.getContextRemaining();
    expect(result.windowId).toBe('later-window');
    expect(result.estimatedInputTokens).toBeGreaterThanOrEqual(22000);
    expect(result.remainingAutomatic + result.estimatedInputTokens).toBe(64000);
    expect(result.hardLimitHeadroom + result.estimatedInputTokens).toBe(105000);
  });

  it('reports provider-counted context without reserving an unsent tool batch', () => {
    const { chat } = fixture();
    const before = chat.getContextRemaining().estimatedInputTokens;
    chat.addHistory({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            id: 'unsent-result',
            response: { output: 'x'.repeat(40000) },
          },
        },
      ],
    });
    expect(chat.getContextRemaining().estimatedInputTokens).toBe(before);
  });

  it('Nov5 R2-16 counts an inflated notes fallback as a compression failure', async () => {
    const { chat } = fixture();
    chat.setLastPromptTokenCount(115000, false);
    const compression = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        info: {
          originalTokenCount: 115000,
          newTokenCount: 114000,
          compressionStatus: CompressionStatus.COMPRESSED,
          strategy: 'summary',
        },
        newHistory: [
          { role: 'user', parts: [{ text: 'inflated summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
      });
    for (let i = 0; i < 2; i++)
      expect(
        (await chat.tryCompress('nov5-' + i, false)).compressionStatus,
      ).toBe(CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT);
    expect(compression.mock.calls[1][1].consecutiveFailures).toBe(1);
  });

  it('uses literal notes with hooks and paired pending input, with no summarization call', async () => {
    const { chat, recorder, pre, post } = fixture();
    const summary = vi.spyOn(sideQuery, 'runSideQuery');
    const pending: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'reset',
            name: 'new_context',
            response: { status: 'pending' },
          },
        },
      ],
    };
    const included = vi.fn();
    const result = await chat.tryCompress('prompt', true, undefined, {
      notesRevision: 'note',
      pendingUserMessage: pending,
      onPendingMessageIncluded: included,
      trigger: 'auto',
    });
    expect(result).toMatchObject({
      strategy: 'notes',
      compressionStatus: CompressionStatus.COMPRESSED,
    });
    expect(summary).not.toHaveBeenCalled();
    expect(pre).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    const history = JSON.stringify(chat.getHistory());
    expect(history).toContain('<analysis>literal notes</analysis>');
    expect(history).toContain('Preserve the exact user constraint.');
    expect(history).toContain('Preserve the hook context.');
    expect(history).toContain(
      'written in window window, covers through source',
    );
    expect(history).toContain('These notes may predate later work.');
    expect(history).not.toContain('past evidence');
    expect(chat.getHistory().at(-1)).toEqual(pending);
    expect(history.match(/"functionResponse"/gu)).toHaveLength(1);
    expect(included).toHaveBeenCalledOnce();
    expect(
      SessionNotesService.prototype.getNotesForHandoff,
    ).toHaveBeenCalledWith(pending);
    const committed = vi.mocked(recorder.recordChatCompressionStrict).mock
      .calls[0][0];
    expect(committed.compressedHistory).toEqual(chat.getHistory());
    expect(recorder.recordChatCompressionStrict).toHaveBeenCalledWith(
      expect.objectContaining({ compressedHistory: chat.getHistory() }),
      expect.objectContaining({
        revision: 'note',
        windowId: 'window',
        sourceLeafUuid: 'source',
      }),
      undefined,
      expect.objectContaining({
        windowId: 'later-window',
        sourceLeafUuid: 'later-source',
      }),
    );
    expect(recorder.recordChatCompression).not.toHaveBeenCalled();
  });

  function sendingFixture(strategy: 'notes' | 'summary' = 'notes') {
    const result = fixture(strategy);
    const modalities = {
      image: false,
      audio: false,
      video: false,
      pdf: false,
    };
    Object.assign(result.config, {
      getModelRouteIdentity: () => '',
      getEffectiveInputModalities: () => modalities,
      getBaseLlmClient: () => undefined,
      getModelFallbacks: () => [],
      getUsageStatisticsEnabled: () => false,
      getTelemetryLogPromptsEnabled: () => false,
      getDebugMode: () => false,
      getCliVersion: () => 'test',
      getClearContextOnIdle: () => undefined,
      getRestoreAskUserQuestion: () => false,
    });
    Object.assign(result.recorder, {
      observeNotesInput: vi.fn(),
      recordAssistantTurn: vi.fn(),
    });
    return result;
  }

  const hookCount = (
    history: readonly Content[],
    context = 'DURABLE_HOOK_CONTEXT',
  ) =>
    history
      .flatMap((entry) => entry.parts ?? [])
      .filter((part) => part.text === wrapUserPromptSubmitContext(context))
      .length;
  const restoredHookTokens = estimateContentTokens([
    {
      role: 'user',
      parts: [createUserPromptSubmitContextPart('DURABLE_HOOK_CONTEXT')],
    },
  ]);

  it('R11-1 persists the suppressed hook context before the notes send checkpoint freezes', async () => {
    const { chat, recorder } = sendingFixture();
    vi.spyOn(SessionNotesService.prototype, 'peekPendingReset').mockReturnValue(
      'note',
    );
    let durableHistory: Content[] = [];
    let durablePromptId: string | undefined;
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      async ({ compressedHistory }) => {
        durablePromptId = getApiHistoryPromptId(compressedHistory.at(-1)!);
        durableHistory = structuredClone(compressedHistory);
        return 'committed-window';
      },
    );
    const stream = await chat.sendMessageStream(
      'test',
      {
        message: [
          {
            functionResponse: {
              id: 'reset',
              name: 'new_context',
              response: { status: 'pending' },
            },
          },
        ],
      },
      'suppressed-hook-notes',
      undefined,
      {
        suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
        promptId: 'initial-hook-prompt',
      },
    );
    try {
      expect((await stream.next()).value?.type).toBe(
        StreamEventType.COMPRESSED,
      );
      expect(durablePromptId).toBe('initial-hook-prompt');
      expect(hookCount(chat.getHistory())).toBe(1);
      expect(hookCount(durableHistory)).toBe(1);
    } finally {
      await stream.return(undefined);
    }
  });

  it('R11-1 gives a notes-mode summary fallback the same durable hook context', async () => {
    const { chat, recorder } = sendingFixture();
    vi.mocked(
      SessionNotesService.prototype.getNotesForHandoff,
    ).mockResolvedValue(undefined);
    vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
      newHistory: [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ],
      info: {
        strategy: 'summary',
        compressionStatus: CompressionStatus.COMPRESSED,
        originalTokenCount: 22000,
        newTokenCount: 100,
      },
    });
    let durableHistory: Content[] = [];
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      async ({ compressedHistory }) => {
        durableHistory = structuredClone(compressedHistory);
        return 'summary-window';
      },
    );
    const stream = await chat.sendMessageStream(
      'test',
      { message: 'continue' },
      'summary-hook',
      undefined,
      {
        suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
      },
    );
    try {
      expect((await stream.next()).value).toMatchObject({
        type: StreamEventType.COMPRESSED,
        info: { newTokenCount: 100 + restoredHookTokens },
      });
      expect(hookCount(chat.getHistory())).toBe(1);
      expect(hookCount(durableHistory)).toBe(1);
    } finally {
      await stream.return(undefined);
    }
  });

  it.each(['context', 'payload'] as const)(
    'R11-1 freezes hook context before a reactive %s checkpoint',
    async (kind) => {
      const { chat, config, recorder } = sendingFixture();
      const error =
        kind === 'context'
          ? new Error('prompt is too long: 135000 tokens > 128000 maximum')
          : Object.assign(new Error('Request Entity Too Large'), {
              status: 413,
            });
      const generateContentStream = vi.fn().mockRejectedValue(error);
      Object.assign(config, {
        getContentGenerator: () => ({ generateContentStream }),
      });
      vi.spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            compressionStatus: CompressionStatus.NOOP,
            originalTokenCount: 22000,
            newTokenCount: 22000,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'notes handoff' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ],
          info: {
            strategy: 'notes',
            compressionStatus: CompressionStatus.COMPRESSED,
            originalTokenCount: 22000,
            newTokenCount: 100,
          },
        });
      let durableHistory: Content[] = [];
      let durableSummaryPrefix: number | undefined;
      vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
        async ({ compressedHistory, summaryPrefixLength }) => {
          durableSummaryPrefix = summaryPrefixLength;
          durableHistory = structuredClone(compressedHistory);
          return 'reactive-window';
        },
      );
      const stream = await chat.sendMessageStream(
        'test',
        { message: 'continue' },
        'reactive-hook-' + kind,
        undefined,
        {
          suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
        },
      );
      try {
        expect((await stream.next()).value).toMatchObject({
          type: StreamEventType.COMPRESSED,
          info: { newTokenCount: 100 + restoredHookTokens },
        });
        expect(generateContentStream).toHaveBeenCalledOnce();
        expect(durableSummaryPrefix).toBe(2);
        expect(hookCount(chat.getHistory())).toBe(1);
        expect(hookCount(durableHistory)).toBe(1);
      } finally {
        await stream.return(undefined);
      }
    },
  );

  it('R11-1 preserves a pre-existing hook and API prompt metadata in the pending checkpoint', async () => {
    const { chat, recorder } = fixture();
    const pending: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'reset',
            name: 'new_context',
            response: { status: 'pending' },
          },
        },
        createUserPromptSubmitContextPart('DURABLE_HOOK_CONTEXT'),
      ],
    };
    markApiHistoryPrompt(pending, 'preserved-prompt');
    let durableHistory: Content[] = [];
    let durablePromptId: string | undefined;
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      async ({ compressedHistory }) => {
        durablePromptId = getApiHistoryPromptId(compressedHistory.at(-1)!);
        durableHistory = structuredClone(compressedHistory);
        return 'single-hook-window';
      },
    );
    const options = {
      notesRevision: 'note',
      pendingUserMessage: pending,
      suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
    };
    await chat.tryCompress('single-hook', true, undefined, options);
    expect(hookCount(durableHistory)).toBe(1);
    expect(hookCount(chat.getHistory())).toBe(1);
    expect(durablePromptId).toBe('preserved-prompt');
  });

  it.each(['rejected', 'inflated'] as const)(
    'R11-1 leaves input and history untouched when its candidate is %s',
    async (kind) => {
      const { chat, recorder, original, post } = fixture();
      const pending: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'reset',
              name: 'new_context',
              response: { status: 'pending' },
            },
          },
        ],
      };
      const before = structuredClone(pending);
      const included = vi.fn();
      if (kind === 'rejected')
        vi.mocked(recorder.recordChatCompressionStrict).mockRejectedValue(
          new Error('strict writer failed'),
        );
      else
        vi.spyOn(
          ChatCompressionService.prototype,
          'compress',
        ).mockResolvedValue({
          newHistory: [{ role: 'user', parts: [{ text: 'inflated' }] }],
          info: {
            strategy: 'notes',
            compressionStatus: CompressionStatus.COMPRESSED,
            originalTokenCount: 22000,
            newTokenCount: 100000,
          },
        });
      const options = {
        notesRevision: 'note',
        pendingUserMessage: pending,
        onPendingMessageIncluded: included,
        suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
      };
      const compress = chat.tryCompress(
        'unchanged-candidate',
        true,
        undefined,
        options,
      );
      if (kind === 'rejected')
        await expect(compress).rejects.toThrow('strict writer failed');
      else
        expect((await compress).compressionStatus).toBe(
          CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        );
      expect(pending).toEqual(before);
      expect(chat.getHistory()).toEqual(original);
      expect(included).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(['rejected', 'inflated'] as const)(
    'R11-1 leaves retained source content untouched when its candidate is %s',
    async (kind) => {
      const { chat, recorder, original } = fixture();
      const before = structuredClone(original);
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: [original[0]],
        info: {
          strategy: 'notes',
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 22000,
          newTokenCount: kind === 'inflated' ? 100000 : 100,
        },
      });
      if (kind === 'rejected')
        vi.mocked(recorder.recordChatCompressionStrict).mockRejectedValue(
          new Error('strict writer failed'),
        );
      const options = {
        trigger: 'auto' as const,
        suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
      };
      const compress = chat.tryCompress(
        'retained-candidate',
        true,
        undefined,
        options,
      );
      if (kind === 'rejected')
        await expect(compress).rejects.toThrow('strict writer failed');
      else
        expect((await compress).compressionStatus).toBe(
          CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        );
      expect(original).toEqual(before);
      expect(chat.getHistory()).toEqual(before);
    },
  );

  it.each(['auto', 'hard', 'context', 'payload'] as const)(
    'R11-1 keeps the final legacy %s checkpoint aligned without counting pending input twice',
    async (kind) => {
      const { chat, config, recorder } = sendingFixture('summary');
      const compressed = {
        newHistory: [
          { role: 'user' as const, parts: [{ text: 'legacy summary' }] },
          { role: 'model' as const, parts: [{ text: 'ack' }] },
        ],
        info: {
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 22000,
          newTokenCount: 100,
        },
      };
      const compression = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      if (kind === 'context' || kind === 'payload') {
        compression.mockResolvedValueOnce({
          newHistory: null,
          info: {
            compressionStatus: CompressionStatus.NOOP,
            originalTokenCount: 22000,
            newTokenCount: 22000,
          },
        });
        const error =
          kind === 'context'
            ? new Error('prompt is too long: 135000 tokens > 128000 maximum')
            : Object.assign(new Error('Request Entity Too Large'), {
                status: 413,
              });
        Object.assign(config, {
          getContentGenerator: () => ({
            generateContentStream: vi.fn().mockRejectedValue(error),
          }),
        });
      } else if (kind === 'hard') chat.setLastPromptTokenCount(115000, false);
      compression.mockResolvedValueOnce(compressed);
      const checkpoints: Content[][] = [];
      vi.mocked(recorder.recordChatCompression).mockImplementation(
        ({ compressedHistory }) => {
          checkpoints.push(structuredClone(compressedHistory));
        },
      );
      const stream = await chat.sendMessageStream(
        'test',
        { message: 'continue' },
        'legacy-hook-' + kind,
        undefined,
        {
          suppressedHookContext: 'DURABLE_HOOK_CONTEXT',
        },
      );
      try {
        expect((await stream.next()).value?.type).toBe(
          StreamEventType.COMPRESSED,
        );
        expect(checkpoints.length).toBeGreaterThan(0);
        expect(recorder.recordChatCompressionStrict).not.toHaveBeenCalled();
        if (kind === 'auto' || kind === 'hard')
          expect(chat.getLastPromptTokenCount()).toBe(100);
        expect(hookCount(chat.getHistory())).toBe(1);
        expect(hookCount(checkpoints.at(-1)!)).toBe(1);
      } finally {
        await stream.return(undefined);
      }
    },
  );

  it('does not install history or fire PostCompact until its exact checkpoint is durable', async () => {
    const { chat, recorder, original, post, invalidatePendingExtract } =
      fixture();
    let accept!: (id: string) => void;
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const completeReset = vi.spyOn(
      SessionNotesService.prototype,
      'completePendingReset',
    );
    const transition = chat.tryCompress('prompt', true, undefined, {
      notesRevision: 'note',
    });
    await vi.waitFor(() =>
      expect(recorder.recordChatCompressionStrict).toHaveBeenCalledOnce(),
    );
    expect(chat.getHistory()).toEqual(original);
    expect(post).not.toHaveBeenCalled();
    expect(invalidatePendingExtract).not.toHaveBeenCalled();
    expect(completeReset).not.toHaveBeenCalled();
    accept('committed-window');
    expect((await transition).strategy).toBe('notes');
    expect(completeReset).toHaveBeenCalledExactlyOnceWith('note');
    expect(chat.getHistory()).not.toEqual(original);
    expect(invalidatePendingExtract).toHaveBeenCalledExactlyOnceWith(
      'session',
      expect.anything(),
    );
    expect(post).toHaveBeenCalledOnce();
  });

  it('retains live input and the pending reset when the captured notes snapshot loses the CAS race', async () => {
    const { chat, recorder, post } = fixture();
    const completeReset = vi.spyOn(
      SessionNotesService.prototype,
      'completePendingReset',
    );
    let reject!: (error: Error) => void;
    vi.mocked(recorder.recordChatCompressionStrict).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const transition = chat.tryCompress('prompt', true, undefined, {
      notesRevision: 'note',
    });
    const failure = transition.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(recorder.recordChatCompressionStrict).toHaveBeenCalledOnce(),
    );
    chat.addHistory({
      role: 'user',
      parts: [{ text: 'arrived during compression' }],
    });
    const live = chat.getHistory();
    reject(new Error('Session notes state changed'));
    expect(await failure).toMatchObject({
      message: 'Session notes state changed',
    });
    expect(chat.getHistory()).toEqual(live);
    expect(completeReset).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves history on write failure and on a stale explicit revision', async () => {
    const { chat, recorder, original, post } = fixture();
    vi.mocked(recorder.recordChatCompressionStrict).mockRejectedValueOnce(
      new Error('writer lost'),
    );
    const completeReset = vi.spyOn(
      SessionNotesService.prototype,
      'completePendingReset',
    );
    await expect(
      chat.tryCompress('prompt', true, undefined, { notesRevision: 'note' }),
    ).rejects.toThrow('writer lost');
    expect(completeReset).not.toHaveBeenCalled();
    expect(chat.getHistory()).toEqual(original);
    expect(post).not.toHaveBeenCalled();
    await expect(
      chat.tryCompress('prompt', true, undefined, { notesRevision: 'old' }),
    ).rejects.toThrow('unavailable');
    expect(chat.getHistory()).toEqual(original);
  });

  it('uses the same durable boundary when missing notes or custom instructions select summary', async () => {
    const { chat, recorder } = fixture();
    const compression = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
        postCompactSummary: 'summary',
        info: {
          originalTokenCount: 22000,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
    const result = await chat.tryCompress('prompt', true, undefined, {
      customInstructions: 'Keep the error details.',
    });
    expect(compression.mock.calls[0][1]).toMatchObject({
      customInstructions: 'Keep the error details.',
      notesHandoff: undefined,
      deferPostCompactEvent: true,
    });
    expect(result.strategy).toBe('summary');
    expect(recorder.recordChatCompressionStrict).toHaveBeenCalledOnce();
  });

  it('preserves the retained-operation boundary in a notes recorder summary checkpoint', async () => {
    const { chat, recorder } = fixture();
    const retained: Content = {
      role: 'model',
      parts: [{ text: 'latest original response' }],
    };
    const compressedHistory: Content[] = [
      { role: 'user', parts: [{ text: 'summary' }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
      { role: 'user', parts: [{ text: 'Recent operation follows.' }] },
      retained,
    ];
    vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
      newHistory: compressedHistory,
      postCompactSummary: 'summary',
      info: {
        strategy: 'summary',
        summaryPrefixLength: 3,
        originalTokenCount: 22000,
        newTokenCount: 100,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
    });
    const pending: Content = {
      role: 'user',
      parts: [{ text: 'continue with the next change' }],
    };

    await chat.tryCompress('retained-summary', true, undefined, {
      customInstructions: 'Preserve recent operations.',
      pendingUserMessage: pending,
    });

    expect(recorder.recordChatCompressionStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryPrefixLength: 3,
        compressedHistory: [...compressedHistory, pending],
      }),
      undefined,
      undefined,
      expect.anything(),
    );
    expect(chat.getHistory()).toEqual([...compressedHistory, pending]);
  });

  it('propagates a managed PostCompact hook failure', async () => {
    const { chat, hookSystem, post } = fixture();
    hookSystem.isManaged.mockReturnValue(true);
    post.mockRejectedValueOnce(new Error('managed runtime worker unavailable'));
    await expect(chat.tryCompress('prompt', true)).rejects.toThrow(
      'managed runtime worker unavailable',
    );
  });

  it('keeps a local PostCompact hook failure nonfatal', async () => {
    const { chat, post } = fixture();
    post.mockRejectedValueOnce(new Error('local hook script failed'));
    await expect(chat.tryCompress('prompt', true)).resolves.toMatchObject({
      compressionStatus: CompressionStatus.COMPRESSED,
    });
  });

  it.each(['effective', 'provider override', 'estimated', 'previous API'])(
    'counts pending input once in summary fallback with %s tokens',
    async (source) => {
      const { chat, config } = fixture();
      Object.assign(config, { getAllConfiguredModels: () => [] });
      const pending: Content = {
        role: 'user',
        parts: [{ text: 'next request '.repeat(100) }],
      };
      const compression = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
        text: '<state_snapshot>summary</state_snapshot>',
        usage: {
          promptTokenCount: 10000,
          candidatesTokenCount: 500,
          totalTokenCount: 10500,
        },
      });
      if (source === 'estimated') chat.setLastPromptTokenCount(22000, true);
      const options =
        source === 'effective'
          ? { precomputedEffectiveTokens: 22300 }
          : source === 'provider override'
            ? {
                originalTokenCountOverride: {
                  count: 22300,
                  isEstimated: false,
                },
              }
            : {};
      const result = await chat.tryCompress('prompt', true, undefined, {
        customInstructions: 'Use summary fallback.',
        pendingUserMessage: pending,
        ...options,
      });
      const originalCount = compression.mock.calls[0][1].originalTokenCount;
      expect(sideQuery.runSideQuery).toHaveBeenCalledOnce();
      expect(result.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      // The previous API baseline is the only source that excludes pending
      // input. Summary usage removes old visible history plus its overhead.
      const pendingAdjustment =
        source === 'previous API' ? estimateContentTokens([pending]) : 0;
      expect(result.newTokenCount).toBe(
        originalCount - (10000 - 1000) + 500 + pendingAdjustment,
      );
      expect(chat.getHistory().at(-1)).toEqual(pending);
    },
  );
});
