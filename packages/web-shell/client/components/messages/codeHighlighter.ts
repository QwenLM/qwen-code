/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki';

// A single, lazily-created highlighter shared by all code blocks. It uses
// Shiki's default Oniguruma (WASM) engine — the same engine `main` highlights
// with — and loads languages on demand, so each language/grammar is fetched at
// most once. (The JS regex engine was ~12–19x slower and is not used.)
const THEMES = ['github-light-default', 'github-dark-default'];

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguages = new Map<string, Promise<void>>();
// Languages whose load rejected. Unlike the highlighter singleton (which retries
// transient failures because it gates ALL highlighting), a single failed grammar
// only costs one language, so we stop retrying it — otherwise a permanently
// broken bundle would re-request on every re-highlight. Cleared on reset.
const failedLanguages = new Set<string>();

// Highlighted-HTML cache, owned here so it shares one invalidation point with
// the highlighter singleton (see __resetForTesting).
export const SHIKI_CACHE_MAX = 128;
const shikiCache = new Map<string, string>();

function cacheKey(code: string, lang: string, theme: string): string {
  return `${lang}\0${theme}\0${code}`;
}

function setCache(key: string, html: string): void {
  if (shikiCache.size >= SHIKI_CACHE_MAX) {
    const first = shikiCache.keys().next().value;
    if (first !== undefined) shikiCache.delete(first);
  }
  shikiCache.set(key, html);
}

/** Returns previously-highlighted HTML for this exact code/lang/theme, or null. */
export function getCachedHtml(
  code: string,
  lang: string,
  theme: string,
): string | null {
  return shikiCache.get(cacheKey(code, lang, theme)) ?? null;
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      langs: [],
      themes: THEMES,
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
  if (loadedLanguages.has(lang)) return highlighter;
  if (failedLanguages.has(lang)) {
    throw new Error(`shiki: language "${lang}" previously failed to load`);
  }
  // Dedupe concurrent loads of the same language: without this, two callers
  // can both pass the `has` check and call `loadLanguage` twice.
  let pending = pendingLanguages.get(lang);
  if (!pending) {
    pending = highlighter
      .loadLanguage(lang as BundledLanguage)
      .then(() => {
        loadedLanguages.add(lang);
      })
      .catch((err) => {
        failedLanguages.add(lang);
        throw err;
      })
      .finally(() => {
        pendingLanguages.delete(lang);
      });
    pendingLanguages.set(lang, pending);
  }
  await pending;
  return highlighter;
}

// Even with the Oniguruma engine, TextMate tokenization of a very long,
// unbroken line is roughly O(n²) and runs synchronously on the main thread, so
// a pathological single line (minified JSON, a long base64 literal, etc.) can
// still jank. This is a generous safety net — well above normal source — past
// which a block is rendered as plain text instead of highlighted, on both the
// streaming and the settled static paths. `main` has no such guard at all.
export const MAX_HIGHLIGHT_TOTAL_CHARS = 100_000;
export const MAX_HIGHLIGHT_LINE_CHARS = 20_000;

export function isTooLargeToHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_TOTAL_CHARS) return true;
  // Bail if any single line exceeds the per-line limit (short-circuits early).
  let lineStart = 0;
  const len = code.length;
  for (let i = 0; i <= len; i++) {
    if (i === len || code.charCodeAt(i) === 10 /* \n */) {
      if (i - lineStart > MAX_HIGHLIGHT_LINE_CHARS) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

/**
 * Synchronously highlights code to HTML *iff* the highlighter and language are
 * already warm (e.g. right after a streaming block settles). Returns null
 * otherwise, so the caller can fall back to the async path (or plain text).
 *
 * The size policy (isTooLargeToHighlight) lives at the caller, which already
 * gates before reaching this function — so it is not re-checked here.
 */
export function highlightToHtmlSync(
  code: string,
  lang: string,
  theme: string,
  persist = true,
): string | null {
  if (highlighterInstance && loadedLanguages.has(lang)) {
    try {
      const html = highlighterInstance.codeToHtml(code, { lang, theme });
      if (persist) setCache(cacheKey(code, lang, theme), html);
      return html;
    } catch (err) {
      // Fall back to the async path rather than crashing the render tree, and
      // log it (the async path logs too) so a failing grammar isn't silent.
      console.warn('[web-shell] sync highlight failed for lang=%s', lang, err);
      return null;
    }
  }
  return null;
}

/** Resets all module-level highlighter state (incl. the HTML cache). Tests only. */
export function __resetForTesting(): void {
  highlighterPromise = null;
  highlighterInstance = null;
  loadedLanguages.clear();
  pendingLanguages.clear();
  failedLanguages.clear();
  shikiCache.clear();
}
