/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI-level shared path helpers — the home for pieces more than one command
// family consumes, so neither imports across command groups.

import { createHash } from 'node:crypto';

/** POSIX caps one filename component at 255 bytes; every consumer
 *  interpolates the slug into a single component. Keep the bound far
 *  enough under the cap that a suffix can still join the component. */
const SAFE_TARGET_MAX_CHARS = 200;

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
 *
 * Dashes are flattened too, on purpose: the slugs are prefix-scanned with a
 * dash boundary (`qwen-review-<slug>-` in review's cleanup), and a slug that
 * itself contained `-` — natively, or via the truncation join — could extend
 * a shorter slug, letting one target's cleanup sweep a DISTINCT target's
 * artifacts. With `-` out of the slug alphabet the space is prefix-free at
 * that boundary by construction.
 */
export function safeTarget(target: string): string {
  let flat = target
    .replace(/[^A-Za-z0-9._]/g, '_') // separators, dashes, anything odd → underscore
    .replace(/\.\.+/g, '_'); // no run of dots survives as a traversal token
  // A deep nested target flattens past the one-component byte cap
  // (ENAMETOOLONG): truncate and keep uniqueness with a hash of the
  // ORIGINAL target, so distinct long paths stay distinct. The digest joins
  // with `_` — the one dash in a filename is the prefix-scan boundary.
  if (flat.length > SAFE_TARGET_MAX_CHARS) {
    const digest = createHash('sha256')
      .update(target)
      .digest('hex')
      .slice(0, 12);
    flat = `${flat.slice(0, SAFE_TARGET_MAX_CHARS - digest.length - 1)}_${digest}`;
  }
  // Leading dots/underscores too: a dash-leading slug is no longer possible
  // (dashes flatten), and a dot-leading component reads as a hidden file.
  return flat.replace(/^[._]+/, '') || 'target';
}
