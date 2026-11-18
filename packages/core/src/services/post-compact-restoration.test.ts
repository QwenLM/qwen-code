/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { LlmChat } from '../core/llm-chat.js';
import { CompressionStatus } from '../core/turn.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';
import {
  ChatCompressionService,
  computeThresholds,
  HARD_BUFFER,
} from './chatCompressionService.js';
import { ApprovalMode } from '../config/config.js';
import { buildFileRestorationBlocks } from './postCompactAttachments.js';
import * as tokenEstimation from './tokenEstimation.js';
import * as postCompactAttachments from './postCompactAttachments.js';
import * as sideQuery from '../utils/sideQuery.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '../utils/api-history-metadata.js';
import { RETAINED_COMPACTION_TAIL_REMINDER } from '../core/environmentContext.js';
import {
  getAutoMemorySnapshot,
  withoutAutoMemorySnapshots,
} from '../memory/request-context.js';

vi.mock('../telemetry/loggers.js');

let fixture: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

it('issue #15487: a successful 16K compaction must fit after restoring recent files', async () => {
  fixture = mkdtempSync(join(tmpdir(), 'qwen-15487-'));
  const history: Content[] = [
    userText('Earlier conversation '.repeat(1800)),
    modelText('Understood.'),
  ];
  for (let index = 0; index < 5; index++) {
    const file = join(fixture, `file-${index}.txt`);
    writeFileSync(file, `${index}`.repeat(8000));
    history.push(
      content(
        'model',
        fnCall('read_file', { file_path: file, limit: 1 }, `read-${index}`),
      ),
      content(
        'user',
        fnResponse(
          'read_file',
          { output: `First line of file ${index}` },
          `read-${index}`,
        ),
      ),
      modelText(`Read file ${index}.`),
    );
  }
  vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    usage: {
      promptTokenCount: 13_000,
      candidatesTokenCount: 100,
      totalTokenCount: 13_100,
    },
  } as never);
  const config = {
    getChatCompression: () => undefined,
    getAutoCompactThreshold: () => undefined,
    getBaseLlmClient: vi.fn(),
    getContentGeneratorConfig: () => ({ contextWindowSize: 16_000 }),
    getHookSystem: () => undefined,
    getModel: () => 'test-model',
    getAllConfiguredModels: () => [],
    getApprovalMode: () => 'default',
    getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    getTargetDir: () => fixture,
  } as unknown as Config;
  const chat = { getHistoryShallow: () => history } as unknown as LlmChat;
  const result = await new ChatCompressionService().compress(chat, {
    promptId: 'issue-15487',
    force: true,
    config,
    consecutiveFailures: 0,
    originalTokenCount: 18_000,
  });
  expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  expect(result.info.newTokenCount).toBeLessThan(16_000 - HARD_BUFFER);
  expect(
    tokenEstimation.estimateContentTokens(result.newHistory!),
  ).toBeLessThan(16_000 - HARD_BUFFER);
  const restored = historyText(result.newHistory);
  for (let index = 0; index < 5; index++) {
    expect(restored).toContain(join(fixture, `file-${index}.txt`));
    expect(restored.includes(`${index}`.repeat(8000))).toBe(index >= 3);
  }
});

function restorationFixture(
  window: number,
  fileCount = 5,
  fileChars = 8000,
  fileCharacter?: string,
) {
  fixture = mkdtempSync(join(tmpdir(), 'qwen-restoration-'));
  const history: Content[] = [
    userText('Earlier conversation '.repeat(1800)),
    modelText('Understood.'),
  ];
  const files = Array.from({ length: fileCount }, (_, index) => {
    const path = join(fixture!, `file-${index}.txt`);
    const body = `file-content-${index}:`.padEnd(
      fileChars,
      fileCharacter ?? String(index),
    );
    writeFileSync(path, body);
    history.push(
      content(
        'model',
        fnCall('read_file', { file_path: path }, `read-${index}`),
      ),
      content(
        'user',
        fnResponse('read_file', { output: 'First line' }, `read-${index}`),
      ),
      modelText(`Read file ${index}.`),
    );
    return { path, body };
  });
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const config = {
    getChatCompression: () => undefined,
    getAutoCompactThreshold: () => undefined,
    getBaseLlmClient: vi.fn(),
    getContentGeneratorConfig: () => ({ contextWindowSize: window }),
    getHookSystem: () => undefined,
    getModel: () => 'test-model',
    getModelRouteIdentity: () => 'main-route',
    getAllConfiguredModels: () => [],
    getApprovalMode: () => ApprovalMode.DEFAULT,
    getDebugLogger: () => logger,
    getTargetDir: () => fixture,
  } as unknown as Config;
  const chat = { getHistoryShallow: () => history } as unknown as LlmChat;
  return { history, files, config, chat, logger };
}

function historyText(history: Content[] | null) {
  return (history ?? [])
    .flatMap((entry) => entry.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n');
}

it.each([
  [16_000, 2, 5, 8000],
  [32_000, 4, 5, 8000],
  [128_000, 5, 5, 8000],
  [128_000, 6, 8, 20_000],
  [200_000, 8, 8, 20_000],
  [200_000, 5, 5, 8000],
  [1_000_000, 10, 12, 20_000],
])(
  'bounds restored file contents for a %i-token window',
  async (window, embedded, fileCount, fileChars) => {
    const { files, config, chat } = restorationFixture(
      window,
      fileCount,
      fileChars,
    );
    vi.spyOn(config, 'getChatCompression').mockReturnValue({
      maxRecentFilesToRetain: fileCount,
    });
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: {
        promptTokenCount: fileChars === 20_000 ? 100_000 : 13_000,
        candidatesTokenCount: 100,
      },
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'restoration-budget',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: fileChars === 20_000 ? 120_000 : 18_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    const restored = historyText(result.newHistory);
    for (const [index, file] of files.entries()) {
      expect(restored).toContain(file.path);
      if (index >= files.length - embedded) {
        expect(restored).toContain(file.body);
      } else {
        expect(restored).not.toContain(file.body);
      }
    }
  },
);

it('retains references when no file-content budget remains', async () => {
  const { files } = restorationFixture(16_000);
  const blocks = await buildFileRestorationBlocks(
    files.map(({ path }) => path),
    undefined,
    0,
  );
  const restored = historyText(blocks);
  for (const file of files) {
    expect(restored).toContain(file.path);
    expect(restored).not.toContain(file.body);
  }
});

it.each([
  { window: 40_000, threshold: undefined, embedded: 1 },
  { window: 128_000, threshold: 0.1, embedded: 3 },
  { window: 1_000_000, threshold: 0.01, embedded: 2 },
])(
  'retains partial file contents at a low threshold for a $window-token window',
  async ({ window, threshold, embedded }) => {
    const { files, config, chat } = restorationFixture(window);
    vi.spyOn(config, 'getAutoCompactThreshold').mockReturnValue(threshold);
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 16_000, candidatesTokenCount: 100 },
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'low-restoration-threshold',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 18_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBeLessThan(
      computeThresholds(window, threshold).auto,
    );
    const restored = historyText(result.newHistory);
    for (const [index, file] of files.entries()) {
      expect(restored).toContain(file.path);
      expect(restored.includes(file.body)).toBe(
        index >= files.length - embedded,
      );
    }
  },
);

it('embeds CJK files that fit and references the remaining files', async () => {
  const { files } = restorationFixture(16_000, 5, 1000, '中');
  const blocks = await buildFileRestorationBlocks(
    files.map(({ path }) => path),
    undefined,
    4000,
  );
  const restored = historyText(blocks);
  for (const [index, file] of files.entries()) {
    expect(restored).toContain(file.path);
    expect(restored.includes(file.body)).toBe(index < 2);
  }
});

it.each([
  { script: 'Chinese', character: '中', hasUsage: true },
  { script: 'Chinese', character: '中', hasUsage: false },
  { script: 'Thai', character: 'ท', hasUsage: true },
  { script: 'Thai', character: 'ท', hasUsage: false },
])(
  'drops a budget-fitting $script file when the full candidate overflows with usage=$hasUsage',
  async ({ character, hasUsage }) => {
    const { files, history, config, chat } = restorationFixture(
      16_000,
      1,
      2640,
      character,
    );
    const historyTokens = tokenEstimation.estimateContentTokens(history);
    const nonVisibleTokens = 11_500;
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: hasUsage
        ? { promptTokenCount: historyTokens + 1000, candidatesTokenCount: 100 }
        : undefined,
    } as never);
    const compose = vi.spyOn(
      postCompactAttachments,
      'composePostCompactHistory',
    );
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'non-ascii-restoration-overflow',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: historyTokens + nonVisibleTokens,
    });
    const initialHistory = await compose.mock.results[0].value;
    expect(historyText(initialHistory)).toContain(files[0].body);
    expect(compose).toHaveBeenCalledTimes(2);
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBeGreaterThanOrEqual(nonVisibleTokens);
    expect(result.info.newTokenCount).toBeLessThan(16_000 - HARD_BUFFER);
    expect(historyText(result.newHistory)).not.toContain(files[0].body);
  },
);

it.each([true, false])(
  'drops overflowing files and images with usage metadata=%s while preserving state and tool calls',
  async (hasUsage) => {
    const { history, files, config, chat } = restorationFixture(16_000);
    if (!hasUsage) history[0] = userText('Earlier conversation '.repeat(1000));
    history.push(
      content(
        'user',
        ...Array.from({ length: 3 }, () => ({
          inlineData: { mimeType: 'image/png', data: 'screenshot-bytes' },
        })),
      ),
      content(
        'model',
        fnCall('pending_tool', { value: 'pending' }, 'pending-call'),
      ),
    );
    vi.spyOn(config, 'getApprovalMode').mockReturnValue(ApprovalMode.PLAN);
    Object.assign(config, {
      getBackgroundTaskRegistry: () => ({
        getAll: () => [
          {
            kind: 'agent',
            isBackgrounded: true,
            status: 'running',
            id: 'background-agent',
            description: 'Continue analysis',
            startTime: 0,
          },
        ],
      }),
    });
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: hasUsage
        ? { promptTokenCount: 11_000, candidatesTokenCount: 100 }
        : undefined,
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'restoration-overflow',
      force: true,
      trigger: 'auto',
      config,
      consecutiveFailures: 0,
      originalTokenCount: 19_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBeLessThan(
      computeThresholds(16_000).auto,
    );
    expect(result.info.newTokenCount).toBeGreaterThan(6000);
    const restored = historyText(result.newHistory);
    expect(JSON.stringify(result.newHistory)).not.toContain('screenshot-bytes');
    for (const file of files) expect(restored).not.toContain(file.path);
    expect(restored).toContain('<plan-mode-active>');
    expect(restored).toContain('background-agent');
    expect(result.newHistory?.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'pending-call' }),
      }),
    );
  },
);

function compressionFixture(
  window = 16_000,
  fileCount = 5,
  fileCharacter?: string,
) {
  const { files, history, config, chat, logger } = restorationFixture(
    window,
    fileCount,
    8000,
    fileCharacter,
  );
  vi.spyOn(config, 'getChatCompression').mockReturnValue({
    maxRecentFilesToRetain: fileCount,
  });
  const summary = vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    usage: { promptTokenCount: 13_000, candidatesTokenCount: 100 },
  } as never);
  const run = async (
    options: Partial<Parameters<ChatCompressionService['compress']>[1]> = {},
  ) => {
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'review-restoration',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 18_000,
      ...options,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    return { ...result, text: historyText(result.newHistory) };
  };
  return { files, history, config, logger, summary, run };
}

it('drops restored bodies below the auto threshold to leave request headroom', async () => {
  const { files, logger, run } = compressionFixture();
  const compose = vi.spyOn(postCompactAttachments, 'composePostCompactHistory');
  const originalTokenCount = 21_000;
  const result = await run({ originalTokenCount });
  const initialHistory = await compose.mock.results[0].value;
  const initialCount =
    originalTokenCount -
    (13_000 - 1000) +
    100 +
    tokenEstimation.estimateContentTokens(initialHistory.slice(2));
  expect(initialCount).toBeGreaterThanOrEqual(16_000 - HARD_BUFFER);
  expect(initialCount).toBeLessThan(computeThresholds(16_000).auto);
  expect(
    files.filter((file) => historyText(initialHistory).includes(file.body)),
  ).toHaveLength(2);
  expect(result.info.newTokenCount).toBeLessThan(16_000 - HARD_BUFFER);
  expect(
    tokenEstimation.estimateContentTokens(result.newHistory!) + HARD_BUFFER,
  ).toBeLessThan(16_000);
  for (const file of files) expect(result.text).not.toContain(file.body);
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining('reached the restoration target 13000'),
  );
});

it.each([
  { character: '中', usage: 'absent' },
  { character: '中', usage: 'reported' },
  { character: 'ท', usage: 'absent' },
  { character: 'ท', usage: 'prompt-only' },
  { character: 'ท', usage: 'reported' },
])(
  'corrects a $character summary when the output count is $usage',
  async ({ character, usage }) => {
    const { history, files, summary, run } = compressionFixture();
    const historyTokens = tokenEstimation.estimateContentTokens(history);
    const originalTokenCount = historyTokens + 7500;
    const summaryBody = character.repeat(3000);
    const text = `<state_snapshot>${summaryBody}</state_snapshot>`;
    const providerOutputCount = usage === 'reported' ? 800 : undefined;
    summary.mockResolvedValue({
      text,
      usage:
        usage === 'absent'
          ? undefined
          : {
              promptTokenCount: historyTokens + 1000,
              candidatesTokenCount: providerOutputCount,
            },
    } as never);
    const compose = vi.spyOn(
      postCompactAttachments,
      'composePostCompactHistory',
    );
    const result = await run({ originalTokenCount });
    const initialHistory = await compose.mock.results[0].value;
    const initialCount =
      7500 + tokenEstimation.estimateContentTokens(initialHistory);
    expect(initialCount).toBeLessThan(16_000 - HARD_BUFFER);
    expect(initialCount + 3750).toBeGreaterThan(16_000 - HARD_BUFFER);
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(usage === 'reported' ? 2 : 0);
    expect(compose).toHaveBeenCalledTimes(usage === 'reported' ? 1 : 2);
    expect(result.text).toContain(summaryBody);
    const expectedCount =
      usage === 'absent'
        ? 7500 + tokenEstimation.estimateContentTokens(result.newHistory!)
        : 7500 +
          (providerOutputCount ?? tokenEstimation.estimateCjkTextTokens(text)) +
          tokenEstimation.estimateContentTokens(result.newHistory!.slice(2));
    expect(result.info.newTokenCount).toBe(expectedCount);
  },
);

it('keeps fitting files when a locally estimated summary strips non-ASCII analysis', async () => {
  const { history, files, summary, run } = compressionFixture();
  const historyTokens = tokenEstimation.estimateContentTokens(history);
  summary.mockResolvedValue({
    text: `<analysis>${'ท'.repeat(3100)}</analysis><state_snapshot>Completed file inspections.</state_snapshot>`,
    usage: { promptTokenCount: historyTokens + 1000 },
  } as never);
  const result = await run({ originalTokenCount: historyTokens + 7500 });
  expect(files.filter((file) => result.text.includes(file.body))).toHaveLength(
    2,
  );
  expect(result.text).not.toContain('ท');
});

it('estimates the restored-content base once', async () => {
  const estimate = vi.spyOn(tokenEstimation, 'estimateContentTokens');
  const { run } = compressionFixture();
  const result = await run();
  const restored = result.newHistory!.slice(2);
  expect(restored).not.toHaveLength(0);
  const calls = estimate.mock.calls.filter(
    ([contents]) =>
      contents.length === restored.length &&
      contents.every((entry, index) => entry === restored[index]),
  );
  expect(calls).toHaveLength(1);
});

it.each([
  { plan: true, agent: false },
  { plan: false, agent: true },
  { plan: true, agent: true },
])(
  'keeps reminders without attempting attachment removal %j',
  async ({ plan, agent }) => {
    const { config, logger, run } = compressionFixture(16_000, 0);
    vi.spyOn(config, 'getApprovalMode').mockReturnValue(
      plan ? ApprovalMode.PLAN : ApprovalMode.DEFAULT,
    );
    Object.assign(config, {
      getBackgroundTaskRegistry: () => ({
        getAll: () =>
          agent
            ? [
                {
                  kind: 'agent',
                  isBackgrounded: true,
                  status: 'running',
                  id: 'background-agent',
                  description: 'Continue analysis',
                  startTime: 0,
                },
              ]
            : [],
      }),
    });
    const compose = vi.spyOn(
      postCompactAttachments,
      'composePostCompactHistory',
    );
    const result = await run({ originalTokenCount: 40_000 });
    expect(result.info.newTokenCount).toBeGreaterThan(
      computeThresholds(16_000).auto,
    );
    expect(result.text.includes('<plan-mode-active>')).toBe(plan);
    expect(result.text.includes('background-agent')).toBe(agent);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('dropped restored files and images'),
    );
  },
);

it('keeps a references-only block with reminders and a pending call', async () => {
  const { files, history, config, logger, run } = compressionFixture(
    16_000,
    5,
    '中',
  );
  vi.spyOn(config, 'getApprovalMode').mockReturnValue(ApprovalMode.PLAN);
  history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
  const compose = vi.spyOn(postCompactAttachments, 'composePostCompactHistory');
  const result = await run({ originalTokenCount: 40_000, trigger: 'auto' });
  expect(compose).toHaveBeenCalledTimes(1);
  const initialHistory = await compose.mock.results[0].value;
  const initialText = historyText(initialHistory);
  for (const file of files) {
    expect(initialText).toContain(file.path);
    expect(initialText).not.toContain(file.body);
    expect(result.text).toContain(file.path);
  }
  expect(result.text).toContain('<plan-mode-active>');
  expect(result.newHistory?.at(-1)?.parts).toContainEqual(
    expect.objectContaining({
      functionCall: expect.objectContaining({ id: 'pending-call' }),
    }),
  );
  expect(logger.debug).not.toHaveBeenCalledWith(
    expect.stringContaining('dropped restored files and images'),
  );
});

it.each([
  ['total', 'test-model', undefined],
  ['input', 'test-model', undefined],
  ['total', 'compact-model', undefined],
  ['input', 'compact-model', undefined],
  ['total', 'test-model', 'main-route'],
  ['input', 'test-model', 'main-route'],
  ['total', 'compact-model', 'main-route'],
  ['input', 'compact-model', 'main-route'],
] as const)(
  'bounds restoration against a server %s ceiling with summary model %s and route %s',
  async (observedServerCeilingKind, compactionModel, requestRouteKey) => {
    const { files, config, summary, run } = compressionFixture(200_000, 9);
    Object.assign(config, { getCompactionModel: () => compactionModel });
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 35_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({
      originalTokenCount: 40_000,
      observedServerCeiling: 16_384,
      observedServerCeilingKind,
      requestRouteKey,
    });
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(2);
    expect(result.info.newTokenCount).toBeLessThan(
      computeThresholds(16_384).auto,
    );
    expect(summary.mock.calls[0][1].model).toBe(compactionModel);
    for (const file of files) expect(result.text).toContain(file.path);
  },
);

it('drops restored images against a server-reported total window', async () => {
  const { history, summary, run } = compressionFixture(200_000, 2);
  history.push(
    content(
      'user',
      ...Array.from({ length: 3 }, () => ({
        inlineData: { mimeType: 'image/png', data: 'screenshot-bytes' },
      })),
    ),
  );
  summary.mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    usage: { promptTokenCount: 30_000, candidatesTokenCount: 100 },
  } as never);
  const result = await run({
    originalTokenCount: 40_000,
    observedServerCeiling: 16_384,
    observedServerCeilingKind: 'total',
  });
  expect(result.info.newTokenCount).toBeLessThan(
    computeThresholds(16_384).auto,
  );
  expect(JSON.stringify(result.newHistory)).not.toContain('screenshot-bytes');
});

it.each(['input', 'total'] as const)(
  'ignores a server %s ceiling from another request route',
  async (observedServerCeilingKind) => {
    const { files, summary, run } = compressionFixture(200_000, 9);
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 35_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({
      originalTokenCount: 40_000,
      observedServerCeiling: 16_384,
      observedServerCeilingKind,
      requestRouteKey: 'other-route',
    });
    for (const file of files) expect(result.text).toContain(file.body);
  },
);

it.each([
  { character: 'x', length: 20_000, original: 18_000, kept: true },
  { character: '中', length: 4_000, original: 24_000, kept: false },
])(
  'counts a pending $character tool result once with a CJK correction',
  async ({ character, length, original, kept }) => {
    const { files, history, summary, run } = compressionFixture();
    history[0] = userText('Earlier conversation '.repeat(1000));
    history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
    const pendingUserMessage = content(
      'user',
      fnResponse(
        'pending_tool',
        { output: character.repeat(length) },
        'pending-call',
      ),
    );
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 18_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({
      trigger: 'auto',
      pendingUserMessage,
      originalTokenCount: original,
    });
    expect(result.info.newTokenCount).toBeLessThan(
      computeThresholds(16_000).auto,
    );
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(kept ? 2 : 0);
    for (const file of files)
      expect(result.text.includes(file.path)).toBe(kept);
    expect(result.newHistory?.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        functionCall: expect.objectContaining({ id: 'pending-call' }),
      }),
    );
  },
);

it.each([
  { character: 'x', withUsage: false, kept: 2 },
  { character: 'x', withUsage: true, kept: 2 },
  { character: '中', withUsage: false, kept: 0 },
  { character: '中', withUsage: true, kept: 0 },
  { character: 'ท', withUsage: false, kept: 0 },
  { character: 'ท', withUsage: true, kept: 0 },
])(
  'corrects pending plain-text $character input with usage=$withUsage',
  async ({ character, withUsage, kept }) => {
    const { files, history, summary, run } = compressionFixture();
    const pendingUserMessage = userText(character.repeat(3000));
    const historyTokens = tokenEstimation.estimateContentTokens(history);
    const pendingTokens = tokenEstimation.estimateContentTokens([
      pendingUserMessage,
    ]);
    const nonVisibleTokens = 7500 + pendingTokens;
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      ...(withUsage && {
        usage: {
          promptTokenCount: historyTokens + 1000,
          candidatesTokenCount: 100,
        },
      }),
    } as never);
    const compose = vi.spyOn(
      postCompactAttachments,
      'composePostCompactHistory',
    );
    const result = await run({
      trigger: 'auto',
      pendingUserMessage,
      originalTokenCount: historyTokens + nonVisibleTokens,
    });
    const initialHistory = await compose.mock.results[0].value;
    const initialCount =
      nonVisibleTokens +
      (withUsage
        ? 100 + tokenEstimation.estimateContentTokens(initialHistory.slice(2))
        : tokenEstimation.estimateContentTokens(initialHistory));
    const correction =
      tokenEstimation.estimateRestorationTextTokens(character.repeat(3000)) -
      pendingTokens;
    expect(initialCount).toBeLessThan(16_000 - HARD_BUFFER);
    if (kept === 0) {
      expect(initialCount + correction).toBeGreaterThan(16_000);
    }
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(kept);
    expect(compose).toHaveBeenCalledTimes(kept === 0 ? 2 : 1);
    expect(result.info.newTokenCount + correction).toBeLessThan(16_000);
    expect(pendingUserMessage).toEqual(userText(character.repeat(3000)));
  },
);

it.each([
  { visible: false, withUsage: false },
  { visible: false, withUsage: true },
  { visible: true, withUsage: false },
  { visible: true, withUsage: true },
])(
  'matches pending memory visibility=$visible with usage=$withUsage',
  async ({ visible, withUsage }) => {
    const { files, history, config, summary, run } = compressionFixture();
    const snapshot = getAutoMemorySnapshot([], '中'.repeat(3000))!;
    const pendingUserMessage = content('user', { text: 'continue' }, snapshot);
    const before = structuredClone(pendingUserMessage);
    config.getAutoMemoryContext = () => (visible ? 'current catalog' : '');
    const visiblePending = visible
      ? [pendingUserMessage]
      : withoutAutoMemorySnapshots([pendingUserMessage]);
    const historyTokens = tokenEstimation.estimateContentTokens(history);
    const nonVisibleTokens =
      7500 + tokenEstimation.estimateContentTokens(visiblePending);
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      ...(withUsage && {
        usage: {
          promptTokenCount: historyTokens + 1000,
          candidatesTokenCount: 100,
        },
      }),
    } as never);
    const result = await run({
      trigger: 'auto',
      pendingUserMessage,
      originalTokenCount: historyTokens + nonVisibleTokens,
    });
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(visible ? 0 : 2);
    expect(pendingUserMessage).toEqual(before);
  },
);

it.each(['x', '中'])(
  'counts a pending %s tool result once when summary usage is missing',
  async (character) => {
    const { files, history, summary, run } = compressionFixture();
    history[0] = userText('Earlier conversation '.repeat(1000));
    history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
    const pendingUserMessage = content(
      'user',
      fnResponse(
        'pending_tool',
        { output: character.repeat(character === 'x' ? 20_000 : 4_000) },
        'pending-call',
      ),
    );
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    } as never);
    const result = await run({
      trigger: 'auto',
      pendingUserMessage,
      originalTokenCount:
        tokenEstimation.estimateContentTokens(history) +
        (character === 'x' ? 6000 : 8000),
    });
    expect(
      files.filter((file) => result.text.includes(file.body)),
    ).toHaveLength(character === 'x' ? 2 : 0);
  },
);

it.each([true, false])(
  'keeps the retained tool call when dropping restored files with usage=%s',
  async (hasUsage) => {
    const { files, history, summary, run } = compressionFixture();
    const prompt = userText('Run one more tool.');
    markApiHistoryPrompt(prompt, 'latest-prompt');
    const toolCall = content(
      'model',
      fnCall('pending_tool', {}, 'latest-call'),
    );
    history.push(prompt, toolCall);
    const pendingUserMessage = content(
      'user',
      fnResponse('pending_tool', { output: 'Latest result' }, 'latest-call'),
    );
    const historyTokens = tokenEstimation.estimateContentTokens(history);
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: hasUsage
        ? { promptTokenCount: historyTokens + 1000, candidatesTokenCount: 100 }
        : undefined,
    } as never);
    const compose = vi.spyOn(
      postCompactAttachments,
      'composePostCompactHistory',
    );
    const result = await run({
      trigger: 'auto',
      pendingUserMessage,
      originalTokenCount: historyTokens + 10_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(compose).toHaveBeenCalledTimes(2);
    expect(result.info.newTokenCount).toBeGreaterThan(10_000);
    expect(result.info.newTokenCount).toBeLessThan(16_000 - HARD_BUFFER);
    expect(result.info.summaryPrefixLength).toBe(3);
    expect(result.newHistory?.[2].parts).toEqual([
      { text: RETAINED_COMPACTION_TAIL_REMINDER },
    ]);
    expect(result.newHistory?.slice(3)).toEqual([toolCall]);
    expect(getApiHistoryPromptId(result.newHistory![3])).toBe('latest-prompt');
    for (const file of files) expect(result.text).not.toContain(file.body);
  },
);

it('charges CJK content against the token restoration budget', async () => {
  const { files, run } = compressionFixture(16_000, 5, '中');
  const result = await run();
  for (const file of files) {
    expect(result.text).toContain(file.path);
    expect(result.text).not.toContain(file.body);
  }
});

it('keeps a substantial summary in the count when removing restoration', async () => {
  const { history, summary, run } = compressionFixture();
  history.push(
    content(
      'user',
      ...Array.from({ length: 3 }, () => ({
        inlineData: { mimeType: 'image/png', data: 'screenshot-bytes' },
      })),
    ),
  );
  summary.mockResolvedValue({
    text: `<state_snapshot>${'s'.repeat(16_000)}</state_snapshot>`,
    usage: { promptTokenCount: 15_000, candidatesTokenCount: 4_000 },
  } as never);
  const result = await run({ originalTokenCount: 19_000 });
  expect(result.text).toContain('s'.repeat(16_000));
  expect(JSON.stringify(result.newHistory)).not.toContain('screenshot-bytes');
  expect(result.info.newTokenCount).toBeGreaterThan(8_800);
  expect(result.info.newTokenCount).toBeLessThan(9_300);
});

it('preserves summary accounting for CJK history when usage is missing', async () => {
  const { history, summary, run } = compressionFixture(128_000, 0);
  history[0] = userText('中'.repeat(10_000));
  summary.mockResolvedValue({
    text: `<state_snapshot>${'中'.repeat(3000)}</state_snapshot>`,
  } as never);
  const result = await run();
  expect(result.text).toContain('中'.repeat(3000));
  expect(result.info.newTokenCount).toBeGreaterThan(16_200);
  expect(result.info.newTokenCount).toBeLessThan(16_400);
});

it.each([undefined, 0.5])(
  'respects the configured auto threshold %s',
  async (threshold) => {
    const { files, config, summary, run } = compressionFixture(128_000);
    vi.spyOn(config, 'getAutoCompactThreshold').mockReturnValue(threshold);
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 21_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({ originalTokenCount: 80_000 });
    expect(result.text.includes(files.at(-1)!.body)).toBe(
      threshold === undefined,
    );
  },
);

it.each(['error', 'nested'])(
  'corrects CJK in a pending tool %s payload',
  async (carrier) => {
    const { files, history, summary, run } = compressionFixture();
    history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
    const response = fnResponse('pending_tool', {}, 'pending-call');
    if (carrier === 'error') {
      response.functionResponse!.response = { error: '中'.repeat(4000) };
    } else {
      Object.assign(response.functionResponse!, {
        parts: [
          { text: '中'.repeat(4000) },
          { inlineData: { mimeType: 'image/png', data: 'bytes' } },
        ],
      });
    }
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 18_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({
      trigger: 'auto',
      originalTokenCount: carrier === 'nested' ? 22_400 : 24_000,
      pendingUserMessage: content('user', response),
    });
    for (const file of files) expect(result.text).not.toContain(file.body);
  },
);

it('logs the threshold, pending correction, and counts on attachment removal', async () => {
  const { history, logger, run } = compressionFixture();
  history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
  const result = await run({
    trigger: 'auto',
    pendingUserMessage: content(
      'user',
      fnResponse('pending_tool', { output: '中'.repeat(4000) }, 'pending-call'),
    ),
  });
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining('reached the restoration target 13000'),
  );
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining('removed 3 restoration blocks'),
  );
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining('5000 pending non-ASCII correction'),
  );
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringMatching(/post-compression count \d+ -> \d+/),
  );
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining(`-> ${result.info.newTokenCount}`),
  );
});

it('accepts shrinking CJK restoration when summary usage is missing', async () => {
  const { history, files, config, chat } = restorationFixture(
    200_000,
    1,
    20_000,
    '中',
  );
  history[0] = userText('x'.repeat(30_000));
  vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
  } as never);
  const result = await new ChatCompressionService().compress(chat, {
    promptId: 'cjk-restoration-accounting',
    force: true,
    config,
    consecutiveFailures: 0,
    originalTokenCount: 55_000,
  });
  expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  expect(result.info.newTokenCount).toBeLessThan(55_000);
  expect(historyText(result.newHistory)).toContain(files[0].body);
});

it.each(['я', 'é', 'α', 'א', 'ท'])(
  'keeps the path when 16000 %s characters exceed the 16K restoration budget',
  async (character) => {
    const { files, config, chat } = restorationFixture(
      16_000,
      1,
      16_000,
      character,
    );
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 11_000, candidatesTokenCount: 100 },
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'non-ascii-restoration-budget',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 18_000,
    });
    const restored = historyText(result.newHistory);
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(restored).toContain(files[0].path);
    expect(restored).not.toContain(files[0].body);
  },
);

it('embeds Latin prose with accents that fits the restoration budget', async () => {
  const { files } = restorationFixture(16_000, 1);
  const body = 'Le rapport est presque terminé. '.repeat(250);
  writeFileSync(files[0].path, body);
  const blocks = await buildFileRestorationBlocks(
    [files[0].path],
    undefined,
    4000,
  );
  expect(historyText(blocks)).toContain(body);
});

it.each([
  { maxImages: 0, imageTokenEstimate: 1600, embedded: 2 },
  { maxImages: 3, imageTokenEstimate: 1600, embedded: 0 },
  { maxImages: 3, imageTokenEstimate: 500, embedded: 1 },
])(
  'reserves $imageTokenEstimate tokens for each of $maxImages restored images',
  async ({ maxImages, imageTokenEstimate, embedded }) => {
    const { history, files, config, run } = compressionFixture();
    vi.spyOn(config, 'getChatCompression').mockReturnValue({
      imageTokenEstimate,
      maxRecentImagesToRetain: maxImages,
    });
    history.push(
      content(
        'user',
        ...Array.from({ length: 3 }, () => ({
          inlineData: { mimeType: 'image/png', data: 'screenshot-bytes' },
        })),
      ),
    );
    const result = await run();
    const text = result.text;
    expect(files.filter((file) => text.includes(file.body))).toHaveLength(
      embedded,
    );
    for (const file of files) expect(text).toContain(file.path);
    expect(
      (result.newHistory ?? [])
        .flatMap((entry) => entry.parts ?? [])
        .filter((part) => part.inlineData),
    ).toHaveLength(maxImages);
  },
);
