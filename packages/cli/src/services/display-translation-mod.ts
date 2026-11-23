/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  ModModelCompleteInput,
  ModModelCompleteResult,
} from '@qwen-code/qwen-code-core/mods/types.js';
import type {
  ModRenderSite,
  ModRenderSurface,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { LoadedSettings } from '../config/settings.js';

export type DisplayTranslationTarget = 'zh-CN' | 'en';

const logger = createDebugLogger('MODS');
const SITES: readonly ModRenderSite[] = ['AssistantMessage', 'Thinking'];
const LANGUAGES = { 'zh-CN': 'Simplified Chinese', en: 'English' };
const END = '\n[QWEN_DISPLAY_END]';
const TRUNCATED = '\n[... truncated for Mods ...]\n';
let simplifiedChineseConverter: Promise<(text: string) => string> | undefined;

/** The language `general.displayLanguage` shows replies in, if any. */
export function displayTranslationTarget(
  settings: LoadedSettings,
): DisplayTranslationTarget | undefined {
  const value = settings.merged.general?.displayLanguage;
  return value === 'zh-CN' || value === 'en' ? value : undefined;
}

/** Whether a host drawing `sites` draws a row the translation rewrites. */
export function drawsTranslatedRows(sites: readonly ModRenderSite[]): boolean {
  return sites.some((site) => SITES.includes(site));
}

async function inspectMarkdown(text: string) {
  const { parseMarkdown, walkMarkdown } = await import(
    '../ui/utils/export/markdown-document-policy.js'
  );
  const root = parseMarkdown(text);
  if (!root) return undefined;
  const words: string[] = [];
  const code: Array<{
    type: 'code' | 'inlineCode';
    value?: string;
    lang?: string | null;
    meta?: string | null;
  }> = [];
  walkMarkdown(root, ({ type, value, lang, meta }) => {
    if (type === 'text' && value) words.push(value);
    if (type === 'code' || type === 'inlineCode') {
      code.push({ type, value, lang, meta });
    }
  });
  return { prose: words.join(' '), code };
}

async function needsTranslation(
  prose: string,
  target: DisplayTranslationTarget,
): Promise<boolean> {
  if (!/\p{Letter}/u.test(prose)) return false;
  if (/[^\p{Script=Han}\p{Script=Latin}\P{Letter}]/u.test(prose)) return true;
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinWords = prose.match(/\p{Script=Latin}+/gu)?.length ?? 0;
  const chinese = han >= latinWords;
  if (target === 'en') return chinese;
  if (!chinese) return true;
  simplifiedChineseConverter ??= import('opencc-js/t2cn').then(
    ({ Converter }) => Converter({ from: 't', to: 'cn' }),
  );
  const toSimplifiedChinese = await simplifiedChineseConverter;
  return toSimplifiedChinese(prose) !== prose;
}

/** Translates a display row, leaving the original in place on failure. */
export async function translateDisplayText(
  original: string,
  target: DisplayTranslationTarget,
  complete: (
    input: ModModelCompleteInput,
    signal: AbortSignal,
  ) => Promise<ModModelCompleteResult>,
  signal: AbortSignal,
  surface: ModRenderSurface = 'desktop',
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  try {
    const source = await inspectMarkdown(original);
    if (!source || !(await needsTranslation(source.prose, target))) {
      return undefined;
    }
    if (signal.aborted) return undefined;

    const result = await complete(
      {
        model: 'haiku',
        system:
          `Translate the Markdown the user sends into ${LANGUAGES[target]}. ` +
          'Keep its Markdown structure, code blocks, inline code, file paths, URLs, ' +
          'commands and identifiers unchanged. Reply with only the full translation, ' +
          `followed by this exact line:${END}`,
        prompt: original,
        maxTokens: 8192,
        timeoutMs: 25_000,
      },
      signal,
    );
    if (signal.aborted) return undefined;
    const answer = result.isAnswered
      ? result.text.replace(/\r/g, '').trimEnd()
      : '';
    const whole = answer.endsWith(END) && !answer.includes(TRUNCATED);
    const text = whole ? answer.slice(0, -END.length) : '';
    if (!text.trim()) {
      logger.debug(
        `Left untranslated: ${!result.isAnswered ? result.reason : whole ? 'empty answer' : 'incomplete answer'}`,
      );
      return undefined;
    }
    // The Web Shell copies the displayed code. Ink also draws fences that
    // CommonMark treats as part of a paragraph.
    const translated = await inspectMarkdown(text);
    const terminalFences =
      surface === 'terminal'
        ? (await import('../ui/utils/markdown-utilities.js'))
            .getFencedCodeBlocks
        : undefined;
    if (
      !translated ||
      !isDeepStrictEqual(source.code, translated.code) ||
      (terminalFences &&
        !isDeepStrictEqual(terminalFences(original), terminalFences(text)))
    ) {
      logger.debug('Left untranslated: code changed');
      return undefined;
    }
    return signal.aborted ? undefined : text;
  } catch (error) {
    logger.debug(`Left untranslated: ${String(error)}`);
    return undefined;
  }
}

/**
 * Whether a session that draws rows starts its Mods: the installed ones, the
 * built-in translation, or both.
 */
export function modsWanted(settings: LoadedSettings): boolean {
  return (
    settings.merged.experimental?.mods === true ||
    displayTranslationTarget(settings) !== undefined
  );
}
