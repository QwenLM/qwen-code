/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shell-ish argument tokenization for skill argument strings, shared by the
// review and audit parse-args subcommands from the CLI-level shared home.

/**
 * Split a raw argument string on whitespace, honoring single and double
 * quotes (quotes are stripped, their content kept verbatim — a quoted path
 * with spaces or shell metacharacters survives as one literal token).
 */
export function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let sawAny = false;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawAny = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || sawAny) tokens.push(current);
      current = '';
      sawAny = false;
      continue;
    }
    current += ch;
  }
  if (current || sawAny) tokens.push(current);
  return tokens;
}
