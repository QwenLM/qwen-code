/**
 * Styled-text measurement and conversion utilities.
 *
 * Ported from @jrichman/ink@6.6.7 build/measure-text.js to standalone TypeScript.
 * Origin licence: MIT (Copyright (c) Vadym Demedes <vadimdemedes@hey.com>)
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 *
 * Exported symbols:
 *   toStyledCharacters        – parse an ANSI string → StyledLine
 *   styledCharsWidth          – visible column width of a StyledLine
 *   wordBreakStyledChars      – split a StyledLine at word boundaries
 *   widestLineFromStyledChars – max width across an array of StyledLines
 */
import { StyledLine } from './styled-line.js';
import { tokenize, styledLineFromTokens } from './sgr-tokenize.js';
import { FULL_WIDTH_MASK } from './ansi-constants.js';

// ── Simple LRU cache for toStyledCharacters ───────────────────────────────────
// Caps both key count (2 000) and total key character data (100 000 chars) to
// match the upstream DataLimitedLruMap behaviour without the mnemonist dep.
const CACHE_MAX_KEYS = 2000;
const CACHE_MAX_DATA = 100_000;

class SimpleLruCache {
  private readonly map = new Map<string, StyledLine>();
  private currentDataSize = 0;

  get(key: string): StyledLine | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Promote to MRU position
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: StyledLine): void {
    const size = key.length;
    while (
      (this.currentDataSize + size > CACHE_MAX_DATA ||
        this.map.size >= CACHE_MAX_KEYS) &&
      this.map.size > 0
    ) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.currentDataSize -= oldest.length;
    }
    this.map.set(key, value);
    this.currentDataSize += size;
  }

  clear(): void {
    this.map.clear();
    this.currentDataSize = 0;
  }
}

const toStyledCharactersCache = new SimpleLruCache();
let cacheEnabled = true;

// ── toStyledCharacters ────────────────────────────────────────────────────────

/**
 * Parse an ANSI-escaped string into a StyledLine of grapheme clusters.
 *
 * Tabs are expanded to 4 spaces; backspaces are dropped; combining characters
 * and ZWJ sequences are merged into the preceding grapheme.
 */
export function toStyledCharacters(text: string): StyledLine {
  if (cacheEnabled) {
    const cached = toStyledCharactersCache.get(text);
    if (cached !== undefined) return cached;
  }

  const tokens = tokenize(text);
  const characters = styledLineFromTokens(tokens);
  const combinedLine = new StyledLine();

  for (let i = 0; i < characters.length; i++) {
    const value = characters.getValue(i);
    const flags = characters.getFormatFlags(i);
    const fgColor = characters.getFgColor(i);
    const bgColor = characters.getBgColor(i);
    const link = characters.getLink(i);

    if (value === '\t') {
      // Expand tab → 4 spaces
      for (let j = 0; j < 4; j++)
        combinedLine.pushChar(' ', flags, fgColor, bgColor, link);
      continue;
    }
    if (value === '\b') continue;

    let combinedValue = value;
    let isCombined = false;
    const firstCodePoint = combinedValue.codePointAt(0);

    // 1. Regional Indicators (flag emoji) — combine consecutive pairs
    if (
      firstCodePoint !== undefined &&
      firstCodePoint >= 0x1_f1_e6 &&
      firstCodePoint <= 0x1_f1_ff &&
      i + 1 < characters.length
    ) {
      const nextValue = characters.getValue(i + 1);
      const nextCP = nextValue.codePointAt(0);
      if (nextCP !== undefined && nextCP >= 0x1_f1_e6 && nextCP <= 0x1_f1_ff) {
        combinedValue += nextValue;
        i++;
        isCombined = true;
      }
    }

    // 2. Other combining characters (diacritics, skin tones, ZWJ sequences, etc.)
    if (!isCombined) {
      while (i + 1 < characters.length) {
        const nextValue = characters.getValue(i + 1);
        if (!nextValue) break;
        const nextCP = nextValue.codePointAt(0);
        if (nextCP === undefined) break;

        const isUnicodeMark = /\p{Mark}/u.test(nextValue);
        const isSkinTone = nextCP >= 0x1_f3_fb && nextCP <= 0x1_f3_ff;
        const isZWJ = nextCP === 0x20_0d;
        const isTagsBlock = nextCP >= 0xe_00_00 && nextCP <= 0xe_00_7f;
        const isCombining =
          isUnicodeMark ||
          isSkinTone ||
          isZWJ ||
          isTagsBlock ||
          nextCP === 0x0e_33 || // Thai SARA AM
          nextCP === 0x0e_b3; // Lao SARA AM

        if (!isCombining) break;

        combinedValue += nextValue;
        i++;
        if (isZWJ && i + 1 < characters.length) {
          const afterZwj = characters.getValue(i + 1);
          if (afterZwj) {
            combinedValue += afterZwj;
            i++;
          }
        }
      }
    }

    combinedLine.pushChar(combinedValue, flags, fgColor, bgColor, link);
  }

  if (cacheEnabled) toStyledCharactersCache.set(text, combinedLine);
  return combinedLine;
}

// ── styledCharsWidth ──────────────────────────────────────────────────────────

/**
 * Return the total visible column width of a StyledLine.
 *
 * The FULL_WIDTH_MASK bit on each char's charData was set during tokenisation
 * (by `styledLineFromTokens`), so we can measure width without re-computing
 * `eastAsianWidth` for every grapheme here.
 */
export function styledCharsWidth(line: StyledLine): number {
  let total = 0;
  for (let i = 0; i < line.length; i++) {
    // Full-width chars occupy 2 terminal columns; all others 1.
    total += (line.getFormatFlags(i) & FULL_WIDTH_MASK) !== 0 ? 2 : 1;
  }
  return total;
}

// ── wordBreakStyledChars ──────────────────────────────────────────────────────

/**
 * Split a StyledLine into word-sized chunks at space/newline boundaries.
 * Each space and newline becomes its own single-character StyledLine.
 */
export function wordBreakStyledChars(line: StyledLine): StyledLine[] {
  const words: StyledLine[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const val = line.getValue(i);
    if (val === '\n' || val === ' ') {
      if (i > start) words.push(line.slice(start, i));
      words.push(line.slice(i, i + 1));
      start = i + 1;
    }
  }
  if (start < line.length) words.push(line.slice(start));
  return words;
}

// ── widestLineFromStyledChars ─────────────────────────────────────────────────

/**
 * Return the maximum visible column width across an array of StyledLines.
 */
export function widestLineFromStyledChars(lines: StyledLine[]): number {
  let maxWidth = 0;
  for (const line of lines)
    maxWidth = Math.max(maxWidth, styledCharsWidth(line));
  return maxWidth;
}
