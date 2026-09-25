/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_MEMORY_CONTENT_CHARACTERS = 4000;

const NON_CONTENT_CHARACTER = /^[\p{White_Space}\p{Cc}\p{Cf}]$/u;
const DISPLAY_ESCAPE_CHARACTER = /[\u007f-\u009f\u2028\u2029\p{Cf}]/gu;

export function isValidMemoryContent(value: string): boolean {
  if (
    Array.from(value).length > MAX_MEMORY_CONTENT_CHARACTERS ||
    hasUnpairedSurrogate(value)
  ) {
    return false;
  }

  return Array.from(value).some(
    (character) => !NON_CONTENT_CHARACTER.test(character),
  );
}

export function renderMemoryContentForConfirmation(value: string): string {
  return JSON.stringify(value).replace(DISPLAY_ESCAPE_CHARACTER, (character) =>
    character
      .split('')
      .map(
        (codeUnit) =>
          `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
      .join(''),
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
