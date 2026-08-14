/**
 * @license
 * Copyright 2026 QwenLM
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression tests for https://github.com/QwenLM/qwen-code/issues/7960
// The compression side-query used to always request a fixed
// maxOutputTokens=COMPACT_MAX_OUTPUT_TOKENS (20K). On a small-window
// deployment (e.g. vLLM --max-model-len 65536) whose prompt is already near
// the window, prompt + 20K exceeded the context window and the backend
// rejected the request with a 400 before the model generated anything. The
// side-query budget is now clamped to the window's remaining room.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';
import {
  ChatCompressionService,
  COMPACT_MAX_OUTPUT_TOKENS,
  COMPACTION_BUDGET_SAFETY_MARGIN,
  computeCompactionOutputBudget,
} from './chatCompressionService.js';
import { CompressionStatus } from '../core/turn.js';
import type { GeminiChat } from '../core/geminiChat.js';
import type { Config } from '../config/config.js';
import type {
  BaseLlmClient,
  GenerateTextOptions,
} from '../core/baseLlmClient.js';
import { estimateContentTokens } from './tokenEstimation.js';

vi.mock('../telemetry/uiTelemetry.js');
vi.mock('../core/tokenLimits.js');
vi.mock('../telemetry/loggers.js');

// The issue's real deployment: vLLM with --max-model-len 65536.
const WINDOW = 65_536;

describe('issue #7960: compression side-query output budget vs small windows', () => {
  let service: ChatCompressionService;
  let mockChat: GeminiChat;
  let mockConfig: Config;
  let capturedPromptTokens: number | undefined;
  let capturedMaxOutputTokens: number | undefined;
  let capturedModel: string | undefined;

  beforeEach(() => {
    capturedPromptTokens = undefined;
    capturedMaxOutputTokens = undefined;
    capturedModel = undefined;
    service = new ChatCompressionService();
    mockChat = {
      getHistory: vi.fn(),
      getHistoryShallow: vi.fn((curated?: boolean) =>
        mockChat.getHistory(curated),
      ),
    } as unknown as GeminiChat;
    mockConfig = {
      getChatCompression: vi.fn(),
      getAutoCompactThreshold: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        model: 'test-model',
        contextWindowSize: WINDOW,
      }),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getModel: () => 'test-model',
      getCompactionModel: vi.fn(),
      getFastModel: vi.fn(),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
      }),
      getTargetDir: () => '/tmp/test-workspace',
    } as unknown as Config;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Emulates the vLLM/OpenAI-compatible backend preflight check:
  // prompt_tokens + max_tokens must fit the model window or the request is
  // rejected with a 400 before generation starts. With hitCap the mock model
  // additionally stops exactly at the requested budget and returns an unclosed
  // <state_snapshot>, like a real model that runs out of output tokens.
  function mockVllmBackend(window: number = WINDOW, hitCap = false) {
    const generateText = vi.fn(async (opts: GenerateTextOptions) => {
      const contents = opts.contents as Content[];
      const systemText =
        typeof opts.systemInstruction === 'string'
          ? opts.systemInstruction
          : '';
      capturedModel = opts.model;
      capturedPromptTokens =
        estimateContentTokens(contents) + Math.ceil(systemText.length / 4);
      capturedMaxOutputTokens = (
        opts.config as { maxOutputTokens?: number } | undefined
      )?.maxOutputTokens;
      if (
        capturedMaxOutputTokens !== undefined &&
        capturedPromptTokens + capturedMaxOutputTokens > window
      ) {
        throw new Error(
          `400 BadRequestError: {"error":{"message":"This model's maximum ` +
            `context length is ${window} tokens. However, you requested ` +
            `${capturedMaxOutputTokens} output tokens and your prompt ` +
            `contains at least ${capturedPromptTokens} input tokens, for a ` +
            `total of at least ${capturedPromptTokens + capturedMaxOutputTokens} ` +
            `tokens."}}`,
        );
      }
      if (hitCap) {
        return {
          text: '<state_snapshot>truncated mid-content...',
          usage: {
            promptTokenCount: capturedPromptTokens,
            candidatesTokenCount: capturedMaxOutputTokens,
          },
        };
      }
      return {
        text: '<state_snapshot>summary</state_snapshot>',
        usage: {
          promptTokenCount: capturedPromptTokens,
          candidatesTokenCount: 2_000,
        },
      };
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText,
    } as unknown as BaseLlmClient);
    return generateText;
  }

  it('clamps maxOutputTokens so the request fits a 65K window with a ~45.5K prompt (manual /compress)', async () => {
    // ~45,500 estimated tokens of history (chars/4), matching the issue's
    // real failed session ("Estimated prompt Tokens: 45512").
    const bigText = 'x'.repeat(182_000);
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: bigText }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ]);
    mockVllmBackend();

    // Before the fix the fixed 20K budget overflowed the window and the
    // backend 400 escaped compress(). Now the budget is clamped and
    // compression succeeds.
    const result = await service.compress(mockChat, {
      promptId: 'test-prompt-id',
      force: true,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 45_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);

    // The budget was actually clamped below the fixed ceiling...
    expect(capturedMaxOutputTokens).toBeLessThan(COMPACT_MAX_OUTPUT_TOKENS);
    // ...to window - prompt - safety margin (with a 2-token tolerance for
    // per-part vs combined ceil rounding between the service's estimate and
    // this mock's)...
    expect(capturedMaxOutputTokens).toBeLessThanOrEqual(
      WINDOW - capturedPromptTokens! - COMPACTION_BUDGET_SAFETY_MARGIN,
    );
    expect(capturedMaxOutputTokens).toBeGreaterThanOrEqual(
      WINDOW - capturedPromptTokens! - COMPACTION_BUDGET_SAFETY_MARGIN - 2,
    );
    // ...and the request now satisfies the backend invariant.
    expect(
      capturedPromptTokens! + capturedMaxOutputTokens!,
    ).toBeLessThanOrEqual(WINDOW);
  });

  it('still requests the full 20K budget on a large window', async () => {
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'test-model',
      contextWindowSize: 128_000,
    });
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'x'.repeat(182_000) }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ]);
    mockVllmBackend(128_000);

    const result = await service.compress(mockChat, {
      promptId: 'test-prompt-id',
      force: true,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 45_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(capturedMaxOutputTokens).toBe(COMPACT_MAX_OUTPUT_TOKENS);
  });

  it('drops a summary truncated at the clamped budget instead of persisting it', async () => {
    // The truncation guard must compare against the budget actually
    // requested, not the fixed 20K ceiling: output can never exceed what
    // was requested, so against the ceiling the guard could never fire on a
    // clamped request and a truncated summary would be persisted.
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'x'.repeat(182_000) }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ]);
    mockVllmBackend(WINDOW, true);

    const result = await service.compress(mockChat, {
      promptId: 'test-prompt-id',
      force: true,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 45_000,
    });
    expect(capturedMaxOutputTokens).toBeLessThan(COMPACT_MAX_OUTPUT_TOKENS);
    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
    );
    expect(result.newHistory).toBeNull();
  });

  it('keys the budget to the compaction model window when a distinct compaction model is kept', async () => {
    // Main window 65K, compaction model window 200K, ~60K history: the
    // guard keeps the compaction model, and the budget must clamp against
    // the receiving model's 200K window — not the main window, which would
    // needlessly shrink the summary ceiling to ~3.6K.
    vi.mocked(mockConfig.getCompactionModel).mockReturnValue('compact-model');
    vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue([
      { id: 'compact-model', contextWindowSize: 200_000 },
    ] as never[]);
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'x'.repeat(240_000) }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ]);
    mockVllmBackend(200_000);

    const result = await service.compress(mockChat, {
      promptId: 'test-prompt-id',
      force: true,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 60_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(capturedModel).toBe('compact-model');
    expect(capturedMaxOutputTokens).toBe(COMPACT_MAX_OUTPUT_TOKENS);
  });

  describe('computeCompactionOutputBudget', () => {
    it('returns the fixed ceiling when the window has ample room', () => {
      expect(computeCompactionOutputBudget(10_000, 128_000)).toBe(
        COMPACT_MAX_OUTPUT_TOKENS,
      );
    });

    it('clamps to the remaining room on the issue scenario', () => {
      // The issue's real numbers: ~45,537 prompt tokens in a 65,536 window.
      const budget = computeCompactionOutputBudget(45_537, 65_536);
      expect(budget).toBe(65_536 - 45_537 - COMPACTION_BUDGET_SAFETY_MARGIN);
      expect(45_537 + budget).toBeLessThan(65_536);
    });

    it('floors at 1 when the estimate already exceeds the window', () => {
      expect(computeCompactionOutputBudget(70_000, 65_536)).toBe(1);
    });
  });
});
