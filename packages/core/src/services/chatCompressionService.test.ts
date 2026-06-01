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
  MAX_CONSECUTIVE_FAILURES,
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
import * as postCompactModule from './postCompactAttachments.js';

vi.mock('../telemetry/uiTelemetry.js');
vi.mock('../core/tokenLimits.js');
vi.mock('../telemetry/loggers.js');

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
      getTargetDir: () => '/tmp/test-workspace',
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

  describe('screenshot-overflow trigger', () => {
    const SCREENSHOT_ENV = [
      'QWEN_COMPACT_SCREENSHOT_TRIGGER',
      'QWEN_COMPACT_SCREENSHOT_THRESHOLD',
      'QWEN_COMPACT_MAX_RECENT_FILES',
      'QWEN_COMPACT_MAX_RECENT_IMAGES',
    ];
    beforeEach(() => {
      for (const k of SCREENSHOT_ENV) delete process.env[k];
    });
    afterEach(() => {
      for (const k of SCREENSHOT_ENV) delete process.env[k];
    });

    // 4-entry history whose single tool result nests `imageCount`
    // screenshots inside functionResponse.parts (the real shape from
    // coreToolScheduler.convertToFunctionResponse).
    function historyWithToolImages(imageCount: number): Content[] {
      const imageParts = Array.from({ length: imageCount }, (_, i) => ({
        inlineData: { mimeType: 'image/png', data: `shot${i}` },
      }));
      return [
        { role: 'user', parts: [{ text: 'take screenshots' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'computer_use__get_app_state',
                args: { app: 'Safari' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'computer_use__get_app_state',
                response: { output: '' },
                parts: imageParts,
              } as unknown as NonNullable<
                Content['parts']
              >[number]['functionResponse'],
            },
          ],
        },
        { role: 'model', parts: [{ text: 'captured' }] },
      ];
    }

    function mockSummarySideQuery() {
      const generateText = vi.fn().mockResolvedValue({
        text: 'Summary',
        usage: {
          promptTokenCount: 49_000,
          candidatesTokenCount: 1_500,
          totalTokenCount: 50_500,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText,
      } as unknown as BaseLlmClient);
      return generateText;
    }

    function setWindow128k() {
      // 128K window → auto ≈ 95K. originalTokenCount 50K is below auto, so
      // the token gate alone would NOOP; only the screenshot trigger can
      // force compression in these tests.
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'gemini-pro',
        contextWindowSize: 128_000,
      } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);
    }

    it('fires compaction when tool-image count reaches the threshold, even below the token threshold', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue(historyWithToolImages(3));
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        enableScreenshotTrigger: true,
        screenshotTriggerThreshold: 3,
      } as ReturnType<typeof mockConfig.getChatCompression>);
      setWindow128k();
      const generateText = mockSummarySideQuery();

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        consecutiveFailures: 0,
        originalTokenCount: 50_000,
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(generateText).toHaveBeenCalled();
      // Screenshot trigger → reason must be image_overflow (not token_limit)
      // so the UI notice is accurate when it fired below the token threshold.
      expect(result.info.triggerReason).toBe('image_overflow');
    });

    it('does NOT fire when the trigger is disabled (NOOP below token threshold despite many images)', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue(historyWithToolImages(20));
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        enableScreenshotTrigger: false,
        screenshotTriggerThreshold: 3,
      } as ReturnType<typeof mockConfig.getChatCompression>);
      setWindow128k();
      const generateText = mockSummarySideQuery();

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        consecutiveFailures: 0,
        originalTokenCount: 50_000,
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(generateText).not.toHaveBeenCalled();
    });

    it('does NOT fire when tool-image count is below the threshold', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue(historyWithToolImages(2));
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        enableScreenshotTrigger: true,
        screenshotTriggerThreshold: 50,
      } as ReturnType<typeof mockConfig.getChatCompression>);
      setWindow128k();
      const generateText = mockSummarySideQuery();

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        consecutiveFailures: 0,
        originalTokenCount: 50_000,
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
      expect(generateText).not.toHaveBeenCalled();
    });

    it('reads threshold + enable flag from QWEN_COMPACT_* env over settings', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue(historyWithToolImages(4));
      // Settings would NOT trigger (threshold 50); env lowers it to 4 and
      // force-enables, so the env values must win.
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        enableScreenshotTrigger: false,
        screenshotTriggerThreshold: 50,
      } as ReturnType<typeof mockConfig.getChatCompression>);
      process.env['QWEN_COMPACT_SCREENSHOT_TRIGGER'] = 'true';
      process.env['QWEN_COMPACT_SCREENSHOT_THRESHOLD'] = '4';
      setWindow128k();
      const generateText = mockSummarySideQuery();

      const result = await service.compress(mockChat, {
        promptId: mockPromptId,
        force: false,
        model: mockModel,
        config: mockConfig,
        consecutiveFailures: 0,
        originalTokenCount: 50_000,
      });

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(generateText).toHaveBeenCalled();
      // Screenshot trigger → reason must be image_overflow (not token_limit)
      // so the UI notice is accurate when it fired below the token threshold.
      expect(result.info.triggerReason).toBe('image_overflow');
    });
  });

  it('treats an all-<analysis> summary as empty (no [Summary unavailable] silent success)', async () => {
    // The side-query returns ONLY an <analysis> block (no <state_snapshot>).
    // Raw body is non-empty but it strips to nothing. isSummaryEmpty must
    // check the STRIPPED summary so this takes the FAILED_EMPTY path instead
    // of "succeeding" with `[Summary unavailable]` as the agent's only context.
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'do the thing' }] },
      { role: 'model', parts: [{ text: 'working' }] },
      { role: 'user', parts: [{ text: 'continue' }] },
      { role: 'model', parts: [{ text: 'more' }] },
    ]);
    const generateText = vi.fn().mockResolvedValue({
      text: '<analysis>thinking, but I never produced a state_snapshot</analysis>',
      usage: {
        promptTokenCount: 49_000,
        candidatesTokenCount: 200,
        totalTokenCount: 49_200,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 100_000,
    });

    expect(result.info.compressionStatus).toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(result.newHistory).toBeNull();
  });

  it('manual /compress strips a trailing orphaned functionCall from the post-compact history', async () => {
    // History ends with model+functionCall and NO functionResponse (an
    // interrupted tool call). On manual /compress there is no pending
    // response, so preserving it would emit model[fc] then the next user
    // text turn → API 400. The post-compact history must not end with it.
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'read the file' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: '/x.ts' } } },
        ],
      },
    ]);
    const generateText = vi.fn().mockResolvedValue({
      text: '<state_snapshot><primary_request_and_intent>read</primary_request_and_intent></state_snapshot>',
      usage: {
        promptTokenCount: 49_000,
        candidatesTokenCount: 1_500,
        totalTokenCount: 50_500,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText,
    } as unknown as BaseLlmClient);

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true, // → compactTrigger 'manual'
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 100_000,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    const last = result.newHistory![result.newHistory!.length - 1];
    const lastIsOrphanFc =
      last.role === 'model' && (last.parts ?? []).some((p) => !!p.functionCall);
    expect(lastIsOrphanFc).toBe(false);
  });

  it('degrades to summary+ack (folding trailing fc) when composePostCompactHistory throws', async () => {
    // A restoration-assembly throw must NOT escape to sendMessageStream
    // (which would crash the turn AND bypass the COMPRESSION_FAILED breaker).
    // It degrades to a valid post-compact history; an auto-compaction trailing
    // functionCall is folded into the ack so a pending functionResponse keeps
    // its match (and the trailing turn's text is dropped, per the composer).
    vi.mocked(mockChat.getHistory).mockReturnValue([
      { role: 'user', parts: [{ text: 'go' }] },
      { role: 'model', parts: [{ text: 'thinking' }] },
      { role: 'user', parts: [{ text: 'go on' }] },
      {
        role: 'model',
        parts: [
          { text: 'let me read it' },
          { functionCall: { name: 'read_file', args: { file_path: '/x.ts' } } },
        ],
      },
    ]);
    const generateText = vi.fn().mockResolvedValue({
      text: '<state_snapshot><primary_request_and_intent>x</primary_request_and_intent></state_snapshot>',
      usage: {
        promptTokenCount: 49_000,
        candidatesTokenCount: 1_500,
        totalTokenCount: 50_500,
      },
    });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
      generateText,
    } as unknown as BaseLlmClient);
    const composeSpy = vi
      .spyOn(postCompactModule, 'composePostCompactHistory')
      .mockRejectedValue(new Error('EACCES: simulated disk failure'));

    const result = await service.compress(mockChat, {
      promptId: mockPromptId,
      force: true,
      trigger: 'auto', // keep the trailing fc (manual would strip it)
      model: mockModel,
      config: mockConfig,
      consecutiveFailures: 0,
      originalTokenCount: 100_000,
    });

    expect(composeSpy).toHaveBeenCalled();
    // Degraded success — not an escape, not a compression failure.
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    const last = result.newHistory![result.newHistory!.length - 1];
    expect(last.role).toBe('model');
    expect(last.parts?.some((p) => p.text)).toBe(true); // ack text
    expect(last.parts?.some((p) => !!p.functionCall)).toBe(true); // folded fc
    const ackText = (last.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join(' ');
    expect(ackText).not.toContain('let me read it'); // trailing text dropped
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
    // Crossed the token threshold (not the screenshot trigger) → token_limit.
    expect(result.info.triggerReason).toBe('token_limit');
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
    // postProcessSummary appends the resume trailer to the summary body,
    // so it's "Summary\n\n<trailer>" rather than a strict equality.
    expect(result.newHistory![0].parts![0].text).toContain('Summary');
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

  it('should reject inflated local delta if usage metadata is missing', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'short user message' }] },
      { role: 'model', parts: [{ text: 'short model response' }] },
      { role: 'user', parts: [{ text: 'another short user message' }] },
      { role: 'model', parts: [{ text: 'another short model response' }] },
    ];
    vi.mocked(mockChat.getHistory).mockReturnValue(history);
    vi.mocked(uiTelemetryService.getLastPromptTokenCount).mockReturnValue(800);
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      model: 'gemini-pro',
      contextWindowSize: 6_000,
    } as unknown as ReturnType<typeof mockConfig.getContentGeneratorConfig>);

    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: 'x'.repeat(40_000),
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
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
    );
    expect(result.info.originalTokenCount).toBe(800);
    expect(result.info.newTokenCount).toBeGreaterThan(800);
    expect(result.newHistory).toBeNull();
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
      getTargetDir: () => '/tmp/test-workspace',
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
      getTargetDir: () => '/tmp/test-workspace',
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
      getTargetDir: () => '/tmp/test-workspace',
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

describe('ChatCompressionService.compress — claude-code-style full-history compression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFakeChat(history: Content[]): GeminiChat {
    const getHistoryMock = vi.fn().mockReturnValue(history);
    return {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
    } as unknown as GeminiChat;
  }

  function makeFakeConfig(): Config {
    return {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
      getTargetDir: () => '/tmp/test-workspace',
    } as unknown as Config;
  }

  it('sends the ENTIRE history to the summary side-query (no split)', async () => {
    const runSideQuerySpy = vi
      .spyOn(sideQueryModule, 'runSideQuery')
      .mockResolvedValue({
        text: 'TEST SUMMARY',
        usage: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        },
      } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'first request' }] },
      { role: 'model', parts: [{ text: 'first reply' }] },
      { role: 'user', parts: [{ text: 'second request' }] },
      { role: 'model', parts: [{ text: 'second reply' }] },
    ];

    const service = new ChatCompressionService();
    await service.compress(makeFakeChat(history), {
      promptId: 'p',
      force: true,
      model: 'qwen-vl',
      config: makeFakeConfig(),
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
      trigger: 'manual',
    });

    const calledWith = runSideQuerySpy.mock.calls[0]![1] as {
      contents: Array<{ parts: Array<{ text?: string }> }>;
    };
    // Full 4 history entries + 1 trailing scratchpad prompt = 5 contents.
    expect(calledWith.contents).toHaveLength(5);
    expect(calledWith.contents[0].parts[0].text).toContain('first request');
  });

  it('produces newHistory composed via composePostCompactHistory', async () => {
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: 'SUM_TXT',
      usage: {
        // newTokenCount = 180_000 - (170_000 - 1000) + 500 = 11_500 <= 180_000
        promptTokenCount: 170_000,
        candidatesTokenCount: 500,
        totalTokenCount: 170_500,
      },
    } as never);

    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'how are you' }] },
      { role: 'model', parts: [{ text: 'fine' }] },
    ];

    const service = new ChatCompressionService();
    const result = await service.compress(makeFakeChat(history), {
      promptId: 'p',
      force: true,
      model: 'qwen-vl',
      config: makeFakeConfig(),
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
      trigger: 'manual',
    });

    expect(result.newHistory).not.toBeNull();
    expect(result.newHistory![0].role).toBe('user');
    const firstPart = result.newHistory![0].parts?.[0] as { text?: string };
    expect(firstPart.text).toContain('SUM_TXT');
    expect(result.newHistory![1].role).toBe('model');
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
      getTargetDir: () => '/tmp/test-workspace',
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

describe('ChatCompressionService.compress — single-turn computer-use regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFakeChat(history: Content[]): GeminiChat {
    const getHistoryMock = vi.fn().mockReturnValue(history);
    return {
      getHistory: getHistoryMock,
      getHistoryShallow: getHistoryMock,
    } as unknown as GeminiChat;
  }

  function makeFakeConfig(): Config {
    return {
      getChatCompression: vi.fn(),
      getBaseLlmClient: vi.fn(),
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ contextWindowSize: 200_000 }),
      getHookSystem: vi.fn().mockReturnValue({
        firePreCompactEvent: vi.fn().mockResolvedValue(undefined),
        firePostCompactEvent: vi.fn().mockResolvedValue(undefined),
      }),
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
      getTargetDir: () => '/tmp/test-workspace',
    } as unknown as Config;
  }

  it('preserves the user prompt verbatim in summary and restores 3 most recent screenshots', async () => {
    // Reproduces the "single-turn long task" scenario the rewrite targets:
    // ONE user message kicks off many tool calls. OLD behavior with the
    // split-point model: 0 entries preserved verbatim when compression
    // fires after a tool result (the common case). NEW behavior: summary
    // contains the user prompt verbatim (via 9-section prompt template's
    // "All user messages" section) + 3 most recent screenshots attached
    // as the image restoration block.
    // Real shape: the screenshot is nested inside functionResponse.parts,
    // exactly as coreToolScheduler.convertToFunctionResponse emits it — NOT
    // a top-level sibling. (The earlier sibling shape masked the bug where
    // extractRecentImages restored zero screenshots.)
    const screenshot = (data: string): Content => ({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'computer_use__get_app_state',
            response: { output: 'ok' },
            parts: [{ inlineData: { mimeType: 'image/png', data } }],
          } as unknown as NonNullable<
            Content['parts']
          >[number]['functionResponse'],
        },
      ],
    });
    const callScreenshot = (app: string): Content => ({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'computer_use__get_app_state',
            args: { app },
          },
        },
      ],
    });

    const history: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'open Safari and read the first headline' }],
      },
      callScreenshot('Safari'),
      screenshot('s1'),
      callScreenshot('Safari'),
      screenshot('s2'),
      callScreenshot('Safari'),
      screenshot('s3'),
      callScreenshot('Safari'),
      screenshot('s4'),
      callScreenshot('Safari'),
      screenshot('s5'),
    ];

    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: 'SUMMARY containing "open Safari and read the first headline" verbatim',
      usage: {
        promptTokenCount: 170_000,
        candidatesTokenCount: 500,
        totalTokenCount: 170_500,
      },
    } as never);

    const service = new ChatCompressionService();
    const result = await service.compress(makeFakeChat(history), {
      promptId: 'p',
      force: true,
      model: 'qwen-vl',
      config: makeFakeConfig(),
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
      trigger: 'manual',
    });

    expect(result.newHistory).not.toBeNull();
    const flat = result.newHistory!;
    const flatText = flat
      .flatMap((c) => c.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n');

    // Assertion 1: summary text (mocked) carries the user prompt verbatim.
    expect(flatText).toContain('open Safari and read the first headline');

    // Assertion 2: Image restoration block exists and contains exactly s3, s4, s5
    // (the 3 most recent screenshots), in chronological order.
    const inlineDataParts = flat.flatMap((c) =>
      (c.parts ?? []).filter((p) =>
        (
          p as { inlineData?: { mimeType?: string } }
        ).inlineData?.mimeType?.startsWith('image/'),
      ),
    );
    expect(
      inlineDataParts.map(
        (p) => (p as { inlineData: { data: string } }).inlineData.data,
      ),
    ).toEqual(['s3', 's4', 's5']);

    // Assertion 3: Image metadata header mentions the source tool and args.
    expect(flatText).toContain('computer_use__get_app_state');
    expect(flatText).toContain('"app":"Safari"');
  });
});
