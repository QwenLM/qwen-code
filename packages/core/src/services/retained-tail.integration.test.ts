/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { LlmChat } from '../core/llm-chat.js';
import { getStartupContextLength } from '../core/environmentContext.js';
import { buildApiHistoryFromConversation } from './session-api-history.js';
import {
  ChatRecordingService,
  type ChatCompressionRecordPayload,
  type ChatRecord,
} from './chatRecordingService.js';
import { deleteTranscriptMessageGroups } from '../utils/message-group-deletion.js';
import { CompressionStatus } from '../core/turn.js';
import { AuthType } from '../core/contentGenerator.js';
import { estimateContentTokens } from './tokenEstimation.js';
import { ChatCompressionService } from './chatCompressionService.js';
import type { CompressOptions } from './chatCompressionService.js';
import * as sideQuery from '../utils/sideQuery.js';
import * as attachments from './postCompactAttachments.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '../utils/api-history-metadata.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

vi.mock('../telemetry/loggers.js');

const summary = '<state_snapshot>Earlier work is summarized.</state_snapshot>';
const older = () => {
  const first = userText('Inspect the project.');
  const latest = userText('Now fix the failing test.');
  markApiHistoryPrompt(first, 'first-prompt');
  markApiHistoryPrompt(latest, 'latest-prompt');
  return [
    first,
    modelText(
      'The project uses TypeScript. ' + 'Older task details. '.repeat(1000),
    ),
    latest,
  ];
};

function setup(history: Content[], planMode = false) {
  const summarize = vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
    text: summary,
    usage: {
      promptTokenCount: 100_000,
      candidatesTokenCount: 100,
      totalTokenCount: 100_100,
    },
  });
  const chat = {
    getHistoryShallow: () => history,
  } as unknown as LlmChat;
  const config = {
    getChatCompression: () => undefined,
    getAutoCompactThreshold: () => undefined,
    getContentGeneratorConfig: () => ({ contextWindowSize: 200_000 }),
    getHookSystem: () => undefined,
    getBaseLlmClient: () => undefined,
    getModel: () => 'test-model',
    getAllConfiguredModels: () => [],
    getApprovalMode: () =>
      planMode ? ApprovalMode.PLAN : ApprovalMode.DEFAULT,
    getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    getTargetDir: () => '/tmp/retained-tail-test-workspace',
  } as unknown as Config;
  const compress = (options: Partial<CompressOptions> = {}) =>
    new ChatCompressionService().compress(chat, {
      promptId: 'retained-tail-test',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 180_000,
      ...options,
    });
  return { summarize, compress, config, chat };
}

function toolGroup(resultText = 'Test fails at assertion 42.'): Content[] {
  return [
    content(
      'model',
      { text: 'I will inspect both failures.', thoughtSignature: 'signature' },
      fnCall('run_shell_command', { command: 'npm test' }, 'test-call'),
      fnCall('read_file', { path: 'src/test.ts' }, 'read-call'),
    ),
    content(
      'user',
      fnResponse('run_shell_command', { output: resultText }, 'test-call'),
      fnResponse(
        'read_file',
        { output: 'expect(result).toBe(42)' },
        'read-call',
      ),
    ),
  ];
}

describe('retained latest operation through compression', () => {
  afterEach(() => vi.restoreAllMocks());

  it('summarizes only older history and retains the complete multi-tool group verbatim', async () => {
    const prefix = older();
    const tail = toolGroup();
    const original = [...prefix, ...tail];
    const before = JSON.stringify(original);
    const { summarize, compress } = setup(original);

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory?.slice(-2)).toEqual(tail);
    expect(result.info.summaryPrefixLength).toBe(3);
    expect(result.newHistory?.at(-2)).toBe(tail[0]);
    expect(result.newHistory?.at(-1)).toBe(tail[1]);
    const input = summarize.mock.calls[0][1].contents;
    expect(JSON.stringify(input)).toContain('The project uses TypeScript.');
    expect(JSON.stringify(input)).not.toContain('test-call');
    expect(JSON.stringify(input)).not.toContain('Test fails at assertion 42.');
    expect(JSON.stringify(original)).toBe(before);
    expect(result.newHistory?.map((entry) => entry.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
    ]);
  });

  it('keeps the real operation outside startup context after a JSON checkpoint roundtrip', async () => {
    const tail = toolGroup();
    const { compress } = setup([...older(), ...tail]);
    const result = await compress();
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(
      getStartupContextLength(result.newHistory!, { includeCompressed: true }),
    ).toBe(3);
    const checkpoint: ChatRecord = {
      uuid: 'retained-tail-checkpoint',
      parentUuid: null,
      sessionId: 'session',
      timestamp: '2026-11-13T00:00:00Z',
      cwd: '/tmp',
      version: 'test',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: {
        compressedHistory: result.newHistory!,
        contextPrefixLength: getStartupContextLength(result.newHistory!, {
          includeCompressed: true,
        }),
        summaryPrefixLength: result.info.summaryPrefixLength,
        promptIds: result.newHistory!.map(
          (entry) => getApiHistoryPromptId(entry) ?? null,
        ),
        info: result.info,
      },
    };
    const restored = buildApiHistoryFromConversation({
      messages: [JSON.parse(JSON.stringify(checkpoint))],
    });
    expect(getStartupContextLength(restored, { includeCompressed: true })).toBe(
      3,
    );
    expect(restored.slice(3)).toEqual(tail);
    expect(restored).toEqual(result.newHistory);
  });

  it.each(['text', 'tool'] as const)(
    'deletes the retained %s operation from a recorded checkpoint',
    async (operation) => {
      for (const hasPendingPrompt of [false, true]) {
        const tail =
          operation === 'tool' ? toolGroup() : [modelText('Raw latest reply.')];
        if (tail[1]) markApiHistoryPrompt(tail[1], 'latest-prompt');
        const history = [...older(), ...tail];
        const envelope = {
          sessionId: 'retained-tail-session',
          timestamp: '2026-11-13T00:00:00Z',
          cwd: '/tmp',
          version: 'test',
        };
        const records: ChatRecord[] = history.map((message, index) => ({
          ...envelope,
          uuid: String(index),
          parentUuid: index ? String(index - 1) : null,
          type:
            message.role === 'model'
              ? 'assistant'
              : message.parts?.some((part) => part.functionResponse)
                ? 'tool_result'
                : 'user',
          message,
          promptId: getApiHistoryPromptId(message),
        }));
        const pending = userText('Next task.');
        markApiHistoryPrompt(pending, 'next-prompt');
        const { compress } = setup(history);
        const result = await compress({
          pendingUserMessage: hasPendingPrompt ? pending : undefined,
        });
        expect(result.info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
        expect(result.newHistory?.slice(3)).toEqual(tail);
        expect(getApiHistoryPromptId(result.newHistory![3])).toBe(
          'latest-prompt',
        );
        const compressedHistory = [
          ...result.newHistory!,
          ...(hasPendingPrompt ? [pending] : []),
        ];
        if (hasPendingPrompt) {
          records.push({
            ...envelope,
            uuid: 'next-user',
            parentUuid: records.at(-1)!.uuid,
            type: 'user',
            message: pending,
            promptId: 'next-prompt',
          });
        }
        const recorder = {
          activeBranchRecords: records,
          createBaseRecord: () => ({
            ...envelope,
            uuid: 'compressed',
            parentUuid: records.at(-1)!.uuid,
            type: 'system',
          }),
          appendRecord: (record: ChatRecord) =>
            records.push(JSON.parse(JSON.stringify(record)) as ChatRecord),
        } as unknown as ChatRecordingService;
        ChatRecordingService.prototype.recordChatCompression.call(recorder, {
          info: result.info,
          compressedHistory,
          summaryPrefixLength: result.info.summaryPrefixLength,
        });
        const { records: kept } = deleteTranscriptMessageGroups(
          records,
          ['2'],
          { ...envelope, uuid: 'deleted', parentUuid: null, type: 'system' },
        );
        const payload = kept.find((record) => record.uuid === 'compressed')!
          .systemPayload as ChatCompressionRecordPayload;
        expect(payload.compressedHistory).toEqual(
          JSON.parse(
            JSON.stringify([
              ...compressedHistory.slice(0, 3),
              ...(hasPendingPrompt ? [pending] : []),
            ]),
          ),
        );
        const restored = buildApiHistoryFromConversation({ messages: kept });
        expect(JSON.stringify(restored)).toBe(
          JSON.stringify(payload.compressedHistory),
        );
        expect(
          getStartupContextLength(restored, { includeCompressed: true }),
        ).toBe(3);
        expect(getApiHistoryPromptId(restored.at(-1)!)).toBe(
          hasPendingPrompt ? 'next-prompt' : undefined,
        );
        expect(kept.some((record) => record.uuid === '3')).toBe(false);
      }
    },
  );

  it('resolves the latest owner before curation coalesces adjacent prompts', async () => {
    const history = older();
    const latest = userText('Newer request after an unanswered prompt.');
    markApiHistoryPrompt(latest, 'newer-prompt');
    history.push(latest, modelText('Latest answer.'));
    const { config } = setup(history);
    const result = await new ChatCompressionService().compress(
      new LlmChat(config, {}, history),
      {
        promptId: 'compress',
        force: true,
        config,
        consecutiveFailures: 0,
        originalTokenCount: 180_000,
      },
    );
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(getApiHistoryPromptId(result.newHistory![3])).toBe('newer-prompt');
  });

  it('keeps ownership through another compaction within a restored tool turn', async () => {
    const { compress } = setup([...older(), ...toolGroup()]);
    const first = await compress();
    const checkpoint: ChatRecord = {
      uuid: 'compressed',
      parentUuid: null,
      sessionId: 'session',
      timestamp: '2026-11-13T00:00:00Z',
      cwd: '/tmp',
      version: 'test',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: {
        info: first.info,
        compressedHistory: first.newHistory!,
        promptIds: first.newHistory!.map(
          (entry) => getApiHistoryPromptId(entry) ?? null,
        ),
        summaryPrefixLength: first.info.summaryPrefixLength,
      },
    };
    const restored = buildApiHistoryFromConversation({
      messages: [JSON.parse(JSON.stringify(checkpoint))],
    });
    restored.push(modelText('The latest tool round is complete.'));
    const second = await setup(restored).compress();
    expect(second.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(second.newHistory?.at(-1)?.parts?.[0]?.text).toBe(
      'The latest tool round is complete.',
    );
    expect(getApiHistoryPromptId(second.newHistory![3])).toBe('latest-prompt');
  });

  it('does not assign an unanswered prompt to an earlier curated response', async () => {
    const history = [...older(), modelText('Earlier answer.')];
    const unanswered = userText('Unanswered request.');
    markApiHistoryPrompt(unanswered, 'unanswered-prompt');
    history.push(unanswered, { role: 'model', parts: [] });
    const { config, summarize } = setup(history);
    const result = await new ChatCompressionService().compress(
      new LlmChat(config, {}, history),
      {
        promptId: 'compress',
        force: true,
        config,
        consecutiveFailures: 0,
        originalTokenCount: 180_000,
      },
    );
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'Earlier answer.',
    );
    expect(
      result.newHistory?.some((entry) => getApiHistoryPromptId(entry)),
    ).toBe(false);
  });

  it('falls back to full compression when the retained operation has no owner', async () => {
    const history = [
      userText('Earlier request.'),
      modelText('Earlier answer.'),
      userText('Latest request without an identity.'),
      modelText('Latest answer.'),
    ];
    const { compress, summarize } = setup(history);
    const result = await compress();
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'Latest answer.',
    );
    expect(result.info.summaryPrefixLength).toBe(result.newHistory!.length);
  });

  it('uses pending tool results to validate the group without replaying them twice', async () => {
    const [calls, pending] = toolGroup();
    const { summarize, compress } = setup([...older(), calls]);

    const result = await compress({
      trigger: 'auto',
      pendingUserMessage: pending,
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory?.at(-1)).toBe(calls);
    expect(result.info.summaryPrefixLength).toBe(3);
    expect(result.newHistory?.some((entry) => entry === pending)).toBe(false);
    expect(
      result.newHistory
        ?.flatMap((entry) => entry.parts ?? [])
        .some((part) => part.functionResponse),
    ).toBe(false);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).not.toContain(
      'test-call',
    );
    expect([...result.newHistory!, pending].map((entry) => entry.role)).toEqual(
      ['user', 'model', 'user', 'model', 'user'],
    );
  });

  it('retains a latest text response and following user input without summarizing either', async () => {
    const tail = [
      modelText('The fix is ready for review.'),
      userText('Also cover null.'),
    ];
    const { summarize, compress } = setup([...older(), ...tail]);

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory?.slice(-2)).toEqual(tail);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).not.toContain(
      'Also cover null.',
    );
  });

  it('falls back to full compression when there is no older completed response', async () => {
    const tail = toolGroup();
    const { summarize, compress } = setup([userText('Fix the test.'), ...tail]);

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'test-call',
    );
    expect(result.newHistory?.includes(tail[0])).toBe(false);
  });

  it('does not retain an incomplete manual tool operation', async () => {
    const [calls] = toolGroup();
    const { compress } = setup([...older(), calls]);

    const result = await compress({ trigger: 'manual' });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(
      result.newHistory
        ?.flatMap((entry) => entry.parts ?? [])
        .some((part) => part.functionCall),
    ).toBe(false);
  });

  it('falls back to full compression for an oversized latest operation', async () => {
    const tail = toolGroup('oversized result '.repeat(30_000));
    const { summarize, compress } = setup([...older(), ...tail]);

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'test-call',
    );
    expect(result.newHistory?.includes(tail[0])).toBe(false);
    expect(result.newHistory?.includes(tail[1])).toBe(false);
  });

  it('does not restore a rejected raw tail during payload-overflow recovery', async () => {
    const tail = toolGroup();
    const { summarize, compress } = setup([...older(), ...tail]);

    const result = await compress({
      requestPayloadTooLarge: true,
      trigger: 'auto',
    });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'test-call',
    );
    expect(result.newHistory?.includes(tail[0])).toBe(false);
  });

  it('uses the small-window tail budget rather than the fixed 20k ceiling', async () => {
    const tail = toolGroup('x'.repeat(18_000));
    const { summarize, compress, config } = setup([...older(), ...tail]);
    vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
      contextWindowSize: 16_000,
    } as ReturnType<Config['getContentGeneratorConfig']>);

    const result = await compress({ originalTokenCount: 14_000 });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'test-call',
    );
    expect(result.newHistory?.includes(tail[0])).toBe(false);
  });

  it('does not retain raw screenshots when image overflow triggers compression', async () => {
    const tail = toolGroup();
    tail[1].parts![0].functionResponse!.parts = [
      { inlineData: { mimeType: 'image/png', data: 'c2NyZWVuc2hvdA==' } },
    ];
    const { summarize, compress, config } = setup([...older(), ...tail]);
    vi.spyOn(config, 'getChatCompression').mockReturnValue({
      enableScreenshotTrigger: true,
      screenshotTriggerThreshold: 1,
    } as ReturnType<Config['getChatCompression']>);

    const result = await compress({ force: false, originalTokenCount: 50_000 });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.triggerReason).toBe('image_overflow');
    expect(JSON.stringify(summarize.mock.calls[0][1].contents)).toContain(
      'test-call',
    );
    expect(result.newHistory?.includes(tail[0])).toBe(false);
  });

  it('accounts for the retained tail once when usage is missing', async () => {
    const tail = toolGroup();
    const history = [...older(), ...tail];
    const { summarize, compress } = setup(history);
    summarize.mockResolvedValue({ text: summary });

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory?.slice(-2)).toEqual(tail);
    expect(result.info.newTokenCount).toBe(
      180_000 -
        estimateContentTokens(history) +
        estimateContentTokens(result.newHistory!),
    );
  });

  it.each([true, false])(
    'adds previously unaccounted output once with provider usage: %s',
    async (hasUsage) => {
      const tail = [
        modelText('latest output '.repeat(1000)),
        userText('Continue.'),
      ];
      const { summarize, compress } = setup([...older(), ...tail]);
      if (!hasUsage) summarize.mockResolvedValue({ text: summary });
      const baseline = await compress();
      const result = await compress({ unaccountedOutputTokens: 3000 });
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.newHistory?.slice(-2)).toEqual(tail);
      expect(result.info.newTokenCount).toBe(
        baseline.info.newTokenCount + 3000,
      );
    },
  );

  it.each([true, false])(
    'compares inflation with prompt plus retained output, usage=%s',
    async (hasUsage) => {
      const prefix = older();
      const latest = modelText('Latest useful answer. '.repeat(1000));
      const originalTokenCount = estimateContentTokens(prefix) + 1000;
      const unaccountedOutputTokens = estimateContentTokens([latest]);
      const before = originalTokenCount + unaccountedOutputTokens;
      const { compress, summarize } = setup([...prefix, latest]);
      summarize.mockImplementation(async (_config, options) => ({
        text: summary,
        ...(hasUsage
          ? {
              usage: {
                promptTokenCount:
                  estimateContentTokens(options.contents as Content[]) + 1000,
                candidatesTokenCount: 100,
              },
            }
          : {}),
      }));
      const result = await compress({
        originalTokenCount,
        unaccountedOutputTokens,
      });
      expect(result.newHistory?.at(-1)).toBe(latest);
      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.info.originalTokenCount).toBe(before);
      expect(result.info.newTokenCount).toBeGreaterThan(originalTokenCount);
      expect(result.info.newTokenCount).toBeLessThan(before);

      summarize.mockResolvedValue({
        text: `<state_snapshot>${'x'.repeat(40_000)}</state_snapshot>`,
        ...(hasUsage
          ? {
              usage: { promptTokenCount: 1000, candidatesTokenCount: 10_000 },
            }
          : {}),
      });
      const inflated = await compress({
        originalTokenCount,
        unaccountedOutputTokens,
      });
      expect(inflated.info.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
      );
      expect(inflated.info.newTokenCount).toBeGreaterThan(before);
    },
  );

  it('uses the same earlier-only history on the cache-sharing path', async () => {
    const tail = toolGroup();
    const history = [...older(), ...tail];
    const { summarize, compress, config, chat } = setup(history);
    const generateText = vi.fn().mockResolvedValue({ text: summary });
    vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
      contextWindowSize: 200_000,
      authType: AuthType.USE_GEMINI,
    } as ReturnType<Config['getContentGeneratorConfig']>);
    vi.spyOn(config, 'getBaseLlmClient').mockReturnValue({
      generateText,
    } as never);
    Object.assign(chat, {
      getLastPromptTokenCount: () => 100_000,
      getLastOutputTokenCount: () => 100,
      getGenerationConfig: () => ({ systemInstruction: 'Main system' }),
    });

    const result = await compress({ originalTokenCount: 100_000 });

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(summarize).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(generateText.mock.calls[0][0].contents),
    ).not.toContain('test-call');
    expect(result.newHistory?.slice(-2)).toEqual(tail);
    expect(result.info.newTokenCount).toBe(
      100_000 -
        estimateContentTokens(history) +
        estimateContentTokens(result.newHistory!),
    );
  });

  it('retains the tail and plan-mode reminder when restoration assembly fails', async () => {
    const tail = toolGroup();
    const { compress } = setup([...older(), ...tail], true);
    vi.spyOn(attachments, 'composePostCompactHistory').mockRejectedValue(
      new Error('simulated restoration failure'),
    );

    const result = await compress();

    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.newHistory?.slice(-2)).toEqual(tail);
    expect(JSON.stringify(result.newHistory?.slice(0, 3))).toContain(
      '<plan-mode-active>',
    );
    expect(result.newHistory?.map((entry) => entry.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
    ]);
  });
});
