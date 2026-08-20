/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A path, quoted for a POSIX shell — the form every printed repair command
 * uses. Bare interpolation split a copy-pasted `--plan` at the first space; a
 * plain `'…'` wrap traded that for breaking on the first embedded apostrophe
 * (`~/Documents/John's Projects/…` is an ordinary macOS workspace). The
 * `'\''` dance closes both: end the quote, emit a literal `'`, reopen.
 * Same pattern as `shellQuoteForSh` in utils/standalone-update.ts.
 */
export function shellQuotePath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}
