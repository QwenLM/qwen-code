/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SHELL_SPECIAL_CHARS = /[ \t()[\]{};|*?$`'"#&<>!~]/;

export function escapePath(filePath: string): string {
  let result = '';
  for (let i = 0; i < filePath.length; i += 1) {
    const char = filePath[i];

    let backslashCount = 0;
    for (let j = i - 1; j >= 0 && filePath[j] === '\\'; j -= 1) {
      backslashCount += 1;
    }

    const isAlreadyEscaped = backslashCount % 2 === 1;

    if (!isAlreadyEscaped && SHELL_SPECIAL_CHARS.test(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }

  return result;
}

export function unescapePath(filePath: string): string {
  return filePath.replace(
    new RegExp(`\\\\([${SHELL_SPECIAL_CHARS.source.slice(1, -1)}])`, 'g'),
    '$1',
  );
}
