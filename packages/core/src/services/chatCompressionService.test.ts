/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatCompressionService,
  findCompressSplitPoint,
  extractContentText,
  isCompressedMessage,
  COMPRESSED_CONTEXT_PREFIX,
  INCREMENTAL_PROTECTED_TAIL,
  INCREMENTAL_MAX_CHUNK_SIZE,
} from './chatCompressionService.js';
import type { Content, GenerateContentResponse } from '@google/genai';
import { CompressionStatus } from '../core/turn.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { tokenLimit } from '../core/tokenLimits.js';
import type { GeminiChat } from '../core/geminiChat.js';
import type { Config } from '../config/config.js';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { SessionStartSource, PreCompactTrigger } from '../hooks/types.js';

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

  it('should return earlier splitpoint if no valid ones are after threshhold', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the first message.' }] },
      { role: 'model', parts: [{ text: 'This is the second message.' }] },
      { role: 'user', parts: [{ text: 'This is the third message.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'foo', args: {} } }] },
    ];
    // Can't return 4 because the previous item has a function call.
    expect(findCompressSplitPoint(history, 0.99)).toBe(2);
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
      getContentGenerator: vi.fn(),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getHookSystem: mockGetHookSystem,
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({
        warn: vi.fn(),
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
    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    expect(result.newHistory).toBeNull();
  });

  it('should return NOOP if previously failed and not forced', async () => {
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      true,
    );
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

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );
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
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info).toMatchObject({
      compressionStatus: CompressionStatus.NOOP,
      originalTokenCount: 0,
      newTokenCount: 0,
    });
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(tokenLimit).not.toHaveBeenCalled();

    const forcedResult = await service.compress(
      mockChat,
      mockPromptId,
      true,
      mockModel,
      mockConfig,
      false,
    );
    expect(forcedResult.info).toMatchObject({
      compressionStatus: CompressionStatus.NOOP,
      originalTokenCount: 0,
      newTokenCount: 0,
    });
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(tokenLimit).not.toHaveBeenCalled();
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
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBe(250); // 800 - (1600 - 1000) + 50
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toBe(
      '[COMPRESSED_CONTEXT]\nSummary',
    );
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
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1100,
        candidatesTokenCount: 50,
        totalTokenCount: 1150,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      true, // forced
      mockModel,
      mockConfig,
      false,
    );

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

  it('should return FAILED if new token count is inflated', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'msg1' }] },
      { role: 'model', parts: [{ text: 'msg2' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(10);
    vi.mocked(tokenLimit).mockReturnValue(1000);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 20,
        totalTokenCount: 21,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      true,
      mockModel,
      mockConfig,
      false,
    );

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
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      // No usageMetadata -> keep original token count
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

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
      candidates: [
        {
          content: {
            parts: [{ text: '' }], // Empty summary
          },
        },
      ],
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      true,
      mockModel,
      mockConfig,
      false,
    );

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
      candidates: [
        {
          content: {
            parts: [{ text: '   \n\t  ' }], // Only whitespace
          },
        },
      ],
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      true,
      mockModel,
      mockConfig,
      false,
    );

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
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 20,
        totalTokenCount: 21,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      true,
      mockModel,
      mockConfig,
      false,
    );

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
      candidates: [
        {
          content: {
            parts: [{ text: 'Summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    // Should still complete compression despite hook error
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
  });

  describe('PreCompact hook', () => {
    let mockFirePreCompactEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFirePreCompactEvent = vi.fn().mockResolvedValue(undefined);
      mockGetHookSystem.mockReturnValue({
        fireSessionStartEvent: mockFireSessionStartEvent,
        firePreCompactEvent: mockFirePreCompactEvent,
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
        candidates: [
          {
            content: {
              parts: [{ text: 'Summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1100,
          candidatesTokenCount: 50,
          totalTokenCount: 1150,
        },
      } as unknown as GenerateContentResponse);
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
        generateContent: mockGenerateContent,
      } as unknown as ContentGenerator);

      await service.compress(
        mockChat,
        mockPromptId,
        true, // force = true -> Manual trigger
        mockModel,
        mockConfig,
        false,
      );

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
        candidates: [
          {
            content: {
              parts: [{ text: 'Summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      } as unknown as GenerateContentResponse);
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
        generateContent: mockGenerateContent,
      } as unknown as ContentGenerator);

      await service.compress(
        mockChat,
        mockPromptId,
        false, // force = false -> Auto trigger
        mockModel,
        mockConfig,
        false,
      );

      expect(mockFirePreCompactEvent).toHaveBeenCalledWith(
        PreCompactTrigger.Auto,
        '',
        undefined,
      );
    });

    it('should not fire PreCompact hook when history is empty', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([]);

      const result = await service.compress(
        mockChat,
        mockPromptId,
        true,
        mockModel,
        mockConfig,
        false,
      );

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

      const result = await service.compress(
        mockChat,
        mockPromptId,
        true,
        mockModel,
        mockConfig,
        false,
      );

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

      const result = await service.compress(
        mockChat,
        mockPromptId,
        false,
        mockModel,
        mockConfig,
        false,
      );

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
        candidates: [
          {
            content: {
              parts: [{ text: 'Summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      } as unknown as GenerateContentResponse);
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
        generateContent: mockGenerateContent,
      } as unknown as ContentGenerator);

      const result = await service.compress(
        mockChat,
        mockPromptId,
        false,
        mockModel,
        mockConfig,
        false,
      );

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
        candidates: [
          {
            content: {
              parts: [{ text: 'Summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      } as unknown as GenerateContentResponse);
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
        generateContent: mockGenerateContent,
      } as unknown as ContentGenerator);

      await service.compress(
        mockChat,
        mockPromptId,
        false,
        mockModel,
        mockConfig,
        false,
      );

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
        candidates: [
          {
            content: {
              parts: [{ text: 'Summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      } as unknown as GenerateContentResponse);
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
        generateContent: mockGenerateContent,
      } as unknown as ContentGenerator);

      const result = await service.compress(
        mockChat,
        mockPromptId,
        false,
        mockModel,
        mockConfig,
        false,
      );

      // Should still complete compression without hook
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory).not.toBeNull();
      // mockFirePreCompactEvent should not be called since hookSystem is null
      expect(mockFirePreCompactEvent).not.toHaveBeenCalled();
    });
  });
});

describe('extractContentText', () => {
  it('should return text from a Content with text parts', () => {
    const content: Content = {
      role: 'user',
      parts: [{ text: 'hello' }, { text: ' world' }],
    };
    expect(extractContentText(content)).toBe('hello world');
  });

  it('should return null for Content with no parts', () => {
    const content: Content = { role: 'user', parts: [] };
    expect(extractContentText(content)).toBeNull();
  });

  it('should return null for Content with undefined parts', () => {
    const content: Content = { role: 'user' };
    expect(extractContentText(content)).toBeNull();
  });

  it('should return null for Content with only non-text parts', () => {
    const content: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'foo', args: {} } }],
    };
    expect(extractContentText(content)).toBeNull();
  });

  it('should concatenate only text parts, ignoring non-text parts', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { text: 'first' },
        { functionCall: { name: 'foo', args: {} } },
        { text: 'second' },
      ],
    };
    expect(extractContentText(content)).toBe('firstsecond');
  });
});

describe('isCompressedMessage', () => {
  it('should return true for messages starting with COMPRESSED_CONTEXT_PREFIX', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {
          text: `${COMPRESSED_CONTEXT_PREFIX}\n<chunk_summary>...</chunk_summary>`,
        },
      ],
    };
    expect(isCompressedMessage(content)).toBe(true);
  });

  it('should return false for normal messages', () => {
    const content: Content = {
      role: 'user',
      parts: [{ text: 'Hello, please help me with something.' }],
    };
    expect(isCompressedMessage(content)).toBe(false);
  });

  it('should return false for messages with no text', () => {
    const content: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'foo', args: {} } }],
    };
    expect(isCompressedMessage(content)).toBe(false);
  });

  it('should return false for empty content', () => {
    const content: Content = { role: 'user', parts: [] };
    expect(isCompressedMessage(content)).toBe(false);
  });
});

describe('Incremental Compression', () => {
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
      firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
    });
    mockConfig = {
      getChatCompression: vi.fn(),
      getContentGenerator: vi.fn(),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getHookSystem: mockGetHookSystem,
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({
        warn: vi.fn(),
      }),
    } as unknown as Config;

    vi.mocked(tokenLimit).mockReturnValue(1000);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a history array with alternating user/model messages.
   */
  function buildHistory(count: number): Content[] {
    const history: Content[] = [];
    for (let i = 0; i < count; i++) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'model',
        parts: [{ text: `Message ${i + 1}` }],
      });
    }
    return history;
  }

  it('should use incremental compression when history exceeds protected tail + 2', async () => {
    // Need > INCREMENTAL_PROTECTED_TAIL + 2 messages for incremental path
    const historySize = INCREMENTAL_PROTECTED_TAIL + 10;
    const history = buildHistory(historySize);
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                text: `${COMPRESSED_CONTEXT_PREFIX}\n<chunk_summary>Compressed</chunk_summary>`,
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();

    // The first message should be the compressed summary
    expect(result.newHistory![0].parts![0].text).toContain(
      COMPRESSED_CONTEXT_PREFIX,
    );
    // The second message should be the model acknowledgment
    expect(result.newHistory![1].parts![0].text).toBe(
      'Understood. Incremental context loaded.',
    );

    // Protected tail messages should still be intact at the end
    const tail = result.newHistory!.slice(-INCREMENTAL_PROTECTED_TAIL);
    expect(tail.length).toBe(INCREMENTAL_PROTECTED_TAIL);
    // The last message in the tail should be the last message from original history
    expect(tail[tail.length - 1].parts![0].text).toBe(`Message ${historySize}`);
  });

  it('should fall back to full compression for short histories', async () => {
    // Only 4 messages — below the incremental threshold
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
      candidates: [
        {
          content: {
            parts: [{ text: 'Full compression summary' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    // Full compression adds COMPRESSED_CONTEXT_PREFIX
    expect(result.newHistory![0].parts![0].text).toContain(
      COMPRESSED_CONTEXT_PREFIX,
    );
    // Full compression uses "Got it" ack
    expect(result.newHistory![1].parts![0].text).toBe(
      'Got it. Thanks for the additional context!',
    );
  });

  it('should skip already-compressed messages at the start', async () => {
    const historySize = INCREMENTAL_PROTECTED_TAIL + 10;
    // First two messages are already compressed
    const history: Content[] = [
      {
        role: 'user',
        parts: [{ text: `${COMPRESSED_CONTEXT_PREFIX}\nPrevious summary` }],
      },
      {
        role: 'model',
        parts: [{ text: 'Understood. Incremental context loaded.' }],
      },
      ...buildHistory(historySize - 2),
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: `${COMPRESSED_CONTEXT_PREFIX}\nNew chunk summary` },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1200,
        candidatesTokenCount: 40,
        totalTokenCount: 1240,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();

    // The first message should still be the original compressed summary
    expect(result.newHistory![0].parts![0].text).toContain('Previous summary');
    // The model ack for the first compressed message should be preserved
    // (it's not compressed, so it gets included in the chunk to compress)
    // Actually, index 1 (the model ack) is not a compressed message, so it starts the chunk.
    // But the chunk starts at index 1 (after the compressed user message at index 0).
    // Wait -- isCompressedMessage checks the first message. The model ack at index 1
    // does NOT start with [COMPRESSED_CONTEXT], so chunkStart=1.
    // The new summary replaces messages starting at index 1.
    // So: [original compressed user msg] + [new summary] + [new ack] + [remaining + tail]
    expect(result.newHistory![1].parts![0].text).toContain('New chunk summary');
  });

  it('should handle incremental compression returning empty summary gracefully', async () => {
    const historySize = INCREMENTAL_PROTECTED_TAIL + 10;
    const history = buildHistory(historySize);
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    // First call (incremental) returns empty, second call (full fallback) returns content
    const mockGenerateContent = vi
      .fn()
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [{ text: '' }], // Empty summary for incremental
            },
          },
        ],
      } as unknown as GenerateContentResponse)
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              parts: [{ text: 'Full fallback summary' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1600,
          candidatesTokenCount: 50,
          totalTokenCount: 1650,
        },
      } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    // Should fall back to full compression after incremental fails
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].parts![0].text).toContain(
      'Full fallback summary',
    );
  });

  it('should limit chunk size to INCREMENTAL_MAX_CHUNK_SIZE', async () => {
    // Create a very large history
    const historySize =
      INCREMENTAL_PROTECTED_TAIL + INCREMENTAL_MAX_CHUNK_SIZE + 20;
    const history = buildHistory(historySize);
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: `${COMPRESSED_CONTEXT_PREFIX}\nChunk summary` }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);

    // Verify the model was called with only INCREMENTAL_MAX_CHUNK_SIZE messages
    // (plus the instruction message appended)
    const callArgs = mockGenerateContent.mock.calls[0][0];
    // The contents should be chunk messages + 1 instruction message
    expect(callArgs.contents.length).toBe(INCREMENTAL_MAX_CHUNK_SIZE + 1);

    // Verify the result still has uncompressed messages after the summary
    // New history: [summary] + [ack] + [remaining uncompressed] + [protected tail]
    const expectedRemaining = historySize - INCREMENTAL_MAX_CHUNK_SIZE;
    // +2 for summary + ack
    expect(result.newHistory!.length).toBe(expectedRemaining + 2);
  });

  it('should add prefix when model does not include it', async () => {
    const historySize = INCREMENTAL_PROTECTED_TAIL + 10;
    const history = buildHistory(historySize);
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 1000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    // Model returns summary WITHOUT the prefix
    const mockGenerateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: '<chunk_summary>No prefix</chunk_summary>' }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 1600,
        candidatesTokenCount: 50,
        totalTokenCount: 1650,
      },
    } as unknown as GenerateContentResponse);
    vi.mocked(mockConfig.getContentGenerator).mockReturnValue({
      generateContent: mockGenerateContent,
    } as unknown as ContentGenerator);

    const result = await service.compress(
      mockChat,
      mockPromptId,
      false,
      mockModel,
      mockConfig,
      false,
    );

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    // The prefix should be prepended
    const summaryText = result.newHistory![0].parts![0].text!;
    expect(summaryText.startsWith(COMPRESSED_CONTEXT_PREFIX)).toBe(true);
    expect(summaryText).toContain('No prefix');
  });
});
