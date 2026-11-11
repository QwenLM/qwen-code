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
import { ChatCompressionService } from './chatCompressionService.js';
import { computeThresholds } from './chatCompressionService.js';
import { ApprovalMode } from '../config/config.js';
import { buildFileRestorationBlocks } from './postCompactAttachments.js';
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
  console.log(
    JSON.stringify({
      window: 16_000,
      before: result.info.originalTokenCount,
      after: result.info.newTokenCount,
      status: result.info.compressionStatus,
      restoredChars: JSON.stringify(result.newHistory).length,
    }),
  );
  expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
  expect(result.info.newTokenCount).toBeLessThan(16_000);
});

function restorationFixture(window: number, fileCount = 5, fileChars = 8000) {
  fixture = mkdtempSync(join(tmpdir(), 'qwen-restoration-'));
  const history: Content[] = [
    userText('Earlier conversation '.repeat(1800)),
    modelText('Understood.'),
  ];
  const files = Array.from({ length: fileCount }, (_, index) => {
    const path = join(fixture!, `file-${index}.txt`);
    const body = `file-content-${index}:`.padEnd(fileChars, String(index));
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
  const config = {
    getChatCompression: () => undefined,
    getAutoCompactThreshold: () => undefined,
    getBaseLlmClient: vi.fn(),
    getContentGeneratorConfig: () => ({ contextWindowSize: window }),
    getHookSystem: () => undefined,
    getModel: () => 'test-model',
    getAllConfiguredModels: () => [],
    getApprovalMode: () => ApprovalMode.DEFAULT,
    getDebugLogger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    getTargetDir: () => fixture,
  } as unknown as Config;
  const chat = { getHistoryShallow: () => history } as unknown as LlmChat;
  return { history, files, config, chat };
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
    const restored = JSON.stringify(result.newHistory);
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
  const restored = JSON.stringify(blocks);
  for (const file of files) {
    expect(restored).toContain(file.path);
    expect(restored).not.toContain(file.body);
  }
});

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
    const restored = JSON.stringify(result.newHistory);
    expect(restored).not.toContain('screenshot-bytes');
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
