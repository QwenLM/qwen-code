/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
  type Highlighter,
} from 'shiki';

// A single, lazily-created highlighter shared by both the static code blocks
// and the streaming ones (@shikijs/stream). It uses the JavaScript regex engine
// (no WASM) with `forgiving` enabled, and loads languages on demand, so the
// bundle stays small and each language/grammar is fetched at most once.
const THEMES = ['github-light-default', 'github-dark-default'];

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      langs: [],
      themes: THEMES,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
      .then((highlighter) => {
        highlighterInstance = highlighter;
        return highlighter;
      })
      .catch((err) => {
        // Don't cache a rejected promise: a transient failure (e.g. a dynamic
        // import hiccup) would otherwise permanently disable highlighting for
        // the whole session. Reset so the next call retries.
        highlighterPromise = null;
        throw err;
      });
  }
  return highlighterPromise;
}

/** Returns the shared highlighter with `lang` loaded (lazily, cached). */
export async function getCodeHighlighter(lang: string): Promise<Highlighter> {
  const highlighter = await getHighlighter();
  if (!loadedLanguages.has(lang)) {
    // Dedupe concurrent loads of the same language: without this, two callers
    // can both pass the `has` check and call `loadLanguage` twice.
    let pending = pendingLanguages.get(lang);
    if (!pending) {
      pending = highlighter
        .loadLanguage(lang as BundledLanguage)
        .then(() => {
          loadedLanguages.add(lang);
        })
        .finally(() => {
          pendingLanguages.delete(lang);
        });
      pendingLanguages.set(lang, pending);
    }
    await pending;
  }
  return highlighter;
}

/** Highlights code to HTML, loading the language on demand if needed. */
export async function highlightToHtml(
  code: string,
  lang: string,
  theme: string,
): Promise<string> {
  const highlighter = await getCodeHighlighter(lang);
  return highlighter.codeToHtml(code, { lang, theme });
}

// Above this size, synchronous tokenization would risk a noticeable main-thread
// stall, so the sync path bails and the caller falls back to the async one.
const SYNC_HIGHLIGHT_MAX_CHARS = 30_000;

/**
 * Synchronously highlights code to HTML *iff* the highlighter and language are
 * already warm (e.g. right after a streaming block settles) and the block is
 * small enough to tokenize without janking. Returns null otherwise, so the
 * caller can fall back to the async path.
 */
export function highlightToHtmlSync(
  code: string,
  lang: string,
  theme: string,
): string | null {
  if (
    highlighterInstance &&
    loadedLanguages.has(lang) &&
    code.length <= SYNC_HIGHLIGHT_MAX_CHARS
  ) {
    try {
      return highlighterInstance.codeToHtml(code, { lang, theme });
    } catch {
      // Fall back to the async path rather than crashing the render tree.
      return null;
    }
  }
  return null;
}
