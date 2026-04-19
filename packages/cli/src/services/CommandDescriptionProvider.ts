/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from '../ui/commands/types.js';
import { DynamicCommandTranslationService } from './DynamicCommandTranslationService.js';
import {
  getDynamicCommandDescriptionMetadata,
  type DynamicCommandDescriptionKind,
  type TrackedDynamicDescriptionSource,
} from './commandDescriptionMetadata.js';

export interface TranslationProvider<Request, Result = string> {
  resolve(request: Request): Result;
}

interface StaticCommandDescriptionSource {
  type: 'static';
  getText: () => string;
}

interface DynamicCommandDescriptionSource {
  type: 'dynamic';
  kind: DynamicCommandDescriptionKind;
  sourceText: string;
  getFallbackText: () => string;
  formatResolvedText?: (resolvedText: string) => string;
}

export type CommandDescriptionSource =
  | StaticCommandDescriptionSource
  | DynamicCommandDescriptionSource;

export interface CommandDescriptionProvider
  extends TranslationProvider<CommandDescriptionSource> {
  trackCommands(commands: readonly SlashCommand[]): void;
  refreshTrackedDescriptions(): number;
  clearCurrentLanguageCache(): void;
}

type DescriptionReader = (receiver: SlashCommand) => string;

function createDescriptionReader(
  descriptor: PropertyDescriptor | undefined,
): DescriptionReader {
  if (typeof descriptor?.get === 'function') {
    return (receiver) => {
      const value = descriptor.get?.call(receiver);
      return typeof value === 'string' ? value : '';
    };
  }

  if (typeof descriptor?.value === 'string') {
    return () => descriptor.value as string;
  }

  return () => '';
}

function bindCommandTree(
  command: SlashCommand,
  provider: CommandDescriptionProvider,
): SlashCommand {
  const descriptors = Object.getOwnPropertyDescriptors(command);
  const readOriginalDescription = createDescriptionReader(
    descriptors['description'],
  );
  const metadata = getDynamicCommandDescriptionMetadata(command);

  descriptors['description'] = {
    get(this: SlashCommand) {
      if (metadata) {
        return provider.resolve({
          type: 'dynamic',
          kind: metadata.kind,
          sourceText: metadata.sourceText,
          getFallbackText: () => readOriginalDescription(this),
          formatResolvedText: metadata.formatResolvedText,
        });
      }

      return provider.resolve({
        type: 'static',
        getText: () => readOriginalDescription(this),
      });
    },
    enumerable: true,
    configurable: true,
  };

  if (command.subCommands?.length) {
    descriptors['subCommands'] = {
      value: Object.freeze(
        command.subCommands.map((subCommand) =>
          bindCommandTree(subCommand, provider),
        ),
      ) as SlashCommand[],
      writable: false,
      enumerable: true,
      configurable: true,
    };
  }

  return Object.create(
    Object.getPrototypeOf(command),
    descriptors,
  ) as SlashCommand;
}

export class UnifiedCommandDescriptionProvider
  implements CommandDescriptionProvider
{
  private readonly dynamicTranslationService: DynamicCommandTranslationService;

  constructor(
    config: Config | null,
    options: {
      onTranslationsUpdated?: () => void;
      failureCooldownMs?: number;
    } = {},
  ) {
    this.dynamicTranslationService = new DynamicCommandTranslationService(
      config,
      options,
    );
  }

  resolve(source: CommandDescriptionSource): string {
    if (source.type === 'static') {
      return source.getText();
    }

    const resolvedText = this.dynamicTranslationService.getDescription(
      source.kind,
      source.sourceText,
    );
    const formattedText = source.formatResolvedText
      ? source.formatResolvedText(resolvedText)
      : resolvedText;

    return formattedText || source.getFallbackText();
  }

  trackCommands(commands: readonly SlashCommand[]): void {
    const tracked = new Map<string, TrackedDynamicDescriptionSource>();

    const visit = (commandList: readonly SlashCommand[]) => {
      for (const command of commandList) {
        const metadata = getDynamicCommandDescriptionMetadata(command);
        if (metadata) {
          tracked.set(`${metadata.kind}:${metadata.sourceText}`, {
            kind: metadata.kind,
            sourceText: metadata.sourceText,
          });
        }

        if (command.subCommands?.length) {
          visit(command.subCommands);
        }
      }
    };

    visit(commands);
    this.dynamicTranslationService.setTrackedSources(
      Array.from(tracked.values()),
    );
  }

  refreshTrackedDescriptions(): number {
    return this.dynamicTranslationService.refreshTrackedDescriptions();
  }

  clearCurrentLanguageCache(): void {
    this.dynamicTranslationService.clearCurrentLanguageCache();
  }
}

export function bindCommandDescriptionProvider(
  command: SlashCommand,
  provider: CommandDescriptionProvider,
): SlashCommand {
  return bindCommandTree(command, provider);
}
