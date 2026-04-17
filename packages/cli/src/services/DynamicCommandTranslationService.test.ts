/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core';
import { Storage } from '@qwen-code/qwen-code-core';
import { setLanguageAsync } from '../i18n/index.js';
import { CommandKind } from '../ui/commands/types.js';
import { DynamicCommandTranslationService } from './DynamicCommandTranslationService.js';

function makeResponse(translation: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify({ translation }) }],
        },
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DynamicCommandTranslationService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-i18n-cache-'));
    vi.spyOn(Storage, 'getCommandTranslationsCachePath').mockImplementation(
      (language: string) => path.join(tempDir, `${language}.json`),
    );
    await setLanguageAsync('en');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await setLanguageAsync('en');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns cached translations synchronously when present on disk', async () => {
    const cacheFile = {
      version: 1,
      language: 'zh',
      entries: {
        [createHash('sha256').update('Review code changes').digest('hex')]: {
          sourceText: 'Review code changes',
          translatedText: '审查代码变更',
          updatedAt: new Date().toISOString(),
          translator: 'dynamic-command-translation',
          translatorVersion: 1,
          model: 'qwen3',
        },
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'zh.json'),
      JSON.stringify(cacheFile, null, 2),
      'utf-8',
    );

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(null);

    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('审查代码变更');
  });

  it('returns source text on cold cache, then persists and reuses the translation', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue(makeResponse('审查代码变更'));
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;
    const onTranslationsUpdated = vi.fn();

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(config, {
      onTranslationsUpdated,
    });

    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Review code changes');

    await flushMicrotasks();
    expect(onTranslationsUpdated).toHaveBeenCalledTimes(1);

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'qwen3',
        config: expect.objectContaining({
          tools: [],
          responseMimeType: 'application/json',
          thinkingConfig: { includeThoughts: false },
        }),
      }),
      expect.stringContaining('dynamic_command_translation'),
    );

    const freshService = new DynamicCommandTranslationService(config);
    expect(
      freshService.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('审查代码变更');
  });

  it('deduplicates concurrent translation requests for the same source text', async () => {
    let releaseTranslation!: () => void;
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve;
    });
    const generateContent = vi.fn().mockImplementation(async () => {
      await translationGate;
      return makeResponse('创建拉取请求');
    });
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(config);

    expect(
      service.getDescription(CommandKind.FILE, 'Create a pull request'),
    ).toBe('Create a pull request');
    expect(
      service.getDescription(CommandKind.FILE, 'Create a pull request'),
    ).toBe('Create a pull request');

    expect(generateContent).toHaveBeenCalledTimes(1);

    releaseTranslation();
    await flushMicrotasks();
    expect(
      service.getDescription(CommandKind.FILE, 'Create a pull request'),
    ).toBe('创建拉取请求');
  });

  it('applies a failure cooldown before retrying the same translation', async () => {
    vi.useFakeTimers();
    const generateContent = vi
      .fn()
      .mockRejectedValue(new Error('translation failed'));
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(config, {
      failureCooldownMs: 1_000,
    });

    service.getDescription(CommandKind.MCP_PROMPT, 'Inspect widget tree');
    expect(generateContent).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    service.getDescription(CommandKind.MCP_PROMPT, 'Inspect widget tree');
    expect(generateContent).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);
    service.getDescription(CommandKind.MCP_PROMPT, 'Inspect widget tree');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('treats changed source text as a cache miss and translates again', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(makeResponse('提交已暂存变更'))
      .mockResolvedValueOnce(makeResponse('用 AI 提交已暂存变更'));
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(config);

    expect(
      service.getDescription(CommandKind.FILE, 'Commit staged changes'),
    ).toBe('Commit staged changes');
    await flushMicrotasks();
    expect(generateContent).toHaveBeenCalledTimes(1);

    expect(
      service.getDescription(
        CommandKind.FILE,
        'Commit staged changes with an AI-generated commit message',
      ),
    ).toBe('Commit staged changes with an AI-generated commit message');

    await flushMicrotasks();
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('refreshes the currently tracked dynamic descriptions', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue(makeResponse('审查代码变更'));
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;

    await setLanguageAsync('zh');
    const service = new DynamicCommandTranslationService(config);
    service.setTrackedSources([
      { kind: CommandKind.SKILL, sourceText: 'Review code changes' },
    ]);

    expect(service.refreshTrackedDescriptions()).toBe(1);
    await flushMicrotasks();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('keeps per-language caches isolated', async () => {
    const hash = createHash('sha256')
      .update('Review code changes')
      .digest('hex');
    await fs.writeFile(
      path.join(tempDir, 'zh.json'),
      JSON.stringify(
        {
          version: 1,
          language: 'zh',
          entries: {
            [hash]: {
              sourceText: 'Review code changes',
              translatedText: '审查代码变更',
              updatedAt: new Date().toISOString(),
              translator: 'dynamic-command-translation',
              translatorVersion: 1,
              model: 'qwen3',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'de.json'),
      JSON.stringify(
        {
          version: 1,
          language: 'de',
          entries: {
            [hash]: {
              sourceText: 'Review code changes',
              translatedText: 'Codeänderungen prüfen',
              updatedAt: new Date().toISOString(),
              translator: 'dynamic-command-translation',
              translatorVersion: 1,
              model: 'qwen3',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const service = new DynamicCommandTranslationService(null);

    await setLanguageAsync('zh');
    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('审查代码变更');

    await setLanguageAsync('de');
    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Codeänderungen prüfen');
  });

  it('does not let an in-flight translation from the previous UI language affect the current UI language view', async () => {
    let releaseZhTranslation!: () => void;
    let releaseDeTranslation!: () => void;
    const zhGate = new Promise<void>((resolve) => {
      releaseZhTranslation = resolve;
    });
    const deGate = new Promise<void>((resolve) => {
      releaseDeTranslation = resolve;
    });
    const onTranslationsUpdated = vi.fn();
    const generateContent = vi
      .fn()
      .mockImplementation(async (_request, promptId) => {
        if (String(promptId).endsWith('_zh')) {
          await zhGate;
          return makeResponse('审查代码变更');
        }

        await deGate;
        return makeResponse('Codeänderungen prüfen');
      });
    const config = {
      getModel: vi.fn().mockReturnValue('qwen3'),
      getContentGenerator: vi.fn().mockReturnValue({
        generateContent,
      }),
    } as unknown as Config;

    const service = new DynamicCommandTranslationService(config, {
      onTranslationsUpdated,
    });

    await setLanguageAsync('zh');
    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Review code changes');

    await setLanguageAsync('de');
    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Review code changes');

    releaseZhTranslation();
    await flushMicrotasks();

    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Review code changes');

    releaseDeTranslation();
    await flushMicrotasks();

    expect(
      service.getDescription(CommandKind.SKILL, 'Review code changes'),
    ).toBe('Codeänderungen prüfen');
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(onTranslationsUpdated).toHaveBeenCalledTimes(2);
  });
});
