/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompressionService,
  findCompressSplitPoint,
  TOOL_ROUND_RETAIN_COUNT,
} from './chatCompressionService.js';
import type { Content } from '@google/genai';
import { CompressionStatus } from '../core/turn.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { tokenLimit } from '../core/tokenLimits.js';
import type { GeminiChat } from '../core/geminiChat.js';
import type { Config } from '../config/config.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import {
  SessionStartSource,
  PreCompactTrigger,
  PostCompactTrigger,
} from '../hooks/types.js';

vi.mock('../telemetry/uiTelemetry.js');
vi.mock('../core/tokenLimits.js');
vi.mock('../telemetry/loggers.js');

describe('findCompressSplitPoint', () => {
  it('should throw an error for non-positive numbers', () => {
    expect(() => findCompressSplitPoint([], 0)).toThrow(
      'Fraction must be between 0 and 1',
    );
  });

  it('should throw an error for a fraction greater than or equal to 1', () => {
    expect(() => findCompressSplitPoint([], 1)).toThrow(
      'Fraction must be between 0 and 1',
    );
  });

  it('should handle an empty history', () => {
    expect(findCompressSplitPoint([], 0.5)).toBe(0);
  });

  it('should handle a fraction in the middle', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the first message.' }] }, // JSON length: 66 (19%)
      { role: 'model', parts: [{ text: 'This is the second message.' }] }, // JSON length: 68 (40%)
      { role: 'user', parts: [{ text: 'This is the third message.' }] }, // JSON length: 66 (60%)
      { role: 'model', parts: [{ text: 'This is the fourth message.' }] }, // JSON length: 68 (80%)
      { role: 'user', parts: [{ text: 'This is the fifth message.' }] }, // JSON length: 65 (100%)
    ];
    expect(findCompressSplitPoint(history, 0.5)).toBe(4);
  });

  it('should handle a fraction of last index', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the first message.' }] }, // JSON length: 66 (19%)
      { role: 'model', parts: [{ text: 'This is the second message.' }] }, // JSON length: 68 (40%)
      { role: 'user', parts: [{ text: 'This is the third message.' }] }, // JSON length: 66 (60%)
      { role: 'model', parts: [{ text: 'This is the fourth message.' }] }, // JSON length: 68 (80%)
      { role: 'user', parts: [{ text: 'This is the fifth message.' }] }, // JSON length: 65 (100%)
    ];
    expect(findCompressSplitPoint(history, 0.9)).toBe(4);
  });

  it('should handle a fraction of after last index', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the first message.' }] }, // JSON length: 66 (24%)
      { role: 'model', parts: [{ text: 'This is the second message.' }] }, // JSON length: 68 (50%)
      { role: 'user', parts: [{ text: 'This is the third message.' }] }, // JSON length: 66 (74%)
      { role: 'model', parts: [{ text: 'This is the fourth message.' }] }, // JSON length: 68 (100%)
    ];
    expect(findCompressSplitPoint(history, 0.8)).toBe(4);
  });

  it('compresses everything before the trailing in-flight functionCall', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the first message.' }] },
      { role: 'model', parts: [{ text: 'This is the second message.' }] },
      { role: 'user', parts: [{ text: 'This is the third message.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'foo', args: {} } }] },
    ];
    // Trailing m+fc is in-flight; no preceding (m+fc, u+fr) pair to retain,
    // so the in-flight fallback compresses everything except the trailing fc.
    // The kept slice starts with m+fc; callers bridge with a synthetic user.
    expect(findCompressSplitPoint(history, 0.99)).toBe(3);
  });

  it('should handle a history with only one item', () => {
    const historyWithEmptyParts: Content[] = [
      { role: 'user', parts: [{ text: 'Message 1' }] },
    ];
    expect(findCompressSplitPoint(historyWithEmptyParts, 0.5)).toBe(0);
  });

  it('should handle history with weird parts', () => {
    const historyWithEmptyParts: Content[] = [
      { role: 'user', parts: [{ text: 'Message 1' }] },
      {
        role: 'model',
        parts: [{ fileData: { fileUri: 'derp', mimeType: 'text/plain' } }],
      },
      { role: 'user', parts: [{ text: 'Message 2' }] },
    ];
    expect(findCompressSplitPoint(historyWithEmptyParts, 0.5)).toBe(2);
  });

  it('should compress everything when last message is a functionResponse', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Fix this bug' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'readFile', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'readFile',
              response: { result: 'file content' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'writeFile', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'writeFile',
              response: { result: 'ok' },
            },
          },
        ],
      },
    ];
    // Last message is functionResponse -> safe to compress everything
    expect(findCompressSplitPoint(history, 0.7)).toBe(5);
  });

  it('retains last K complete tool rounds when no fresh user splits past target', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Fix this' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read1', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read1',
              response: { result: 'a'.repeat(1000) },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read2', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read2',
              response: { result: 'b'.repeat(1000) },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'write1', args: {} } }],
      },
    ];
    // 2 complete (m+fc, u+fr) pairs precede the trailing fc → retain both
    // pairs + trailing fc = last 5 entries; compress index 0 (the task).
    // Pre-refactor this returned 0 (NOOP); now it compresses-most.
    expect(findCompressSplitPoint(history, 0.7)).toBe(history.length - 5);
  });

  it('prefers compress-most over lastSplitPoint when scan finds no clean split past target', () => {
    const longContent = 'a'.repeat(10000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Fix bug A' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
      { role: 'user', parts: [{ text: 'Fix bug B' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read1', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read1',
              response: { result: longContent },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read2', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read2',
              response: { result: longContent },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'write1', args: {} } }],
      },
    ];
    // 2 complete pairs before the trailing fc → retain both + trailing = 5
    // entries kept. Pre-refactor returned lastSplitPoint=2 (compress less).
    expect(findCompressSplitPoint(history, 0.7)).toBe(history.length - 5);
  });

  it('compresses-most via in-flight fallback when scan never crosses the target', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'resp1' }] },
      {
        role: 'user',
        parts: [{ text: 'msg2 with some substantial content here' }],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'tool1', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool1',
              response: { result: 'short' },
            },
          },
        ],
      },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'resp3' }] },
      { role: 'user', parts: [{ text: 'msg4' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'tool2', args: {} } }],
      },
    ];
    // The entry before the trailing fc is a fresh user (msg4), not a u+fr,
    // so the pair walk stops with 0 pairs found → retain only the trailing
    // fc, compress everything else. Pre-refactor returned lastSplitPoint=7.
    expect(findCompressSplitPoint(history, 0.99)).toBe(history.length - 1);
  });

  it('honors precomputedCharCounts when provided', () => {
    // Three messages of equal real length. If precomputedCharCounts
    // claims the middle message is the heaviest, the split point should
    // move past it.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'model', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] },
      { role: 'model', parts: [{ text: 'd' }] },
      { role: 'user', parts: [{ text: 'e' }] },
    ];
    // Force the first three messages to dominate the budget so the
    // splitter returns the index of the next user message (4).
    const inflated = [1000, 1000, 1000, 1, 1];
    expect(
      findCompressSplitPoint(history, 0.7, TOOL_ROUND_RETAIN_COUNT, inflated),
    ).toBe(4);
    // Same history with even weights yields the standard split.
    const even = [1, 1, 1, 1, 1];
    expect(
      findCompressSplitPoint(history, 0.7, TOOL_ROUND_RETAIN_COUNT, even),
    ).toBe(4);
  });
});

describe('findCompressSplitPoint — in-flight fallback', () => {
  const userTask = (text: string): Content => ({
    role: 'user',
    parts: [{ text }],
  });
  const modelText = (text: string): Content => ({
    role: 'model',
    parts: [{ text }],
  });
  const modelFc = (name: string): Content => ({
    role: 'model',
    parts: [{ functionCall: { name, args: {} } }],
  });
  const userFr = (name: string): Content => ({
    role: 'user',
    parts: [{ functionResponse: { name, response: { result: 'x' } } }],
  });

  // Subagent-shaped history at compression check time: env bootstrap, task,
  // alternating tool rounds, ending in a trailing in-flight model+fc whose
  // functionResponse hasn't been pushed yet. The scan finds no clean split
  // past the target fraction, so the in-flight fallback decides the index.
  it('compresses everything except trailing fc + most recent retainCount pairs', () => {
    const history = [
      userTask('env'),
      modelText('env-ack'),
      userTask('task'),
      modelFc('a'),
      userFr('a'),
      modelFc('b'),
      userFr('b'),
      modelFc('c'),
      userFr('c'),
      modelFc('d'),
      userFr('d'),
      modelFc('trailing'),
    ];
    // Default retainCount = 2 → keep last 5 (2 pairs + trailing).
    expect(findCompressSplitPoint(history, 0.7)).toBe(history.length - 5);
  });

  it('retains all pairs when fewer than retainCount exist', () => {
    const history = [
      userTask('env'),
      modelText('env-ack'),
      userTask('task'),
      modelFc('a'),
      userFr('a'),
      modelFc('trailing'),
    ];
    // Only 1 complete pair → keep last 3 (1 pair + trailing).
    expect(findCompressSplitPoint(history, 0.7)).toBe(history.length - 3);
  });

  it('retains just the trailing fc when no complete pairs precede it', () => {
    const history = [
      userTask('env'),
      modelText('env-ack'),
      userTask('task'),
      modelFc('trailing'),
    ];
    // No complete pairs → keep only the trailing fc.
    expect(findCompressSplitPoint(history, 0.7)).toBe(history.length - 1);
  });

  it('respects an explicit retainCount override', () => {
    const history = [
      userTask('env'),
      modelText('env-ack'),
      userTask('task'),
      modelFc('a'),
      userFr('a'),
      modelFc('b'),
      userFr('b'),
      modelFc('c'),
      userFr('c'),
      modelFc('trailing'),
    ];
    // Override retainCount to 1 → keep last 3 (1 pair + trailing).
    expect(findCompressSplitPoint(history, 0.7, 1)).toBe(history.length - 3);
  });
});

describe('ChatCompressionService', () => {
  let service: ChatCompressionService;
  let mockChat: GeminiChat;
  let mockConfig: Config;
  const mockModel = 'gemini-pro';
  const mockPromptId = 'test-prompt-id';
  let mockFireSessionStartEvent: ReturnType<typeof vi.fn>;
  let mockGetHookSystem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new ChatCompressionService();
    mockChat = {
      getHistory: vi.fn(),
    } as unknown as GeminiChat;
    mockFireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
    mockGetHookSystem = vi.fn().mockReturnValue({
      fireSessionStartEvent: mockFireSessionStartEvent,
    });
    mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getHookSystem: mockGetHookSystem,
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
      }),
    } as unknown as Config;

    vi.mocked(tokenLimit).mockReturnValue(1000);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(500);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return NOOP if history is empty', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([]);
    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should return NOOP if previously failed and not forced', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: true,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should return NOOP if under token threshold and not forced', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(600);
    vi.mocked(tokenLimit).mockReturnValue(1000);
    // Threshold is 0.7 * 1000 = 700. 600 < 700, so NOOP.

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should return NOOP when contextPercentageThreshold is 0', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getChatCompression).mockReturnValue({
      contextPercentageThreshold: 0,
    });

    const mockGenerateContent = vi.fn();
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info).toMatchObject({
      compressionStatus: CompressionStatus.NOOP,
      originalTokenCount: 0,
      newTokenCount: 0,
    });
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(tokenLimit).not.toHaveBeenCalled();

    const forcedResult = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(forcedResult.info).toMatchObject({
      compressionStatus: CompressionStatus.NOOP,
      originalTokenCount: 0,
      newTokenCount: 0,
    });
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(tokenLimit).not.toHaveBeenCalled();
  });

  it('should return NOOP when historyToCompress is below MIN_COMPRESSION_FRACTION of total', async () => {
    // Construct a history where the split point lands on the 2nd regular user
    // message (index 2), but indices 0-1 are tiny relative to the huge content
    // at index 2. historyToCompress = [0,1] will be << 5% of totalCharCount.
    const hugeContent = 'x'.repeat(100000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'world' }] },
      // Huge user message pushes the cumulative well past the split threshold
      { role: 'user', parts: [{ text: hugeContent }] },
      // Pending functionCall prevents returning contents.length,
      // so the fallback split at index 2 is used
      {
        role: 'model',
        parts: [{ functionCall: { name: 'process', args: {} } }],
      },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn();
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    // force=true bypasses the token threshold gate so we exercise the 5% guard
    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('should compress if over token threshold', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    // Mock contextWindowSize instead of tokenLimit
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);
    // newTokenCount = 800 - (1600 - 1000) + 50 = 800 - 600 + 50 = 250 <= 800 (success)
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBe(250); // 800 - (1600 - 1000) + 50
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toBe('Summary');
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(mockGetHookSystem).toHaveBeenCalled();
    expect(mockFireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Compact,
      mockModel,
      'default',
      undefined,
      undefined,
    );
  });

  it('should force compress even if under threshold', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    // newTokenCount = 100 - (1100 - 1000) + 50 = 100 - 100 + 50 = 50 <= 100 (success)
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1100,
        candidatesTokenCount: 50,
        totalTokenCount: 1150,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      // forced
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    expect(mockFireSessionStartEvent).toHaveBeenCalledWith(
      SessionStartSource.Compact,
      mockModel,
      'default',
      undefined,
      undefined,
    );
  });

  it('passes abort signal to summary generation', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const abortController = new AbortController();
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateText = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1100,
        candidatesTokenCount: 50,
        totalTokenCount: 1150,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateText,
    } as unknown as BaseLlmClient);

    await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      signal: abortController.signal,
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
      }),
    );
  });

  it('strips inline media from side-query contents during compaction', async () => {
    // Wire-up test: a real compaction should call slimCompactionInput
    // before runSideQuery, so the base64 payload never reaches the
    // summary model.
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'context msg' },
          { inlineData: { mimeType: 'image/png', data: 'AAAA'.repeat(2000) } },
        ],
      },
      { role: 'model', parts: [{ text: 'ack' }] },
      { role: 'user', parts: [{ text: 'final fresh user message' }] },
      { role: 'model', parts: [{ text: 'final model reply' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateText = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 200,
        candidatesTokenCount: 50,
        totalTokenCount: 250,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateText,
    } as unknown as BaseLlmClient);

    await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    // Inspect the actual contents passed to the summary model.
    const call = mockGenerateText.mock.calls[0]?.[0] as { contents: Content[] };
    expect(call).toBeDefined();
    const serialized = JSON.stringify(call.contents);
    // No base64 image bytes leaked through.
    expect(serialized).not.toContain('AAAAAAAA');
    // Placeholder is present.
    expect(serialized).toContain('[image: image/png]');
  });

  it('forwards model, maxAttempts, and thinkingConfig to runSideQuery', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateText = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1100,
        candidatesTokenCount: 50,
        totalTokenCount: 1150,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateText,
    } as unknown as BaseLlmClient);

    await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    // Compression quality depends on thinkingConfig.includeThoughts being on
    // and maxAttempts being short (best-effort); a future refactor that drops
    // any of these would silently regress quality without this assertion.
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModel,
        maxAttempts: 1,
        config: expect.objectContaining({
          thinkingConfig: { includeThoughts: true },
        }),
      }),
    );
  });

  it('should return FAILED if new token count is inflated', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(10);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1,
        candidatesTokenCount: 20,
        totalTokenCount: 21,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
    );
    expect(result.newHistory).toBeNull();
  });

  it('should return FAILED if usage metadata is missing', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      // No usage -> keep original token count
      usage: undefined,
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
    );
    expect(result.info.originalTokenCount).toBe(800);
    expect(result.info.newTokenCount).toBe(800);
    expect(result.newHistory).toBeNull();
  });

  it('should return FAILED if summary is empty string', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '', // Empty summary
      usage: undefined,
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.newHistory).toBeNull();
    expect(result.info.originalTokenCount).toBe(100);
    expect(result.info.newTokenCount).toBe(100);
  });

  it('should return FAILED if summary is only whitespace', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '   \n\t  ', // Only whitespace
      usage: undefined,
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.newHistory).toBeNull();
  });

  it('should not fire SessionStart event when compression fails', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(10);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1,
        candidatesTokenCount: 20,
        totalTokenCount: 21,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
    );
    expect(result.newHistory).toBeNull();
    expect(mockFireSessionStartEvent).not.toHaveBeenCalled();
  });

  it('should handle SessionStart hook errors gracefully', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    mockFireSessionStartEvent.mockRejectedValue(
      new Error('SessionStart hook failed'),
    );

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      usage: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText: mockGenerateContent,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      hasFailedCompressionAttempt: false,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    // Should still complete compression despite hook error
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
  });

  describe('PreCompact hook', () => {
    let mockFirePreCompactEvent: ReturnType<typeof vi.fn>;
    let mockFirePostCompactEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFirePreCompactEvent = vi.fn().mockResolvedValue(undefined);
      mockFirePostCompactEvent = vi.fn().mockResolvedValue(undefined);
      mockGetHookSystem.mockReturnValue({
        fireSessionStartEvent: mockFireSessionStartEvent,
        firePreCompactEvent: mockFirePreCompactEvent,
        firePostCompactEvent: mockFirePostCompactEvent,
      });
    });

    it('should fire PreCompact hook with Manual trigger when force=true', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        100,
      );
      vi.mocked(tokenLimit).mockReturnValue(1000);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1100,
          candidatesTokenCount: 50,
          totalTokenCount: 1150,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        // force = true -> Manual trigger
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Manual,
        '',
        undefined,
      );
    });

    it('should fire PreCompact hook with Auto trigger when force=false', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        // force = false -> Auto trigger
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Auto,
        '',
        undefined,
      );
    });

    it('should not fire PreCompact hook when history is empty', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([]);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(mockFirePreCompactEvent).not.toHaveBeenCalled();
    });

    it('should not fire PreCompact hook when threshold is 0', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        contextPercentageThreshold: 0,
      });

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(mockFirePreCompactEvent).not.toHaveBeenCalled();
    });

    it('should not fire PreCompact hook when under threshold and not forced', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        600,
      );
      vi.mocked(tokenLimit).mockReturnValue(1000);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(mockFirePreCompactEvent).not.toHaveBeenCalled();
    });

    it('should handle PreCompact hook errors gracefully', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      mockFirePreCompactEvent.mockRejectedValue(
        new Error('PreCompact hook failed'),
      );

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression despite hook error
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockFirePreCompactEvent).toHaveBeenCalled();
    });

    it('should fire PreCompact hook before compression and SessionStart after', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const callOrder: string[] = [];
      mockFirePreCompactEvent.mockImplementation(async () => {
        callOrder.push('PreCompact');
      });
      mockFireSessionStartEvent.mockImplementation(async () => {
        callOrder.push('SessionStart');
      });

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // PreCompact should be called before SessionStart
      expect(callOrder).toEqual(['PreCompact', 'SessionStart']);
    });

    it('should not fire PreCompact hook when hookSystem is null', async () => {
      mockGetHookSystem.mockReturnValue(null);

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression without hook
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      // mockFirePreCompactEvent should not be called since hookSystem is null
      expect(mockFirePreCompactEvent).not.toHaveBeenCalled();
    });
  });

  describe('PostCompact hook', () => {
    let mockFirePreCompactEvent: ReturnType<typeof vi.fn>;
    let mockFirePostCompactEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFirePreCompactEvent = vi.fn().mockResolvedValue(undefined);
      mockFirePostCompactEvent = vi.fn().mockResolvedValue(undefined);
      mockGetHookSystem.mockReturnValue({
        fireSessionStartEvent: mockFireSessionStartEvent,
        firePreCompactEvent: mockFirePreCompactEvent,
        firePostCompactEvent: mockFirePostCompactEvent,
      });
    });

    it('should fire PostCompact hook with Manual trigger when force=true', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        100,
      );
      vi.mocked(tokenLimit).mockReturnValue(1000);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1100,
          candidatesTokenCount: 50,
          totalTokenCount: 1150,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        // force = true -> Manual trigger
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePostCompactEvent).toHaveBeenCalledWith(
        PostCompactTrigger.Manual,
        'Summary',
        undefined,
      );
    });

    it('should fire PostCompact hook with Auto trigger when force=false', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Auto Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        // force = false -> Auto trigger
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePostCompactEvent).toHaveBeenCalledWith(
        PostCompactTrigger.Auto,
        'Auto Summary',
        undefined,
      );
    });

    it('should not fire PostCompact hook when compression fails with empty summary', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        100,
      );
      vi.mocked(tokenLimit).mockReturnValue(1000);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: '', // Empty summary
        usage: {
          promptTokenCount: 1100,
          candidatesTokenCount: 0,
          totalTokenCount: 1100,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
      );
      expect(mockFirePostCompactEvent).not.toHaveBeenCalled();
    });

    it('should handle PostCompact hook errors gracefully', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      mockFirePostCompactEvent.mockRejectedValue(
        new Error('PostCompact hook failed'),
      );

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression despite hook error
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockFirePostCompactEvent).toHaveBeenCalled();
    });

    it('should fire hooks in correct order: PreCompact -> SessionStart -> PostCompact', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const callOrder: string[] = [];
      mockFirePreCompactEvent.mockImplementation(async () => {
        callOrder.push('PreCompact');
      });
      mockFireSessionStartEvent.mockImplementation(async () => {
        callOrder.push('SessionStart');
      });
      mockFirePostCompactEvent.mockImplementation(async () => {
        callOrder.push('PostCompact');
      });

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Hooks should be called in order: PreCompact -> SessionStart -> PostCompact
      expect(callOrder).toEqual(['PreCompact', 'SessionStart', 'PostCompact']);
    });

    it('should not fire PostCompact hook when hookSystem is null', async () => {
      mockGetHookSystem.mockReturnValue(null);

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'msg1' }] },
        { role: 'model', parts: [{ text: 'msg2' }] },
        { role: 'user', parts: [{ text: 'msg3' }] },
        { role: 'model', parts: [{ text: 'msg4' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression without hook
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      // mockFirePostCompactEvent should not be called since hookSystem is null
      expect(mockFirePostCompactEvent).not.toHaveBeenCalled();
    });
  });

  describe('orphaned trailing funcCall handling', () => {
    it('should compress everything when force=true and last message is an orphaned funcCall', async () => {
      // Issue #2647: tool-heavy conversation interrupted/crashed while a tool
      // was still running. The funcCall will never get a response since the agent
      // is idle. Manual /compress strips the orphaned funcCall, then compresses
      // the remaining history normally.
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'Fix all TypeScript errors.' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'glob', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'glob',
                response: { result: 'files...' },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'readFile', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'readFile',
                response: { result: 'code...' },
              },
            },
          ],
        },
        // orphaned funcCall — agent was interrupted before getting a response
        {
          role: 'model',
          parts: [{ functionCall: { name: 'editFile', args: {} } }],
        },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        100,
      );
      vi.mocked(tokenLimit).mockReturnValue(1000);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'Summary of all work done',
        usage: {
          promptTokenCount: 1100,
          candidatesTokenCount: 50,
          totalTokenCount: 1150,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        // force=true (manual /compress)
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should compress successfully — orphaned funcCall is stripped first, then
      // normal compression runs on the remaining history, historyToKeep is empty
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      // Reconstructed history: [User(summary), Model("Got it...")] — valid structure
      expect(result.newHistory).toHaveLength(2);
      expect(result.newHistory![0].role).toBe('user');
      expect(result.newHistory![1].role).toBe('model');
      // The orphaned funcCall is stripped before compression, so only the first 5
      // messages are sent, plus the compression instruction (+1) = history.length total.
      const optionsArg = mockGenerateContent.mock.calls[0][0];
      expect(optionsArg.contents.length).toBe(history.length); // (history.length - 1) messages + 1 instruction
    });

    it('compresses-most without orphaning when last entry is in-flight funcCall (auto-compress)', async () => {
      // Auto-compress fires BEFORE the matching funcResponse is sent back to
      // the model. The trailing funcCall must be retained (its response is
      // coming); the in-flight fallback compresses everything safely before
      // it. Pre-refactor this returned NOOP, leaving the chat to grow until
      // it 400'd.
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'Fix all TypeScript errors.' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'glob', args: {} } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'glob',
                response: { result: 'files...' },
              },
            },
          ],
        },
        // Pending funcCall: tool is currently executing, funcResponse is coming
        {
          role: 'model',
          parts: [{ functionCall: { name: 'readFile', args: {} } }],
        },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        800,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 1000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'state snapshot summary',
        usage: {
          promptTokenCount: 2000,
          candidatesTokenCount: 50,
          totalTokenCount: 2050,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      // Trailing in-flight functionCall is preserved last in the kept slice
      // so the upcoming functionResponse pairs with it.
      const newHistory = result.newHistory!;
      const last = newHistory[newHistory.length - 1];
      expect(last.role).toBe('model');
      expect(last.parts?.some((p) => p.functionCall)).toBe(true);
      // Strict role alternation throughout.
      for (let i = 1; i < newHistory.length; i++) {
        expect(newHistory[i].role).not.toBe(newHistory[i - 1].role);
      }
    });
  });

  describe('tool-loop subagent absorption', () => {
    // The fresh-user split heuristic produces a tiny compress slice when the
    // history is dominated by tool rounds (every user past the task is a
    // functionResponse). Without absorption, MIN_COMPRESSION_FRACTION would
    // NOOP every send and the subagent eventually hits the 400 it was meant
    // to avoid.
    it('compresses by absorbing older tool rounds when fresh-user split is too small', async () => {
      const FILLER = 'A'.repeat(20_000);
      // Auto-compress fires BEFORE the next functionResponse is pushed, so
      // the trailing entry is always a model+functionCall with no match yet.
      // Build a history with N complete pairs followed by one trailing fc.
      const buildHistory = (completePairs: number): Content[] => {
        const h: Content[] = [
          { role: 'user', parts: [{ text: 'env-bootstrap' }] },
          { role: 'model', parts: [{ text: 'env-ack' }] },
          { role: 'user', parts: [{ text: 'task: explore' }] },
        ];
        for (let r = 0; r < completePairs; r++) {
          h.push({
            role: 'model',
            parts: [
              { text: `round ${r}: ${FILLER}` },
              { functionCall: { name: 'glob', args: { pattern: '**/*.md' } } },
            ],
          });
          h.push({
            role: 'user',
            parts: [
              {
                functionResponse: { name: 'glob', response: { result: 'x' } },
              },
            ],
          });
        }
        // Trailing model+fc whose response is about to be sent.
        h.push({
          role: 'model',
          parts: [
            { text: `round ${completePairs}: ${FILLER}` },
            { functionCall: { name: 'glob', args: { pattern: '**/*.md' } } },
          ],
        });
        return h;
      };

      // Five complete tool rounds + 1 trailing fc → 5 pairs in keep; absorbs
      // 3 older pairs and retains the 2 most recent (plus the trailing fc).
      vi.mocked(mockChat.getHistory).mockReturnValue(buildHistory(5));
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        80_000,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 100_000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: 'state snapshot summary',
        usage: {
          promptTokenCount: 60_000,
          candidatesTokenCount: 200,
          totalTokenCount: 60_200,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const newHistory = result.newHistory!;
      // [summary_user, summary_ack_model, continuation_bridge_user, ...keep]
      // where keep starts with the retained model+functionCall.
      expect(newHistory[0].role).toBe('user');
      expect(newHistory[0].parts?.[0].text).toBe('state snapshot summary');
      expect(newHistory[1].role).toBe('model');
      expect(newHistory[2].role).toBe('user');
      expect(newHistory[2].parts?.[0].text).toMatch(/Continue/);
      // Retained two complete pairs (4 entries) + trailing model+fc = 5.
      expect(newHistory.slice(3)).toHaveLength(5);
      expect(newHistory[3].role).toBe('model');
      expect(newHistory[3].parts?.some((p) => p.functionCall)).toBe(true);
      expect(newHistory[4].role).toBe('user');
      expect(newHistory[4].parts?.some((p) => p.functionResponse)).toBe(true);
      // Trailing model+fc remains last so the upcoming functionResponse pushed
      // by sendMessageStream pairs with it correctly.
      const last = newHistory[newHistory.length - 1];
      expect(last.role).toBe('model');
      expect(last.parts?.some((p) => p.functionCall)).toBe(true);

      // Strict role alternation throughout the new history.
      for (let i = 1; i < newHistory.length; i++) {
        expect(newHistory[i].role).not.toBe(newHistory[i - 1].role);
      }
    });

    it('NOOPs when the keep slice has too few tool rounds to absorb', async () => {
      const FILLER = 'A'.repeat(20_000);
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'env-bootstrap' }] },
        { role: 'model', parts: [{ text: 'env-ack' }] },
        { role: 'user', parts: [{ text: 'task' }] },
        {
          role: 'model',
          parts: [
            { text: FILLER },
            { functionCall: { name: 'glob', args: {} } },
          ],
        },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      // Set originalTokenCount above the threshold gate (0.7 * 30000 = 21000)
      // so the test actually exercises findCompressSplitPoint and the
      // MIN_COMPRESSION_FRACTION decision rather than short-circuiting at
      // the cheap-gate.
      vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
        22_000,
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 30_000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

      const mockGenerateContent = vi.fn();
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText: mockGenerateContent,
      } as unknown as BaseLlmClient);

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        hasFailedCompressionAttempt: false,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });
});
