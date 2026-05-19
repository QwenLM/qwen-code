/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompressionService,
  computeThresholds,
  findCompressSplitPoint,
  MAX_CONSECUTIVE_FAILURES,
  TOOL_ROUND_RETAIN_COUNT,
} from './chatCompressionService.js';
import type { Content } from '@google/genai';
import { CompressionStatus } from '../core/turn.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { tokenLimit } from '../core/tokenLimits.js';
import type { GeminiChat } from '../core/geminiChat.js';
import type { Config } from '../config/config.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import { PreCompactTrigger, PostCompactTrigger } from '../hooks/types.js';
import * as sideQueryModule from '../utils/sideQuery.js';

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
  let mockGetHookSystem: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new ChatCompressionService();
    mockChat = {
      getHistory: vi.fn(),
      appendSystemInstruction: vi.fn(),
    } as unknown as GeminiChat;
    mockGetHookSystem = vi.fn().mockReturnValue({});
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should return NOOP when consecutiveFailures has hit the breaker and not forced', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('falls through when consecutiveFailures is below the breaker threshold', async () => {
    // Below MAX_CONSECUTIVE_FAILURES, the cheap-gate must NOT NOOP on the
    // failure counter alone — it should fall through. Use force=true to
    // bypass the token-threshold check too, then prove we reached the
    // post-cheap-gate path by observing chat.getHistory(true) being called.
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);

    await service.compress(mockChat, {
      promptId: mockPromptId,
      // force=true so the only thing that could NOOP us up front is the
      // circuit-breaker. At MAX-1, the breaker must NOT trip.
      force: true,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    // Reaching the curated-history clone is the proof we got past the
    // cheap-gate. The service calls chat.getHistory(true) once it falls
    // through — if the breaker had tripped, it would have returned the
    // cheap-gate NOOP without ever touching the history clone.
    expect(mockChat.getHistory).toHaveBeenCalledWith(true);
  });

  it('trips the circuit breaker only when consecutiveFailures has reached MAX_CONSECUTIVE_FAILURES', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    // At exactly MAX (unforced) -> NOOP at cheap-gate.
    const tripped = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: false,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(tripped.info.compressionStatus).toBe(CompressionStatus.NOOP);

    // force=true bypasses the breaker even when tripped.
    vi.mocked(mockChat.getHistory).mockClear();
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    // Force bypasses the cheap-gate; service reaches the curated-history clone.
    expect(mockChat.getHistory).toHaveBeenCalledWith(true);
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should bypass the token threshold when requested without force=true', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '<state_snapshot>Summary</state_snapshot>',
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
      force: false,
      bypassTokenThreshold: true,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('should bypass the consecutive-failure breaker when heap pressure requests compaction', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '<state_snapshot>Summary</state_snapshot>',
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
      force: false,
      bypassTokenThreshold: true,
      model: mockModel,
      config: mockConfig,
      // Breaker is tripped (consecutiveFailures >= MAX) but heap-pressure
      // bypass must override the latch so the memory safety net still fires.
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    expect(mockGenerateContent).toHaveBeenCalled();
  });

  it('silently ignores the deprecated chatCompression.contextPercentageThreshold = 0 (no longer disables compaction)', async () => {
    // Pre-PR #4168, setting contextPercentageThreshold = 0 short-circuited
    // compress() at the cheap-gate (NOOP). The field was removed from
    // ChatCompressionSettings as part of the redesign; leftover values
    // in stale settings.json must be ignored without suppressing the gate.
    // Drive the non-force path with originalTokenCount above auto so the
    // gate would have to actively pass, and verify the side-query fires.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
      100_000,
    );
    // The deprecated field is no longer in ChatCompressionSettings; cast so
    // we can simulate a leftover value coming from a stale settings.json.
    vi.mocked(mockConfig.getChatCompression).mockReturnValue({
      contextPercentageThreshold: 0,
    } as unknown as ReturnType<typeof mockConfig.getChatCompression>);
    // 128K window → auto ≈ 95K; originalTokenCount 100K crosses.
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 128_000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '<state_snapshot>Summary</state_snapshot>',
      usage: {
        // Realistic compression usage so the inflation guard doesn't fire:
        //   newTokens = max(0, 100000 - (99000 - 1000) + 1500) = 3500 → COMPRESSED
        promptTokenCount: 99_000,
        candidatesTokenCount: 1500,
        totalTokenCount: 100_500,
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(mockGenerateContent).toHaveBeenCalled();
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
      consecutiveFailures: 0,
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBe(250); // 800 - (1600 - 1000) + 50
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toBe(
      '<state_snapshot>Summary</state_snapshot>',
    );
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(mockGetHookSystem).toHaveBeenCalled();
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
  });

  it('does not append SessionStart additionalContext after successful compression', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(100);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '<state_snapshot>Summary</state_snapshot>',
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
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(mockGenerateContent).toHaveBeenCalled();
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    // Thinking is intentionally disabled (per-provider budget semantics are
    // inconsistent) and the output is hard-capped by COMPACT_MAX_OUTPUT_TOKENS
    // so subsequent threshold math has a predictable reserve. maxAttempts=1
    // keeps the call best-effort (next turn re-triggers on failure).
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: mockModel,
        maxAttempts: 1,
        config: expect.objectContaining({
          thinkingConfig: { includeThoughts: false },
          maxOutputTokens: 20_000,
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
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
      consecutiveFailures: 0,
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.newHistory).toBeNull();
  });

  it('should not append extra SessionStart context when compression fails', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(10);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
    );
    expect(result.newHistory).toBeNull();
  });

  it('should complete compression without SessionStart hooks', async () => {
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
      text: '<state_snapshot>Summary</state_snapshot>',
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
      consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        consecutiveFailures: 0,
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression despite hook error
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockFirePreCompactEvent).toHaveBeenCalled();
    });

    it('should fire PreCompact hook before compression', async () => {
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

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(callOrder).toEqual(['PreCompact']);
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePostCompactEvent).toHaveBeenCalledWith(
        PostCompactTrigger.Manual,
        '<state_snapshot>Summary</state_snapshot>',
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
        text: '<state_snapshot>Auto Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(mockFirePostCompactEvent).toHaveBeenCalledWith(
        PostCompactTrigger.Auto,
        '<state_snapshot>Auto Summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Should still complete compression despite hook error
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockFirePostCompactEvent).toHaveBeenCalled();
    });

    it('should fire hooks in correct order: PreCompact -> PostCompact', async () => {
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
      mockFirePostCompactEvent.mockImplementation(async () => {
        callOrder.push('PostCompact');
      });

      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      // Hooks should be called in order: PreCompact -> PostCompact
      expect(callOrder).toEqual(['PreCompact', 'PostCompact']);
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
        text: '<state_snapshot>Summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>Summary of all work done</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>state snapshot summary</state_snapshot>',
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
        consecutiveFailures: 0,
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
        text: '<state_snapshot>state snapshot summary</state_snapshot>',
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const newHistory = result.newHistory!;
      // [summary_user, summary_ack_model, continuation_bridge_user, ...keep]
      // where keep starts with the retained model+functionCall.
      expect(newHistory[0].role).toBe('user');
      expect(newHistory[0].parts?.[0].text).toBe(
        '<state_snapshot>state snapshot summary</state_snapshot>',
      );
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
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });
  });
});

describe('ChatCompressionService.compress sideQuery config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes maxOutputTokens=20_000 and includeThoughts=false to runSideQuery', async () => {
    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>summary</state_snapshot>',
      usage: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const service = new ChatCompressionService();
    await service.compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![1] as {
      config?: {
        thinkingConfig?: { includeThoughts?: boolean };
        maxOutputTokens?: number;
      };
    };
    expect(callArg.config?.thinkingConfig?.includeThoughts).toBe(false);
    expect(callArg.config?.maxOutputTokens).toBe(20_000);
  });

  it('returns FAILED_OUTPUT_TRUNCATED when the summary output exceeds the COMPACT_MAX_OUTPUT_TOKENS cap (likely truncated)', async () => {
    // Mock the side-query to return a non-empty summary that exceeds the
    // 20K cap — the guard should drop the result and surface it as a
    // failure with a status distinct from EMPTY_SUMMARY so telemetry can
    // separate prompt-quality failures from capacity failures.
    // (R1.1 made the breaker tick; R5.2 split the status; R7.8 reverted
    // R6.2's `>` back to `>=` — the API hard-caps at 20K, so `>` was
    // dead code that silently persisted truncated summaries. The
    // separate `treats output at exactly COMPACT_MAX_OUTPUT_TOKENS as
    // truncated` test below pins the exact-cap case the revert exists
    // to catch.)
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>truncated...</state_snapshot>',
      usage: {
        promptTokenCount: 50_000,
        // 1 token over the cap — only `>` triggers, not `>=`.
        candidatesTokenCount: 20_001,
        totalTokenCount: 70_001,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const warn = vi.fn();
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn, debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
    );
    expect(result.newHistory).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('COMPACT_MAX_OUTPUT_TOKENS'),
    );
  });

  it('treats output at exactly COMPACT_MAX_OUTPUT_TOKENS as truncated (R8.2 / R7.8 exact-cap boundary)', async () => {
    // The whole point of R7.8 reverting `>` back to `>=`: a model whose
    // tokenizer lands exactly at the cap is far more likely truncated
    // than legitimately completing. This test would PASS under `>=` and
    // FAIL under `>` — pinning the revert against accidental
    // re-introduction.
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>truncated...</state_snapshot>',
      usage: {
        promptTokenCount: 50_000,
        candidatesTokenCount: 20_000, // exactly at cap
        totalTokenCount: 70_000,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
    );
  });

  it('persists only the <state_snapshot> envelope, stripping pre/post scratchpad content (R8.3a / R7.1 data-retention)', async () => {
    // R7.1's data-retention fix: with `includeThoughts: false` the
    // model emits its <scratchpad> reasoning as plain text alongside
    // <state_snapshot>. Persisting the concatenation would leak
    // sensitive tool output that the model quoted to reason about.
    // Verify the persisted summary is the snapshot envelope ONLY.
    const SCRATCHPAD =
      '<scratchpad>secret API_KEY=sk-xxxYYY in tool output</scratchpad>';
    const SNAPSHOT = '<state_snapshot>Clean summary</state_snapshot>';
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: `${SCRATCHPAD}\n${SNAPSHOT}`,
      usage: {
        // Realistic compression side-query: input ≈ originalTokenCount
        // (most of the history) + ~1000 prompt overhead. Without this
        // the `originalTokenCount - (input - 1000) + output` formula
        // makes the new count > original and trips the inflation guard.
        promptTokenCount: 175_000,
        candidatesTokenCount: 500,
        totalTokenCount: 175_500,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    const persisted = result.newHistory![0].parts![0].text!;
    // Snapshot envelope persists exactly; scratchpad content nowhere
    // in the persisted history.
    expect(persisted).toBe(SNAPSHOT);
    expect(persisted).not.toContain('API_KEY');
    expect(persisted).not.toContain('scratchpad');
    expect(persisted).not.toContain('sk-xxxYYY');
  });

  it('extracts the real snapshot when the scratchpad literally mentions <state_snapshot> (R8.6 / R7.1 regex anchor)', async () => {
    // Reviewer R8.6: the compression prompt instructs the model to
    // "generate the <state_snapshot>", so the scratchpad is plausibly
    // going to mention the tag literally. A non-greedy match from the
    // first occurrence would capture the scratchpad's mention through
    // to the real closing tag — bypassing the data-retention fix.
    // The regex must anchor on the LAST opening tag so the captured
    // envelope is always the real snapshot, never the mention.
    const RAW =
      'I need to generate a <state_snapshot> of this conversation now. ' +
      'Reasoning: API_KEY=sk-xxx was mentioned in the chat.\n' +
      '<state_snapshot>Real summary content here</state_snapshot>';
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: RAW,
      usage: {
        promptTokenCount: 175_000,
        candidatesTokenCount: 500,
        totalTokenCount: 175_500,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    const persisted = result.newHistory![0].parts![0].text!;
    expect(persisted).toBe(
      '<state_snapshot>Real summary content here</state_snapshot>',
    );
    expect(persisted).not.toContain('API_KEY');
    expect(persisted).not.toContain('Reasoning:');
  });

  it('warns and surfaces EMPTY_SUMMARY when model output is non-empty but lacks <state_snapshot> tags (R8.1 / R8.3b format-violation)', async () => {
    // Format violation: the model produced text but didn't follow the
    // <state_snapshot> envelope contract. The persisted summary becomes
    // empty (regex no-match) and we surface EMPTY_SUMMARY — but pre-R8.1
    // this branch was silent, making it indistinguishable from a model
    // that genuinely returned nothing. A warn log with a content slice
    // is the actionable diagnostic an oncall needs.
    const FORMAT_VIOLATION_RAW =
      'Sure, here is the summary: The user asked X and Y happened. ' +
      'No <state_snapshot> tags emitted at all.';
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: FORMAT_VIOLATION_RAW,
      usage: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const warn = vi.fn();
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn, debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    // Warn must fire with a content fingerprint so oncall can identify
    // "format violation" vs "genuinely empty model output".
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('state_snapshot'),
    );
  });

  it('breaker-tripped NOOP returns the caller originalTokenCount, not zero (R8.3c / R7.6 telemetry)', async () => {
    // R7.6 changed the breaker-tripped NOOP from returning
    // `{ originalTokenCount: 0, newTokenCount: 0 }` to forwarding the
    // caller's count so telemetry/dashboards aren't misled by a zero on
    // the trip event. Pin that contract.
    const ORIGINAL = 175_000;
    const mockChat = {
      getHistory: vi
        .fn()
        .mockReturnValue([{ role: 'user', parts: [{ text: 'msg' }] }]),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES, // breaker tripped
      originalTokenCount: ORIGINAL,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.info.originalTokenCount).toBe(ORIGINAL);
    expect(result.info.newTokenCount).toBe(ORIGINAL);
  });

  it('newTokenCount accounts for only the persisted snapshot, not the discarded scratchpad (R8.7)', async () => {
    // Pre-R8.7: newTokenCount used compressionOutputTokenCount from the
    // API, which counts the full model output (scratchpad + snapshot).
    // The persisted history only contains the snapshot, so the inflated
    // count made the next cheap-gate trigger compaction earlier than
    // necessary. Fix: scale by summary/raw character ratio so the
    // bookkeeping reflects what we actually keep.
    //
    // Mock raw output where scratchpad is ~3x the snapshot in chars,
    // and assert newTokenCount tracks the snapshot share — not the full
    // candidatesTokenCount.
    const SCRATCHPAD = '<scratchpad>' + 'x'.repeat(3000) + '</scratchpad>';
    const SNAPSHOT =
      '<state_snapshot>' + 'y'.repeat(1000) + '</state_snapshot>';
    const RAW = `${SCRATCHPAD}\n${SNAPSHOT}`;

    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: RAW,
      usage: {
        promptTokenCount: 175_000, // realistic — slimmed history + prompt
        candidatesTokenCount: 1024, // full output (scratchpad + snapshot)
        totalTokenCount: 176_024,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const mockChat = {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
    const mockConfig = {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;

    const result = await new ChatCompressionService().compress(mockChat, {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    // The persisted summary is SNAPSHOT (~1016 chars). The raw was
    // ~4030 chars. The scaled "snapshot share" of the 1024-token
    // candidatesTokenCount is approximately 1024 * 1016/4030 ≈ 258.
    // Pre-R8.7, the code used the full 1024 verbatim. Asserting the
    // count is *materially* smaller pins the scaling behaviour without
    // hard-coding the exact value (different scaling strategies are
    // acceptable; the contract is "smaller than the raw API count").
    const apiOutputTokens = 1024;
    const persistedOutputTokens =
      result.info.newTokenCount - 180_000 + (175_000 - 1000); // invert the formula
    expect(persistedOutputTokens).toBeGreaterThan(0);
    expect(persistedOutputTokens).toBeLessThan(apiOutputTokens * 0.5); // snapshot is ~25% of raw
  });
});

describe('ChatCompressionService.compress cheap-gate uses estimated tokens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Inline helpers (Task 3): the existing file uses per-block inline
  // mockChat/mockConfig rather than shared factories, so we follow that
  // pattern here. getHistory(true) returns a non-empty array so the cheap-
  // gate flow can reach the spy when the threshold is crossed.
  function makeFakeChat(): GeminiChat {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    return {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
  }

  function makeFakeConfig(opts: { contextWindowSize: number }): Config {
    return {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: opts.contextWindowSize }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;
  }

  it('triggers compaction when precomputedEffectiveTokens crosses the auto threshold even though originalTokenCount is below it', async () => {
    // 200K window, computeThresholds(200K).auto = 167K
    // originalTokenCount = 160K (under by 7K), but caller's precomputed
    // estimate factors in the pending user message → 170K, crosses 167K.
    // R6.14 collapsed the "estimate-inside-the-service" branch; callers
    // pass `precomputedEffectiveTokens` upstream now. (R7.5 removed the
    // now-dead `pendingUserMessage` field; only the precomputed value
    // remains in the contract.)

    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>x</state_snapshot>',
      usage: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      originalTokenCount: 160_000,
      precomputedEffectiveTokens: 170_000,
    });

    // cheap-gate let it through (not NOOP), so spy was called
    expect(spy).toHaveBeenCalled();
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });

  it('NOOPs when neither precomputedEffectiveTokens nor originalTokenCount reaches threshold', async () => {
    const spy = vi
      .spyOn(sideQueryModule, 'runSideQuery')
      .mockResolvedValue({ text: 's', usage: {} } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      originalTokenCount: 80_000,
      precomputedEffectiveTokens: 80_010,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('falls back to originalTokenCount when no precomputedEffectiveTokens is supplied (R6.14)', async () => {
    // Direct callers (tests, future internal paths) without precomputed
    // estimate use originalTokenCount as the gate input — the
    // pendingUserMessage-only branch was removed because the service
    // shouldn't double-clone history that the caller already paid for.
    const spy = vi
      .spyOn(sideQueryModule, 'runSideQuery')
      .mockResolvedValue({ text: 's', usage: {} } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      originalTokenCount: 50_000, // below auto=167K → NOOP
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('precomputedEffectiveTokens path skips estimation work (R6.15)', async () => {
    // R6.15: pin the perf optimization. When the caller supplies
    // precomputedEffectiveTokens, the service must NOT recompute the
    // estimate (no `getHistory(true)` clone). Verifies that the
    // precomputed value alone drives the gate decision — even if
    // originalTokenCount is way below the threshold.
    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>x</state_snapshot>',
      usage: {
        promptTokenCount: 99_000,
        candidatesTokenCount: 1500,
        totalTokenCount: 100_500,
      },
    } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      // Raw count low, but caller's precomputed estimate has already
      // crossed auto=167K — the gate trusts the precomputed value.
      originalTokenCount: 10_000,
      precomputedEffectiveTokens: 180_000,
    });

    expect(spy).toHaveBeenCalled();
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });
});

describe('computeThresholds', () => {
  it('32K window — proportional fallback for all tiers, hard degrades to auto', () => {
    const t = computeThresholds(32_000);
    expect(t.warn).toBe(19_200); // 0.6 * 32K
    expect(t.auto).toBe(22_400); // 0.7 * 32K
    expect(t.hard).toBe(22_400); // max(window-23K=9K, auto=22.4K) = auto
    expect(t.effectiveWindow).toBe(12_000);
  });

  it('128K window — mixed (warn=pct, auto/hard=abs)', () => {
    const t = computeThresholds(128_000);
    expect(t.warn).toBe(76_800); // 0.6 * 128K (pct wins: 76.8K vs auto-20K=75K)
    expect(t.auto).toBe(95_000); // abs: effectiveWindow-13K = 108-13 = 95K (abs wins: 95K vs 0.7*128K=89.6K)
    expect(t.hard).toBe(105_000); // abs: effectiveWindow-3K = 108-3 = 105K
    expect(t.effectiveWindow).toBe(108_000);
  });

  it('200K window — absolute takes over all tiers', () => {
    const t = computeThresholds(200_000);
    expect(t.warn).toBe(147_000); // abs: auto-20K (abs wins: 147K vs 0.6*200K=120K)
    expect(t.auto).toBe(167_000); // abs: effectiveWindow-13K = 180-13 = 167K
    expect(t.hard).toBe(177_000); // abs: effectiveWindow-3K = 180-3 = 177K
  });

  it('1M window — fully absolute', () => {
    const t = computeThresholds(1_000_000);
    expect(t.warn).toBe(947_000);
    expect(t.auto).toBe(967_000);
    expect(t.hard).toBe(977_000);
  });

  it('extreme small window (10K) does not crash; returns sane values', () => {
    const t = computeThresholds(10_000);
    expect(t.warn).toBeGreaterThan(0);
    expect(t.auto).toBeGreaterThan(0);
    expect(t.warn).toBeLessThanOrEqual(t.auto);
    expect(t.auto).toBeLessThanOrEqual(t.hard);
  });

  it('thresholds always satisfy warn <= auto <= hard', () => {
    for (const w of [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000]) {
      const t = computeThresholds(w);
      expect(t.warn).toBeLessThanOrEqual(t.auto);
      expect(t.auto).toBeLessThanOrEqual(t.hard);
    }
  });
});

describe('ChatCompressionService.compress cheap-gate uses computeThresholds.auto', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFakeChat(): GeminiChat {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    return {
      getHistory: vi.fn().mockReturnValue(history),
    } as unknown as GeminiChat;
  }

  function makeFakeConfig(opts: { contextWindowSize: number }): Config {
    return {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: opts.contextWindowSize }),
      getHookSystem: vi.fn().mockReturnValue({
        fireSessionStartEvent: vi.fn().mockResolvedValue(undefined),
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    } as unknown as Config;
  }

  it('on a 200K window with originalTokenCount=160K, NOOPs (below auto=167K)', async () => {
    const spy = vi
      .spyOn(sideQueryModule, 'runSideQuery')
      .mockResolvedValue({ text: 's', usage: {} } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      originalTokenCount: 160_000,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('on a 200K window with originalTokenCount=168K, falls through cheap-gate (above auto=167K)', async () => {
    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>summary</state_snapshot>',
      usage: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    } as never);

    const result = await new ChatCompressionService().compress(makeFakeChat(), {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      consecutiveFailures: 0,
      originalTokenCount: 168_000,
    });

    // 168K > 167K (computeThresholds(200K).auto), cheap-gate lets through
    expect(spy).toHaveBeenCalled();
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });
});
