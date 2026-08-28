/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

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
 *
 * Deliberately byte-identical to the pre-lift review implementation: the
 * lift must not change any slug, because review's artifact naming is a
 * two-sided contract — bundled-skill templates, composed-name, prev-ledger,
 * and brief/report producers hardcode the dash spelling. Deep-target
 * truncation (and the prefix-free question it raises for cleanup's prefix
 * sweep, review-round finding R8-7) stays OUT of this lift: it is a behavior
 * change and lands with the sweep-side fix it needs, not smuggled through a
 * move.
 */
export function safeTarget(target: string): string {
  // IDEMPOTENT over its own outputs, checked BEFORE the flatten: `tmpFile`/
  // `tmpPrefix` apply this function to tokens that other callers derived
  // with it already, and the capped shape's `~` joiner sits outside the
  // kept alphabet — a second flatten rewrote it to `_` while `run`'s pins
  // interpolated the single-flatten spelling raw, so for every deep target
  // the child wrote `<head>_<digest>-stop.json` and the parent polled
  // `<head>~<digest>-…` for ever (R18-1). An INPUT that happens to spell
  // the capped shape passes through unchanged; the collision that permits
  // is no wider than the flatten's own (`src/foo` and `src_foo` already
  // share a token by design).
  if (/^[A-Za-z0-9._-]{55}~[0-9a-f]{8}$/.test(target)) return target;
  const flat = target
    .replace(/[^A-Za-z0-9._-]/g, '_') // separators and anything odd → underscore
    .replace(/\.\.+/g, '_'); // no run of dots survives as a traversal token
  const stem = flat.replace(/^[._]+/, '') || 'target';
  if (stem.length <= SAFE_TARGET_MAX) return stem;
  // Capped, because the stem is now a whole repo-relative path rather than a
  // basename, and it rides inside a FILENAME: `qwen-review-<stem>-<suffix>`
  // adds 33 characters around it, so a legal path whose flattened spelling
  // passes ~222 makes every write for that target throw ENAMETOOLONG on a
  // NAME_MAX-255 filesystem — the capture dies before it writes the plan, on
  // every round, for that target and no other.
  //
  // Suffixed with a digest of the FULL spelling, not truncated bare: two deep
  // paths sharing a 56-character head are ordinary in a monorepo, and a bare
  // cut would give them one cache and one set of artifacts.
  //
  // On the prefix sweep this was deferred for (`cleanup` filters
  // `startsWith(tmpPrefix(target))`, review-round finding R8-7): capped stems
  // are prefix-free against EVERY stem, not just each other. Among
  // themselves they are all exactly `SAFE_TARGET_MAX` long, so none extends
  // another; against uncapped stems the `~` joiner decides — it sits outside
  // the token alphabet (the flatten above maps it to `_`), so no uncapped
  // stem can spell a capped stem's head-plus-joiner. With `-` here, every
  // exactly-55-character uncapped stem WAS a strict sweep-prefix of every
  // capped stem sharing its head, and a finishing review deleted the capped
  // twin's live artifacts mid-round (R17-6 entrance 2). The short-stem
  // hazard the sweep already had (`abc` prefixing `abc-def`, R17-6
  // entrance 1) predates the cap and is tracked separately.
  return `${stem.slice(0, SAFE_TARGET_MAX - 9)}~${createHash('sha256')
    .update(stem)
    .digest('hex')
    .slice(0, 8)}`;
}

/**
 * Longest stem `safeTarget` emits.
 *
 * 64 matches `scratchLabel`'s cap, which was set against the same NAME_MAX
 * ceiling: 12 characters of `qwen-review-` prefix, the longest suffix any
 * producer appends (21, `-cache-candidate.json`), and the stem leaves ~158
 * characters of headroom.
 */
const SAFE_TARGET_MAX = 64;
