/**
 * @license
 * Copyright 2025 Google LLC
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
  type SupportedLanguage,
  t,
} from '../../i18n/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

const LLM_OUTPUT_LANGUAGE_RULE_FILENAME = 'output-language.md';

/**
 * Generates the LLM output language rule template based on the language name.
 */
function generateLlmOutputLanguageRule(language: string): string {
  return `# ⚠️ CRITICAL: ${language} Output Language Rule - HIGHEST PRIORITY ⚠️

## 🚨 MANDATORY RULE - NO EXCEPTIONS 🚨

**YOU MUST RESPOND IN ${language.toUpperCase()} FOR EVERY SINGLE OUTPUT, REGARDLESS OF THE USER'S INPUT LANGUAGE.**

This is a **NON-NEGOTIABLE** requirement. Even if the user writes in English, says "hi", asks a simple question, or explicitly requests another language, **YOU MUST ALWAYS RESPOND IN ${language.toUpperCase()}.**

## What Must Be in ${language}

**EVERYTHING** you output: conversation replies, tool call descriptions, success/error messages, generated file content (comments, documentation), and all explanatory text.

**Tool outputs**: All descriptive text from \`read_file\`, \`write_file\`, \`codebase_search\`, \`run_terminal_cmd\`, \`todo_write\`, \`web_search\`, etc. MUST be in ${language}.

## Examples

### ✅ CORRECT:
- User says "hi" → Respond in ${language} (e.g., "Bonjour" if ${language} is French)
- Tool result → "已成功读取文件 config.json" (if ${language} is Chinese)
- Error → "无法找到指定的文件" (if ${language} is Chinese)

### ❌ WRONG:
- User says "hi" → "Hello" in English
- Tool result → "Successfully read file" in English
- Error → "File not found" in English

## Notes

- Code elements (variable/function names, syntax) can remain in English
- Comments, documentation, and all other text MUST be in ${language}

**THIS RULE IS ACTIVE NOW. ALL OUTPUTS MUST BE IN ${language.toUpperCase()}. NO EXCEPTIONS.**
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
 * Gets the current LLM output language from the rule file if it exists.
 */
function getCurrentLlmOutputLanguage(): string | null {
  const filePath = getLlmOutputLanguageRulePath();
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Extract language name from the first line
      // Template format: "# CRITICAL: Chinese Output Language Rule - HIGHEST PRIORITY"
      const match = content.match(/^#.*?(\w+)\s+Output Language Rule/i);
      if (match) {
        return match[1];
      }
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

  // Map language codes to friendly display names
  const langDisplayNames: Partial<Record<SupportedLanguage, string>> = {
    zh: '中文（zh-CN）',
    en: 'English（en-US）',
    ru: 'Русский (ru-RU)',
  };

  return {
    type: 'message',
    messageType: 'info',
    content: t('UI language changed to {{lang}}', {
      lang: langDisplayNames[lang] || lang,
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
    const content = generateLlmOutputLanguageRule(language);

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

    // If no arguments, show current language settings and usage
    if (!trimmedArgs) {
      const currentUiLang = getCurrentLanguage();
      const currentLlmLang = getCurrentLlmOutputLanguage();
      const message = [
        t('Current UI language: {{lang}}', { lang: currentUiLang }),
        currentLlmLang
          ? t('Current LLM output language: {{lang}}', { lang: currentLlmLang })
          : t('LLM output language not set'),
        '',
        t('Available subcommands:'),
        `  /language ui [zh-CN|en-US|ru-RU] - ${t('Set UI language')}`,
        `  /language output <language> - ${t('Set LLM output language')}`,
      ].join('\n');

      return {
        type: 'message',
        messageType: 'info',
        content: message,
      };
    }

    // Parse subcommand
    const parts = trimmedArgs.split(/\s+/);
    const subcommand = parts[0].toLowerCase();

    if (subcommand === 'ui') {
      // Handle /language ui [zh-CN|en-US|ru-RU]
      if (parts.length === 1) {
        // Show UI language subcommand help
        return {
          type: 'message',
          messageType: 'info',
          content: [
            t('Set UI language'),
            '',
            t('Usage: /language ui [zh-CN|en-US|ru-RU]'),
            '',
            t('Available options:'),
            t('  - zh-CN: Simplified Chinese'),
            t('  - en-US: English'),
            t('  - ru-RU: Russian'),
            '',
            t(
              'To request additional UI language packs, please open an issue on GitHub.',
            ),
          ].join('\n'),
        };
      }

      const langArg = parts[1].toLowerCase();
      let targetLang: SupportedLanguage | null = null;

      if (langArg === 'en' || langArg === 'english' || langArg === 'en-us') {
        targetLang = 'en';
      } else if (
        langArg === 'zh' ||
        langArg === 'chinese' ||
        langArg === '中文' ||
        langArg === 'zh-cn'
      ) {
        targetLang = 'zh';
      } else if (
        langArg === 'ru' ||
        langArg === 'ru-RU' ||
        langArg === 'russian' ||
        langArg === 'русский'
      ) {
        targetLang = 'ru';
      } else {
        return {
          type: 'message',
          messageType: 'error',
          content: t('Invalid language. Available: en-US, zh-CN, ru-RU'),
        };
      }

      return setUiLanguage(context, targetLang);
    } else if (subcommand === 'output') {
      // Handle /language output <language>
      if (parts.length === 1) {
        return {
          type: 'message',
          messageType: 'info',
          content: [
            t('Set LLM output language'),
            '',
            t('Usage: /language output <language>'),
            `  ${t('Example: /language output 中文')}`,
          ].join('\n'),
        };
      }

      // Join all parts after "output" as the language name
      const language = parts.slice(1).join(' ');
      return generateLlmOutputLanguageRuleFile(language);
    } else {
      // Backward compatibility: treat as UI language
      const langArg = trimmedArgs.toLowerCase();
      let targetLang: SupportedLanguage | null = null;

      if (langArg === 'en' || langArg === 'english' || langArg === 'en-us') {
        targetLang = 'en';
      } else if (
        langArg === 'zh' ||
        langArg === 'chinese' ||
        langArg === '中文' ||
        langArg === 'zh-cn'
      ) {
        targetLang = 'zh';
      } else if (
        langArg === 'ru' ||
        langArg === 'ru-RU' ||
        langArg === 'russian' ||
        langArg === 'русский'
      ) {
        targetLang = 'ru';
      } else {
        return {
          type: 'message',
          messageType: 'error',
          content: [
            t('Invalid command. Available subcommands:'),
            '  - /language ui [zh-CN|en-US|ru-RU] - ' + t('Set UI language'),
            '  - /language output <language> - ' + t('Set LLM output language'),
          ].join('\n'),
        };
      }

      return setUiLanguage(context, targetLang);
    }
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
              t('Usage: /language ui [zh-CN|en-US]'),
              '',
              t('Available options:'),
              t('  - zh-CN: Simplified Chinese'),
              t('  - en-US: English'),
              '',
              t(
                'To request additional UI language packs, please open an issue on GitHub.',
              ),
            ].join('\n'),
          };
        }

        const langArg = trimmedArgs.toLowerCase();
        let targetLang: SupportedLanguage | null = null;

        if (langArg === 'en' || langArg === 'english' || langArg === 'en-us') {
          targetLang = 'en';
        } else if (
          langArg === 'zh' ||
          langArg === 'chinese' ||
          langArg === '中文' ||
          langArg === 'zh-cn'
        ) {
          targetLang = 'zh';
        } else {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Invalid language. Available: en-US, zh-CN'),
          };
        }

        return setUiLanguage(context, targetLang);
      },
      subCommands: [
        {
          name: 'zh-CN',
          altNames: ['zh', 'chinese', '中文'],
          get description() {
            return t('Set UI language to Simplified Chinese (zh-CN)');
          },
          kind: CommandKind.BUILT_IN,
          action: async (
            context: CommandContext,
            args: string,
          ): Promise<MessageActionReturn> => {
            if (args.trim().length > 0) {
              return {
                type: 'message',
                messageType: 'error',
                content: t(
                  'Language subcommands do not accept additional arguments.',
                ),
              };
            }
            return setUiLanguage(context, 'zh');
          },
        },
        {
          name: 'en-US',
          altNames: ['en', 'english'],
          get description() {
            return t('Set UI language to English (en-US)');
          },
          kind: CommandKind.BUILT_IN,
          action: async (
            context: CommandContext,
            args: string,
          ): Promise<MessageActionReturn> => {
            if (args.trim().length > 0) {
              return {
                type: 'message',
                messageType: 'error',
                content: t(
                  'Language subcommands do not accept additional arguments.',
                ),
              };
            }
            return setUiLanguage(context, 'en');
          },
        },
        {
          name: 'ru-RU',
          altNames: ['ru', 'russian', 'русский'],
          get description() {
            return t('Set UI language to Russian (ru-RU)');
          },
          kind: CommandKind.BUILT_IN,
          action: async (
            context: CommandContext,
            args: string,
          ): Promise<MessageActionReturn> => {
            if (args.trim().length > 0) {
              return {
                type: 'message',
                messageType: 'error',
                content: t(
                  'Language subcommands do not accept additional arguments.',
                ),
              };
            }
            return setUiLanguage(context, 'ru');
          },
        },
      ],
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
