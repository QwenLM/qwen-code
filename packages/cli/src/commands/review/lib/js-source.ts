/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JavaScript source with its comments blanked. String and template literals
 * match first and are returned verbatim, so a `/*` or a `// …` line inside a
 * literal — a glob like `'packages/*'`, a URL, an agent prompt — never
 * triggers the comment arms and blanks real code up to the next `*\/`.
 * A regex literal is not modeled.
 */
export function stripComments(src: string): string {
  return src.replace(
    /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('/') ? ' ' : m),
  );
}
