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
  const fences: Array<{
    value?: string;
    lang?: string | null;
    meta?: string | null;
  }> = [];
  // Translation may reorder spans and links, but must keep each one.
  const spans: string[] = [];
  walkMarkdown(root, ({ type, value, lang, meta, url, children }) => {
    if (type === 'text' && value) words.push(value);
    else if (type === 'code') fences.push({ value, lang, meta });
    else if (type === 'inlineCode') spans.push(`code:${value}`);
    else if (type === 'math' || type === 'inlineMath' || type === 'html')
      spans.push(`${type}:${value}`);
    else if (url !== undefined) {
      // A bare URL shows its own target, and CJK punctuation after it
      // parses as part of it.
      const shown = children?.length === 1 ? children[0].value : undefined;
      const bare =
        type === 'link' &&
        shown !== undefined &&
        /^(?:https?|mailto):/i.test(url) &&
        [shown, `mailto:${shown}`, `http://${shown}`].includes(url);
      spans.push(`url:${bare ? url.replace(/[^\x21-\x7e]+$/u, '') : url}`);
    }
  });
  return { prose: words.join(' '), code: { fences, spans: spans.sort() } };
}

async function terminalMarkdown() {
  const [{ getFencedCodeBlocks }, { MD_LINK_PATTERN, MD_LINK_CAPTURE }] =
    await Promise.all([
      import('../ui/utils/markdown-utilities.js'),
      import('../ui/utils/osc8.js'),
    ]);
  const link = new RegExp(MD_LINK_PATTERN, 'g');
  return (text: string) => ({
    fences: getFencedCodeBlocks(text),
    urls: Array.from(
      text.matchAll(link),
      ([token]) => token.match(MD_LINK_CAPTURE)?.[2],
    ).sort(),
  });
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
    // CommonMark treats as part of a paragraph, and links that CommonMark
    // treats as escaped text or raw HTML.
    const translated = await inspectMarkdown(text);
    const terminal =
      surface === 'terminal' ? await terminalMarkdown() : undefined;
    if (
      !translated ||
      !isDeepStrictEqual(source.code, translated.code) ||
      (terminal && !isDeepStrictEqual(terminal(original), terminal(text)))
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
