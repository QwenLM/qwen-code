/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import { FsError, type FsErrorKind } from './errors.js';

// `canonicalizeWorkspace` and `MAX_WORKSPACE_PATH_LENGTH` lifted to
// `@qwen-code/acp-bridge` in #4175 PR 22b — the bridge package owns the
// cross-module workspace-canonicalization contract directly. Imported
// here for the local `canonicalizeBoundWorkspaceCached` fast-path AND
// re-exported so callers like `config.ts` / `settings.ts` /
// `sandbox.ts` and the file-system service keep importing from
// `./serve/fs/paths.js` without churn.
import {
  canonicalizeWorkspace,
  MAX_WORKSPACE_PATH_LENGTH,
} from '@qwen-code/acp-bridge/workspacePaths';
export { canonicalizeWorkspace, MAX_WORKSPACE_PATH_LENGTH };

/**
 * Branded absolute path that has passed the workspace boundary check.
 * The runtime value is just a string; the brand is a compile-time
 * marker that prevents PR 19/20 routes from accidentally bypassing
 * `resolveWithinWorkspace` and reading user-supplied input straight
 * to disk. Construct one only via `resolveWithinWorkspace`.
 */
export type ResolvedPath = string & { readonly __brand: 'ResolvedPath' };

/**
 * Intent declared at boundary entry. Used by callers (and the upcoming
 * `policy.ts` module) to decide ignore/trust handling.
 * `resolveWithinWorkspace` itself uses the intent to differentiate
 * ENOENT semantics: `'write'` and `'stat'` tolerate a non-existent
 * leaf (the file is about to be created, or the caller is asking
 * "does this exist?"), other intents do not.
 *
 * `'edit'` is a distinct intent from `'write'` so the trust gate,
 * audit payload, and exhaustiveness checks can reason about
 * partial-replace semantics separately from full-overwrite. Both
 * gate identically in `assertTrustedForIntent`; the split exists
 * to keep audit events faithful to the operation actually
 * performed.
 *
 * Why `'stat'` tolerates ENOENT: stat-ing a path that doesn't
 * exist is a legitimate existence check (a route handler asking
 * "should I 404?" before letting a downstream call fail with a
 * cryptic message). `WorkspaceFileSystem.stat()` re-`lstat`s the
 * resolved path itself and surfaces the natural ENOENT to the
 * caller, so the resolver doesn't need to pre-emptively reject.
 */
export type Intent = 'read' | 'write' | 'edit' | 'list' | 'glob' | 'stat';

/**
 * Intents that tolerate a non-existent leaf — see `Intent`'s
 * docstring for why each is in the set. Adding a new intent here
 * is a deliberate decision: the resolver's ancestor walk returns
 * a synthetic canonical path that the caller MUST be prepared to
 * see succeed for nonexistent leaves.
 */
const ENOENT_TOLERATING_INTENTS: ReadonlySet<Intent> = new Set([
  'write',
  'stat',
]);

/**
 * Detect Windows-targeted path attack patterns that bypass naive
 * boundary checks. Adapted from claude-code's
 * `hasSuspiciousWindowsPathPattern` (`src/utils/permissions/filesystem.ts`).
 *
 * Why detection rather than normalization:
 *
 * 1. Short-name normalization depends on the file existing. For a
 *    write intent the leaf is absent by definition, so normalization
 *    can't run.
 * 2. Filesystem state can change between normalization and access
 *    (TOCTOU), so a "normalized then check" pipeline still admits
 *    races. Detecting the dangerous *literal* on input closes that
 *    window.
 * 3. The patterns are cheap to detect and produce zero false
 *    positives on legitimate POSIX filenames the daemon expects to
 *    receive (workspace files are project sources / configs, never
 *    `\\?\` long-path prefixes).
 *
 * Checked patterns:
 * - NTFS ADS (`:` after position 2 — drive-letter slot exempted)
 * - 8.3 short names (`~\d`)
 * - Long-path prefixes (`\\?\`, `\\.\`, `//?/`, `//./`)
 * - Trailing dots / spaces (Windows strips during resolution)
 * - DOS device names as final extension (`.CON`, `.PRN`, ...)
 * - Three-or-more consecutive dots used as a path component
 * - UNC prefix (`\\server\share`, `//server/share`) — also blocks
 *   loopback DNS / SMB lookups during resolution.
 *
 * NTFS-on-Linux mounts (`ntfs-3g`) admit the same bypasses except
 * the colon syntax (which only the Windows kernel parses), so the
 * platform gate exists only for the ADS branch; everything else is
 * checked unconditionally.
 */
export function hasSuspiciousPathPattern(p: string): boolean {
  if (process.platform === 'win32') {
    const colonIndex = p.indexOf(':', 2);
    if (colonIndex !== -1) return true;
  }
  // NTFS 8.3 short-name suffix: `LONGFILENAME~1.TXT`. Two fixes
  // over the original `/~\d/`:
  //
  // 1. Multi-digit (`~10`, `~99`) — NTFS allocates `~1`..`~4` for
  //    the first 4 collisions, then switches to a hashed scheme
  //    where `~10` and above are real, common short names. The
  //    original regex missed those entirely.
  // 2. Gate on Windows — on POSIX, `~\d` is a legitimate filename
  //    character used by editor swap files (`file~1.swp`),
  //    backup tools (`notes~2.md`, `backup~1.txt`), and version
  //    schemes. The daemon's actual filesystem on Linux/macOS
  //    isn't NTFS, so 8.3 interpretation doesn't apply and
  //    rejecting these is a false positive that breaks
  //    legitimate workflows. NTFS-on-Linux mounts (`ntfs-3g`) are
  //    rare enough that we accept the residual gap; operators
  //    mounting NTFS into a daemon workspace can disable
  //    suspicious-pattern rejection at the route layer.
  if (process.platform === 'win32' && /~\d+/.test(p)) return true;
  if (
    p.startsWith('\\\\?\\') ||
    p.startsWith('\\\\.\\') ||
    p.startsWith('//?/') ||
    p.startsWith('//./')
  ) {
    return true;
  }
  if (
    (p.startsWith('\\\\') && p.length > 2 && p[2] !== '\\') ||
    (p.startsWith('//') && p.length > 2 && p[2] !== '/')
  ) {
    // UNC prefix `\\server\share` / `//server/share` — never legitimate
    // input from a daemon client. The earlier long-path check covers
    // the special device variants (`\\?\`, `\\.\`).
    return true;
  }
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(p)) return true;
  // Per-component checks below: skip empty segments and the legitimate
  // POSIX traversal tokens `.` / `..`. Bare `.` and `..` are fine
  // inputs — the boundary's `path.resolve` + `isWithinRoot` will reject
  // any traversal that lands outside the workspace.
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '' || seg === '.' || seg === '..') continue;
    if (/[.\s]+$/.test(seg)) return true;
    // DOS / NTFS reserved device names. The Windows kernel treats
    // these as device handles regardless of extension, so all four
    // forms are reserved:
    //   - bare:        `CON`, `NUL`, `LPT1`
    //   - first-ext:   `CON.txt`, `NUL.dat`, `COM1.json`
    //   - last-ext:    `file.CON`, `audit.PRN`, `bar.LPT9`
    //   - any-ext:     `CON.foo.bar`
    // The earlier regex anchored to `$` only caught the last-ext
    // form. Anchor to either start (bare or first-ext) or `.`
    // (last-ext or middle-ext) to cover the full set. Names
    // containing the reserved word as a substring of a longer
    // segment (e.g. `BACON`, `concat.txt`) are NOT reserved — the
    // boundary anchor `(^|\.)` keeps those legitimate.
    if (/(^|\.)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(seg)) {
      return true;
    }
  }
  return false;
}

/** Default ancestor-walk depth limit for ENOENT fallback. */
const MAX_ANCESTOR_HOPS = 40;

/**
 * Module-level memo cache for `boundWorkspace → canonical`
 * mapping. The factory already canonicalizes once at build time,
 * so the inner call inside `resolveWithinWorkspace` is paying for
 * a redundant `realpathSync.native` per request. The cache turns
 * subsequent calls with the same `boundWorkspace` into an O(1)
 * Map lookup; first call still pays the syscall (idempotent on
 * already-canonical input).
 *
 * Cache size is bounded only by the number of *distinct*
 * `boundWorkspace` values a daemon ever sees — `1 daemon = 1
 * workspace` per #4175, so the steady-state size is exactly 1.
 * Tests that exercise multiple workspaces add an entry per
 * scratch dir; entries never have to be evicted because realpath
 * is functional (a path's canonical form doesn't change unless
 * the path is moved on disk, in which case the bound workspace
 * is wrong elsewhere too).
 */
const CANONICAL_BOUND_CACHE = new Map<string, string>();
function canonicalizeBoundWorkspaceCached(boundWorkspace: string): string {
  const cached = CANONICAL_BOUND_CACHE.get(boundWorkspace);
  if (cached !== undefined) return cached;
  const canonical = canonicalizeWorkspace(boundWorkspace);
  CANONICAL_BOUND_CACHE.set(boundWorkspace, canonical);
  return canonical;
}

/**
 * Walk up `absolute` until a component exists on disk. Returns the
 * existing ancestor and the trailing components that don't exist
 * yet, joined with the platform separator. Used by the ENOENT
 * fallback in `resolveWithinWorkspace` to canonicalize the existing
 * portion (resolving any symlink in the parent chain) before
 * boundary-checking the eventual write target.
 */
async function findExistingAncestor(
  absolute: string,
): Promise<{ ancestor: string; tail: string }> {
  let current = absolute;
  const tailParts: string[] = [];
  for (let i = 0; i < MAX_ANCESTOR_HOPS; i++) {
    let stat: Awaited<ReturnType<typeof fsp.stat>> | null = null;
    try {
      stat = await fsp.stat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // POSIX returns `ENOTDIR` when a regular file occupies a
        // path segment we tried to traverse through; Windows
        // returns `ENOENT` for the same case (CI failure on
        // commit a81ada43f flagged the divergence). Either errno
        // means "the *current* path doesn't resolve" — keep
        // walking up and let the post-walk dirent-kind check
        // below decide whether to accept the ancestor.
      } else {
        throw err;
      }
    }
    if (stat) {
      // A regular file sits where the request expected a directory
      // (e.g. write target `${ws}/file.txt/child`, where
      // `file.txt` is a regular file). Without this check the
      // walk would happily return the file's parent as the
      // canonical ancestor and let the eventual write surface a
      // confusing late failure. Reject up-front with
      // `parse_error`. `fsp.stat` follows symlinks, so
      // `stat.isDirectory()` reflects the symlink target's kind —
      // exactly what we want. Cross-platform: works the same on
      // POSIX and Windows because the kind check fires regardless
      // of which errno surfaced during the walk-up.
      if (tailParts.length > 0 && !stat.isDirectory()) {
        throw new FsError(
          'parse_error',
          `path component is not a directory: ${absolute}`,
          {
            hint: 'a non-directory file occupies a path segment',
          },
        );
      }
      return { ancestor: current, tail: tailParts.join(path.sep) };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new FsError(
        'path_not_found',
        `no existing ancestor for ${absolute}`,
      );
    }
    tailParts.unshift(path.basename(current));
    current = parent;
  }
  throw new FsError(
    'path_not_found',
    `path traversal exceeded ${MAX_ANCESTOR_HOPS} hops while finding ancestor`,
    {
      hint: 'path is too deeply nested or filesystem is responding unexpectedly',
    },
  );
}

/**
 * Resolve a daemon-input path to an absolute, symlink-canonicalized
 * `ResolvedPath` that is provably inside `boundWorkspace`. Throws
 * `FsError` on any boundary violation.
 *
 * Algorithm (#4175 PR 18 plan, claude-code-style chain check):
 *
 * 1. Reject suspicious literal patterns before any I/O.
 * 2. Resolve against `boundWorkspace` to absolutize relative inputs.
 * 3. Cheap pre-filter: textual containment check rejects obvious
 *    `..` traversal without paying for `realpath`.
 * 4. `fs.promises.realpath` on the absolute path. Node's realpath
 *    follows the entire symlink chain natively (SYMLOOP_MAX-bounded);
 *    if any hop escapes the workspace, the final canonical lands
 *    outside and step 5 catches it.
 * 5. ENOENT (write/stat intents): walk up to first existing ancestor,
 *    realpath the ancestor, re-attach the unresolved tail. The tail
 *    can't introduce new symlinks (it doesn't exist), so the joined
 *    result is the actual write target the OS will use.
 * 6. Final containment check against canonicalized `boundWorkspace`.
 *    If the canonical landed outside but the resolved-without-realpath
 *    version was inside, classify as `symlink_escape`; otherwise as
 *    `path_outside_workspace`.
 *
 * The brand on the return type is the contract that PR 19/20 routes
 * may not construct one without going through this function.
 */
export async function resolveWithinWorkspace(
  input: string,
  boundWorkspace: string,
  intent: Intent,
): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.length === 0) {
    throw new FsError('parse_error', 'path must be a non-empty string');
  }
  if (hasSuspiciousPathPattern(input)) {
    throw new FsError(
      'path_outside_workspace',
      `path contains suspicious pattern: ${input}`,
      {
        hint: 'paths with NTFS ADS, 8.3 short names, UNC prefixes, or trailing dots are rejected outright',
      },
    );
  }

  const boundCanonical = canonicalizeBoundWorkspaceCached(boundWorkspace);
  const absolute = path.resolve(boundCanonical, input);

  // Cheap pre-filter on the resolved-but-not-realpathed form. Catches
  // textual `..` escape without an FS call.
  if (!isWithinRoot(absolute, boundCanonical)) {
    throw new FsError(
      'path_outside_workspace',
      `path escapes workspace: ${input}`,
    );
  }

  let canonical: string;
  try {
    canonical = await fsp.realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' && ENOENT_TOLERATING_INTENTS.has(intent)) {
      // Captured iff the symlink chain validated successfully —
      // we then return this verified canonical instead of falling
      // through to a re-walk from `absolute` (which would
      // re-traverse the chain and could pick up an attacker's
      // mid-walk symlink swap).
      let symlinkResolvedCanonical: string | null = null;
      // Dangling-symlink write-escape guard. `realpath` follows
      // symlinks, so a path like `<ws>/leak -> /etc/cron.d/evil`
      // (where the target doesn't exist YET) throws ENOENT here.
      // Without this branch the ENOENT-tolerant ancestor walk
      // below would happily walk up to the workspace root and
      // return `<ws>/leak` as the canonical write target — but
      // the OS-level write would follow the symlink to
      // `/etc/cron.d/evil` and create the file there. `lstat`
      // detects the symlink without following it; `readlink` +
      // resolved-target containment closes the loop.
      try {
        // Walk the FULL symlink chain via `lstat` + `readlink`,
        // not just one hop. The earlier single-readlink fix was
        // bypassed by `<ws>/leak -> <ws>/middle -> /etc/passwd`
        // (where `middle` is itself a symlink): `findExistingAncestor`
        // uses `fsp.stat` which follows the rest of the chain,
        // landed on the target's parent, and reported the
        // intermediate hop as canonical — letting the OS write
        // follow the full chain to the escape target. The loop
        // below dereferences every layer up to a max-depth bound
        // and tracks visited inodes to surface cycles as
        // `symlink_escape`. Once we reach a non-symlink leaf, we
        // canonicalize that leaf via the deepest-existing-ancestor
        // path (so macOS `/var` vs `/private/var` and Win32 case
        // collapse consistently with `boundCanonical`).
        let cursor: string = absolute;
        const visitedInodes = new Set<bigint>();
        let firstHopTarget: string | null = null;
        let resolvedFully = false;
        for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
          let linkStat: Awaited<ReturnType<typeof fsp.lstat>>;
          try {
            linkStat = await fsp.lstat(cursor);
          } catch (lstatErr) {
            const lcode = (lstatErr as NodeJS.ErrnoException)?.code;
            if (lcode === 'ENOENT' || lcode === 'ENOTDIR') {
              // Reached a non-existent leaf — no symlink to chase
              // here. Run the deepest-existing-ancestor check on
              // `cursor` so the eventual write target is bounded.
              resolvedFully = true;
              break;
            }
            throw lstatErr;
          }
          if (!linkStat.isSymbolicLink()) {
            // Reached a real file/dir — chain terminates here.
            resolvedFully = true;
            break;
          }
          // Detect cycles via inode identity (ino is a bigint on
          // recent Node versions). Some filesystems return 0 for
          // ino (e.g. virtual mounts); the depth bound covers
          // those cases as a fallback.
          const ino =
            typeof linkStat.ino === 'bigint'
              ? linkStat.ino
              : BigInt(linkStat.ino as unknown as number);
          if (ino !== 0n && visitedInodes.has(ino)) {
            throw new FsError(
              'symlink_escape',
              `symlink cycle detected at ${cursor}`,
              { hint: 'symlink loops back onto a previously visited inode' },
            );
          }
          if (ino !== 0n) visitedInodes.add(ino);
          const target = await fsp.readlink(cursor);
          const absTarget = path.isAbsolute(target)
            ? target
            : path.resolve(path.dirname(cursor), target);
          if (firstHopTarget === null) firstHopTarget = target;
          cursor = absTarget;
        }
        if (!resolvedFully) {
          throw new FsError(
            'symlink_escape',
            `symlink chain exceeded ${MAX_ANCESTOR_HOPS} hops for ${input}`,
            { hint: 'symlink chain is too long or contains a cycle' },
          );
        }
        // Only run the containment check when we actually traversed
        // at least one symlink — `firstHopTarget !== null` means the
        // input was a symlink (vs a path through a non-existent
        // ancestor that wasn't itself a symlink). The verified
        // `canonicalTarget` becomes the function's result; we DO
        // NOT re-walk from `absolute` afterwards, since that would
        // open a TOCTOU window between the check and the re-walk
        // where an attacker swapping an intermediate symlink
        // could produce a different canonical than the one we
        // just verified.
        if (firstHopTarget !== null) {
          const { ancestor: targetAncestor, tail: targetTail } =
            await findExistingAncestor(cursor);
          const targetAncestorReal = await fsp.realpath(targetAncestor);
          const canonicalTarget = targetTail
            ? path.join(targetAncestorReal, targetTail)
            : targetAncestorReal;
          if (!isWithinRoot(canonicalTarget, boundCanonical)) {
            throw new FsError(
              'symlink_escape',
              `dangling symlink target escapes workspace: ${input}`,
              {
                // Hint must NOT embed the symlink target — `recordDenied`
                // forwards `hint` into `fs.denied` even in privacy mode,
                // and an absolute outside-target string would leak the
                // attacker's intended exfiltration path through audit
                // events. Operators wanting the actual target value
                // run with `QWEN_AUDIT_RAW_PATHS=1` and read it from
                // `relPath` / `message`.
                hint: 'symlink chain leaves the workspace; enable QWEN_AUDIT_RAW_PATHS for the resolved target',
              },
            );
          }
          symlinkResolvedCanonical = canonicalTarget;
        }
      } catch (err2) {
        if (err2 instanceof FsError) throw err2;
        // `lstat` ENOENT on the very first hop means the input
        // path itself doesn't exist (input is a path through a
        // non-existent ancestor) — no symlink to worry about;
        // fall through to the ancestor walk.
        const code2 = (err2 as NodeJS.ErrnoException)?.code;
        if (code2 !== 'ENOENT') throw err2;
      }
      // If the symlink-walk produced a verified canonical, use it
      // instead of re-walking from `absolute` (which would discard
      // the verification and admit a TOCTOU swap window). The
      // re-walk is only the right behavior when no symlink was
      // present at all.
      if (symlinkResolvedCanonical !== null) {
        canonical = symlinkResolvedCanonical;
      } else {
        const { ancestor, tail } = await findExistingAncestor(absolute);
        const ancestorReal = await fsp.realpath(ancestor);
        canonical = tail ? path.join(ancestorReal, tail) : ancestorReal;
      }
    } else if (code === 'ENOENT') {
      throw new FsError('path_not_found', `path does not exist: ${input}`, {
        cause: err,
      });
    } else if (code === 'ELOOP') {
      throw new FsError(
        'symlink_escape',
        `symlink loop or chain too long for ${input}`,
        {
          cause: err,
          hint: 'a symlink in the path forms a cycle or exceeds SYMLOOP_MAX',
        },
      );
    } else if (code === 'EACCES') {
      throw new FsError(
        'permission_denied',
        `permission denied resolving ${input}`,
        { cause: err },
      );
    } else {
      throw err;
    }
  }

  if (!isWithinRoot(canonical, boundCanonical)) {
    const kind: FsErrorKind =
      canonical !== absolute ? 'symlink_escape' : 'path_outside_workspace';
    throw new FsError(
      kind,
      kind === 'symlink_escape'
        ? `symlink resolves outside workspace: ${input}`
        : `path escapes workspace: ${input}`,
    );
  }

  return canonical as ResolvedPath;
}
