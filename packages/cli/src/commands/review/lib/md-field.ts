/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render a PR-controlled segment — a diff file path, a linter's message — safe to
 * splice into the review body we POST to GitHub. Git allows almost any byte in a
 * filename, so an unescaped path could carry `@mentions`, HTML, Markdown, or a
 * newline that forges body structure. An inline code span makes Markdown/HTML/`@`
 * inert; stripping backticks and newlines stops the value breaking out of the span
 * or forging new lines. (`capture-local`'s `display()` does the terminal-side
 * equivalent for stderr; this is the Markdown-body side.)
 *
 * Shared rather than restated: every body surface that renders a PR-controlled
 * path routes through this ONE function. The convergence paragraph spelled its
 * own backticks at first and shipped the breakout this strip exists to stop —
 * a path recorded in one round's ledger, rendered in the next round's cluster
 * sentence, terminated the code span early and the remainder rendered as live
 * Markdown in the bot's own public body.
 */
export function mdField(s: unknown): string {
  const inner = String(s)
    .replace(/[`\r\n]+/g, ' ')
    .trim();
  // A value that strips to nothing would emit a bare pair of backticks, which
  // is not a code span at all: two such runs in one paragraph pair up as
  // opener and closer, and the bot's own prose between them renders as code.
  // Git permits a filename that is nothing but backticks, so the empty case
  // is PR-controlled like every other input here.
  return '`' + (inner === '' ? '(unnamed)' : inner) + '`';
}
