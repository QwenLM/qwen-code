/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompressionService,
  COMPACT_MAX_OUTPUT_TOKENS,
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
      getHistoryShallow: vi.fn((curated?: boolean) =>
        mockChat.getHistory(curated),
      ),
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
    // Seed a non-zero originalTokenCount so we can assert the breaker-NOOP
    // path forwards it (rather than zeroing the field — see R4-1). Telemetry
    // consumers rely on this to distinguish "breaker tripped at N tokens"
    // from "empty session".
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
      120_000,
    );
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
    expect(result.info.originalTokenCount).toBe(120_000);
    expect(result.info.newTokenCount).toBe(120_000);
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
      text: 'Summary',
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBe(250); // 800 - (1600 - 1000) + 50
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toBe('Summary');
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(mockGetHookSystem).toHaveBeenCalled();
  });

  it('does not deep-clone full history while compressing', async () => {
    const largeToolOutput = 'x'.repeat(1024 * 1024);
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'review this PR' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'read-1',
              name: 'read_file',
              args: { path: 'large.ts' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'read-1',
              name: 'read_file',
              response: { output: largeToolOutput },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'analysis' }] },
    ];
    vi.mocked(mockChat.getHistory).mockImplementation(() => {
      throw new Error('getHistory should not be called by compression');
    });
    vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);

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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(mockChat.getHistory).not.toHaveBeenCalled();
    expect(mockChat.getHistoryShallow).toHaveBeenCalledWith(true);
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
      consecutiveFailures: 0,
      originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
    );
    expect(result.newHistory).toBeNull();
  });

  it('should use estimated token count if usage metadata is missing', async () => {
    const largeMessage = 'x'.repeat(4_000);
    const history: Content[] = [
      { role: 'user', parts: [{ text: largeMessage }] },
      { role: 'model', parts: [{ text: largeMessage }] },
      { role: 'user', parts: [{ text: largeMessage }] },
      { role: 'model', parts: [{ text: largeMessage }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
      5_000,
    );
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 6_000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'Summary',
      // Some OpenAI-compatible providers (for example MiniMax-2.7) may omit
      // usage on the compression side-query even when they return a summary.
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

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.originalTokenCount).toBe(5_000);
    expect(result.info.newTokenCount).toBeGreaterThan(1_000);
    expect(result.info.newTokenCount).toBeLessThan(5_000);
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toBe('Summary');
  });

  it('should reject cap-sized summaries even if usage metadata is missing', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(
      180_000,
    );
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 200_000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const warn = vi.fn();
    (
      mockConfig as unknown as {
        getDebugLogger: () => {
          warn: typeof warn;
          debug: ReturnType<typeof vi.fn>;
        };
      }
    ).getDebugLogger = () => ({
      warn,
      debug: vi.fn(),
    });
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'x'.repeat(COMPACT_MAX_OUTPUT_TOKENS * 4),
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
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
    );
    expect(result.newHistory).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('local estimate'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('COMPACT_MAX_OUTPUT_TOKENS'),
    );
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
        consecutiveFailures: 0,
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
        consecutiveFailures: 0,
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

    // Shared fixture for the two trailing-in-flight-funcCall scenarios below:
    // both auto-compress (force=false) and hard-rescue (force=true,
    // trigger='auto') see the same history snapshot — a tool loop where the
    // last message is a model funcCall whose matching funcResponse is about
    // to arrive in the pending userContent (not in history yet). The only
    // thing that differs between the two tests is the `compress(...)` call
    // options and the per-test assertions.
    const setupInFlightFuncCallFixture = () => {
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
        // Trailing funcCall: matching funcResponse is in the pending
        // userContent, not in history yet — active, not orphaned.
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

      return { history, mockGenerateContent };
    };

    it('compresses-most without orphaning when last entry is in-flight funcCall (auto-compress)', async () => {
      // Auto-compress fires BEFORE the matching funcResponse is sent back to
      // the model. The trailing funcCall must be retained (its response is
      // coming); the in-flight fallback compresses everything safely before
      // it. Pre-refactor this returned NOOP, leaving the chat to grow until
      // it 400'd.
      const { mockGenerateContent } = setupInFlightFuncCallFixture();

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

    it('preserves trailing model+funcCall under hard-rescue (force=true + trigger=auto)', async () => {
      // Hard-rescue fires from inside sendMessageStream() BEFORE the pending
      // userContent (a funcResponse) is pushed onto history. At that moment
      // the trailing model+funcCall is ACTIVE, not orphaned — its matching
      // funcResponse is sitting in the pending message about to be appended.
      //
      // Pre-fix, the service's orphan-strip predicate gated on `force` alone,
      // which meant hard-rescue (force=true, trigger='auto') was conflated
      // with manual /compress and stripped the active funcCall — corrupting
      // tool-call/response pairing on the next API send. Fix: gate the strip
      // on `trigger === 'manual'` so only the explicit user-initiated
      // /compress path performs the orphan cleanup.
      setupInFlightFuncCallFixture();

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: true,
        trigger: 'auto', // hard-rescue explicitly signals automatic intent
        model: mockModel,
        config: mockConfig,
        consecutiveFailures: 0,
        originalTokenCount: uiTelemetryService.getLastPromptTokenCount(),
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      // The active funcCall must survive in the post-compression history so
      // the about-to-be-pushed funcResponse has its matching tool_use.
      const newHistory = result.newHistory!;
      const last = newHistory[newHistory.length - 1];
      expect(last.role).toBe('model');
      expect(last.parts?.some((p) => p.functionCall)).toBe(true);
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
    const getHistoryMock = vi.fn().mockReturnValue(history);
    const mockChat = {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
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

  it('returns FAILED_OUTPUT_TRUNCATED when the summary output hits the COMPACT_MAX_OUTPUT_TOKENS cap (likely truncated)', async () => {
    // Mock the side-query to return a non-empty summary that exactly hits the
    // 20K cap — the guard should drop the result and surface it as a failure
    // with a status distinct from EMPTY_SUMMARY so telemetry can separate
    // prompt-quality failures (empty) from capacity failures (truncated).
    // (R1.1 made the breaker tick; R5.2 split the status.)
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>truncated...',
      usage: {
        promptTokenCount: 50_000,
        candidatesTokenCount: 20_000, // ← exactly at COMPACT_MAX_OUTPUT_TOKENS
        totalTokenCount: 70_000,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
      { role: 'user', parts: [{ text: 'msg3' }] },
      { role: 'model', parts: [{ text: 'msg4' }] },
    ];
    const getHistoryMock = vi.fn().mockReturnValue(history);
    const mockChat = {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
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
    const getHistoryMock = vi.fn().mockReturnValue(history);
    return {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
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

  it('triggers compaction when API-reported tokens are below threshold but estimated tokens with the pending user message exceed it', async () => {
    // 200K window, computeThresholds(200K).auto = 167K
    // originalTokenCount = 160K (under by 7K)
    // user message ~ 10K tokens (40K chars / 4) -> effectiveTokens = 170K, crosses 167K
    const userMessage: Content = {
      role: 'user',
      parts: [{ text: 'x'.repeat(40_000) }],
    };

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
      pendingUserMessage: userMessage,
    });

    // cheap-gate let it through (not NOOP), so spy was called
    expect(spy).toHaveBeenCalled();
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });

  it('NOOPs when neither originalTokenCount nor estimated total reaches threshold', async () => {
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
      pendingUserMessage: {
        role: 'user',
        parts: [{ text: 'short' }],
      },
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
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
    // window < SUMMARY_RESERVE: effectiveWindow is clamped to 0, not negative.
    // auto/warn/hard remain positive because each is `Math.max(proportional, absolute)`
    // and the proportional branch dominates whenever the absolute branch goes ≤ 0.
    expect(t.effectiveWindow).toBe(0);
  });

  it('zero window returns effectiveWindow=0 and non-negative tiers', () => {
    const t = computeThresholds(0);
    expect(t.effectiveWindow).toBe(0);
    expect(t.warn).toBe(0);
    expect(t.auto).toBe(0);
    expect(t.hard).toBe(0);
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
    const getHistoryMock = vi.fn().mockReturnValue(history);
    return {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
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
