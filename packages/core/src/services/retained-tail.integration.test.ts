/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { LlmChat } from '../core/llm-chat.js';
import { getStartupContextLength } from '../core/environmentContext.js';
import { buildApiHistoryFromConversation } from './session-api-history.js';
import type { ChatRecord } from './chatRecordingService.js';
import { CompressionStatus } from '../core/turn.js';
import { AuthType } from '../core/contentGenerator.js';
import { estimateContentTokens } from './tokenEstimation.js';
import { ChatCompressionService } from './chatCompressionService.js';
import type { CompressOptions } from './chatCompressionService.js';
import * as sideQuery from '../utils/sideQuery.js';
import * as attachments from './postCompactAttachments.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

vi.mock('../telemetry/loggers.js');

const summary = '<state_snapshot>Earlier work is summarized.</state_snapshot>';
const older = () => [
  userText('Inspect the project.'),
  modelText(
    'The project uses TypeScript. ' + 'Older task details. '.repeat(1000),
  ),
  userText('Now fix the failing test.'),
];

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
