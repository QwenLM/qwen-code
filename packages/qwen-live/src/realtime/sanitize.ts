/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import ansiRegex from 'ansi-regex';

const regex = ansiRegex();

/**
 * Ported from packages/cli/src/ui/utils/textUtils.ts (escapeAnsiCtrlCodes),
 * reduced to the string path this package actually uses: escape ANSI/control
 * sequences in untrusted text before it reaches logs or model context.
 * Returns the input unchanged when it contains no ANSI sequences.
 */
export function escapeAnsiCtrlCodes(text: string): string {
  if (text.search(regex) === -1) {
    return text; // No changes return original string
  }
  regex.lastIndex = 0; // needed for global regex
  return text.replace(regex, (match) => JSON.stringify(match).slice(1, -1));
}
