/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validates and emits hook-provided terminal escape sequences.
 *
 * Only an allowlisted subset of OSC codes and bare BEL are accepted.
 * Invalid input is rejected entirely — no partial stripping — to
 * prevent transforming a malicious sequence into a different valid one.
 */

import { BEL, wrapForMultiplexer } from './osc.js';

const ESC = '\x1b';
const ST_CHAR = '\\';

/** OSC codes that hooks are allowed to emit. */
const ALLOWED_OSC_CODES = new Set([0, 1, 2, 9, 99, 777]);

/**
 * Parse a `terminalSequence` string into individual validated tokens.
 *
 * Returns the array of raw sequence strings when the entire input is
 * valid, or `null` when any part is invalid.
 */
export function parseAllowedTerminalSequences(input: string): string[] | null {
  if (!input) return null;

  const tokens: string[] = [];
  let position = 0;

  while (position < input.length) {
    if (input[position] === '\x07') {
      // Bare BEL
      tokens.push('\x07');
      position++;
      continue;
    }

    if (
      input[position] === ESC &&
      position + 1 < input.length &&
      input[position + 1] === ']'
    ) {
      // OSC sequence: ESC ] <code> ; <payload> <terminator>
      const oscResult = parseOscSequence(input, position);
      if (!oscResult) return null;
      tokens.push(oscResult.raw);
      position = oscResult.end;
      continue;
    }

    // Any other byte at the top level is invalid
    return null;
  }

  return tokens.length > 0 ? tokens : null;
}

interface OscParseResult {
  raw: string;
  end: number;
}

function parseOscSequence(input: string, start: number): OscParseResult | null {
  // start points at ESC, start+1 is ']'
  let position = start + 2;

  // Read the numeric OSC code
  let codeStr = '';
  while (
    position < input.length &&
    input[position] >= '0' &&
    input[position] <= '9'
  ) {
    codeStr += input[position];
    position++;
  }

  if (codeStr.length === 0) return null;

  const oscCode = Number(codeStr);
  if (!ALLOWED_OSC_CODES.has(oscCode)) return null;

  // After the code, expect ';' or a terminator
  // (OSC 0/1/2 can have just a title with ';')
  if (position >= input.length) return null;

  // Read until terminator: BEL or ST (ESC \)
  // The ';' after code is part of payload
  while (position < input.length) {
    const char = input[position];

    if (char === '\x07') {
      // BEL terminator
      return {
        raw: input.slice(start, position + 1),
        end: position + 1,
      };
    }

    if (
      char === ESC &&
      position + 1 < input.length &&
      input[position + 1] === ST_CHAR
    ) {
      // ST terminator (ESC \)
      return {
        raw: input.slice(start, position + 2),
        end: position + 2,
      };
    }

    // Nested ESC that isn't ST is invalid (except within payload of allowed sequences)
    if (
      char === ESC &&
      (position + 1 >= input.length || input[position + 1] !== ST_CHAR)
    ) {
      return null;
    }

    position++;
  }

  // Unterminated — no terminator found
  return null;
}

/**
 * Validate and emit a `terminalSequence` string through a raw writer.
 *
 * BEL is written raw (so tmux bell-action works).
 * OSC sequences are wrapped for tmux/screen passthrough.
 *
 * @returns `true` when the sequence was emitted, `false` when rejected.
 */
export function emitTerminalSequence(
  sequence: string,
  writeRaw: (data: string) => void,
): boolean {
  const tokens = parseAllowedTerminalSequences(sequence);
  if (!tokens) return false;

  for (const token of tokens) {
    if (token === '\x07') {
      writeRaw(BEL);
    } else {
      writeRaw(wrapForMultiplexer(token));
    }
  }

  return true;
}
