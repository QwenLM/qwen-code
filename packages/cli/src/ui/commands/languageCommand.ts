/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { SettingScope } from '../../config/settings.js';
import {
  setLanguageAsync,
  getCurrentLanguage,
  detectSystemLanguage,
  getLanguageNameFromLocale,
  type SupportedLanguage,
  t,
} from '../../i18n/index.js';
import {
  SUPPORTED_LANGUAGES,
  type LanguageDefinition,
} from '../../i18n/languages.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

const LLM_OUTPUT_LANGUAGE_RULE_FILENAME = 'output-language.md';
const LLM_OUTPUT_LANGUAGE_MARKER_PREFIX = 'qwen-code:llm-output-language:';

function parseUiLanguageArg(input: string): SupportedLanguage | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  for (const lang of SUPPORTED_LANGUAGES) {
    if (
      lowered === lang.code ||
      lowered === lang.id.toLowerCase() ||
      lowered === lang.fullName.toLowerCase()
    ) {
      return lang.code;
    }
  }
  return null;
}

function formatUiLanguageDisplay(lang: SupportedLanguage): string {
  const option = SUPPORTED_LANGUAGES.find((o) => o.code === lang);
  return option ? `${option.fullName}（${option.id}）` : lang;
}

function sanitizeLanguageForMarker(language: string): string {
  // HTML comments cannot contain "--" or end markers like "-->" or "--!>" safely.
  // Also avoid newlines to keep the marker single-line and robust to parsing.
  return language
    .replace(/[\r\n]/g, ' ')
    .replace(/--!?>/g, '')
    .replace(/--/g, '');
}

/**
 * Generates the LLM output language rule template based on the language name.
 */
function generateLlmOutputLanguageRule(language: string): string {
  const markerLanguage = sanitizeLanguageForMarker(language);
  return `# Output language preference: ${language}
<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${markerLanguage} -->

## Goal
Prefer responding in **${language}** for normal assistant messages and explanations.

## Keep technical artifacts unchanged
Do **not** translate or rewrite:
- Code blocks, CLI commands, file paths, stack traces, logs, JSON keys, identifiers
- Exact quoted text from the user (keep quotes verbatim)

## When a conflict exists
If higher-priority instructions (system/developer) require a different behavior, follow them.

## Tool / system outputs
Raw tool/system outputs may contain fixed-format English. Preserve them verbatim, and if needed, add a short **${language}** explanation below.
`;
}

/**
 * Gets the path to the LLM output language rule file.
 */
function getLlmOutputLanguageRulePath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    LLM_OUTPUT_LANGUAGE_RULE_FILENAME,
  );
}

/**
 * Normalizes a language input to its full English name.
 * If the input is a known locale code (e.g., "ru", "zh"), converts it to the full name.
 * Otherwise, returns the input as-is (e.g., "Japanese" stays "Japanese").
 */
function normalizeLanguageName(language: string): string {
  const lowered = language.toLowerCase();
  // Check if it's a known locale code and convert to full name
  const fullName = getLanguageNameFromLocale(lowered);
  // If getLanguageNameFromLocale returned a different value, use it
  // Otherwise, use the original input (preserves case for unknown languages)
  if (fullName !== 'English' || lowered === 'en') {
    return fullName;
  }
  return language;
}

function extractLlmOutputLanguageFromRuleFileContent(
  content: string,
): string | null {
  // Preferred: machine-readable marker that supports Unicode and spaces.
  // Example: <!-- qwen-code:llm-output-language: 中文 -->
  const markerMatch = content.match(
    new RegExp(
      String.raw`<!--\s*${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX}\s*(.*?)\s*-->`,
      'i',
    ),
  );
  if (markerMatch?.[1]) {
    const lang = markerMatch[1].trim();
    if (lang) return lang;
  }

  // Backward compatibility: parse the heading line.
  // Example: "# CRITICAL: Chinese Output Language Rule - HIGHEST PRIORITY"
  // Example: "# ⚠️ CRITICAL: 日本語 Output Language Rule - HIGHEST PRIORITY ⚠️"
  const headingMatch = content.match(
    /^#.*?CRITICAL:\s*(.*?)\s+Output Language Rule\b/im,
  );
  if (headingMatch?.[1]) {
    const lang = headingMatch[1].trim();
    if (lang) return lang;
  }

  return null;
}

/**
 * Initializes the LLM output language rule file on first startup.
 * If the file already exists, it is not overwritten (respects user preference).
 */
export function initializeLlmOutputLanguage(): void {
  const filePath = getLlmOutputLanguageRulePath();

  // Skip if file already exists (user preference)
  if (fs.existsSync(filePath)) {
    return;
  }

  // Detect system language and map to language name
  const detectedLocale = detectSystemLanguage();
  const languageName = getLanguageNameFromLocale(detectedLocale);

  // Generate the rule file
  const content = generateLlmOutputLanguageRule(languageName);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Write file
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Gets the current LLM output language from the rule file if it exists.
 */
function getCurrentLlmOutputLanguage(): string | null {
  const filePath = getLlmOutputLanguageRulePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return extractLlmOutputLanguageFromRuleFileContent(content);
    } catch {
      // Ignore errors
    }
  }
  return null;
}

/**
 * Sets the UI language and persists it to settings.
 */
async function setUiLanguage(
  context: CommandContext,
  lang: SupportedLanguage,
): Promise<MessageActionReturn> {
  const { services } = context;
  const { settings } = services;

  if (!services.config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('Configuration not available.'),
    };
  }

  // Set language in i18n system (async to support JS translation files)
  await setLanguageAsync(lang);

  // Persist to settings (user scope)
  if (settings && typeof settings.setValue === 'function') {
    try {
      settings.setValue(SettingScope.User, 'general.language', lang);
    } catch (error) {
      console.warn('Failed to save language setting:', error);
    }
  }

  // Reload commands to update their descriptions with the new language
  context.ui.reloadCommands();

  return {
    type: 'message',
    messageType: 'info',
    content: t('UI language changed to {{lang}}', {
      lang: formatUiLanguageDisplay(lang),
    }),
  };
}

/**
 * Generates the LLM output language rule file.
 */
function generateLlmOutputLanguageRuleFile(
  language: string,
): Promise<MessageActionReturn> {
  try {
    const filePath = getLlmOutputLanguageRulePath();
    // Normalize locale codes (e.g., "ru" -> "Russian") to full language names
    const normalizedLanguage = normalizeLanguageName(language);
    const content = generateLlmOutputLanguageRule(normalizedLanguage);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Write file (overwrite if exists)
    fs.writeFileSync(filePath, content, 'utf-8');

    return Promise.resolve({
      type: 'message',
      messageType: 'info',
      content: [
        t('LLM output language rule file generated at {{path}}', {
          path: filePath,
        }),
        '',
        t('Please restart the application for the changes to take effect.'),
      ].join('\n'),
    });
  } catch (error) {
    return Promise.resolve({
      type: 'message',
      messageType: 'error',
      content: t(
        'Failed to generate LLM output language rule file: {{error}}',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    });
  }
}

export const languageCommand: SlashCommand = {
  name: 'language',
  get description() {
    return t('View or change the language setting');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const { services } = context;
    if (!services.config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Configuration not available.'),
      };
    }

    const trimmedArgs = args.trim();

    // Handle subcommands if called directly via action (for tests/backward compatibility)
    const parts = trimmedArgs.split(/\s+/);
    const firstArg = parts[0].toLowerCase();
    const subArgs = parts.slice(1).join(' ');

    if (firstArg === 'ui' || firstArg === 'output') {
      const subCommand = languageCommand.subCommands?.find(
        (s) => s.name === firstArg,
      );
      if (subCommand?.action) {
        return subCommand.action(
          context,
          subArgs,
        ) as Promise<SlashCommandActionReturn>;
      }
    }

    // If no arguments, show current language settings and usage
    if (!trimmedArgs) {
      const currentUiLang = getCurrentLanguage();
      const currentLlmLang = getCurrentLlmOutputLanguage();
      const message = [
        t('Current UI language: {{lang}}', {
          lang: formatUiLanguageDisplay(currentUiLang as SupportedLanguage),
        }),
        currentLlmLang
          ? t('Current LLM output language: {{lang}}', { lang: currentLlmLang })
          : t('LLM output language not set'),
        '',
        t('Available subcommands:'),
        `  /language ui [${SUPPORTED_LANGUAGES.map((o) => o.id).join('|')}] - ${t('Set UI language')}`,
        `  /language output <language> - ${t('Set LLM output language')}`,
      ].join('\n');

      return {
        type: 'message',
        messageType: 'info',
        content: message,
      };
    }

    // Handle backward compatibility for /language [lang]
    const targetLang = parseUiLanguageArg(trimmedArgs);
    if (targetLang) {
      return setUiLanguage(context, targetLang);
    }

    return {
      type: 'message',
      messageType: 'error',
      content: [
        t('Invalid command. Available subcommands:'),
        `  - /language ui [${SUPPORTED_LANGUAGES.map((o) => o.id).join('|')}] - ${t('Set UI language')}`,
        '  - /language output <language> - ' + t('Set LLM output language'),
      ].join('\n'),
    };
  },
  subCommands: [
    {
      name: 'ui',
      get description() {
        return t('Set UI language');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn> => {
        const trimmedArgs = args.trim();
        if (!trimmedArgs) {
          return {
            type: 'message',
            messageType: 'info',
            content: [
              t('Set UI language'),
              '',
              t('Usage: /language ui [{{options}}]', {
                options: SUPPORTED_LANGUAGES.map((o) => o.id).join('|'),
              }),
              '',
              t('Available options:'),
              ...SUPPORTED_LANGUAGES.map(
                (o) => `  - ${o.id}: ${t(o.fullName)}`,
              ),
              '',
              t(
                'To request additional UI language packs, please open an issue on GitHub.',
              ),
            ].join('\n'),
          };
        }

        const targetLang = parseUiLanguageArg(trimmedArgs);
        if (!targetLang) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Invalid language. Available: {{options}}', {
              options: SUPPORTED_LANGUAGES.map((o) => o.id).join(','),
            }),
          };
        }

        return setUiLanguage(context, targetLang);
      },
      subCommands: SUPPORTED_LANGUAGES.map(createUiLanguageSubCommand),
    },
    {
      name: 'output',
      get description() {
        return t('Set LLM output language');
      },
      kind: CommandKind.BUILT_IN,
      action: async (
        context: CommandContext,
        args: string,
      ): Promise<MessageActionReturn> => {
        const trimmedArgs = args.trim();
        if (!trimmedArgs) {
          return {
            type: 'message',
            messageType: 'info',
            content: [
              t('Set LLM output language'),
              '',
              t('Usage: /language output <language>'),
              `  ${t('Example: /language output 中文')}`,
              `  ${t('Example: /language output English')}`,
              `  ${t('Example: /language output 日本語')}`,
            ].join('\n'),
          };
        }

        return generateLlmOutputLanguageRuleFile(trimmedArgs);
      },
    },
  ],
};

/**
 * Helper to create a UI language subcommand.
 */
function createUiLanguageSubCommand(option: LanguageDefinition): SlashCommand {
  return {
    name: option.id,
    get description() {
      return t('Set UI language to {{name}}', { name: option.fullName });
    },
    kind: CommandKind.BUILT_IN,
    action: async (context, args) => {
      if (args.trim().length > 0) {
        return {
          type: 'message',
          messageType: 'error',
          content: t(
            'Language subcommands do not accept additional arguments.',
          ),
        };
      }
      return setUiLanguage(context, option.code);
    },
  };
}
