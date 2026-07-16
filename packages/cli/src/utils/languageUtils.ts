/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for managing the LLM output language rule file.
 * This file handles the creation and maintenance of ~/.qwen/output-language.md
 * which instructs the LLM to respond in the user's preferred language.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import { getLanguageNameFromLocale } from '../i18n/index.js';
import { SUPPORTED_LANGUAGES } from '../i18n/languages.js';

const LLM_OUTPUT_LANGUAGE_RULE_FILENAME = 'output-language.md';
const LLM_OUTPUT_LANGUAGE_MARKER_PREFIX = 'qwen-code:llm-output-language:';

/** Special value meaning "follow the user's input language" */
export const OUTPUT_LANGUAGE_AUTO = 'auto';

/**
 * Checks if a value represents the "auto" setting.
 */
export function isAutoLanguage(value: string | undefined | null): boolean {
  return !value || value.toLowerCase() === OUTPUT_LANGUAGE_AUTO;
}

/**
 * Normalizes a language input to its canonical form.
 * Converts known locale codes (e.g., "zh", "ru") to full names (e.g., "Chinese", "Russian").
 * Unknown inputs are returned as-is to support any language name.
 */
export function normalizeOutputLanguage(language: string): string {
  const normalized = language.trim().replace(/_/g, '-').toLowerCase();
  const knownLanguageName = SUPPORTED_LANGUAGES.find(
    (supportedLanguage) =>
      supportedLanguage.fullName.toLowerCase() === normalized,
  );
  if (knownLanguageName) {
    return knownLanguageName.fullName;
  }

  const knownLocaleCode = SUPPORTED_LANGUAGES.some((supportedLanguage) => {
    const code = supportedLanguage.code.toLowerCase();
    const id = supportedLanguage.id.toLowerCase();
    return (
      normalized === code ||
      normalized === id ||
      normalized.startsWith(`${code}-`) ||
      normalized.startsWith(`${id}-`) ||
      normalized.startsWith(`${code}.`) ||
      normalized.startsWith(`${id}.`) ||
      normalized.startsWith(`${code}@`) ||
      normalized.startsWith(`${id}@`)
    );
  });
  if (!knownLocaleCode) {
    return language;
  }

  return getLanguageNameFromLocale(normalized);
}

/**
 * Resolves an explicit output language to its canonical form.
 */
export function resolveOutputLanguage(value: string): string {
  if (isAutoLanguage(value)) {
    throw new Error(
      'resolveOutputLanguage does not accept auto; use resolveOutputLanguageOrPreserveAuto instead.',
    );
  }
  return normalizeOutputLanguage(value);
}

/**
 * Preserves 'auto' as the dynamic same-language mode, otherwise resolves an
 * explicit language to its canonical form.
 */
export function resolveOutputLanguageOrPreserveAuto(
  value: string | undefined | null,
): string {
  return isAutoLanguage(value)
    ? OUTPUT_LANGUAGE_AUTO
    : resolveOutputLanguage(value!);
}

/**
 * Returns the path to the LLM output language rule file (~/.qwen/output-language.md).
 */
export function getOutputLanguageFilePath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    LLM_OUTPUT_LANGUAGE_RULE_FILENAME,
  );
}

/**
 * Sanitizes a language string for use in an HTML comment marker.
 * Removes characters that could break HTML comment syntax.
 */
function sanitizeForMarker(language: string): string {
  return language
    .replace(/[\r\n]/g, ' ')
    .replace(/--!?>/g, '')
    .replace(/--/g, '');
}

/**
 * Generates the content for the LLM output language rule file.
 */
function generateOutputLanguageFileContent(language: string): string {
  const safeLanguage = sanitizeForMarker(language);
  if (isAutoLanguage(language)) {
    return `# Output language preference: ${OUTPUT_LANGUAGE_AUTO}
<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${OUTPUT_LANGUAGE_AUTO} -->

## Rule
Respond in the same language as the user's input.

## Exception
If the user **explicitly** requests a response in a specific language (e.g., "please reply in English"), switch to the user's requested language for the remainder of the conversation.

## Mixed-language input
If the user mixes languages, use the language that best matches the user's main request.

## Keep technical artifacts unchanged
Do **not** translate or rewrite:
- Code blocks, CLI commands, file paths, stack traces, logs, JSON keys, identifiers
- Exact quoted text from the user (keep quotes verbatim)

## Tool / system outputs
Raw tool/system outputs may contain fixed-format English. Preserve them verbatim, and if needed, add a short explanation in the user's language below.
`;
  }

  return `# Output language preference: ${language}
<!-- ${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX} ${safeLanguage} -->

## Rule
You MUST always respond in **${language}** regardless of the user's input language.
This is a mandatory requirement, not a preference.

## Exception
If the user **explicitly** requests a response in a specific language (e.g., "please reply in English", "用中文回答"), switch to the user's requested language for the remainder of the conversation.

## Keep technical artifacts unchanged
Do **not** translate or rewrite:
- Code blocks, CLI commands, file paths, stack traces, logs, JSON keys, identifiers
- Exact quoted text from the user (keep quotes verbatim)

## Tool / system outputs
Raw tool/system outputs may contain fixed-format English. Preserve them verbatim, and if needed, add a short **${language}** explanation below.
`;
}

/**
 * Extracts the language from the content of an output language rule file.
 * Supports both the new marker format and legacy heading format.
 */
function parseOutputLanguageFromContent(content: string): string | null {
  // Primary: machine-readable marker (e.g., <!-- qwen-code:llm-output-language: 中文 -->)
  const markerRegex = new RegExp(
    String.raw`<!--\s*${LLM_OUTPUT_LANGUAGE_MARKER_PREFIX}\s*(.*?)\s*-->`,
    'i',
  );
  const markerMatch = content.match(markerRegex);
  if (markerMatch?.[1]?.trim()) {
    return markerMatch[1].trim();
  }

  // Fallback: legacy heading format (e.g., # CRITICAL: Chinese Output Language Rule)
  const headingMatch = content.match(
    /^#.*?CRITICAL:\s*(.*?)\s+Output Language Rule\b/im,
  );
  if (headingMatch?.[1]?.trim()) {
    return headingMatch[1].trim();
  }

  return null;
}

/**
 * Reads the current output-language file content.
 */
function readOutputLanguageFileContent(): string | null {
  const filePath = getOutputLanguageFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function isGeneratedOutputLanguageFileContent(
  content: string,
  language: string,
): boolean {
  return (
    content.trimEnd() === generateOutputLanguageFileContent(language).trimEnd()
  );
}

/**
 * Writes the output language rule file with the given language.
 *
 * @param targetPath - When provided, write to this path instead of the
 *   global default.  Callers should pass `config.getOutputLanguageFilePath()`
 *   so the file that the session actually reads is the one being updated.
 */
export function writeOutputLanguageFile(
  language: string,
  targetPath?: string,
): void {
  const filePath = targetPath ?? getOutputLanguageFilePath();
  const content = generateOutputLanguageFileContent(language);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Updates the LLM output language rule file based on the setting value.
 * Preserves 'auto' as a dynamic same-language rule, and resolves explicit
 * languages before writing.
 *
 * @param targetPath - Forwarded to {@link writeOutputLanguageFile}.
 */
export function updateOutputLanguageFile(
  settingValue: string,
  targetPath?: string,
): void {
  const resolved = resolveOutputLanguageOrPreserveAuto(settingValue);
  writeOutputLanguageFile(resolved, targetPath);
}

/**
 * Writes the output-language file to the correct (config-bound) path and,
 * when no path was known yet (first-time creation), registers the global
 * default on the config so subsequent reads are consistent.
 *
 * This encapsulates the get-path → write → register-fallback sequence
 * that was previously duplicated across acpAgent, languageCommand, and
 * SettingsDialog.
 */
export function writeOutputLanguageAndRegisterPath(
  settingValue: string,
  config?: {
    getOutputLanguageFilePath(): string | undefined;
    setOutputLanguageFilePath(p: string): void;
  } | null,
): void {
  const targetPath = config?.getOutputLanguageFilePath();
  updateOutputLanguageFile(settingValue, targetPath);
  if (!targetPath) {
    config?.setOutputLanguageFilePath(getOutputLanguageFilePath());
  }
}

/**
 * Initializes the LLM output language rule file on application startup.
 *
 * @param outputLanguage - The output language setting value (e.g., 'auto', 'Chinese', etc.)
 *
 * Behavior:
 * - If the rule file already exists and contains a valid language setting, do nothing (preserve user modifications)
 * - If the setting is explicitly 'auto' but the rule file contains a fixed language from the old auto behavior, migrate it to the same-language rule
 * - If the rule file doesn't exist, create it with the configured rule ('auto' -> same-language rule, explicit language -> fixed-language rule)
 */
export function initializeLlmOutputLanguage(outputLanguage?: string): void {
  // Check if the file already exists and has valid content
  const currentFileContent = readOutputLanguageFileContent();
  const currentFileLanguage =
    currentFileContent === null
      ? null
      : parseOutputLanguageFromContent(currentFileContent);
  const shouldMigrateFixedFileToAuto =
    outputLanguage?.trim().toLowerCase() === OUTPUT_LANGUAGE_AUTO &&
    currentFileLanguage !== null &&
    !isAutoLanguage(currentFileLanguage) &&
    currentFileContent !== null &&
    isGeneratedOutputLanguageFileContent(
      currentFileContent,
      currentFileLanguage,
    );

  // If file exists with valid language, preserve it unless explicit auto needs migration.
  if (currentFileLanguage && !shouldMigrateFixedFileToAuto) {
    return;
  }

  // File doesn't exist or has invalid content, create it with configured language behavior
  const resolved = resolveOutputLanguageOrPreserveAuto(outputLanguage);
  writeOutputLanguageFile(resolved);
}
