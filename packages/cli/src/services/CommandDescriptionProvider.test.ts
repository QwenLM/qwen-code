/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import {
  bindCommandDescriptionProvider,
  UnifiedCommandDescriptionProvider,
} from './CommandDescriptionProvider.js';
import { DynamicCommandTranslationService } from './DynamicCommandTranslationService.js';
import { markDynamicDescriptionSource } from './commandDescriptionMetadata.js';

describe('UnifiedCommandDescriptionProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves static descriptions through the unified provider', () => {
    const provider = new UnifiedCommandDescriptionProvider(null);
    const command = {
      name: 'help',
      get description() {
        return `help:${this.name}`;
      },
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    } satisfies SlashCommand;

    const boundCommand = bindCommandDescriptionProvider(command, provider);
    expect(boundCommand.description).toBe('help:help');
  });

  it('delegates dynamic descriptions to the dynamic translation service and preserves formatting', () => {
    vi.spyOn(
      DynamicCommandTranslationService.prototype,
      'getDescription',
    ).mockReturnValue('部署到生产环境');

    const provider = new UnifiedCommandDescriptionProvider(null);
    const command = {
      name: 'deploy',
      extensionName: 'acme',
      get description() {
        return '[acme] Deploy to production';
      },
      kind: CommandKind.FILE,
      action: vi.fn(),
    } satisfies SlashCommand;

    markDynamicDescriptionSource(
      command,
      CommandKind.FILE,
      'Deploy to production',
      {
        formatResolvedText: (resolvedText) => `[acme] ${resolvedText}`,
      },
    );

    const boundCommand = bindCommandDescriptionProvider(command, provider);
    expect(boundCommand.description).toBe('[acme] 部署到生产环境');
  });

  it('tracks dynamic description sources through the provider', () => {
    const setTrackedSources = vi
      .spyOn(DynamicCommandTranslationService.prototype, 'setTrackedSources')
      .mockImplementation(() => {});

    const provider = new UnifiedCommandDescriptionProvider(null);
    const command = {
      name: 'review',
      description: 'Review code changes',
      kind: CommandKind.SKILL,
      action: vi.fn(),
    } satisfies SlashCommand;

    markDynamicDescriptionSource(
      command,
      CommandKind.SKILL,
      'Review code changes',
    );

    provider.trackCommands([bindCommandDescriptionProvider(command, provider)]);

    expect(setTrackedSources).toHaveBeenCalledWith([
      { kind: CommandKind.SKILL, sourceText: 'Review code changes' },
    ]);
  });
});
