/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import { Storage, createDebugLogger } from '@qwen-code/qwen-code-core';
import { getCurrentLanguage } from '../i18n/index.js';
import { getLanguageNameFromLocale } from '../i18n/languages.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

const debugLogger = createDebugLogger('DYNAMIC_COMMAND_TRANSLATION');
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;
const PROMPT_ID = 'dynamic_command_translation';

const DYNAMIC_DESCRIPTION_SOURCE = Symbol('dynamicDescriptionSource');

type DynamicCommandKind =
  | CommandKind.SKILL
  | CommandKind.FILE
  | CommandKind.MCP_PROMPT;

interface DynamicDescriptionSource {
  kind: DynamicCommandKind;
  sourceText: string;
}

interface TranslationCacheEntry {
  sourceText: string;
  translatedText: string;
  updatedAt: string;
  translator: 'dynamic-command-translation';
  translatorVersion: number;
  model: string;
}

interface TranslationCacheFile {
  version: number;
  language: string;
  entries: Record<string, TranslationCacheEntry>;
}

const TRANSLATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    translation: {
      type: 'string',
      description:
        'The translated CLI command description in the target language.',
    },
  },
  required: ['translation'],
};

function isDynamicCommandKind(kind: CommandKind): kind is DynamicCommandKind {
  return (
    kind === CommandKind.SKILL ||
    kind === CommandKind.FILE ||
    kind === CommandKind.MCP_PROMPT
  );
}

function buildCacheKey(language: string, sourceText: string): string {
  return `${language}:${hashSourceText(sourceText)}`;
}

function hashSourceText(sourceText: string): string {
  return createHash('sha256').update(sourceText).digest('hex');
}

function extractResponseText(response: GenerateContentResponse): string {
  return (
    response.candidates?.[0]?.content?.parts
      ?.filter((part) => !(part as Record<string, unknown>)['thought'])
      .map((part) => part.text ?? '')
      .join('')
      .trim() || ''
  );
}

function parseTranslatedText(response: GenerateContentResponse): string | null {
  const text = extractResponseText(response);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const translation = parsed['translation'];
    return typeof translation === 'string' ? translation.trim() : null;
  } catch {
    return text;
  }
}

function buildTranslationPrompt(
  sourceText: string,
  targetLanguage: string,
): string {
  return [
    `Translate this CLI slash-command menu description into ${targetLanguage}.`,
    'Return JSON only: {"translation":"..."}',
    'Rules:',
    '- Translate only natural-language prose.',
    '- Preserve slash commands such as /review or /qc:create-pr.',
    '- Preserve flags, env vars, file names, code spans, and quoted literals.',
    '- Preserve product names and technical identifiers such as Qwen Code, MCP, CLI, IDE, GitHub, VS Code, Cursor, Windsurf, JetBrains, and model IDs unless they are normally localized.',
    '- Keep the text concise and suitable for a slash-command suggestion list.',
    '- Do not add explanations or surrounding quotes.',
    '',
    'Source text:',
    sourceText,
  ].join('\n');
}

export function markDynamicDescriptionSource(
  command: SlashCommand,
  kind: DynamicCommandKind,
  sourceText: string,
): void {
  Object.defineProperty(command, DYNAMIC_DESCRIPTION_SOURCE, {
    value: {
      kind,
      sourceText,
    } satisfies DynamicDescriptionSource,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

function getDynamicDescriptionSource(
  command: SlashCommand,
): DynamicDescriptionSource | null {
  const metadata = (
    command as SlashCommand & {
      [DYNAMIC_DESCRIPTION_SOURCE]?: DynamicDescriptionSource;
    }
  )[DYNAMIC_DESCRIPTION_SOURCE];
  if (!metadata || !isDynamicCommandKind(metadata.kind)) {
    return null;
  }
  return metadata;
}

export class DynamicCommandTranslationService {
  private readonly cacheByLanguage = new Map<
    string,
    Map<string, TranslationCacheEntry>
  >();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failureCooldownUntil = new Map<string, number>();
  private readonly languageGeneration = new Map<string, number>();
  private trackedSources: DynamicDescriptionSource[] = [];

  constructor(
    private readonly config: Config | null,
    private readonly options: {
      onTranslationsUpdated?: () => void;
      failureCooldownMs?: number;
    } = {},
  ) {}

  getDescription(kind: CommandKind, sourceText: string): string {
    if (!this.shouldTranslate(kind, sourceText)) {
      return sourceText;
    }
    if (!isDynamicCommandKind(kind)) {
      return sourceText;
    }

    const language = this.getCurrentUiLanguage();
    const cache = this.getCacheForLanguage(language);
    const entry = cache.get(hashSourceText(sourceText));
    if (entry?.sourceText === sourceText && entry.translatedText.trim()) {
      return entry.translatedText;
    }

    this.queueTranslation(kind, sourceText, language);
    return sourceText;
  }

  setTrackedCommands(commands: readonly SlashCommand[]): void {
    const tracked = new Map<string, DynamicDescriptionSource>();

    const visit = (commandList: readonly SlashCommand[]) => {
      for (const command of commandList) {
        const source = getDynamicDescriptionSource(command);
        if (source) {
          tracked.set(
            `${source.kind}:${hashSourceText(source.sourceText)}`,
            source,
          );
        }
        if (command.subCommands?.length) {
          visit(command.subCommands);
        }
      }
    };

    visit(commands);
    this.trackedSources = Array.from(tracked.values());
  }

  refreshTrackedDescriptions(): number {
    const language = this.getCurrentUiLanguage();
    if (language === 'en') {
      return 0;
    }

    let queued = 0;
    for (const source of this.trackedSources) {
      const key = buildCacheKey(language, source.sourceText);
      this.failureCooldownUntil.delete(key);
      this.queueTranslation(source.kind, source.sourceText, language, true);
      queued++;
    }

    return queued;
  }

  clearCurrentLanguageCache(): void {
    const language = this.getCurrentUiLanguage();
    this.cacheByLanguage.delete(language);
    this.languageGeneration.set(
      language,
      this.getLanguageGeneration(language) + 1,
    );

    const cachePath = Storage.getCommandTranslationsCachePath(language);
    try {
      fs.rmSync(cachePath, { force: true });
    } catch (error) {
      debugLogger.warn(
        `Failed to clear dynamic command translation cache for ${language}:`,
        error,
      );
    }
  }

  private shouldTranslate(kind: CommandKind, sourceText: string): boolean {
    return (
      isDynamicCommandKind(kind) &&
      this.getCurrentUiLanguage() !== 'en' &&
      sourceText.trim().length > 0
    );
  }

  private getCacheForLanguage(
    language: string,
  ): Map<string, TranslationCacheEntry> {
    const existing = this.cacheByLanguage.get(language);
    if (existing) {
      return existing;
    }

    const loaded = this.loadCacheFile(language);
    this.cacheByLanguage.set(language, loaded);
    return loaded;
  }

  private loadCacheFile(language: string): Map<string, TranslationCacheEntry> {
    const cachePath = Storage.getCommandTranslationsCachePath(language);
    if (!fs.existsSync(cachePath)) {
      return new Map();
    }

    try {
      const raw = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as TranslationCacheFile;
      if (
        parsed.version !== CACHE_SCHEMA_VERSION ||
        parsed.language !== language ||
        typeof parsed.entries !== 'object'
      ) {
        return new Map();
      }

      return new Map(Object.entries(parsed.entries));
    } catch (error) {
      debugLogger.warn(
        `Failed to read dynamic command translation cache for ${language}:`,
        error,
      );
      return new Map();
    }
  }

  private persistCacheFile(language: string): void {
    const cache = this.getCacheForLanguage(language);
    const cachePath = Storage.getCommandTranslationsCachePath(language);

    const payload: TranslationCacheFile = {
      version: CACHE_SCHEMA_VERSION,
      language,
      entries: Object.fromEntries(cache.entries()),
    };

    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private queueTranslation(
    kind: DynamicCommandKind,
    sourceText: string,
    language: string,
    force: boolean = false,
  ): void {
    const key = buildCacheKey(language, sourceText);
    const cache = this.getCacheForLanguage(language);
    const hash = hashSourceText(sourceText);

    if (!force && cache.has(hash)) {
      return;
    }

    const cooldownUntil = this.failureCooldownUntil.get(key) ?? 0;
    if (!force && cooldownUntil > Date.now()) {
      return;
    }

    if (this.inFlight.has(key)) {
      return;
    }

    const translationPromise = this.translateAndPersist(
      kind,
      sourceText,
      language,
      hash,
      this.getLanguageGeneration(language),
    ).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, translationPromise);
  }

  private async translateAndPersist(
    kind: DynamicCommandKind,
    sourceText: string,
    language: string,
    hash: string,
    generation: number,
  ): Promise<void> {
    if (!this.config) {
      return;
    }

    const model = this.config.getModel?.();
    if (!model) {
      return;
    }

    try {
      const generator = this.config.getContentGenerator();
      const response = await generator.generateContent(
        {
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: buildTranslationPrompt(
                    sourceText,
                    getLanguageNameFromLocale(language),
                  ),
                },
              ],
            },
          ],
          config: {
            tools: [],
            thinkingConfig: { includeThoughts: false },
            responseMimeType: 'application/json',
            responseJsonSchema: TRANSLATION_SCHEMA,
          },
        },
        `${PROMPT_ID}_${kind}_${language}`,
      );

      const translatedText = parseTranslatedText(response);
      if (!translatedText) {
        throw new Error('Translation model returned an empty response.');
      }

      if (this.getLanguageGeneration(language) !== generation) {
        return;
      }

      const cache = this.getCacheForLanguage(language);
      cache.set(hash, {
        sourceText,
        translatedText,
        updatedAt: new Date().toISOString(),
        translator: 'dynamic-command-translation',
        translatorVersion: CACHE_SCHEMA_VERSION,
        model,
      });
      this.persistCacheFile(language);
      this.options.onTranslationsUpdated?.();
    } catch (error) {
      const key = buildCacheKey(language, sourceText);
      this.failureCooldownUntil.set(
        key,
        Date.now() +
          (this.options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS),
      );
      debugLogger.warn(
        `Failed to translate dynamic ${kind} description for ${language}:`,
        error,
      );
    }
  }

  private getLanguageGeneration(language: string): number {
    return this.languageGeneration.get(language) ?? 0;
  }

  private getCurrentUiLanguage(): string {
    return getCurrentLanguage();
  }
}
