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
  const [{ parseMarkdown, walkMarkdown }, { BARE_URL_BREAK_CHARACTERS }] =
    await Promise.all([
      import('../ui/utils/export/markdown-document-policy.js'),
      import('../ui/utils/osc8.js'),
    ]);
  const root = parseMarkdown(text);
  if (!root) return undefined;
  const cjkPunctuation = new RegExp(
    String.raw`(?=[${BARE_URL_BREAK_CHARACTERS}])\p{P}`,
    'u',
  );
  const words: string[] = [];
  const fences: Array<{
    value?: string;
    lang?: string | null;
    meta?: string | null;
  }> = [];
  // Translation may reorder spans and links, but must keep each one.
  const spans: string[] = [];
  const definitions = new Map<string, string>();
  const references: Array<{ kind: 'link' | 'image'; identifier: string }> = [];
  const punctuationOffsets: number[] = [];
  walkMarkdown(root, (node) => {
    const { type, value, lang, meta, url, identifier, children, position } =
      node;
    if (type === 'text' && value) words.push(value);
    else if (type === 'code') fences.push({ value, lang, meta });
    else if (type === 'inlineCode') spans.push(`code:${value}`);
    else if (type === 'math' || type === 'inlineMath' || type === 'html')
      spans.push(`${type}:${value}`);
    else if (type === 'linkReference' || type === 'imageReference') {
      if (identifier) {
        references.push({
          kind: type === 'linkReference' ? 'link' : 'image',
          identifier,
        });
      }
    } else if (url !== undefined) {
      if (type === 'definition' && identifier && !definitions.has(identifier)) {
        // CommonMark uses the first definition for an identifier.
        definitions.set(identifier, url);
      }
      // CJK punctuation after a bare URL parses as part of it.
      let kept = url;
      const start = position?.start.offset;
      const end = position?.end.offset;
      if (
        type === 'link' &&
        start !== undefined &&
        end !== undefined &&
        children?.length === 1 &&
        children[0].type === 'text'
      ) {
        const raw = text.slice(start, end);
        if (
          raw === children[0].value &&
          [raw, `mailto:${raw}`, `http://${raw}`].includes(url)
        ) {
          let urlEnd = url.length;
          while (cjkPunctuation.test(url.charAt(urlEnd - 1))) urlEnd--;
          if (urlEnd < url.length) {
            kept = url.slice(0, urlEnd);
            punctuationOffsets.push(end - (url.length - urlEnd));
          }
        }
      }
      spans.push(`${type}:${kept}`);
    }
  });
  const referenceTargets = new Map<string, string>();
  for (const { kind, identifier } of references) {
    const url = definitions.get(identifier);
    if (url !== undefined) {
      referenceTargets.set(identifier, url);
      spans.push(`${kind}:${url}`);
    }
  }
  return {
    prose: words.join(' '),
    code: { fences, spans: spans.sort() },
    referenceTargets,
    punctuationOffsets,
  };
}

type MarkdownInspection = NonNullable<
  Awaited<ReturnType<typeof inspectMarkdown>>
>;

function preservesMarkdown(
  original: MarkdownInspection,
  candidate: MarkdownInspection | undefined,
): candidate is MarkdownInspection {
  if (!candidate || !isDeepStrictEqual(original.code, candidate.code))
    return false;
  // Reordering links is fine, but a retained identifier must still point to
  // the same destination even when both URLs still appear in the reply.
  for (const [identifier, url] of candidate.referenceTargets) {
    if ((original.referenceTargets.get(identifier) ?? url) !== url)
      return false;
  }
  return true;
}

async function terminalMarkdown() {
  const [
    { getFencedCodeBlocks },
    { mergeInlineMathMatches },
    { parseInkMarkdownBlocks },
    {
      INK_INLINE_MARKDOWN_PATTERN,
      MD_LINK_PATTERN,
      MD_LINK_CAPTURE,
      isSafeOscScheme,
      sanitizeForOsc,
      shouldWrapMarkdownLink,
      trimTrailingUrlPunctuation,
    },
  ] = await Promise.all([
    import('../ui/utils/markdown-utilities.js'),
    import('../ui/utils/inline-math.js'),
    import('../ui/utils/ink-markdown-blocks.js'),
    import('../ui/utils/osc8.js'),
  ]);
  const link = new RegExp(MD_LINK_PATTERN, 'g');
  const markup = new RegExp(INK_INLINE_MARKDOWN_PATTERN, 'g');
  const inkLinkTargets = (text: string, visual: boolean) => {
    const targets: string[] = [];
    for (const block of parseInkMarkdownBlocks(text.split(/\r?\n/), visual)) {
      const fragments =
        block.kind === 'table'
          ? [...block.headers, ...block.rows.flat()]
          : 'text' in block
            ? [block.text]
            : [];
      for (const fragment of fragments) {
        for (const token of mergeInlineMathMatches(fragment, markup, visual)) {
          if (token.kind !== 'markup') continue;
          const [value] = token.match;
          const linkUrl = MD_LINK_CAPTURE.exec(value)?.[2];
          if (linkUrl && shouldWrapMarkdownLink(linkUrl, true)) {
            targets.push(sanitizeForOsc(linkUrl));
          } else if (
            value.startsWith('https://') ||
            value.startsWith('http://')
          ) {
            const end = (token.match.index ?? 0) + value.length;
            const url = trimTrailingUrlPunctuation(value, fragment[end]);
            if (isSafeOscScheme(url)) targets.push(sanitizeForOsc(url));
          }
        }
      }
    }
    return targets.sort();
  };
  return (text: string) => ({
    fences: getFencedCodeBlocks(text),
    urls: Array.from(
      text.matchAll(link),
      ([token]) => token.match(MD_LINK_CAPTURE)?.[2],
    ).sort(),
    linkTargets: [inkLinkTargets(text, false), inkLinkTargets(text, true)],
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
      !preservesMarkdown(source, translated) ||
      (terminal && !isDeepStrictEqual(terminal(original), terminal(text)))
    ) {
      logger.debug('Left untranslated: code changed');
      return undefined;
    }
    if (signal.aborted) return undefined;
    if (surface === 'terminal' || !translated.punctuationOffsets.length)
      return text;

    const parts: string[] = [];
    let start = 0;
    for (const offset of translated.punctuationOffsets) {
      parts.push(text.slice(start, offset));
      start = offset;
    }
    parts.push(text.slice(start));
    const separated = parts.join(' ');
    // Adding a delimiter can make GFM drop adjacent ASCII URL characters too.
    const displayed = await inspectMarkdown(separated);
    return !signal.aborted &&
      preservesMarkdown(translated, displayed) &&
      !displayed.punctuationOffsets.length
      ? separated
      : undefined;
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
