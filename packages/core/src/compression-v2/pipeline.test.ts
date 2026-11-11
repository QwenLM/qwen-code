/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AUTOCOMPACT_WINDOW } from "../config/brand.js";

import {
  testProviderModelResolution,
  testCompressionConfig,
  testModelProviderManager,
} from './provider-test-helpers.js';

import { createRequestTokenAnchor } from '../utils/request-token-count.js';

import {
  testRequestConfig,
  testModelResolution,
} from '../test-utils/model-resolution.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';

import { systemPromptFromText } from '../prompts/system-prompt.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Message } from './message-types.js';
import { getContentBlocks } from './message-types.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import { CompressionStatus } from '../core/turn-events.js';
import { DEFAULT_COMPRESSION_CONFIG } from './config.js';
import { CompressionPipeline } from './pipeline.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import { READ_FILE_TOOL_NAME, SHELL_TOOL_NAME } from '../tools/tool-names.js';
import type { CompressOptions } from './pipeline.js';
import type { CompressionStateStore } from './state-store.js';
import type {
  AttachmentMessage,
  TextBlock,
} from '../protocol/transcript/message.js';
import { getConfigValue } from '../config-service/index.js';

import { runForkedAgent } from '../core/forkedAgent.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import { customProviderModelKey } from '../provider/custom/types.js';
import { CoreEvent, coreEvents } from '../utils/events.js';
import * as prompts from '../core/prompts.js';
import { createCompactBoundaryMessage } from './boundary.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { HookOutputAttachment } from '../attachments/models/hook-attachments.js';
import { HookEventName } from '../hooks/types.js';

const requestModelManager = {
  getModel: async (key: string) => testModelResolution(key).model,
  getModelConfig: () => undefined,
  select: async (input: ModelSelectContext) => {
    const selection = input.overrideSelection ?? input.parentSelection;
    if (!selection)
      throw new Error('Compression test requires a model selection');
    return selection;
  },
};
const requestModelSource = {
  getModelProviderManager: () => requestModelManager,
};

/**
 * Some tests in this file expect compression to fire on tiny histories,
 * which the model-derived auto-compact threshold would otherwise prevent.
 * They opt in by calling forceLowAutoCompactThreshold() at the top of the
 * test; the global test-setup afterEach unstubs envs between tests.
 */
function forceLowAutoCompactThreshold(): void {
  vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100');
}

vi.mock('../core/prompts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/prompts.js')>()),
  getCompressionPrompt: () => 'compression prompt',
  getCompactSummaryUserMessage: (summary: string) => summary,
}));

vi.mock('../utils/environmentContext.js', () => ({
  getInitialChatHistory: async (_config: unknown, extraHistory?: Message[]) =>
    extraHistory ?? [],
}));

vi.mock('../utils/tokenCalculation.js', async () => {
  const actual = await vi.importActual('../utils/tokenCalculation.js');
  return { ...actual };
});

vi.mock('../core/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(async () => ({
    messages: [],
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    textContent:
      '<analysis>internal reasoning</analysis>\n<summary>compact snapshot</summary>',
  })),
}));

vi.mock('../config-service/index.js', () => ({
  getConfigValue: vi.fn(),
}));

describe('CompressionPipeline', () => {
  // Belt-and-suspenders: the global test-setup afterEach already calls
  // vi.unstubAllEnvs(), but when multiple setupFiles or re-entrant hooks
  // are in play the ordering isn't always honored, and a leaked
  // `ENV_AUTOCOMPACT_WINDOW=100` from forceLowAutoCompactThreshold()
  // drops the auto-compact threshold into negative territory and makes
  // every subsequent test's tiny history tip into runForkCompact.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['main', 'subagent'] as const)(
    'points compacted %s history to the retained legacy bucket',
    async (target) => {
      forceLowAutoCompactThreshold();
      const actualPrompts =
        await vi.importActual<typeof prompts>('../core/prompts.js');
      const summarySpy = vi
        .spyOn(prompts, 'getCompactSummaryUserMessage')
        .mockImplementation(actualPrompts.getCompactSummaryUserMessage);
      onTestFinished(() => summarySpy.mockRestore());
      const transcriptPath = path.join('/legacy-bucket', 'session-main.jsonl');
      const config = {
        ...testRequestConfig(),
        ...testCompressionConfig(),
        getModelProviderManager: requestModelSource.getModelProviderManager,
        getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
        getSessionId: () => 'session-main',
        getActiveSessionTranscriptPath: () => transcriptPath,
        storage: { getProjectRoot: () => '/original-project' },
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
      } as unknown as CompressOptions['config'];
      const state = createEmptyCompressionPipelineState();
      vi.mocked(runForkedAgent)
        .mockImplementationOnce(async (params) => {
          params.onCompleted?.({
            model: params.model ?? params.config.getModel(),
            modelRequestIds: ['failed-attempt'],
            modelRequests: [], modelRequestResults: [],
            totalUsage: { ...cloneUsage(), input_tokens: 20, credits: 0.25 },
            durationMs: 10, success: false,
          });
          throw new Error('Prompt is too long: 120000 tokens exceeds the limit 100000');
        })
        .mockImplementationOnce(async (params) => {
          const usage = { ...cloneUsage(), input_tokens: 30, credits: 1.5 };
          params.onCompleted?.({
            model: params.model ?? params.config.getModel(),
            modelRequestIds: ['successful-attempt'],
            modelRequests: [], modelRequestResults: [],
            totalUsage: usage, durationMs: 10, success: true,
          });
          return { messages: [], totalUsage: usage, textContent: '<summary>compact snapshot</summary>' };
        });
      const usageSpy = vi.spyOn(coreEvents, 'emit');
      onTestFinished(() => usageSpy.mockRestore());
      const pipeline = new CompressionPipeline(
        target === 'main'
          ? { target, modelProviderManager: testModelProviderManager() }
          : {
              target,
              modelProviderManager: testModelProviderManager(),
              sessionScopeId: 'prompt-scope',
              agentId: 'reviewer',
            },
        {
          getState: () => state,
          saveState: vi.fn(),
        } as unknown as CompressionStateStore,
      );

      const result = await pipeline.compress(
        [
          makeUser('old question '.repeat(300)),
          makeAssistant([{ type: 'text', text: 'old answer '.repeat(300) }]),
        ],
        {
          modelResolution: testProviderModelResolution('test-model', {}),
          promptId: 'compact-prompt',
          force: true,
          config,
        },
      );

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory?.[0]).toMatchObject({
        compactUsage: { input_tokens: 50, credits: 1.75 },
        modelRequestIds: ['failed-attempt', 'successful-attempt'],
        agentId: target === 'subagent' ? 'reviewer' : undefined,
      });
      expect(usageSpy).not.toHaveBeenCalledWith(CoreEvent.CompressionUsage, expect.anything());
      const summary = getContentBlocks(result.newHistory![1])[0] as TextBlock;
      const expectedPath =
        target === 'main'
          ? transcriptPath
          : path.join(
              '/legacy-bucket',
              'session-main',
              'subagents',
              'agent-reviewer.jsonl',
            );
      expect(summary.text).toContain(expectedPath);
      if (target === 'subagent') {
        expect(summary.text).not.toContain(transcriptPath);
      }
    },
  );

  it('short-circuits manual /compress on a fresh session (env_context-only history)', async () => {
    // Regression: a fresh chat's history is NOT empty — startChat prepends
    // a single env_context user message via getInitialChatHistory. A
    // length-based guard (`boundary.contents.length === 0`) therefore
    // never fires in production, and `/compress` on a truly fresh session
    // would spin up a fork subagent to summarize the env context alone.
    // The fix is to require at least one model turn past the boundary.
    forceLowAutoCompactThreshold();
    const envContextHistory: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: '<session_context>\n  cwd: /tmp/project\n</session_context>',
        },
      ]),
    ];

    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    vi.mocked(runForkedAgent).mockClear();
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    // force=true simulates the manual /compress command path.
    const result = await pipeline.compress([...envContextHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-fresh-compress',
      force: true,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
    // Most important: the fork subagent must not have been spun up.
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it('reports stage inputs and model observations without rereading config', async () => {
    forceLowAutoCompactThreshold();
    const getModelConfig = vi.fn(() => ({
      context: { contextWindow: 999_999 },
    }));
    const getEffectiveContextWindow = vi.fn(() => 888_888);
    const stateStore = {
      getState: vi.fn(() => createEmptyCompressionPipelineState()),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-trigger-snapshot',
      getActiveSessionTranscriptPath: () =>
        '/tmp/session-trigger-snapshot.jsonl',
      getModelProviderManager: () => manager,
      getEffectiveContextWindow,
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    const manager = testModelProviderManager();
    vi.mocked(manager.select).mockResolvedValue(
      testProviderModelResolution('compact-model-at-trigger', {
        context: { contextWindow: 220_000 },
      }),
    );
    const options: CompressOptions = {
      modelResolution: testProviderModelResolution('session-model-at-trigger', {
        context: { contextWindow: 240_000 },
      }),
      promptId: 'prompt-trigger-snapshot',
      force: true,
      config,
      parentRequestSetId: 'request-set-at-trigger',
    };
    const totalUsage = {
      ...cloneUsage(),
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      credits: 1.5,
      billable: true,
    };

    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      options.modelResolution = testProviderModelResolution(
        'session-model-after-trigger',
        { context: { contextWindow: 120_000 } },
      );
      options.parentRequestSetId = 'request-set-after-trigger';
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        requestId: 'compact-request-1',
        modelRequestIds: ['compact-request-1'],
        modelRequests: [
          {
            requestId: 'compact-request-1',
            model: params.model ?? params.config.getModel(),
            ttftMs: 200,
            durationMs: 500,
            usage: totalUsage,
            thinkingTokens: 12,
            finishReason: 'end_turn',
          },
        ],
        modelRequestResults: [],
        totalUsage,
        durationMs: 500,
        success: true,
      });
      return {
        messages: [],
        totalUsage,
        textContent: '<summary>compact snapshot</summary>',
      };
    });

    const pipeline = new CompressionPipeline(
      { modelProviderManager: manager, target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );
    const result = await pipeline.compress(
      [
        makeUser('trigger snapshot test'),
        makeAssistant([{ type: 'text', text: 'model response' }]),
      ],
      options,
    );

    expect(result.newHistory?.[0]).toMatchObject({
      subtype: 'compact_boundary',
      compactUsage: { credits: 1.5, input_tokens: 120, output_tokens: 30 },
      modelRequestIds: ['compact-request-1'],
    });
    expect(getModelConfig).not.toHaveBeenCalled();
    expect(getEffectiveContextWindow).not.toHaveBeenCalled();
  });

  it('reports the existing compression failure without mutating it', async () => {
    forceLowAutoCompactThreshold();
    const stateStore = {
      getState: vi.fn(() => createEmptyCompressionPipelineState()),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-empty-summary',
      getActiveSessionTranscriptPath: () => '/tmp/session-empty-summary.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        modelRequestIds: ['empty-summary-request'],
        modelRequests: [],
        modelRequestResults: [],
        totalUsage: { ...cloneUsage(), credits: 0.5 },
        durationMs: 10,
        success: true,
      });
      return { messages: [], totalUsage: cloneUsage(), textContent: '' };
    });
    const usageSpy = vi.spyOn(coreEvents, 'emit');

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );
    const result = await pipeline.compress(
      [
        makeUser('compact this history'),
        makeAssistant([{ type: 'text', text: 'working on it' }]),
      ],
      {
        modelResolution: testProviderModelResolution('test-model', {}),
        promptId: 'prompt-empty-summary',
        force: true,
        config,
      },
    );

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.info.failureReason).toBe('empty_summary');
    expect(usageSpy).toHaveBeenCalledWith(CoreEvent.CompressionUsage,
      expect.objectContaining({
        modelRequestIds: ['empty-summary-request'], usage: expect.objectContaining({ credits: 0.5 }),
      }));
    usageSpy.mockRestore();
  });

  it('reports provider error and status codes on compaction failure', async () => {
    forceLowAutoCompactThreshold();
    const stateStore = {
      getState: vi.fn(() => createEmptyCompressionPipelineState()),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-provider-error',
      getActiveSessionTranscriptPath: () => '/tmp/session-provider-error.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    vi.mocked(runForkedAgent).mockRejectedValueOnce(
      Object.assign(new Error('Content filtered'), {
        code: 'MODEL_REFUSAL',
        httpStatus: 416,
        providerCode: '406',
      }),
    );

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );
    const result = await pipeline.compress(
      [
        makeUser('compact this history'),
        makeAssistant([{ type: 'text', text: 'working on it' }]),
      ],
      {
        modelResolution: testProviderModelResolution('test-model', {}),
        promptId: 'prompt-provider-error',
        force: true,
        config,
      },
    );

    expect(result.info.failureReason).toBe('provider_error');
    expect(result.info.errorCode).toBe('406');
    expect(result.info.providerStatus).toBe(416);
  });

  it('emits a terminal progress event and preserves user cancellation', async () => {
    forceLowAutoCompactThreshold();
    const stateStore = {
      getState: vi.fn(() => createEmptyCompressionPipelineState()),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-cancelled-compact',
      getActiveSessionTranscriptPath: () =>
        '/tmp/session-cancelled-compact.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    const abortError = Object.assign(new Error('Operation cancelled by user'), {
      name: 'AbortError',
    });
    vi.mocked(runForkedAgent).mockImplementationOnce(async (params) => {
      params.onCompleted?.({
        model: params.model ?? params.config.getModel(),
        modelRequestIds: ['cancelled-request'],
        modelRequests: [], modelRequestResults: [],
        totalUsage: { ...cloneUsage(), credits: 0.25 },
        durationMs: 10, success: false,
      });
      throw abortError;
    });
    const usageSpy = vi.spyOn(coreEvents, 'emit');
    onTestFinished(() => usageSpy.mockRestore());
    const progressSpy = vi.spyOn(coreEvents, 'emitCompressionProgress');
    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    try {
      await expect(
        pipeline.compress(
          [
            makeUser('compact this history'),
            makeAssistant([{ type: 'text', text: 'working on it' }]),
          ],
          {
            modelResolution: testProviderModelResolution('test-model', {}),
            promptId: 'prompt-cancelled-compact',
            force: false,
            config,
          },
        ),
      ).rejects.toBe(abortError);
      expect(usageSpy).toHaveBeenCalledWith(CoreEvent.CompressionUsage,
        expect.objectContaining({
          modelRequestIds: ['cancelled-request'],
          usage: expect.objectContaining({ credits: 0.25 }),
        }));

      expect(progressSpy).toHaveBeenLastCalledWith({
        stage: 'failed',
        trigger: 'auto',
        sessionId: 'session-cancelled-compact',
        sessionScopeId: 'session-cancelled-compact',
        target: 'main',
        agentId: undefined,
        failureReason: 'cancelled',
      });
    } finally {
      progressSpy.mockRestore();
    }
  });

  it('does not resolve the compact model below the auto-compact threshold', async () => {
    const history: Message[] = [
      makeUser([{ type: 'text', text: 'hello' }]),
      makeAssistant([{ type: 'text', text: 'hi' }]),
    ];
    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
    } as unknown as CompressOptions['config'];
    const manager = testModelProviderManager();
    const selectCompactModel = vi.mocked(manager.select);
    const pipeline = new CompressionPipeline(
      { modelProviderManager: manager, target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress(history, {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-below-threshold',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(selectCompactModel).not.toHaveBeenCalled();
  });

  it('does not reuse older usage when the latest request has no usage', async () => {
    const previous = makeAssistant([{ type: 'text', text: 'older response' }]);
    previous.message = { ...previous.message, model: 'current-model' };
    previous.message.usage = {
      ...cloneUsage(),
      input_tokens: 100_000,
      output_tokens: 10,
    };
    const latest = makeAssistant([{ type: 'text', text: 'latest response' }]);
    latest.message = { ...latest.message, model: 'current-model' };
    delete latest.message.usage;
    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      {
        getState: vi.fn(() => createEmptyCompressionPipelineState()),
        saveState: vi.fn(),
      } as unknown as CompressionStateStore,
    );
    const result = await pipeline.compress(
      [makeUser('hello'), previous, makeUser('next'), latest],
      {
        modelResolution: testProviderModelResolution('current-model', {
          context: { contextWindow: 50_000 },
        }),
        promptId: 'missing-latest-usage',
        force: false,
        config: {
          ...testRequestConfig(),
          ...testCompressionConfig(),
          getSessionId: () => 'missing-usage',
          getActiveSessionTranscriptPath: () => '/tmp/missing-usage.jsonl',
          getModelProviderManager: requestModelSource.getModelProviderManager,
          getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
        } as unknown as CompressOptions['config'],
      },
    );
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.info.originalTokenCount).toBeLessThan(1000);
  });

  it.each([
    [
      'embedded usage after a main-session model switch',
      'message',
      'old-session-model',
      'new-session-model',
      CompressionStatus.NOOP,
    ],
    [
      'redacted usage after a main-session model switch',
      'persisted',
      'old-session-model',
      'new-session-model',
      CompressionStatus.NOOP,
    ],
    [
      'usage from the current session model when the compact model differs',
      'message',
      'current-session-model',
      'current-session-model',
      CompressionStatus.COMPRESSED,
    ],
  ] as const)(
    'handles %s',
    async (
      _case,
      usageSource,
      previousResponseModel,
      sessionModel,
      expectedStatus,
    ) => {
      vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');
      vi.mocked(runForkedAgent).mockClear();
      const previousResponse = makeAssistant([
        { type: 'text', text: 'response from the old model' },
      ]);
      previousResponse.message = {
        ...previousResponse.message,
        model: previousResponseModel,
      };
      const previousUsage = {
        ...cloneUsage(),
        input_tokens: 100_000,
        output_tokens: 10,
      };
      if (usageSource === 'message') {
        previousResponse.message.usage = previousUsage;
      } else {
        delete previousResponse.message.usage;
      }

      const priorInput = makeUser('small prompt');
      previousResponse.requestTokenAnchor = createRequestTokenAnchor({
        model: previousResponseModel,
        messages: [priorInput],
      })(previousResponse.message.content);
      const stateStore = {
        getState: vi.fn(() => createEmptyCompressionPipelineState()),
        saveState: vi.fn(),
      } as unknown as CompressionStateStore;
      const pipeline = new CompressionPipeline(
        { modelProviderManager: testModelProviderManager(), target: 'main' },
        stateStore,
      );
      const config = {
        ...testRequestConfig(),
        ...testCompressionConfig(),
        getModelProviderManager: requestModelSource.getModelProviderManager,
        getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
        getSessionId: () => 'model-switch-session',
        getActiveSessionTranscriptPath: () => '/tmp/model-switch-session.jsonl',
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
      } as unknown as CompressOptions['config'];

      const result = await pipeline.compress([priorInput, previousResponse], {
        modelResolution: testProviderModelResolution(sessionModel, {
          context: { contextWindow: 50_000 },
        }),
        promptId: 'model-switch-token-count',
        force: false,
        config,
      });

      expect(result.info.compressionStatus).toBe(expectedStatus);
      if (expectedStatus === CompressionStatus.NOOP) {
        expect(result.info.originalTokenCount).toBeLessThan(1_000);
        expect(runForkedAgent).not.toHaveBeenCalled();
      } else {
        expect(result.info.originalTokenCount).toBe(100_010);
        expect(runForkedAgent).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    [
      'route model with embedded usage',
      'eval-model',
      'provider',
      'provider/eval-model',
      false,
      true,
    ],
    [
      'route model with redacted usage',
      'eval-model',
      'provider',
      'provider/eval-model',
      true,
      true,
    ],
    [
      'model ID containing a slash',
      'vendor/eval-model',
      'provider',
      'provider/vendor/eval-model',
      false,
      true,
    ],
    [
      'model switch within a provider',
      'old-model',
      'provider',
      'provider/new-model',
      false,
      false,
    ],
    [
      'provider switch with the same model ID',
      'eval-model',
      'old-provider',
      'provider/eval-model',
      false,
      false,
    ],
  ] as const)(
    'checks Custom Provider usage for %s',
    async (
      _case,
      responseModelId,
      providerId,
      sessionModel,
      persisted,
      reusable,
    ) => {
      vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');
      vi.mocked(runForkedAgent).mockClear();
      // The assembled response stores the caller's route model, even when
      // the wire response reports a bare model ID.
      const responseModel = customProviderModelKey(providerId, responseModelId);
      const response = makeAssistant([{ type: 'text', text: 'hello' }]);
      response.message = { ...response.message, model: responseModel };
      response.message.usage = {
        ...cloneUsage(),
        input_tokens: 100_000,
        output_tokens: 10,
      };
      response.modelSource = 'custom';
      response.customProviderId = providerId;
      expect(response.message.model).toBe(responseModel);
      const usage = response.message.usage;
      expect(usage?.input_tokens).toBe(100_000);
      if (persisted) delete response.message.usage;
      const priorInput = makeUser('small prompt');
      response.requestTokenAnchor = createRequestTokenAnchor({
        model: responseModel,
        messages: [priorInput],
      })(response.message.content);
      const pipeline = new CompressionPipeline(
        { modelProviderManager: testModelProviderManager(), target: 'main' },
        {
          getState: vi.fn(() => createEmptyCompressionPipelineState()),
          saveState: vi.fn(),
        } as unknown as CompressionStateStore,
      );
      const result = await pipeline.compress([priorInput, response], {
        modelResolution: testProviderModelResolution(sessionModel, {
          context: { contextWindow: 50_000 },
        }),
        promptId: 'custom-provider-token-count',
        force: false,
        config: {
          ...testRequestConfig(),
          ...testCompressionConfig(),
          getModelProviderManager: requestModelSource.getModelProviderManager,
          getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
          getSessionId: () => 'custom-provider-session',
          getActiveSessionTranscriptPath: () =>
            '/tmp/custom-provider-session.jsonl',
          getWorkspaceContext: () => ({ getDirectories: () => [] }),
        } as unknown as CompressOptions['config'],
      });
      if (reusable && !persisted) {
        expect(result.info.originalTokenCount).toBe(100_010);
        expect(result.info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
        expect(runForkedAgent).toHaveBeenCalledTimes(1);
      } else {
        expect(result.info.originalTokenCount).toBeLessThan(1_000);
        expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
        expect(runForkedAgent).not.toHaveBeenCalled();
      }
    },
  );

  it('counts pending input attachments toward the auto-compact threshold', async () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    const history: Message[] = [
      makeUser('Earlier prompt'),
      makeAssistant([{ type: 'text', text: 'Earlier answer' }]),
    ];
    const pendingUser = makeUser('Current prompt');
    const reminder: AttachmentMessage = {
      type: 'attachment',
      uuid: 'large-pending-task-reminder',
      timestamp: '2026-08-04T00:00:00.000Z',
      attachment: {
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: 'x'.repeat(100_000),
            description: 'Large reminder used for threshold coverage',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      },
    };
    const createPipeline = (): CompressionPipeline => {
      const stateStore = {
        getState: vi.fn(() => createEmptyCompressionPipelineState()),
        saveState: vi.fn(),
      } as unknown as CompressionStateStore;
      return new CompressionPipeline(
        { modelProviderManager: testModelProviderManager(), target: 'main' },
        stateStore,
      );
    };
    const baseOptions: CompressOptions = {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-pending-turn-threshold',
      force: false,
      config,
    };

    const userOnlyResult = await createPipeline().compress(history, {
      ...baseOptions,
      pendingTurnForThreshold: [pendingUser],
    });
    const completeTurnResult = await createPipeline().compress(history, {
      ...baseOptions,
      pendingTurnForThreshold: [pendingUser, reminder],
    });

    expect(userOnlyResult.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(completeTurnResult.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSED,
    );
  });

  it('counts ephemeral request prefixes toward the auto-compact threshold', async () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
    } as unknown as CompressOptions['config'];
    const history: Message[] = [
      makeUser('Earlier prompt'),
      makeAssistant([{ type: 'text', text: 'Earlier answer' }]),
    ];
    const stateStore = {
      getState: vi.fn(() => createEmptyCompressionPipelineState()),
      saveState: vi.fn(),
    } as unknown as CompressionStateStore;
    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore,
    );

    const result = await pipeline.compress(history, {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-request-prefix-threshold',
      force: false,
      config,
      requestPrefixMessages: [makeUser('x'.repeat(100_000))],
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  });

  it.each([false, true])(
    'does not repeat retained SessionStart context, but retains changed output (%s)',
    async (changed) => {
      forceLowAutoCompactThreshold();
      const hook = createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'INITIAL_HOOK_CONTEXT',
        }),
      );
      const history: Message[] = [
        makeUser('long conversation '.repeat(100)),
        hook,
        makeAssistant([{ type: 'text', text: 'old answer '.repeat(100) }]),
        makeAssistant([{ type: 'text', text: 'latest response' }]),
      ];
      const state = createEmptyCompressionPipelineState();
      const config = {
        ...testRequestConfig(),
        ...testCompressionConfig(),
        getSessionId: () => 'session-hook-prefix',
        getActiveSessionTranscriptPath: () => '/tmp/session-hook-prefix.jsonl',
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
        getTargetDir: () => '/tmp/project',
        getHookSystem: () => ({
          firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
          firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
          fireSessionStartEvent: vi
            .fn()
            .mockResolvedValue({
              getAdditionalContext: () =>
                changed ? 'CHANGED_HOOK_CONTEXT' : 'INITIAL_HOOK_CONTEXT',
              getStdoutForModel: () => undefined,
              shouldStopExecution: () => false,
            }),
        }),
      } as unknown as CompressOptions['config'];
      const pipeline = new CompressionPipeline({ modelProviderManager: testModelProviderManager(), target: 'main' }, {
        getState: () => state,
        saveState: vi.fn(),
      } as unknown as CompressionStateStore);
      const result = await pipeline.compress(history, {
        promptId: 'hook-prefix',
        force: false,
        modelResolution: testProviderModelResolution('test-model'),
        config,
      });
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      const outputs = result.newHistory!.filter(
        (m) => m.type === 'attachment' && m.attachment.type === 'hook_output',
      );
      expect(outputs).toHaveLength(changed ? 2 : 1);
      expect(outputs.filter((m) => m.isCompactionPrefix)).toHaveLength(1);
    },
  );

  it('routes the compact model through hooks and the compact request', async () => {
    // Regression: stages receive shallow copies of the pipeline input, so
    // the resolver's write-back never reached the outer input.
    forceLowAutoCompactThreshold();
    const originalHistory: Message[] = [
      makeUser([
        { type: 'text' as const, text: 'long conversation '.repeat(50) },
      ]),
      makeAssistant([
        {
          type: 'text' as const,
          text: 'long answer '.repeat(50),
        },
      ]),
    ];

    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const firePreCompactEvent = vi.fn().mockResolvedValue(undefined);
    const firePostCompactEvent = vi.fn().mockResolvedValue(undefined);
    const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
      getHookSystem: () => ({
        firePreCompactEvent,
        firePostCompactEvent,
        fireSessionStartEvent,
      }),
    } as unknown as CompressOptions['config'];

    const manager = testModelProviderManager();
    const selectCompactModel = vi
      .mocked(manager.select)
      .mockResolvedValue(testProviderModelResolution('routed-compact-model'));
    const abortSignal = new AbortController().signal;
    const pipeline = new CompressionPipeline(
      { modelProviderManager: manager, target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('session-model', {}),
      promptId: 'prompt-compact-model-stats',
      force: false,
      config,
      abortSignal,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(selectCompactModel).toHaveBeenCalledTimes(1);
    expect(firePreCompactEvent).toHaveBeenCalledWith(
      'auto',
      '',
      undefined,
      'routed-compact-model',
    );
    expect(firePostCompactEvent).toHaveBeenCalledWith(
      'auto',
      expect.stringContaining('compact snapshot'),
      undefined,
      'routed-compact-model',
    );
    expect(fireSessionStartEvent).toHaveBeenCalledWith(
      'compact',
      'session-model',
    );
  });

  it('does not append synthetic restore messages after a successful compact (file restoration disabled)', async () => {
    forceLowAutoCompactThreshold();
    const originalHistory: Message[] = [
      makeAssistant([
        {
          type: 'tool_use' as const,
          id: 'read-1',
          name: READ_FILE_TOOL_NAME,
          input: { file_path: 'src/alpha.ts' },
        },
      ]),
      makeUser([
        {
          type: 'tool_result' as const,
          tool_use_id: 'read-1',
          content: 'alpha content',
          is_error: false,
        },
      ]),
      makeUser([
        {
          type: 'text' as const,
          text: 'continue from here',
        },
      ]),
    ];

    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-restore',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    expect(
      (getContentBlocks(result.newHistory![1])[0] as TextBlock)?.text,
    ).toContain('Summary:\ncompact snapshot');
    // File restoration is intentionally disabled — see the TODO at the top
    // of post-compact-finalize.ts. No <restored_files> message should be
    // appended, and the compact tail must not include replayed read_file
    // bodies.
    expect(
      result.newHistory?.some((msg) =>
        (getContentBlocks(msg)[0] as TextBlock)?.text?.includes(
          '<restored_files>',
        ),
      ),
    ).toBe(false);
    expect(
      result.newHistory?.some((msg) =>
        (getContentBlocks(msg)[0] as TextBlock)?.text?.includes(
          '/tmp/project/src/alpha.ts',
        ),
      ),
    ).toBe(false);
  });

  it('preserves a trailing unpaired model(tool_use) in newHistory when compaction fires at a turn boundary', async () => {
    // Regression: session-2026-04-11T05-18-6c43633e.json. Compaction fired
    // while the model had emitted a tool_use but the matching tool_result
    // was still pending as the next turn's user message. Without the
    // trailing-tool_use guard in fork-compact.ts, the tool_use is only
    // referenced narratively in the snapshot — the next turn's
    // sendMessageStream appends the pending tool_result onto [snapshot]
    // and the API rejects with:
    //   messages.0.content.N: unexpected tool_use_id found in tool_result
    //   blocks: toolu_vrtx_...
    forceLowAutoCompactThreshold();
    const pendingToolUse: Message = makeAssistant([
      {
        type: 'tool_use' as const,
        id: 'pending-tool-use-1',
        name: SHELL_TOOL_NAME,
        input: { command: 'sed -n 60,100p extensionLoader.ts' },
      },
    ]);
    const originalHistory: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: 'investigate MCP injection. '.repeat(50),
        },
      ]),
      makeAssistant([
        {
          type: 'text' as const,
          text: 'sure, let me look at the codebase for injection vectors. '.repeat(
            50,
          ),
        },
      ]),
      pendingToolUse,
    ];

    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-pending-tooluse',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    // First message is the snapshot; last message must still be the
    // original trailing assistant(tool_use) so the pending tool_result can
    // pair with it on the next turn.
    expect(
      (getContentBlocks(result.newHistory![1])[0] as TextBlock)?.text,
    ).toContain('Summary:');
    const last = result.newHistory?.at(-1);
    expect(last?.type).toBe('assistant');
    expect(
      getContentBlocks(last!).some(
        (block) =>
          block.type === 'tool_use' && block.id === 'pending-tool-use-1',
      ),
    ).toBe(true);
  });

  it('does not preserve a trailing model(tool_use) whose response was already seen in a prior compression round', async () => {
    // Regression: session-2026-04-11T06-58-a0c83a3d.json. Idx 59's
    // auto-compact produced `[snapshot, model(tool_use=…9xNr)]` even
    // though …9xNr's functionResponse had already been processed in a
    // prior compression round (its id was in `seenFunctionResponseIds`).
    // On the next user turn the API rejected the request with
    //   `tool_use ids were found without tool_result blocks:
    //    toolu_bdrk_01MoQYkfhHuUDp3ZBeUH9xNr`.
    // Fork-compact must skip the trailing-tool_use preservation when the
    // id has already been seen — preserving it would reintroduce the
    // exact orphan the upstream rejects.
    forceLowAutoCompactThreshold();
    const staleToolUse: Message = makeAssistant([
      {
        type: 'tool_use' as const,
        id: 'toolu_bdrk_01MoQYkfhHuUDp3ZBeUH9xNr',
        name: SHELL_TOOL_NAME,
        input: { command: 'git status' },
      },
    ]);
    const originalHistory: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: '刚刚干了啥',
        },
      ]),
      makeAssistant([
        {
          type: 'text' as const,
          text: '让我查看一下仓库状态',
        },
      ]),
      staleToolUse,
    ];

    // Seed seenFunctionResponseIds with the tool_use id — as if a prior
    // compression round had already paired & recorded its functionResponse.
    const state = createEmptyCompressionPipelineState();
    state.seenFunctionResponseIds.push('toolu_bdrk_01MoQYkfhHuUDp3ZBeUH9xNr');
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-stale-tooluse',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    // Only the snapshot should be in newHistory — the stale tool_use
    // must NOT be preserved, otherwise the next turn rebuilds the orphan.
    // newHistory shape after refactor: [boundaryMarker, snapshotUser]. The
    // stale tool_use must NOT appear past the snapshot.
    expect(result.newHistory).toHaveLength(2);
    expect(result.newHistory?.[0]?.type).toBe('system');
    expect((result.newHistory![0] as { subtype?: string })?.subtype).toBe(
      'compact_boundary',
    );
    expect(result.newHistory?.[1]?.type).toBe('user');
    expect(
      (getContentBlocks(result.newHistory![1])[0] as TextBlock)?.text,
    ).toContain('Summary:');
    // Safety-belt: the stale functionCall id must not appear anywhere in
    // the compressed output.
    const serialized = JSON.stringify(result.newHistory);
    expect(serialized).not.toContain('toolu_bdrk_01MoQYkfhHuUDp3ZBeUH9xNr');
  });

  it('preserves a trailing parallel model(tool_use) batch when all ids are genuinely pending', async () => {
    // Parallel tool_use variant of the pending-preservation test: a single
    // model message emits three functionCalls at once, none of which have
    // been seen before. All three ids must still be preserved so the
    // pending functionResponse batch can pair on the next turn.
    forceLowAutoCompactThreshold();
    const parallelToolUse: Message = makeAssistant([
      {
        type: 'tool_use' as const,
        id: 'parallel-tool-A',
        name: SHELL_TOOL_NAME,
        input: { command: 'git status' },
      },
      {
        type: 'tool_use' as const,
        id: 'parallel-tool-B',
        name: SHELL_TOOL_NAME,
        input: { command: 'git diff' },
      },
      {
        type: 'tool_use' as const,
        id: 'parallel-tool-C',
        name: SHELL_TOOL_NAME,
        input: { command: 'git log -3' },
      },
    ]);
    const originalHistory: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: 'investigate repo state',
        },
      ]),
      makeAssistant([
        {
          type: 'text' as const,
          // Keep enough summarized text to reduce tokens while retaining all
          // three pending calls verbatim after compaction.
          text: 'kicking off a few parallel checks '.repeat(30),
        },
      ]),
      parallelToolUse,
    ];

    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-parallel-pending',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    // Shape after refactor: [boundaryMarker, snapshotUser, parallelToolUse].
    expect(result.newHistory).toHaveLength(3);
    expect(result.newHistory?.[0]?.type).toBe('system');
    expect((result.newHistory![0] as { subtype?: string })?.subtype).toBe(
      'compact_boundary',
    );
    const last = result.newHistory?.at(-1);
    expect(last?.type).toBe('assistant');
    const preservedIds = (last ? getContentBlocks(last) : [])
      .filter(
        (block): block is typeof block & { type: 'tool_use' } =>
          block.type === 'tool_use',
      )
      .map((block) => block.id);
    expect(preservedIds).toEqual([
      'parallel-tool-A',
      'parallel-tool-B',
      'parallel-tool-C',
    ]);
  });

  it('drops a trailing parallel model(tool_use) batch when any id is already in seenFunctionResponseIds', async () => {
    // Parallel tool_use variant of the stale-drop test: since parallel
    // functionCalls are emitted and paired atomically, a hit on any one
    // of their ids means the entire batch was already resolved in a prior
    // compression round. Preserving only "unseen" ids would split the
    // model message and still orphan the stale one, so the whole batch
    // must be dropped.
    forceLowAutoCompactThreshold();
    const parallelToolUse: Message = makeAssistant([
      {
        type: 'tool_use' as const,
        id: 'parallel-stale-A',
        name: SHELL_TOOL_NAME,
        input: { command: 'git status' },
      },
      {
        type: 'tool_use' as const,
        id: 'parallel-stale-B',
        name: SHELL_TOOL_NAME,
        input: { command: 'git diff' },
      },
    ]);
    const originalHistory: Message[] = [
      makeUser([
        {
          type: 'text' as const,
          text: 'investigate repo state',
        },
      ]),
      makeAssistant([
        {
          type: 'text' as const,
          text: 'kicking off a few parallel checks',
        },
      ]),
      parallelToolUse,
    ];

    const state = createEmptyCompressionPipelineState();
    // Seed both ids — models always pair the whole batch together, so
    // either all or none will be in seenFunctionResponseIds in practice.
    state.seenFunctionResponseIds.push('parallel-stale-A');
    state.seenFunctionResponseIds.push('parallel-stale-B');
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    };
    const config = {
      ...testRequestConfig(),
      ...testCompressionConfig(),
      getModelProviderManager: requestModelSource.getModelProviderManager,
      getCompressionConfig: () => ({
        ...DEFAULT_COMPRESSION_CONFIG,
        autoCompact: {
          maxConsecutiveFailures: 3,
        },
      }),
      getSessionId: () => 'session-main',
      getActiveSessionTranscriptPath: () => '/tmp/session-main.jsonl',
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getTargetDir: () => '/tmp/project',
    } as unknown as CompressOptions['config'];

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore as unknown as CompressionStateStore,
    );

    const result = await pipeline.compress([...originalHistory], {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-parallel-stale',
      force: false,
      config,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    // Shape after refactor: [boundaryMarker, snapshotUser]; the stale
    // tool_use must NOT be preserved.
    expect(result.newHistory).toHaveLength(2);
    expect(result.newHistory?.[0]?.type).toBe('system');
    expect((result.newHistory![0] as { subtype?: string })?.subtype).toBe(
      'compact_boundary',
    );
    const serialized = JSON.stringify(result.newHistory);
    expect(serialized).not.toContain('parallel-stale-A');
    expect(serialized).not.toContain('parallel-stale-B');
  });
  it('keeps budget replacements on NOOP without mutating input or adding request tags', async () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '200000');
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'compact-budget-pipeline-'),
    );
    const manager = testModelProviderManager();
    const selectCompactModel = vi.mocked(manager.select);
    try {
      const state = createEmptyCompressionPipelineState();
      const saveState = vi.fn();
      const pipeline = new CompressionPipeline(
        { modelProviderManager: manager, target: 'main' },
        {
          getState: () => state,
          saveState,
        } as unknown as CompressionStateStore,
      );
      const originalText = 'x'.repeat(250_000);
      const history = [
        makeAssistant([
          { type: 'tool_use', id: 'large-tool', name: 'shell', input: {} },
        ]),
        makeUser([
          {
            type: 'tool_result',
            tool_use_id: 'large-tool',
            content: originalText,
            is_error: false,
          },
        ]),
      ];
      const result = await pipeline.compress(history, {
        modelResolution: testProviderModelResolution('test-model', {}),
        promptId: 'budget-only',
        force: false,
        config: {
          ...testRequestConfig(),
          ...testCompressionConfig(),
          getModelProviderManager: requestModelSource.getModelProviderManager,
          getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
          getSessionId: () => 'budget-only',
          getActiveSessionTranscriptPath: () =>
            path.join(tempDir, 'budget-only.jsonl'),
          getNextCompressionTruncationId: () => 1,
          getTruncateToolOutputThreshold: () => 120,
          storage: {
            getProjectTempDir: () => tempDir,
            getProjectRoot: () => tempDir,
          },
        } as unknown as CompressOptions['config'],
      });
      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(result.newHistory).not.toBeNull();
      const original = getContentBlocks(history[1])[0];
      const replaced = getContentBlocks(result.newHistory![1])[0];
      expect(original).toMatchObject({ content: originalText });
      expect(replaced).toMatchObject({
        content: expect.stringContaining('For full output see:'),
      });
      expect(JSON.stringify(result.newHistory)).not.toContain('[id:');
      expect(result).not.toHaveProperty('requestHistoryOverride');
      expect(selectCompactModel).not.toHaveBeenCalled();
      expect(saveState).toHaveBeenCalled();
      expect(state.replacementDecisions['large-tool']).toBeDefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    'none',
    'prefix',
    'pending',
    'attachment',
    'system',
    'tools',
  ] as const)(
    'recounts %s tokens after tool replacement in an already compacted session',
    async (source) => {
      vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'compact-budget-count-'),
      );
      try {
        const boundary = createCompactBoundaryMessage({
          trigger: 'auto',
          preTokens: 100_000,
        });
        const toolCall = makeAssistant([
          {
            type: 'tool_use',
            id: 'large-tool',
            name: SHELL_TOOL_NAME,
            input: {},
          },
        ]);
        // This server usage predates tool replacement and must not force
        // compaction when the reduced request is below the threshold.
        toolCall.message.usage = {
          ...cloneUsage(),
          input_tokens: 100_000,
          output_tokens: 10,
        };
        const history: Message[] = [
          boundary,
          makeUser('Previous compact summary', { isCompactSummary: true }),
          toolCall,
          makeUser([
            {
              type: 'tool_result',
              tool_use_id: 'large-tool',
              content: 'x'.repeat(250_000),
              is_error: false,
            },
          ]),
        ];
        const originalMessages = JSON.stringify(history.slice(1));
        const largeText = 'x'.repeat(100_000);
        const extraOptions: Partial<CompressOptions> = {};
        if (source === 'prefix')
          extraOptions.requestPrefixMessages = [makeUser(largeText)];
        if (source === 'pending')
          extraOptions.pendingTurnForThreshold = [makeUser(largeText)];
        if (source === 'system')
          extraOptions.systemPrompt = systemPromptFromText(largeText);
        if (source === 'tools')
          extraOptions.tools = [
            { name: 'large_schema', description: largeText },
          ];
        if (source === 'attachment') {
          extraOptions.pendingTurnForThreshold = [
            {
              type: 'attachment',
              uuid: 'pending-reminder',
              timestamp: boundary.timestamp,
              attachment: {
                type: 'task_reminder',
                content: [
                  {
                    id: '1',
                    subject: largeText,
                    description: '',
                    status: 'pending',
                    blocks: [],
                    blockedBy: [],
                  },
                ],
                itemCount: 1,
              },
            },
          ];
        }
        const state = createEmptyCompressionPipelineState();
        const pipeline = new CompressionPipeline(
          { modelProviderManager: testModelProviderManager(), target: 'main' },
          {
            getState: () => state,
            saveState: vi.fn(),
          } as unknown as CompressionStateStore,
        );
        vi.mocked(runForkedAgent).mockClear();
        const result = await pipeline.compress(history, {
          modelResolution: testProviderModelResolution('test-model', {
            context: { contextWindow: 50_000 },
          }),
          promptId: 'budget-count',
          force: false,
          config: {
            ...testRequestConfig(),
            ...testCompressionConfig(),
            getModelProviderManager: requestModelSource.getModelProviderManager,
            getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
            getSessionId: () => 'budget-count',
            getActiveSessionTranscriptPath: () =>
              path.join(tempDir, 'budget-count.jsonl'),
            getNextCompressionTruncationId: () => 1,
            getTruncateToolOutputThreshold: () => 120,
            getWorkspaceContext: () => ({ getDirectories: () => [] }),
            storage: {
              getProjectTempDir: () => tempDir,
              getProjectRoot: () => tempDir,
            },
          } as unknown as CompressOptions['config'],
          ...extraOptions,
        });
        expect(JSON.stringify(history.slice(1))).toBe(originalMessages);
        expect(state.replacementDecisions['large-tool']).toBeDefined();
        expect(result.info.compressionStatus).toBe(
          source === 'none'
            ? CompressionStatus.NOOP
            : CompressionStatus.COMPRESSED,
        );
        expect(runForkedAgent).toHaveBeenCalledTimes(source === 'none' ? 0 : 1);
        if (source === 'none') {
          expect(result.newHistory?.[0]).toEqual(boundary);
          expect(result.info.originalTokenCount).toBeLessThan(1_000);
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe('automatic policy across pipeline stages', () => {
  afterEach(() => vi.mocked(getConfigValue).mockReset());
  it.each([
    [599999, false],
    [600000, false],
    [10, true],
  ] as const)(
    'applies the auto-compact threshold at %i tokens (force=%s)',
    async (tokens, force) => {
      vi.mocked(getConfigValue).mockReturnValue({
        enabled: true,
        model_threshold_caps: { qfmodel: 600000 },
      });
      const stateStore = {
        getState: () => createEmptyCompressionPipelineState(),
        saveState: vi.fn(),
      };
      const config = {
        ...testRequestConfig(),
        ...testCompressionConfig(),
        getModelProviderManager: requestModelSource.getModelProviderManager,
        getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
        getSessionId: () => 'policy-stats-session',
        getActiveSessionTranscriptPath: () =>
          '/tmp/policy-stats-session.jsonl',
        getWorkspaceContext: () => ({ getDirectories: () => [] }),
      } as unknown as CompressOptions['config'];
      const assistant = makeAssistant([
        { type: 'text', text: 'previous response' },
      ]);
      assistant.message = { ...assistant.message, model: 'qfmodel' };
      assistant.message.usage = {
        ...cloneUsage(),
        input_tokens: tokens,
        output_tokens: 0,
      };
      const pipeline = new CompressionPipeline(
        { modelProviderManager: testModelProviderManager(), target: 'main' },
        stateStore as unknown as CompressionStateStore,
      );
      if (force || tokens >= 600000) {
        vi.mocked(runForkedAgent).mockImplementationOnce(async () => {
          // A remote update while summarizing must not rewrite the trigger's policy.
          vi.mocked(getConfigValue).mockReturnValue({
            enabled: true,
            model_threshold_caps: { qfmodel: 500000 },
          });
          return {
            messages: [],
            totalUsage: cloneUsage(),
            textContent: '<summary>compact snapshot</summary>',
          };
        });
      }
      const priorInput = makeUser('hello');
      assistant.requestTokenAnchor = createRequestTokenAnchor({
        model: 'qfmodel',
        messages: [priorInput],
      })(assistant.message.content);
      const result = await pipeline.compress([priorInput, assistant], {
        modelResolution: testProviderModelResolution('qfmodel', {
          context: { contextWindow: 1000000 },
        }),
        promptId: 'policy-test',
        trigger: 'auto',
        force,
        config,
      });
      if (force || tokens >= 600000) {
        expect(result.info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
      } else {
        expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      }
    },
  );
});
