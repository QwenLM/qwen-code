/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** Read the single-line composer between its rules, excluding transcript rows. */
export function composerValue(frame: string): string | undefined {
  const lines = frame.split('\n');
  for (let index = lines.length - 3; index >= 0; index--) {
    if (
      !/^\s*─{20,}/.test(lines[index]) ||
      !/^\s*─{20,}/.test(lines[index + 2])
    ) {
      continue;
    }
    const match = /^\s*[>*❯](?: (.*))?$/.exec(lines[index + 1].trimEnd());
    if (!match) continue;
    const value = match[1] ?? '';
    return value === '  Type your message or @path/to/file' ? '' : value;
  }
  return undefined;
}
