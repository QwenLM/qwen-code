/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModPlugin } from '@qwen-code/qwen-code-core/mods/types.js';
import type { ModRenderSite } from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { LoadedSettings } from '../config/settings.js';

export type DisplayTranslationTarget = 'zh-CN' | 'en';

export const DISPLAY_TRANSLATION_MOD = 'display-translation';

const SITES: readonly ModRenderSite[] = ['AssistantMessage', 'Thinking'];

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

// Runs in the Mod sandbox: plain JavaScript, no imports.
const SOURCE = String.raw`
const LANGUAGES = { 'zh-CN': 'Simplified Chinese', en: 'English' };
// The answer ends with this line, so a cut-off answer is told from a full one.
const END = '\n[QWEN_DISPLAY_END]';
// A host cuts an answer too long for a Mod payload to its head and tail.
const TRUNCATED = '\n[... truncated for Mods ...]\n';
const INDENTED = /^(?: {4}| {0,3}\t)/;
// Closed fences of either kind, including longer closing fences.
const FENCED = /^ {0,3}((\x60|~)\2{2,})(?!\2)[^\n]*\n[\s\S]*?^ {0,3}\1\2*[ \t]*$/gm;

// Prose with at least as many Han characters as Latin words is Chinese; prose
// with neither, such as a block of code alone, is undefined.
function isChinese(text) {
  if (text.split('\n').every((line) => !line.trim() || INDENTED.test(line))) return undefined;
  const prose = text.replace(FENCED, '').replace(/\x60[^\x60\n]*\x60/g, '');
  const han = (prose.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const words = (prose.match(/[A-Za-z]+/g) ?? []).length;
  return han + words === 0 ? undefined : han >= words;
}

export function register(on, options) {
  const target = options.language;
  const system =
    'Translate the Markdown the user sends into ' + LANGUAGES[target] + '. ' +
    'Keep its Markdown structure, code blocks, inline code, file paths, URLs, ' +
    'commands and identifiers unchanged. Reply with only the full translation, ' +
    'followed by this exact line:' + END;
  on('ui.render', { component: ['AssistantMessage', 'Thinking'] }, async ($, e, next) => {
    const chinese = isChinese(e.props.text);
    if (chinese === undefined || chinese === (target === 'zh-CN')) return next(e);
    const r = await $.model.complete(
      { model: 'haiku', system, prompt: e.props.text, maxTokens: 8192, timeoutMs: 25000 },
      { signal: next.signal },
    );
    const answer = r.isAnswered ? r.text.replace(/\r/g, '').trimEnd() : '';
    const whole = answer.endsWith(END) && !answer.includes(TRUNCATED);
    const text = whole ? answer.slice(0, -END.length) : '';
    if (!text.trim()) {
      $.ui.log('Left untranslated: ' + (!r.isAnswered ? r.reason : whole ? 'empty answer' : 'incomplete answer'), { to: 'debug' });
      return next(e);
    }
    return next({ ...e, props: { ...e.props, text } });
  });
}
`;

/** The built-in Mod that shows replies and opened thoughts in `target`. */
export function displayTranslationPlugin(
  target: DisplayTranslationTarget,
): ModPlugin {
  const root = path.dirname(fileURLToPath(import.meta.url));
  return {
    id: `qwen-code:${DISPLAY_TRANSLATION_MOD}`,
    name: DISPLAY_TRANSLATION_MOD,
    source: {
      root,
      entry: path.join(root, `${DISPLAY_TRANSLATION_MOD}.js`),
      source: SOURCE,
    },
    options: { language: target },
  };
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
