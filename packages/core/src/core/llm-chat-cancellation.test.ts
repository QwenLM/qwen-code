/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmChat } from './llm-chat.js';
import { runAgentLoop } from './agent-loop.js';
import { SendMessageType, type LlmClient } from './client.js';
import { CompressionStatus, LlmEventType, Turn } from './turn.js';
import type { Config } from '../config/config.js';
import { ChatCompressionService } from '../services/chatCompressionService.js';
import { modelChunk } from '../test-utils/model-fixtures.js';

vi.mock('../services/sleepInhibitor.js', () => ({
  acquireSleepInhibitor: () => ({ release: () => {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe.each([
  { loop: 'procedural', useEventBus: false },
  { loop: 'event-bus', useEventBus: true },
])('$loop model cancellation', ({ useEventBus }) => {
  it.each(['establish', 'establish-error', 'read', 'close'] as const)(
    'releases the next prompt during a stalled provider %s and discards late state',
    async (stage) => {
      vi.useFakeTimers();
      const release = held();
      const cancelled = held();
      const parent = new AbortController();
      parent.signal.addEventListener('abort', () => cancelled.resolve(), {
        once: true,
      });
      const establishing = stage.startsWith('establish');
      const providerClosed = vi.fn();
      const generateContentStream = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (establishing) await release.promise;
          if (stage === 'establish-error') {
            throw Object.assign(new Error('late provider unavailable'), {
              status: 503,
            });
          }
          return (async function* () {
            try {
              if (!establishing) {
                yield modelChunk([{ text: 'visible before abort' }]);
                await (stage === 'close' ? cancelled.promise : release.promise);
              }
              yield modelChunk([{ text: 'OLD LATE DATA' }], 'STOP', {
                promptTokenCount: 9999,
                candidatesTokenCount: 999,
                totalTokenCount: 10998,
              });
            } finally {
              if (stage === 'close') await release.promise;
              providerClosed();
            }
          })();
        })
        .mockImplementationOnce(async () =>
          (async function* () {
            yield modelChunk([{ text: 'new response' }], 'STOP', {
              promptTokenCount: 21,
              candidatesTokenCount: 2,
              totalTokenCount: 23,
            });
          })(),
        );
      const generator = { generateContentStream };
      const config = {
        getSessionId: () => 'verification-session',
        getTelemetryLogPromptsEnabled: () => false,
        getUsageStatisticsEnabled: () => false,
        getDebugMode: () => false,
        getContentGeneratorConfig: () => ({
          authType: 'gemini',
          model: 'test-model',
        }),
        getModel: () => 'test-model',
        getModelRouteIdentity: () => 'test-model@test',
        setModel: () => {},
        getProjectRoot: () => '/tmp/verify-pr-17145',
        getTargetDir: () => '/tmp/verify-pr-17145',
        getCliVersion: () => '1.0.0',
        storage: { getProjectTempDir: () => '/tmp/verify-pr-17145' },
        getToolRegistry: () => ({ getTool: () => undefined }),
        getContentGenerator: () => generator,
        getEffectiveInputModalities: () => ({ image: true }),
        getBaseLlmClient: () => undefined,
        getModelFallbacks: () => [],
        getChatCompression: () => undefined,
        getClearContextOnIdle: () => ({
          toolResultsThresholdMinutes: 30,
          toolResultsNumToKeep: 1,
        }),
        getAutoCompactThreshold: () => undefined,
        getHookSystem: () => undefined,
        getDebugLogger: () => ({
          debug: () => {},
          warn: () => {},
          info: () => {},
        }),
        getApprovalMode: () => 'default',
        takePendingManualPlanExitNotice: () => undefined,
        restorePendingManualPlanExitNotice: () => {},
        getFileReadCache: () => ({
          clear: () => {},
          markAllReadsEvictedFromHistory: () => {},
        }),
        getRestoreAskUserQuestion: () => false,
        getChatRecordingService: () => undefined,
      } as unknown as Config;
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          compressionStatus: CompressionStatus.NOOP,
          originalTokenCount: 0,
          newTokenCount: 0,
        },
      });
      const recordAssistantTurn = vi.fn();
      const recorder = {
        recordAssistantTurn,
        recordChatCompression: vi.fn(),
        recordMemoryCatalogSnapshot: vi.fn(),
      } as unknown as ConstructorParameters<typeof LlmChat>[3];
      const chat = new LlmChat(config, {}, [], recorder);
      const client = {
        async *sendMessageStream(
          parts: string,
          signal: AbortSignal,
          promptId: string,
        ) {
          const turn = new Turn(chat, promptId);
          yield* turn.run('test-model', parts, signal);
          return turn;
        },
        getHistoryToolCallFingerprints: () => [],
      } as unknown as LlmClient;
      const heard: string[] = [];
      const run = (signal: AbortSignal, promptId: string) =>
        runAgentLoop({
          client,
          config,
          signal,
          useEventBus,
          first: {
            parts: promptId,
            promptId,
            options: { type: SendMessageType.UserQuery },
          },
          executor: { run: async () => [] },
          host: {
            onModelEvent: (event) => {
              if (event.type === LlmEventType.Content) heard.push(event.value);
            },
          },
        });
      const first = run(parent.signal, 'first prompt');
      await vi.advanceTimersByTimeAsync(0);
      expect(generateContentStream).toHaveBeenCalledTimes(1);
      if (!establishing) expect(heard).toContain('visible before abort');
      parent.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await first).reason).toBe('cancelled');
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      const secondSettled = vi.fn();
      const nextSignal = new AbortController().signal;
      const second = run(nextSignal, 'second prompt').then(secondSettled);
      await vi.advanceTimersByTimeAsync(0);
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(secondSettled).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'completed' }),
      );
      await second;
      expect(getEventListeners(nextSignal, 'abort')).toHaveLength(0);
      const history = structuredClone(chat.getHistory());
      const recorded = structuredClone(recordAssistantTurn.mock.calls);
      const promptTokens = chat.getLastPromptTokenCount();
      expect(heard).toContain('new response');
      expect(heard).not.toContain('OLD LATE DATA');
      expect(JSON.stringify(history)).not.toContain('OLD LATE DATA');
      if (!establishing)
        expect(JSON.stringify(history)).toContain('visible before abort');
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.getHistory()).toEqual(history);
      expect(recordAssistantTurn.mock.calls).toEqual(recorded);
      expect(chat.getLastPromptTokenCount()).toBe(promptTokens);
      expect(generateContentStream).toHaveBeenCalledTimes(2);
      expect(heard).not.toContain('OLD LATE DATA');
      if (!establishing) expect(providerClosed).toHaveBeenCalledOnce();
    },
  );
});
