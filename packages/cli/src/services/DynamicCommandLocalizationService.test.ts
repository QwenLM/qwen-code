/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { Storage } from '@qwen-code/qwen-code-core';
import { setLanguageAsync } from '../i18n/index.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { DynamicCommandLocalizationService } from './DynamicCommandLocalizationService.js';

function makeDynamicCommand(
  overrides: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    name: 'review',
    description: 'Review code changes',
    modelDescription: 'Review code changes',
    localizeDescription: true,
    kind: CommandKind.SKILL,
    source: 'bundled-skill',
    sourceLabel: 'Skill',
    ...overrides,
  };
}

describe('DynamicCommandLocalizationService', () => {
  let tempDir: string;
  let generateJson: ReturnType<typeof vi.fn>;
  let mockConfig: Config;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-dynamic-command-i18n-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempDir);

    generateJson = vi.fn().mockResolvedValue({
      translations: [{ id: 'review', text: '审查代码变更' }],
    });

    mockConfig = {
      getFastModel: vi.fn().mockReturnValue('qwen-fast'),
      getModel: vi.fn().mockReturnValue('qwen-main'),
      getBaseLlmClient: vi.fn().mockReturnValue({
        generateJson,
      }),
    } as unknown as Config;

    await setLanguageAsync('zh');
  });

  afterEach(async () => {
    await setLanguageAsync('en');
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('translates dynamic descriptions and preserves modelDescription', async () => {
    const service = new DynamicCommandLocalizationService();
    const localized = await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('审查代码变更');
    expect(localized[0]?.modelDescription).toBe('Review code changes');
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it('skips translation by default unless explicitly enabled', async () => {
    const service = new DynamicCommandLocalizationService();
    const localized = await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
    );

    expect(localized[0]?.description).toBe('Review code changes');
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('reuses persisted cache on subsequent loads', async () => {
    const service = new DynamicCommandLocalizationService();
    await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    const secondGenerateJson = vi.fn();
    const secondConfig = {
      ...mockConfig,
      getBaseLlmClient: vi.fn().mockReturnValue({
        generateJson: secondGenerateJson,
      }),
    } as unknown as Config;

    const secondService = new DynamicCommandLocalizationService();
    const localized = await secondService.localizeCommands(
      secondConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('审查代码变更');
    expect(secondGenerateJson).not.toHaveBeenCalled();
  });

  it('skips translation for English UI language', async () => {
    await setLanguageAsync('en');

    const service = new DynamicCommandLocalizationService();
    const localized = await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('Review code changes');
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('forces a refresh even when cache entries already exist', async () => {
    const service = new DynamicCommandLocalizationService();
    await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    generateJson.mockResolvedValueOnce({
      translations: [{ id: 'review', text: '重新审查代码变更' }],
    });

    service.requestRefreshForLanguage('zh');
    const localized = await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('重新审查代码变更');
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it('clears cache entries for the requested language', async () => {
    const service = new DynamicCommandLocalizationService();
    await service.localizeCommands(
      mockConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    const deleted = await service.clearCacheForLanguage('zh');
    expect(deleted).toBeGreaterThan(0);

    const secondGenerateJson = vi.fn().mockResolvedValue({
      translations: [{ id: 'review', text: '再次审查代码变更' }],
    });
    const secondConfig = {
      ...mockConfig,
      getBaseLlmClient: vi.fn().mockReturnValue({
        generateJson: secondGenerateJson,
      }),
    } as unknown as Config;

    const secondService = new DynamicCommandLocalizationService();
    const localized = await secondService.localizeCommands(
      secondConfig,
      [makeDynamicCommand()],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('再次审查代码变更');
    expect(secondGenerateJson).toHaveBeenCalledTimes(1);
  });

  it('localizes nested subcommand descriptions recursively', async () => {
    generateJson.mockResolvedValueOnce({
      translations: [
        { id: 'prompt', text: '调用提示词' },
        { id: 'prompt help', text: '显示此提示词的帮助' },
      ],
    });

    const service = new DynamicCommandLocalizationService();
    const localized = await service.localizeCommands(
      mockConfig,
      [
        makeDynamicCommand({
          name: 'prompt',
          kind: CommandKind.MCP_PROMPT,
          source: 'mcp-prompt',
          description: 'Invoke prompt prompt',
          modelDescription: 'Invoke prompt prompt',
          subCommands: [
            {
              name: 'help',
              description: 'Show help for this prompt',
              modelDescription: 'Show help for this prompt',
              localizeDescription: true,
              kind: CommandKind.MCP_PROMPT,
              source: 'mcp-prompt',
            },
          ],
        }),
      ],
      new AbortController().signal,
      true,
    );

    expect(localized[0]?.description).toBe('调用提示词');
    expect(localized[0]?.subCommands?.[0]?.description).toBe(
      '显示此提示词的帮助',
    );
  });
});
