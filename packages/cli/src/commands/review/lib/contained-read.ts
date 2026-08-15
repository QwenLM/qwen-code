/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Every read of on-disk evidence, confined to regular files inside the
// harness's own tree.
//
// The resume feature's threat model rests on one sentence: "a fabricated
// session id can at most point a reader at a directory inside the harness's
// own `subagents/` tree." Path-shape validation alone does not deliver that.
// A ledger id that is lexically clean still names a path, and a path is
// resolved by the filesystem — through whatever symlinks sit on it. Three
// separate shapes defeat the sentence:
//
//   - a symlinked ANCESTOR (`subagents` itself, or the project dir) redirects
//     the whole subtree, so checking the final component proves nothing;
//   - a symlinked LEAF (`agent-<id>.jsonl`, `run-sessions.json`) feeds foreign
//     content to a reader that believes it read the harness's record;
//   - a check-then-open pair (`lstatSync` then `readFileSync`, `statSync` then
//     `readUsage`) validates one object and reads another, because the two
//     calls resolve the pathname independently. A swap between them — to
//     another file, or to a FIFO that never returns — lands in the gap.
//
// So reads go through here instead. One `openSync` with `O_NOFOLLOW`, one
// `fstatSync` on THAT descriptor, and the bytes read from the same descriptor:
// the object validated is the object read, with no second resolution of the
// name. Directories are validated component by component from a root that must
// itself be real, and the identity captured before `readdirSync` is re-checked
// after it, so a swap during the listing is detected rather than trusted.
//
// The failure direction is uniform and deliberate: anything that cannot be
// proven to be a contained regular file reads as ABSENT, never as empty
// evidence that happens to certify. Invisible evidence re-owes the work, which
// every gate downstream already implements.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

/**
 * Bookkeeping files (`run-sessions.json`, `resume.json`) hold a handful of
 * small entries. A planted multi-gigabyte one would otherwise stall every
 * command that touches them.
 */
export const MAX_LEDGER_BYTES = 256 * 1024;

/**
 * Transcript and chat streams. Not a policy about how much an agent may say —
 * it is the ceiling above which a file is certainly not one of these. Real
 * ones run to a few MB; a JSONL stream at a quarter gigabyte is a plant or a
 * corruption, and reading it would exhaust the process before any gate saw a
 * record. Sits under V8's own string ceiling, so the read fails as a refusal
 * here rather than as an opaque allocation throw deeper in.
 */
export const MAX_STREAM_BYTES = 256 * 1024 * 1024;

/**
 * Open flags for a contained read.
 *
 * Windows does not expose `O_NOFOLLOW`, so there the leaf is opened WITHOUT
 * symlink protection and the `fstat` regular-file check below is what remains.
 * That is a deliberate trade, not a no-loss fallback: refusing to read
 * evidence at all on Windows would make every gate uncertifiable there. Key it
 * on the platform, not on the flag's presence — every other platform Node runs
 * on exposes `O_NOFOLLOW`, and a bare `?? 0` would silently drop the hardening
 * on some future platform that lacked it for an unrelated reason.
 *
 * `O_NONBLOCK` is what makes the descriptor-first design safe against the FIFO
 * this whole guard exists to refuse. Opening a FIFO for reading BLOCKS until a
 * writer arrives, so checking the type after the open would hang exactly where
 * the old check-then-open pair merely failed — the fix would have introduced
 * the hang it was meant to prevent. Non-blocking, the open returns at once,
 * `fstat` sees a FIFO, and the descriptor is closed unread. It is a no-op for
 * the regular files this ever legitimately opens.
 */
function readFlags(): number {
  const noFollow =
    process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  return (constants.O_RDONLY ?? 0) | noFollow | (constants.O_NONBLOCK ?? 0);
}

/** What a contained read returns: the bytes, and the metadata of the same object. */
export interface ContainedFile {
  content: string;
  /** From `fstat` on the descriptor that produced `content`, not a later stat. */
  mtimeMs: number;
  size: number;
  /**
   * True when `minMtimeMs` was supplied and this file predates it: the
   * descriptor was opened and validated, and the BYTES WERE NEVER READ.
   *
   * This is what keeps the membership fence cheap. A session-scoped transcript
   * directory is never pruned, so it accumulates streams from earlier reviews
   * in the same session, and a file whose last write predates the floor cannot
   * hold an above-floor record. The caller used to skip those with a
   * pathname `stat` and never open them — which is precisely the split this
   * module exists to remove. Folding the test into the descriptor keeps both
   * properties: one resolution of the name, and no bytes read for a file that
   * cannot contribute a record.
   */
  stale?: boolean;
}

/**
 * Why a read was refused. Callers that disclose (the cost ledger) need to tell
 * "not there" from "there but not readable as evidence" — the second is a
 * fact worth printing, the first is the ordinary state of a run that launched
 * no agents.
 */
export class ContainedReadError extends Error {
  constructor(
    message: string,
    readonly reason: /** The file is not there. The ordinary state, not a fault. */
    | 'absent'
      /** There, and the open refused — a link, a permission, an I/O fault. */
      | 'open-failed'
      | 'not-regular'
      | 'too-large'
      | 'read-failed',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ContainedReadError';
  }
}

/**
 * Read one file as a bounded, regular, non-symlinked file — opened once.
 *
 * Throws `ContainedReadError` for every refusal so a caller can disclose the
 * distinction; use {@link readContainedFileOrNull} where absence and refusal
 * are the same answer.
 */
export function readContainedFile(
  path: string,
  maxBytes: number,
  opts: {
    minMtimeMs?: number;
    /**
     * The `readSync` this uses. A seam, and only that: the short-read branch
     * below is the one piece of this module no fixture can reach from the
     * outside, because a fully-present file always comes back in one call —
     * so without it, the loop that keeps a half-flushed transcript from
     * being reported with an uninitialized buffer tail is unpinnable.
     */
    read?: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => number;
  } = {},
): ContainedFile {
  let fd: number;
  try {
    // Windows has no `O_NOFOLLOW`, so without this the open FOLLOWS a leaf
    // link and `fstat` then validates the TARGET — a planted ledger link
    // inside a genuinely contained directory would parse as entries there.
    // `lstat` does not follow on any platform, and refusing is this module's
    // documented direction anyway.
    if (process.platform === 'win32' && lstatSync(path).isSymbolicLink()) {
      throw Object.assign(new Error(`${path} is a symbolic link`), {
        code: 'ELOOP',
      });
    }
    fd = openSync(path, readFlags());
  } catch (err) {
    // ELOOP here IS the symlink refusal on POSIX: `O_NOFOLLOW` fails the open
    // rather than resolving the link. ENOENT is the ordinary absent case; the
    // caller decides which of the two matters to it.
    throw new ContainedReadError(
      `could not open ${path}: ${(err as Error).message}`,
      // ENOENT is absence; every other errno is a refusal. Different reasons,
      // so a caller that discloses can ask this type rather than reaching
      // into an undocumented `cause.code` chain that routes correctly only by
      // accident.
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'absent'
        : 'open-failed',
      { cause: err },
    );
  }
  try {
    // The descriptor, not the name. This is the whole point: no second
    // resolution of the pathname can happen between the check and the read,
    // because there is no second resolution at all.
    const st = fstatSync(fd);
    if (!st.isFile()) {
      // A FIFO would block the read forever — a hang, not an error, in a
      // command a review is waiting on. A directory or device is not evidence
      // either.
      throw new ContainedReadError(
        `${path} is not a regular file`,
        'not-regular',
      );
    }
    // Before the size ceiling and before the read: a stale file is skipped
    // whatever its size, and skipping it costs one `fstat` on a descriptor
    // that is about to be closed.
    if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) {
      return { content: '', mtimeMs: st.mtimeMs, size: 0, stale: true };
    }
    if (st.size > maxBytes) {
      throw new ContainedReadError(
        `${path} is ${st.size} bytes, over the ${maxBytes}-byte ceiling`,
        'too-large',
      );
    }
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    // `readSync` returns short reads. Loop to the size `fstat` reported, and
    // stop at EOF: a file being appended to while it is read (the harness
    // flushes transcripts incrementally) yields fewer bytes than the stat
    // promised, which is a partial record, not a fault — `parseTranscript`
    // and `parseLineTolerant` already drop a torn last line.
    while (off < st.size) {
      const n = (opts.read ?? readSync)(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return {
      content: buf.subarray(0, off).toString('utf8'),
      mtimeMs: st.mtimeMs,
      size: off,
    };
  } catch (err) {
    if (err instanceof ContainedReadError) throw err;
    throw new ContainedReadError(
      `could not read ${path}: ${(err as Error).message}`,
      'read-failed',
      { cause: err },
    );
  } finally {
    closeSync(fd);
  }
}

/** {@link readContainedFile}, with every refusal flattened to `null`. */
export function readContainedFileOrNull(
  path: string,
  maxBytes: number,
  opts: { minMtimeMs?: number } = {},
): ContainedFile | null {
  try {
    return readContainedFile(path, maxBytes, opts);
  } catch {
    return null;
  }
}

/**
 * A path that is not inside the tree it must be inside — or that is reached
 * through a link.
 *
 * Carries a `code` like an errno so it travels through the callers that route
 * on one, and deliberately NOT `ENOENT`: absence is the ordinary state of a
 * run that launched no agents, while this is a directory that exists and is
 * not the one it claims to be. Those two must not collapse.
 */
export class UncontainedPathError extends Error {
  readonly code = 'EUNCONTAINED';
  constructor(message: string) {
    super(message);
    this.name = 'UncontainedPathError';
  }
}

/** A directory's identity, as captured before a listing and re-checked after it. */
interface DirIdentity {
  dev: number;
  ino: number;
}

/**
 * Is `child` inside `parent` (or equal to it), by path shape?
 *
 * Shape only — the component walk below is what proves no link redirects the
 * way there. Both sides are resolved first so `..` cannot smuggle a path out.
 */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  // An ABSOLUTE `rel` means the two paths share no root at all: on Windows,
  // `relative('C:\\root', 'D:\\other')` returns `'D:\\other'`, which is
  // neither empty nor `..`-prefixed and would otherwise read as contained.
  // POSIX `relative` never returns an absolute path, so this clause only
  // bites on the platform where the leaf guard is already weakest.
  if (isAbsolute(rel)) return false;
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/**
 * Why a directory is not usable, when it is not.
 *
 * `missing` and `uncontained` must stay apart. A directory that does not exist
 * yet is the ordinary state of a resumed run before its first agent launches,
 * and callers legitimately absorb it; a directory that exists but is reached
 * through a link, or is not a directory at all, is a fact a run must not
 * quietly proceed past. Collapsing the two would let the second hide inside
 * the first's tolerance.
 */
export type ContainedDirResult =
  | { ok: true; identity: DirIdentity }
  | { ok: false; reason: 'missing' | 'uncontained' };

/**
 * Validate a directory that must live under `root`, following no links.
 *
 * Walks every component from `root` down to `dir` with `lstat`, so a symlinked
 * ancestor — `subagents -> /elsewhere`, the project dir itself — is refused
 * where checking only the final component would pass. `root` must itself be a
 * real directory: a run whose whole harness tree is a link has no contained
 * evidence to offer.
 */
export function containedDir(root: string, dir: string): ContainedDirResult {
  const rootPath = resolve(root);
  const dirPath = resolve(dir);
  if (!isWithin(rootPath, dirPath)) {
    return { ok: false, reason: 'uncontained' };
  }
  // Components between root and dir, root itself included: `subagents` is an
  // ancestor of `subagents/<id>` and is exactly the link a forged ledger entry
  // would ride.
  const parts = relative(rootPath, dirPath).split(sep).filter(Boolean);
  let current = rootPath;
  let last: DirIdentity | null = null;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) current = resolve(current, parts[i - 1] as string);
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      // Absent is not a containment verdict — nothing is there to redirect
      // anything. Anything else (EACCES, EIO) is: the path exists in some
      // form this process cannot vouch for.
      return {
        ok: false,
        reason:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing'
            : 'uncontained',
      };
    }
    // `lstat` does not follow, so a link reports as a link even when it points
    // at a perfectly good directory. Both checks matter: a non-directory
    // ancestor cannot be walked, and a linked one is the redirect itself.
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, reason: 'uncontained' };
    }
    last = { dev: st.dev, ino: st.ino };
  }
  return { ok: true, identity: last as DirIdentity };
}

/**
 * List a validated directory, then prove it was still the same directory.
 *
 * `readdirSync` takes a pathname, so the object it lists is resolved anew —
 * a swap between {@link containedDir} and this call would list a different
 * directory under the name that was validated. Re-`lstat` afterwards and
 * compare `dev`/`ino`: a replaced directory is a different inode, and the
 * listing is discarded rather than trusted.
 *
 * Throws whatever `readdirSync` throws — callers already distinguish ENOENT
 * ("no agents ran") from a live I/O fault, and flattening that here would
 * erase the distinction. A detected swap is reported as ENOENT-shaped
 * absence: the safe direction, since the contents were never proven to be the
 * harness's.
 */
export function listContainedDir(dir: string, identity: DirIdentity): string[] {
  const names = readdirSync(dir);
  let after;
  try {
    after = lstatSync(dir);
  } catch (err) {
    // It was there a moment ago and cannot be stat'ed now. Not "no agents".
    throw new UncontainedPathError(
      `${dir} could not be re-validated after listing: ` +
        `${(err as Error).message}`,
    );
  }
  if (after.dev !== identity.dev || after.ino !== identity.ino) {
    // A DETECTED swap — the one unambiguous signal of interference this
    // re-check exists to produce. Returning `[]` made it indistinguishable
    // from a mundane empty directory, so the detection fired and nothing
    // downstream ever said so. Callers already route `EUNCONTAINED`.
    throw new UncontainedPathError(
      `${dir} was replaced between validation and listing`,
    );
  }
  return names;
}

/**
 * The root every evidence path must sit under: the harness's project
 * directory, validated as a real directory.
 *
 * Returns null when it is absent or is itself a link — in which case nothing
 * below it can be read as contained evidence.
 */
export function containedRoot(
  projectDir: string,
):
  | { ok: true; root: string }
  | { ok: false; reason: 'missing' | 'uncontained' } {
  const root = resolve(projectDir);
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, reason: 'uncontained' };
    }
  } catch (err) {
    // Absent is mundane — a cleaned-up harness tree — and printing the
    // containment word for it sends an operator hunting for a planted link
    // that does not exist.
    return {
      ok: false,
      reason:
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'uncontained',
    };
  }
  return { ok: true, root };
}

/**
 * The directory a file sits in, for callers that hold a leaf path and need its
 * parent validated before the leaf is opened.
 */
export function parentDirOf(filePath: string): string {
  return parse(resolve(filePath)).dir;
}
