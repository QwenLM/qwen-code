/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI-level shared path helpers — the home for pieces more than one command
// family consumes, so neither imports across command groups.

/**
 * A `target` reduced to a single safe filename component.
 *
 * `target` is a file path (`src/foo.ts`) or a label. Interpolated raw,
 * `src/foo.ts` becomes `qwen-review-src/foo.ts-diff.txt`, a nested path whose
 * parent nobody created (ENOENT), and a crafted `../../evil` escapes its temp
 * dir and lets `writeFileSync` land anywhere. Flatten every separator and
 * dot-segment to a single component so the file always sits directly in the
 * target directory.
 *
 * Dots are preserved singly on purpose: review and audit slugs name artifacts
 * after dotted paths (`src/foo.ts`). `sanitizeFilenameComponent` in
 * packages/core (agent-transcript.ts) answers the same question for
 * transcript/monitor names and flattens dots instead — the two stay separate
 * on that deliberate difference.
 */
export function safeTarget(target: string): string {
  const flat = target
    .replace(/[^A-Za-z0-9._-]/g, '_') // separators and anything odd → underscore
    .replace(/\.\.+/g, '_'); // no run of dots survives as a traversal token
  // Leading dashes too: a dash-leading slug is parsed as short flags when a
  // consumer passes it as a spaced CLI argument value.
  return flat.replace(/^[._-]+/, '') || 'target';
}
