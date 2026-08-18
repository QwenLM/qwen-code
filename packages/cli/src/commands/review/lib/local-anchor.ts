/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The local review-fix loop's anchor: content-addressed per-file state.
//
// A PR round anchors on a commit sha. A local round has none — the reviewed
// state is a dirty working tree, and the local capture path is FORBIDDEN from
// writing to the index, the worktree, or any ref (`local-diff.ts` spells out
// why). So the anchor is content: `git hash-object` — no `-w`, computes and
// writes nothing — over every file the plan covered, plus the HEAD the diff
// was based against. The next round re-hashes the same paths and compares:
// under the same HEAD and the same model, a file whose bytes are identical to
// what the previous clean round reviewed is skipped, one import hop of
// dependents re-enters (same widening, same reasons as `fetch-pr --since`), and the
// rest is the delta.
//
// HEAD equality is a hard gate, not a convenience. The captured diff is
// HEAD-vs-worktree: if HEAD moved between rounds, the same worktree bytes
// describe a DIFFERENT change under review (a reset exposes commits the last
// round never saw), so content equality alone certifies nothing. A moved HEAD
// degrades to the full capture, with the reason said out loud.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gitOpt, gitWithInput } from './git.js';

/**
 * Per-file identity for a path whose state CANNOT be captured: a directory
 * (an embedded repo / submodule gitlink above all), a FIFO, an unreadable
 * file, a plan path git C-quoted into something no stat can find. Never
 * compares equal — not even to itself — so such a path re-enters the scope
 * every round. Over-review is the affordable direction; the previous cut
 * mapped all of these to `absent`, where a submodule pointer change compared
 * "unchanged" forever and silently left incremental scope.
 */
export const UNHASHABLE = 'unhashable';

export interface LocalCacheCandidate {
  v: 1;
  target: string;
  /** null on an unborn HEAD (repo with no commits). */
  headSha: string | null;
  /** path → `<mode>:<blob>` identity, for every file the plan covered. */
  files: Record<string, string>;
  /** Content-addressed id of the whole reviewed state, for display and logs. */
  stateId: string;
  /**
   * Digest of the attribute state that decided how these files RENDERED —
   * see `attributeStateId`. Separate from `stateId` because two of its three
   * sources are not in the worktree at all, so a move in them leaves every
   * file identity standing still.
   *
   * Optional only for caches written before the field. Reading one back as
   * "no attribute state" and comparing it equal would be the hole; the gate
   * treats an absent digest as a mismatch, which costs one full round after
   * an upgrade.
   */
  attrId?: string;
}

/**
 * The cache Step 8 writes from a candidate — the candidate's fields plus the
 * model-written ledger (`lastModelId`, `round`, `findings`, …). Only the
 * fields the scoping decision reads are typed; the rest ride as data.
 */
export interface LocalReviewCache extends LocalCacheCandidate {
  lastModelId?: string;
}

/**
 * The per-file identity of `paths`' current worktree state, batched.
 *
 * An identity is `<mode>:<blob>` — `git hash-object` computes the blob id git
 * WOULD store (content-addressed, indifferent to mtime and the index), and
 * the mode prefix carries what content alone cannot: an exec-bit flip or a
 * file↔symlink typechange is its own diff lines, so identical bytes under a
 * different mode are NOT an identical change. Symlinks hash their link text
 * at 120000, exactly what `git diff` renders. Anything that cannot be
 * captured faithfully is `UNHASHABLE`, which never compares equal.
 */
export function hashWorktreeFiles(
  repoRoot: string,
  paths: readonly string[],
): Record<string, string> {
  // Null prototype: a file legally named `__proto__` must store and read as
  // an ordinary own key. On a plain object the assignment hits the inherited
  // setter (a silent no-op) and the read returns Object.prototype — the file
  // could never enter a delta in any round.
  const out: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const hashable: string[] = [];
  const modes: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const p of paths) {
    // `lstat`, not `stat`: a symlink's identity is its LINK TEXT at mode
    // 120000 — exactly what `git diff` renders — not the target's bytes.
    // Following the link let a retargeted symlink whose new target happened
    // to hold equal content compare "unchanged".
    let st;
    try {
      st = lstatSync(join(repoRoot, p));
    } catch {
      // No stat-able file. A genuine deletion lands here — but so does a
      // plan path git C-quoted out of an invalid-UTF-8 filename, whose REAL
      // file exists and changes. The two are indistinguishable at this
      // layer, and treating both as a stable "absent" identity let the
      // second kind compare unchanged forever. UNHASHABLE re-reviews both
      // every round; a deletion's diff section is small, and over-review is
      // the affordable direction.
      out[p] = UNHASHABLE;
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        // RAW BYTES: git identities and diffs use the link text's bytes, and
        // a default-encoding readlink round-trips through a JS string where
        // invalid UTF-8 collapses to U+FFFD — two distinct targets could
        // then share one identity and a retarget compare "unchanged".
        const target = readlinkSync(join(repoRoot, p), { encoding: 'buffer' });
        const oid = gitWithInput(target, [
          '-C',
          repoRoot,
          'hash-object',
          '--stdin',
        ]);
        out[p] = `120000:${oid}`;
      } catch {
        out[p] = UNHASHABLE;
      }
    } else if (st.isFile()) {
      // The mode is part of the identity: `git diff` reports an exec-bit
      // flip as its own lines, so identical bytes under a flipped bit are
      // NOT an identical change. USER bit only (S_IXUSR) — git canonicalizes
      // regular-file modes on that bit alone, and masking all three classes
      // held the identity still across a chmod git visibly reports (0755 →
      // 0655 prints old/new mode lines while g+other bits kept 0o111 truthy).
      modes[p] = (st.mode & 0o100) !== 0 ? '100755' : '100644';
      hashable.push(p);
    } else {
      // Directories (embedded repos, submodule gitlinks the pinned diff
      // flags deliberately keep visible), FIFOs, sockets: not capturable.
      out[p] = UNHASHABLE;
    }
  }
  const BATCH = 200;
  for (let i = 0; i < hashable.length; i += BATCH) {
    const batch = hashable.slice(i, i + BATCH);
    const res = gitOpt('-C', repoRoot, 'hash-object', '--', ...batch);
    const lines = res === null ? null : res.split('\n');
    if (lines !== null && lines.length === batch.length) {
      batch.forEach((p, j) => (out[p] = `${modes[p]}:${lines[j]}`));
      continue;
    }
    // The batch failed as a unit (one unreadable file fails them all) —
    // re-try one by one so a single pathological file costs itself, not
    // its 199 neighbours.
    for (const p of batch) {
      const oid = gitOpt('-C', repoRoot, 'hash-object', '--', p);
      out[p] = oid === null ? UNHASHABLE : `${modes[p]}:${oid}`;
    }
  }
  return out;
}

/**
 * A digest of everything that decides how `git diff` RENDERS the captured
 * files — which is what a round actually reads.
 *
 * The per-file identity above is `<mode>:<blob>` (link text for symlinks) and
 * cannot see this: `binary`, `-diff` and `text` change a section from readable
 * hunks into "Binary files … differ" while every byte and mode stands still.
 * A round that read only a binary marker, then a round where the attribute is
 * gone, would compare equal file-for-file and slice the newly-readable section
 * out of scope — so the first round that CAN read the file never does.
 *
 * Three sources, and only the first is in the worktree:
 *
 *   - every `.gitattributes` governing a captured path (root and ancestors),
 *   - `.git/info/attributes`, which is per-checkout and not tracked,
 *   - `core.attributesFile`, which is per-user and can sit anywhere.
 *
 * The last two are why this cannot be folded into the file map: they flip the
 * rendering with ZERO worktree change, so a delta computed from file
 * identities is empty and the round reports "no changes" over a capture whose
 * diff now contains text nobody read.
 *
 * Absent files contribute a fixed marker rather than nothing, so their later
 * APPEARANCE moves the digest. Unreadable ones contribute their error state
 * for the same reason — a file that cannot be read is not a file that is not
 * there, and both must differ from "read, and empty".
 */
export function attributeStateId(
  repoRoot: string,
  paths: readonly string[],
): string {
  // `.` when the caller has no root to give: every read below is then
  // relative to the process cwd, which is where a rootless caller's files
  // are anyway. Crashing instead would take the whole capture down over a
  // digest, and the digest's job is to make a round MORE conservative.
  const root = repoRoot && repoRoot !== '' ? repoRoot : '.';
  const h = createHash('sha256');
  const read = (abs: string): string => {
    try {
      return `f:${readFileSync(abs, 'utf8')}`;
    } catch (err) {
      return (err as { code?: string }).code === 'ENOENT'
        ? 'absent'
        : 'unreadable';
    }
  };
  for (const rel of governingAttributeFiles(paths)) {
    h.update(`\0${rel}\0${read(join(root, rel))}`);
  }
  h.update(`\0info\0${read(join(root, '.git', 'info', 'attributes'))}`);
  // Per-user and outside the repo. `git config --get` answers null when unset,
  // which is itself part of the state: setting one later must move the digest.
  const configured = gitOpt(
    '-C',
    root,
    'config',
    '--get',
    'core.attributesFile',
  );
  h.update(
    `\0core\0${configured === null ? 'unset' : `${configured}\0${read(configured)}`}`,
  );
  return h.digest('hex');
}

/** `.gitattributes` at the root and in every ancestor of every path. */
function governingAttributeFiles(paths: readonly string[]): string[] {
  const out = new Set<string>(['.gitattributes']);
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      out.add(`${parts.slice(0, i).join('/')}/.gitattributes`);
    }
  }
  return [...out].sort();
}

/** One id for the whole state: order-independent, HEAD included. */
export function stateIdOf(
  headSha: string | null,
  files: Record<string, string>,
): string {
  const h = createHash('sha256');
  h.update(headSha ?? 'unborn');
  for (const path of Object.keys(files).sort()) {
    // NUL-separated fields: no path or blob id contains one, so adjacent
    // entries cannot collide by concatenation.
    h.update(`\0${path}\0${files[path]}`);
  }
  return h.digest('hex');
}

/**
 * Parse a local review cache, fail-quiet. The file is model-written under
 * Step 8's prose rules, so every field is re-validated: a malformed cache
 * degrades to "no anchor" — a full capture — never to a throw and never to a
 * skip.
 */
export function readLocalCache(path: string): LocalReviewCache | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const c = raw as {
    v?: unknown;
    target?: unknown;
    headSha?: unknown;
    files?: unknown;
    stateId?: unknown;
    attrId?: unknown;
    lastModelId?: unknown;
  };
  if (
    !c ||
    c.v !== 1 ||
    typeof c.target !== 'string' ||
    (c.headSha !== null && typeof c.headSha !== 'string') ||
    typeof c.stateId !== 'string' ||
    typeof c.files !== 'object' ||
    c.files === null ||
    // `typeof [] === 'object'`: an array-shaped files map would pass with
    // index-string keys and silently mark every real path changed instead
    // of taking the loud refusal this validator promises.
    Array.isArray(c.files)
  ) {
    return null;
  }
  // Null prototype for the same `__proto__`-as-a-filename reason as
  // `hashWorktreeFiles` — JSON.parse already made the keys own properties;
  // keep them own properties here too.
  const files: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [k, v] of Object.entries(c.files as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    files[k] = v;
  }
  return {
    v: 1,
    target: c.target,
    headSha: c.headSha as string | null,
    files,
    stateId: c.stateId,
    ...(typeof c.attrId === 'string' ? { attrId: c.attrId } : {}),
    ...(typeof c.lastModelId === 'string'
      ? { lastModelId: c.lastModelId }
      : {}),
  };
}

/**
 * The paths whose content differs between the cached state and now — added,
 * removed, and modified alike. Symmetric difference over the two key sets
 * with value comparison on the intersection.
 */
export function changedSince(
  cached: Record<string, string>,
  current: Record<string, string>,
): string[] {
  // `Object.hasOwn`, never `in` or bare reads: both maps can be JSON-parsed
  // or model-written, and a path named after any Object.prototype member
  // (`toString`, `constructor`) must behave as an ordinary key.
  const eq = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined &&
    a === b &&
    // UNHASHABLE never equals — not even itself. It marks state that could
    // not be captured, and "could not capture it twice" is not "unchanged".
    a !== UNHASHABLE;
  const out: string[] = [];
  for (const path of Object.keys(current)) {
    const cachedId = Object.hasOwn(cached, path) ? cached[path] : undefined;
    if (!eq(cachedId, current[path])) out.push(path);
  }
  for (const path of Object.keys(cached)) {
    if (!Object.hasOwn(current, path)) out.push(path);
  }
  return out;
}
