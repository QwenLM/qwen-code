/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import ansiRegex from 'ansi-regex';
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
} from '@opentui/core';

const attributes: Record<number, number> = {
  1: TextAttributes.BOLD,
  2: TextAttributes.DIM,
  3: TextAttributes.ITALIC,
  4: TextAttributes.UNDERLINE,
  5: TextAttributes.BLINK,
  7: TextAttributes.INVERSE,
  8: TextAttributes.HIDDEN,
  9: TextAttributes.STRIKETHROUGH,
};

export function statusLineStyledText(
  value: string,
  { color, dim }: { color?: string; dim: boolean },
): StyledText {
  // Status output may style text but cannot move the renderer's cursor.
  const safe = value
    .replaceAll('\u009b', '\x1b[')
    .replaceAll('\u009d', '\x1b]')
    .replace(ansiRegex(), (code) => {
      // eslint-disable-next-line no-control-regex -- SGR is an escape sequence.
      if (/^\x1b\[[\d;:]*m$/.test(code)) {
        return code.replace(/([34]8):2:(?:0)?:/g, '$1;2;').replaceAll(':', ';');
      }
      return code.startsWith('\x1b]8;') ? code : '';
    });
  const chunks: TextChunk[] = [];
  let previousStyle = '';
  for (const char of styledCharsFromTokens(tokenize(safe))) {
    const style = char.styles.map((code) => code.code).join('');
    const previous = chunks.at(-1);
    if (previous && style === previousStyle) {
      previous.text += char.value;
      continue;
    }
    previousStyle = style;
    const chunk: TextChunk = {
      __isChunk: true,
      text: char.value,
      fg: color ? RGBA.fromHex(color) : undefined,
      attributes: dim ? TextAttributes.DIM : TextAttributes.NONE,
    };
    for (const { code } of char.styles) {
      // eslint-disable-next-line no-control-regex -- OSC8 uses ESC/BEL/ST delimiters.
      const link = /^\x1b\]8;[^;]*;(.*?)(?:\x07|\x1b\\|\u009c)$/.exec(code);
      if (link) {
        if (link[1]) chunk.link = { url: link[1] };
        continue;
      }
      const parts = code.slice(2, -1).split(';').map(Number);
      const n = parts[0];
      if (attributes[n]) chunk.attributes! |= attributes[n];
      else if (n === 38 || n === 48) {
        if (
          parts[1] === 5 &&
          (!Number.isInteger(parts[2]) || parts[2] < 0 || parts[2] > 255)
        ) {
          continue;
        }
        const color =
          parts[1] === 5
            ? RGBA.fromIndex(parts[2])
            : parts[1] === 2
              ? RGBA.fromInts(parts[2], parts[3], parts[4])
              : undefined;
        if (color) chunk[n === 38 ? 'fg' : 'bg'] = color;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        chunk.fg = RGBA.fromIndex(n < 90 ? n - 30 : n - 90 + 8);
      } else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
        chunk.bg = RGBA.fromIndex(n < 100 ? n - 40 : n - 100 + 8);
      }
    }
    chunks.push(chunk);
  }
  return new StyledText(chunks);
}
