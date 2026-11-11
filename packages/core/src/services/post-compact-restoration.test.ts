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
} from './chatCompressionService.js';
import { ApprovalMode } from '../config/config.js';
import { buildFileRestorationBlocks } from './postCompactAttachments.js';
import { estimateContentTokens } from './tokenEstimation.js';
import * as sideQuery from '../utils/sideQuery.js';

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
  expect(result.info.newTokenCount).toBeLessThan(16_000);
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
        promptTokenCount: window === 1_000_000 ? 100_000 : 13_000,
        candidatesTokenCount: 100,
      },
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'restoration-budget',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: window === 1_000_000 ? 120_000 : 18_000,
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

it.each([true, false])(
  'drops a budget-fitting CJK file when the full candidate overflows with usage=%s',
  async (hasUsage) => {
    const { files, history, config, chat } = restorationFixture(
      16_000,
      1,
      2640,
      '中',
    );
    history[0] = userText('Earlier conversation '.repeat(1100));
    vi.spyOn(sideQuery, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: hasUsage
        ? { promptTokenCount: 6600, candidatesTokenCount: 100 }
        : undefined,
    } as never);
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'cjk-restoration-overflow',
      force: true,
      config,
      consecutiveFailures: 0,
      originalTokenCount: 18_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
    expect(result.info.newTokenCount).toBeGreaterThan(12_000);
    expect(result.info.newTokenCount).toBeLessThan(
      computeThresholds(16_000).auto,
    );
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
      originalTokenCount: 18_000,
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

it('bounds file restoration against a server-reported total window', async () => {
  const { files, summary, run } = compressionFixture(200_000, 9);
  summary.mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    usage: { promptTokenCount: 35_000, candidatesTokenCount: 100 },
  } as never);
  const result = await run({
    originalTokenCount: 40_000,
    observedServerCeiling: 16_384,
    observedServerCeilingKind: 'total',
  });
  expect(files.filter((file) => result.text.includes(file.body))).toHaveLength(
    2,
  );
  for (const file of files) expect(result.text).toContain(file.path);
});

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

it.each([
  { observedServerCeilingKind: 'input' as const },
  {
    observedServerCeilingKind: 'total' as const,
    requestRouteKey: 'other-route',
  },
])(
  'ignores ceilings outside the active total-window scope %j',
  async (scope) => {
    const { files, summary, run } = compressionFixture(200_000, 9);
    summary.mockResolvedValue({
      text: '<state_snapshot>Completed file inspections.</state_snapshot>',
      usage: { promptTokenCount: 35_000, candidatesTokenCount: 100 },
    } as never);
    const result = await run({
      originalTokenCount: 40_000,
      observedServerCeiling: 16_384,
      ...scope,
    });
    for (const file of files) expect(result.text).toContain(file.body);
  },
);

it('reserves room for the pending tool result when testing restoration overflow', async () => {
  const { files, history, summary, run } = compressionFixture();
  history[0] = userText('Earlier conversation '.repeat(1000));
  history.push(content('model', fnCall('pending_tool', {}, 'pending-call')));
  const pendingUserMessage = content(
    'user',
    fnResponse(
      'pending_tool',
      {
        output: 'x'.repeat(20_000),
      },
      'pending-call',
    ),
  );
  summary.mockResolvedValue({
    text: '<state_snapshot>Completed file inspections.</state_snapshot>',
    usage: { promptTokenCount: 18_000, candidatesTokenCount: 100 },
  } as never);
  const result = await run({ trigger: 'auto', pendingUserMessage });
  expect(result.info.newTokenCount).toBeGreaterThan(6000);
  expect(result.info.newTokenCount).toBeLessThan(6600);
  expect(
    result.info.newTokenCount + estimateContentTokens([pendingUserMessage]),
  ).toBeLessThan(computeThresholds(16_000).auto);
  for (const file of files) expect(result.text).not.toContain(file.body);
  expect(result.newHistory?.at(-1)?.parts).toContainEqual(
    expect.objectContaining({
      functionCall: expect.objectContaining({ id: 'pending-call' }),
    }),
  );
});

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
  const result = await run();
  expect(result.text).toContain('s'.repeat(16_000));
  expect(JSON.stringify(result.newHistory)).not.toContain('screenshot-bytes');
  expect(result.info.newTokenCount).toBeGreaterThan(7_800);
  expect(result.info.newTokenCount).toBeLessThan(8_300);
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

it('logs attachment removal after the overflow gate fires', async () => {
  const { history, logger, run } = compressionFixture();
  history.push(
    content(
      'user',
      ...Array.from({ length: 3 }, () => ({
        inlineData: { mimeType: 'image/png', data: 'screenshot-bytes' },
      })),
    ),
  );
  const result = await run();
  expect(JSON.stringify(result.newHistory)).not.toContain('screenshot-bytes');
  expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/restor/i));
});
