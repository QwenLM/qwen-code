/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ispell `-a` pipe protocol.
 *
 * aspell, hunspell and ispell all speak it: the checker prints an
 * ispell-compatible banner, then answers one line of words at a time with one
 * response line per interesting word and a blank line to close the batch.
 *
 * Pure functions and constants only — the process that drives them lives in
 * `spellCheckerProcess.ts`.
 */

/** Checkers this understands, in the order `auto` tries them. */
export const CHECKERS = ['aspell', 'hunspell', 'ispell'] as const;

export type CheckerName = (typeof CHECKERS)[number];

export function isCheckerName(value: string): value is CheckerName {
  return (CHECKERS as readonly string[]).includes(value);
}

/**
 * A plain dictionary name.
 *
 * Commas are allowed because hunspell's `-d` takes a comma-separated list.
 */
const DICTIONARY_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_.,-]{0,63}$/;

export function isValidDictionaryName(name: string): boolean {
  return DICTIONARY_NAME_REGEX.test(name);
}

/** Terse mode: stop reporting correct words, which is most of them. */
export const TERSE_MODE_COMMAND = '!\n';

/** How many words one line may carry, by the engine actually answering. */
export const BATCH_WORD_LIMITS: Record<CheckerName, number> = {
  aspell: 256,
  hunspell: 16,
  ispell: 256,
};

/** Byte ceiling for one request line, independent of the word count. */
export const MAX_REQUEST_LINE_BYTES = 4096;

/** A response line longer than this means the stream is not the protocol. */
export const MAX_RESPONSE_LINE_BYTES = 65536;

/** Words outside this length are not worth a round trip. */
export const MIN_WORD_LENGTH = 1;
export const MAX_WORD_LENGTH = 128;

/**
 * Whitespace and control characters cannot travel: words are joined by spaces
 * into a single line, so either one would split or corrupt the request.
 */
const UNSENDABLE_CHARACTER_REGEX = /[\s\p{Cc}]/u;

export function isSendableWord(word: string): boolean {
  return (
    word.length >= MIN_WORD_LENGTH &&
    word.length <= MAX_WORD_LENGTH &&
    !UNSENDABLE_CHARACTER_REGEX.test(word)
  );
}

export function buildCheckerArgs(
  checker: CheckerName,
  language?: string,
): string[] {
  switch (checker) {
    case 'aspell':
      return [
        '-a',
        '--encoding=utf-8',
        '--sug-mode=ultra',
        ...(language ? [`--lang=${language}`] : []),
      ];
    case 'hunspell':
      return ['-a', '-i', 'utf-8', ...(language ? ['-d', language] : [])];
    case 'ispell':
      return ['-a', ...(language ? ['-d', language] : [])];
    default: {
      const exhaustive: never = checker;
      throw new Error(`Unknown checker: ${String(exhaustive)}`);
    }
  }
}

/**
 * Identify the engine from its greeting.
 *
 * All three print an ispell-compatible banner, and aspell and hunspell append a
 * "but really <name>" aside to it. Which one answered decides how many words a
 * batch may carry, so identity is read here rather than assumed from the
 * executable found on PATH.
 *
 * @returns The engine, or null when this is not a checker at all.
 */
export function parseBanner(line: string): CheckerName | null {
  if (!line.startsWith('@(#) International Ispell')) return null;
  if (/but really Aspell/i.test(line)) return 'aspell';
  if (/but really Hunspell/i.test(line)) return 'hunspell';
  return 'ispell';
}

/**
 * Encode one batch as a request line.
 *
 * The leading `^` is what keeps the request data. Lines starting with `*`, `&`,
 * `@`, `#` and friends are control commands in this protocol — a user word
 * beginning with one would otherwise add to the dictionary or change the
 * session's state instead of being checked.
 */
export function encodeCheckLine(words: readonly string[]): string {
  return `^${words.join(' ')}\n`;
}

export type ResponseLine =
  /** Blank line: the batch is answered. */
  | { type: 'end' }
  /** Reported correct. Terse mode suppresses these, so it is a fallback. */
  | { type: 'correct' }
  | { type: 'misspelled'; word: string }
  /** Not part of the protocol. */
  | { type: 'unrecognized' };

/**
 * Classify one response line.
 *
 * The caller strips the line terminator, including a `\r` from a checker that
 * answers with CRLF.
 */
export function parseResponseLine(line: string): ResponseLine {
  if (line === '') return { type: 'end' };

  const marker = line[0];
  if (marker === '*' || marker === '+' || marker === '-') {
    return { type: 'correct' };
  }

  // `& word count offset: suggestions` / `? word 0 offset: suggestions` carry
  // guesses, `# word offset` has none. Only the word matters here.
  if (marker === '&' || marker === '?' || marker === '#') {
    const word = line.slice(2).split(' ')[0];
    if (word) return { type: 'misspelled', word };
    return { type: 'unrecognized' };
  }

  return { type: 'unrecognized' };
}
