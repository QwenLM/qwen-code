/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import ansiRegex from 'ansi-regex';

/**
 * Ported from packages/cli/src/ui/utils/textUtils.ts (escapeAnsiCtrlCodes):
 * escape ANSI/control sequences in untrusted text before it reaches logs or
 * model context. Only the string/object traversal helper is ported — the
 * terminal-rendering helpers around it are not needed here.
 */
const regex = ansiRegex();

/**
 * Recursively traverses a JSON-like structure (objects, arrays, primitives)
 * and escapes all ANSI control characters found in any string values.
 * Copy-on-write: returns the original reference when nothing changed.
 */
export function escapeAnsiCtrlCodes<T>(obj: T): T {
  if (typeof obj === 'string') {
    if (obj.search(regex) === -1) {
      return obj; // No changes return original string
    }

    regex.lastIndex = 0; // needed for global regex
    return obj.replace(regex, (match) =>
      JSON.stringify(match).slice(1, -1),
    ) as T;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    let newArr: unknown[] | null = null;

    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      const escapedValue = escapeAnsiCtrlCodes(value);
      if (escapedValue !== value) {
        if (newArr === null) {
          newArr = [...obj];
        }
        newArr[i] = escapedValue;
      }
    }
    return (newArr !== null ? newArr : obj) as T;
  }

  let newObj: T | null = null;
  const keys = Object.keys(obj);

  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    const escapedValue = escapeAnsiCtrlCodes(value);

    if (escapedValue !== value) {
      if (newObj === null) {
        newObj = { ...obj };
      }
      (newObj as Record<string, unknown>)[key] = escapedValue;
    }
  }

  return newObj !== null ? newObj : obj;
}
