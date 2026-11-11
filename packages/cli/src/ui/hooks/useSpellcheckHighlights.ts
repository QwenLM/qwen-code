/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spell check spans for the prompt input.
 *
 * Owns the checker process for the session, decides which words are worth
 * asking about, and turns the verdicts that come back into column ranges the
 * input renderer can underline.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import tinycolor from 'tinycolor2';
import { runLogger } from '@qwen-code/core';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { cpLen, cpSlice, toCodePoints } from '../utils/textUtils.js';
import { theme } from '../semantic-colors.js';
import { extractWords, type ExtractedWord } from '../utils/spellcheckWords.js';
import {
  SpellCheckerProcess,
  type VerdictLookup,
} from '../../spellcheck/spellCheckerProcess.js';
import type { SpellcheckCheckerSetting } from '../../config/settingsSchema.js';
import {
  resolveSpellcheckSettings,
  type SpellcheckSettingsSource,
} from '../../config/spellcheckSettings.js';
import { registerCleanup } from '../../utils/cleanup.js';

/** How long typing settles before a batch goes out. */
const REQUEST_DEBOUNCE_MS = 250;

/** A code-point column range within one logical line, end exclusive. */
export type SpellcheckSpan = readonly [start: number, end: number];

export interface SpellcheckHighlights {
  /** Logical line index to the misspelled ranges on it. */
  spansByLine: ReadonlyMap<number, readonly SpellcheckSpan[]>;
  /** A color the renderer can hand to `<Text>`, or undefined for no color. */
  color: string | undefined;
}

const EMPTY_SPANS: ReadonlyMap<number, readonly SpellcheckSpan[]> = new Map();
const EMPTY_WORDS: readonly ExtractedWord[] = [];

const NO_HIGHLIGHTS: SpellcheckHighlights = {
  spansByLine: EMPTY_SPANS,
  color: undefined,
};

// --- color ----------------------------------------------------------------

/** The names `colorize()` renders, which are the only ones worth emitting. */
const ANSI_COLOR_NAMES = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]);

const HEX_REGEX = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$/;
const RGB_REGEX = /^rgb\((\d{1,3}),(\d{1,3}),(\d{1,3})\)$/;
const ANSI256_REGEX = /^ansi256\((\d{1,3})\)$/;

function inByte(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
}

/**
 * Put a color into a form the renderer actually paints.
 *
 * `<Text color>` reaches `colorize()`, which recognizes `#hex`, `rgb(r,g,b)`,
 * `ansi256(n)` and `ansi:<name>` — and silently returns the text unstyled for
 * anything else, a bare `"red"` included. Bare names are the natural thing to
 * write, and themes hand out both bare names and hex, so both are converted
 * here rather than being allowed through to render as nothing.
 *
 * @returns A renderable color, or undefined when the value is not a color.
 */
export function normalizeSpellcheckColor(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // `rgb( 1, 2, 3 )` is a reasonable thing to write; colorize's own patterns
  // allow at most one space, so squeeze them out before matching.
  const compact = trimmed.replace(/\s+/g, '');

  if (compact.startsWith('rgb')) {
    const match = RGB_REGEX.exec(compact);
    if (!match) return undefined;
    const [, r, g, b] = match;
    return inByte(r!) && inByte(g!) && inByte(b!) ? `rgb(${r},${g},${b})` : undefined;
  }

  if (compact.startsWith('ansi256')) {
    const match = ANSI256_REGEX.exec(compact);
    return match && inByte(match[1]!) ? `ansi256(${Number(match[1])})` : undefined;
  }

  if (compact.startsWith('ansi:')) {
    const name = compact.slice('ansi:'.length);
    return ANSI_COLOR_NAMES.has(name) ? compact : undefined;
  }

  if (compact.startsWith('#')) {
    return HEX_REGEX.test(compact) ? compact.toLowerCase() : undefined;
  }

  if (ANSI_COLOR_NAMES.has(compact)) return `ansi:${compact}`;

  // Names outside the ANSI set — a theme's "gray", a user's "darkkhaki" —
  // still render once they are hex.
  const parsed = tinycolor(compact);
  return parsed.isValid() ? parsed.toHexString() : undefined;
}

let warnedInvalidColor = false;

/** Test seam: the invalid-color warning is one-shot. */
export function resetSpellcheckColorWarningForTesting(): void {
  warnedInvalidColor = false;
}

/**
 * The color misspelled words are drawn in.
 *
 * @param configured The `spellcheck.color` setting, if any.
 * @param fallback The theme color to use when nothing valid is configured.
 */
export function resolveSpellcheckColor(
  configured: string | undefined,
  fallback: string,
): string | undefined {
  if (configured !== undefined) {
    const normalized = normalizeSpellcheckColor(configured);
    if (normalized) return normalized;
    if (!warnedInvalidColor) {
      warnedInvalidColor = true;
      runLogger.debug(
        `[spellcheck] ignoring color "${configured}" (not a recognized color); ` +
          "using the theme's error color",
      );
    }
  }
  return normalizeSpellcheckColor(fallback);
}

// --- rendering ------------------------------------------------------------

export interface SpellcheckTextRun {
  text: string;
  misspelled: boolean;
}

/**
 * Split a run of rendered text where misspellings start and stop.
 *
 * The text is addressed in *transformed* columns — what the input actually
 * shows, with `@some/image.png` already collapsed to `[Image image.png]` —
 * while spans are logical columns of the underlying buffer. The buffer's own
 * `transformedToLogicalMaps` translates between them, and is the identity for
 * a line with nothing collapsed on it.
 *
 * @param transformedStart The text's first column in the transformed line.
 * @param transformedToLogical The line's map, or undefined for identity.
 */
export function splitTextBySpellcheckSpans(
  text: string,
  transformedStart: number,
  transformedToLogical: readonly number[] | undefined,
  spans: readonly SpellcheckSpan[],
): SpellcheckTextRun[] {
  if (text === '' || spans.length === 0) {
    return [{ text, misspelled: false }];
  }

  const chars = toCodePoints(text);
  const runs: SpellcheckTextRun[] = [];
  let runStart = 0;
  let runMisspelled = false;

  for (let i = 0; i < chars.length; i++) {
    const transformedCol = transformedStart + i;
    const logicalCol = transformedToLogical?.[transformedCol] ?? transformedCol;
    const misspelled = spans.some(
      ([start, end]) => logicalCol >= start && logicalCol < end,
    );

    if (i === 0) {
      runMisspelled = misspelled;
      continue;
    }
    if (misspelled !== runMisspelled) {
      runs.push({
        text: chars.slice(runStart, i).join(''),
        misspelled: runMisspelled,
      });
      runStart = i;
      runMisspelled = misspelled;
    }
  }
  runs.push({
    text: chars.slice(runStart).join(''),
    misspelled: runMisspelled,
  });
  return runs;
}

// --- checker ownership ----------------------------------------------------

// One checker per session, keyed by the settings that decide what it runs.
// Changing either has to mean a new process and a cold verdict cache, because
// a different engine or dictionary can disagree about the same word.
let currentKey: string | null = null;
let currentChecker: SpellCheckerProcess | null = null;
let cleanupRegistered = false;
const checkerListeners = new Set<() => void>();

/**
 * Subscribe to which checker is current.
 *
 * Consumers read the instance through this rather than holding one, so a
 * rebuild reaches all of them and none is left addressing a disposed process.
 */
function subscribeChecker(listener: () => void): () => void {
  checkerListeners.add(listener);
  return () => {
    checkerListeners.delete(listener);
  };
}

function getChecker(): SpellCheckerProcess | null {
  return currentChecker;
}

function notifyCheckerChanged(): void {
  for (const listener of [...checkerListeners]) listener();
}

/**
 * Bring the session's checker in line with the settings.
 *
 * Called from an effect, never from a render.
 */
function configureChecker(
  enabled: boolean,
  checker: SpellcheckCheckerSetting,
  language: string | undefined,
): void {
  if (!enabled) {
    releaseChecker();
    return;
  }

  const key = `${checker}:${language ?? ''}`;
  if (currentKey === key && currentChecker) return;

  currentChecker?.dispose();
  currentChecker = new SpellCheckerProcess({ checker, language });
  currentKey = key;

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerCleanup(() => releaseChecker());
  }
  notifyCheckerChanged();
}

function releaseChecker(): void {
  if (!currentChecker) return;
  currentChecker.dispose();
  currentChecker = null;
  currentKey = null;
  notifyCheckerChanged();
}

/** Test seam. */
export function resetSpellcheckCheckerForTesting(): void {
  releaseChecker();
}

/** Test seam: lets a test tell "same checker" from "rebuilt checker". */
export function getSpellcheckCheckerForTesting(): SpellCheckerProcess | null {
  return currentChecker;
}

// --- hook -----------------------------------------------------------------

const NO_SUBSCRIBE = () => () => {};
const NO_VERDICTS: VerdictLookup = () => undefined;
const GET_NO_VERDICTS = () => NO_VERDICTS;

export interface UseSpellcheckHighlightsParams {
  buffer: TextBuffer;
  /**
   * Whether the prompt is in a state worth checking. The caller owns this:
   * shell mode, history search, an external editor, live dictation and screen
   * reader mode all have better things for the input to be doing.
   */
  active: boolean;
  settings: SpellcheckSettingsSource;
}

export function useSpellcheckHighlights({
  buffer,
  active,
  settings,
}: UseSpellcheckHighlightsParams): SpellcheckHighlights {
  const resolved = useMemo(
    () => resolveSpellcheckSettings(settings),
    [settings],
  );
  const { enabled, checker: checkerName, language } = resolved;

  const checker = useSyncExternalStore(subscribeChecker, getChecker);

  // Starting a process is an effect's job, never a render's.
  //
  // There is deliberately no teardown here. The prompt is mounted and unmounted
  // as a matter of course — `Composer` only renders it while the input is
  // active, so every slash command takes it away and puts it back — and tying
  // the checker's life to that would kill the process and throw away every
  // verdict several times a session. The checker belongs to the session:
  // `registerCleanup` ends it at exit, and turning the setting off or changing
  // which checker to run replaces it.
  useEffect(() => {
    configureChecker(enabled, checkerName, language);
  }, [enabled, checkerName, language]);

  const verdicts = useSyncExternalStore(
    checker ? checker.subscribe : NO_SUBSCRIBE,
    checker ? checker.getVerdicts : GET_NO_VERDICTS,
  );

  const text = buffer.text;
  const words = useMemo(
    () => (enabled && active ? extractWords(text) : EMPTY_WORDS),
    [enabled, active, text],
  );

  const [cursorRow, cursorCol] = buffer.cursor;
  const lines = buffer.lines;
  /** Line starts and the cursor, in the same flat code-point space as the words. */
  const { lineStarts, cursorOffset } = useMemo(() => {
    const starts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      starts.push(offset);
      offset += cpLen(line) + 1; // the newline the lines were joined by
    }
    const base = starts[cursorRow] ?? 0;
    return { lineStarts: starts, cursorOffset: base + cursorCol };
  }, [lines, cursorRow, cursorCol]);

  /**
   * The word being typed is left alone — no request, no underline.
   *
   * Marking a word wrong while it is still half-written is noise, and it also
   * keeps the underline clear of the cursor cell, which the renderer draws with
   * its own escape sequences.
   */
  const isBeingTyped = useMemo(
    () =>
      (word: ExtractedWord): boolean => {
        if (cursorOffset < word.start) return false;
        if (cursorOffset <= word.end) return true;
        // Just past the end is still "inside" while the tail is an apostrophe
        // the user is about to continue: "don" + "'" on the way to "don't".
        return /^['’]*$/.test(cpSlice(text, word.end, cursorOffset));
      },
    [cursorOffset, text],
  );

  // Only words with no verdict yet, so a growing prompt costs only what is new.
  const pendingKey = useMemo(
    () =>
      words
        .filter(
          (word) =>
            !isBeingTyped(word) && verdicts(word.word) === undefined,
        )
        .map((word) => word.word)
        .join('\n'),
    [words, isBeingTyped, verdicts],
  );

  useEffect(() => {
    if (!checker || pendingKey === '') return;
    const timer = setTimeout(() => {
      checker.request(pendingKey.split('\n'));
    }, REQUEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [checker, pendingKey]);

  const spansByLine = useMemo(() => {
    if (words.length === 0) return EMPTY_SPANS;

    const map = new Map<number, SpellcheckSpan[]>();
    // Words arrive in document order, so one walking pointer finds their lines.
    let row = 0;
    for (const word of words) {
      while (row + 1 < lineStarts.length && lineStarts[row + 1]! <= word.start) {
        row += 1;
      }
      if (isBeingTyped(word)) continue;
      if (verdicts(word.word) !== true) continue;

      const lineStart = lineStarts[row] ?? 0;
      const span: SpellcheckSpan = [word.start - lineStart, word.end - lineStart];
      const existing = map.get(row);
      if (existing) existing.push(span);
      else map.set(row, [span]);
    }
    return map.size === 0 ? EMPTY_SPANS : map;
  }, [words, lineStarts, isBeingTyped, verdicts]);

  const color = resolveSpellcheckColor(resolved.color, theme.status.error);

  if (!enabled || !active) return NO_HIGHLIGHTS;
  return { spansByLine, color };
}
