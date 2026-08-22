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
import { gitOpt, gitWithInput, gitWithInputRaw } from './git.js';

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
   * The repo-relative path `target` was flattened from, on a file review.
   *
   * `safeTarget` is not injective — `src/foo.ts` and `src_foo.ts` flatten to
   * one token — and the cache is keyed by the token, so the token alone
   * cannot tell two files apart. Absent on a plain `local` round, which has
   * no single source.
   */
  source?: string;
  /**
   * The identity reviewing this round, provider-qualified, as the runtime
   * published it — written by the CAPTURE, not merged in afterwards.
   *
   * Step 8 used to add it from `{{model}}`, which interpolates the BARE model
   * id: two provider configurations exposing one model name recorded the same
   * token and passed each other's same-model gate, which is the contract's
   * whole point. Empty when the runtime published no identity, and the gate
   * reads empty as a mismatch — an unverifiable contract is a failed one.
   */
  lastModelId: string;
}

/**
 * The cache Step 8 writes from a candidate — the candidate's fields plus the
 * model-written ledger (`round`, `findings`, …). Only the fields the scoping
 * decision reads are typed; the rest ride as data. `lastModelId` is inherited
 * from the candidate and optional here only because a cache written before it
 * moved into the capture may not carry one — which the gate treats as a
 * mismatch, so such a cache costs a full round and never a wrong scope.
 */
export interface LocalReviewCache
  extends Omit<LocalCacheCandidate, 'lastModelId'> {
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
    // A path carrying U+FFFD is a decode, not a name. The capture pins
    // `core.quotePath=false` and decodes with `toString('utf8')`, so every
    // invalid byte folds to the replacement character — and when a file
    // LITERALLY named with U+FFFD exists beside such a path, the two fold to
    // one key: `lstat` succeeds on the real one, the invalid-byte sibling
    // inherits its identity, is never hashed, and its changes compare
    // unchanged for ever. That is the fail-open this identity exists to
    // close, and the `lstat` guard below cannot see it because the stat
    // SUCCEEDS.
    //
    // Over-review is the affordable direction, and a filename holding a real
    // U+FFFD is rare enough that paying for it every round costs nothing
    // measurable.
    if (p.includes('\ufffd')) {
      out[p] = UNHASHABLE;
      continue;
    }
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
  // …and how each one RENDERS, which mode and blob cannot say. `binary`,
  // `-diff` and `text` turn a section from readable hunks into "Binary files
  // … differ" while every byte and mode stands still, so a round that read
  // only the marker and a round where the attribute is gone compared equal
  // and the newly-readable section was sliced out of scope.
  //
  // Per file rather than as one digest beside the map, and asked of git
  // rather than re-derived. A digest over the attribute SOURCES diverged from
  // git's own resolution in every corner anyone looked at — a relative
  // `core.attributesFile` resolves against the repo root, not the process
  // cwd; a linked worktree honours the COMMONDIR's `info/attributes`;
  // `diff.<driver>.binary` flips the rendering from config, which no
  // attributes file mentions — and each divergence left the digest equal
  // while the rendering moved. It also could not survive a changing path set:
  // one new file changed the digest and refused the anchor. Folded in here,
  // the existing per-path comparison handles all of it.
  const attrs = renderingAttributes(repoRoot, hashable);
  for (const p of hashable) {
    if (out[p] === UNHASHABLE) continue;
    const a = attrs[p];
    // A path git could not answer for takes UNHASHABLE, not a placeholder
    // component: a placeholder equals itself, so two rounds that both failed
    // to read the attributes would compare "unchanged" and certify a
    // rendering neither had seen — the same fail-open this whole field
    // exists to close. UNHASHABLE re-reviews it instead.
    out[p] = a === undefined ? UNHASHABLE : `${out[p]}:${a}`;
  }
  return out;
}

/**
 * The effective rendering attributes of each path, as GIT reports them.
 *
 * `git check-attr` answers under every source git honours, in git's own
 * precedence, with git's own path resolution — `.gitattributes` at any level,
 * `.git/info/attributes`, the COMMONDIR's copy in a linked worktree,
 * `core.attributesFile` resolved the way git resolves it, and the config-side
 * diff drivers a hand-derivation cannot see at all.
 *
 * A path git could not answer for gets `'unknown'` from the caller, which
 * never equals a real answer — an unavailable probe must not certify the
 * state it could not read.
 */
function renderingAttributes(
  repoRoot: string,
  paths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (paths.length === 0) return out;
  // `diff` alone would miss the two that set it indirectly: `binary` implies
  // `-diff -text`, and `text` decides eol normalisation, which changes the
  // bytes a hunk shows.
  const ATTRS = ['diff', 'binary', 'text'];
  let raw: string;
  try {
    // `-z` on both sides: NUL-delimited input and output, so a path holding a
    // newline or a colon cannot forge a record — the same reason every
    // listing in this file is byte-faithful.
    //
    // …and RAW, because the convenience wrapper is not. Its `.trim()` eats a
    // leading whitespace byte — legal in a path on Linux and macOS — so the
    // first record's echoed key stops matching the path that was asked
    // about, and every record shifts onto a phantom key: the path gets a
    // MALFORMED identity instead of an honest `UNHASHABLE`. That fails OPEN
    // in one direction, because the stolen record is the `diff` attribute, so
    // a `diff=<driver>` path never folds its driver's `binary` setting in and
    // the config-side binary↔text flip this whole function exists to track
    // goes invisible. The `\r\n` → `\n` rewrite can collide one record's key
    // with a sibling's the same way.
    raw = gitWithInputRaw(Buffer.from(`${paths.join('\0')}\0`), [
      '-C',
      repoRoot === '' ? '.' : repoRoot,
      'check-attr',
      '--stdin',
      '-z',
      ...ATTRS,
    ]);
  } catch {
    return out; // every path falls back to `'unknown'`
  }
  // Records are `<path> NUL <attr> NUL <value> NUL`, repeated.
  const drivers = new Set<string>();
  // Structured path → driver, recorded while the records are parsed, because
  // the comma-joined serialization cannot be re-parsed on the way back: a
  // driver NAME may contain a comma (`*.bin diff=a,b` is a legal gitattributes
  // line), and a `split(',')` match can never equal such a value — the fold
  // below would silently drop its `binary` flag from the identity, leaving
  // the identity still across a flip that changes the rendering.
  const diffDriverByPath = Object.create(null) as Record<string, string>;
  const f = raw.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) {
    const [path, attr, value] = [f[i], f[i + 1], f[i + 2]];
    if (path === undefined || attr === undefined || value === undefined) break;
    if (attr === 'diff' && !ATTR_STATES.has(value)) {
      drivers.add(value);
      diffDriverByPath[path] = value;
    }
    out[path] =
      out[path] === undefined
        ? `${attr}=${value}`
        : `${out[path]},${attr}=${value}`;
  }
  // `diff=<driver>` names a driver whose behaviour lives in git CONFIG, not
  // in any attributes file — and `diff.<driver>.binary` flips a section
  // between readable hunks and "Binary files … differ" with the attribute
  // value, the mode and the blob all standing still. `check-attr` reports the
  // NAME; the config is a second question, and only for the paths that name
  // one. (`textconv` is the driver's other rendering knob and is neutralised
  // by the pinned `--no-textconv`; unpinning that flag means adding it here.)
  for (const driver of drivers) {
    const binary = gitOpt(
      '-C',
      repoRoot === '' ? '.' : repoRoot,
      'config',
      '--get',
      `diff.${driver}.binary`,
    );
    if (binary === null) continue;
    for (const [path, attrs] of Object.entries(out)) {
      if (diffDriverByPath[path] === driver) {
        out[path] = `${attrs},${driver}.binary=${binary}`;
      }
    }
  }
  return out;
}

/** `check-attr` answers for a set attribute, not a driver name. */
const ATTR_STATES = new Set(['unspecified', 'set', 'unset']);

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
    source?: unknown;
    headSha?: unknown;
    files?: unknown;
    stateId?: unknown;
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
    ...(typeof c.lastModelId === 'string'
      ? { lastModelId: c.lastModelId }
      : {}),
    // Carried through, because the target token it sits beside is not
    // injective and the gate compares this instead. Absent stays absent: a
    // cache from before the field reads as a mismatch against a file review,
    // which costs one full round.
    ...(typeof c.source === 'string' ? { source: c.source } : {}),
  };
}

/**
 * The paths whose content differs between the cached state and now — added,
 * removed, and modified alike. Symmetric difference over the two key sets
 * with value comparison on the intersection.
 *
 * Callers that need to know whether anything genuinely MOVED must use
 * `movedSince` instead: a path this returns may be here only because it could
 * not be hashed, which is a reason to review it every round and not a reason
 * to believe the tree changed.
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

/**
 * The paths that genuinely MOVED — `changedSince` minus the ones that are in
 * it only because neither side could be hashed.
 *
 * `UNHASHABLE` never equals itself, deliberately: state that could not be
 * captured must be re-reviewed every round rather than certified. But that
 * makes it permanently present in `changedSince`, and a round that keyed its
 * "nothing changed, stop" decision on that list could never reach it. Any
 * pending deletion of a tracked file hashes this way, so the local
 * review-fix loop could not converge for a change set containing one: round
 * N+1 re-hashed the same section to `UNHASHABLE`, announced "1 changed
 * file(s)" over a byte-identical diff, re-sliced it into scope, and re-armed
 * itself for round N+2 — until HEAD moved.
 *
 * Both facts are needed and they are not the same fact. The scope keeps using
 * `changedSince` (over-reviewing an unhashable path is the safe direction);
 * the stop, and anything a human reads as "what changed", uses this.
 */
export function movedSince(
  cached: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return changedSince(cached, current).filter((path) => {
    const before = Object.hasOwn(cached, path) ? cached[path] : undefined;
    const after = Object.hasOwn(current, path) ? current[path] : undefined;
    // Unhashable on BOTH sides is "still unreadable", not "changed". Either
    // side merely absent IS a move — the path entered or left the capture.
    return !(before === UNHASHABLE && after === UNHASHABLE);
  });
}
