/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isWithinRoot } from '@qwen-code/qwen-code-core';
import { FsError, type FsErrorKind } from './errors.js';

/**
 * Canonicalize a workspace path so the boot-time bound path and every
 * request's `workspaceCwd` collapse to the same key. `path.resolve`
 * alone normalizes `..` and `.` segments and absolutizes, but on
 * case-insensitive filesystems (macOS APFS, Windows NTFS) `/Work/A`
 * and `/work/a` are the same directory yet `resolve` returns them
 * verbatim — without normalization the `boundWorkspace` check would
 * reject every request that spelled the path with different casing
 * and `sessionScope: 'single'` re-attach would silently degrade to
 * "one per spelling".
 *
 * `realpathSync.native` (when the path exists) walks symlinks and returns
 * the on-disk casing; this matches what `config.ts` / `settings.ts` /
 * `sandbox.ts` use for their own workspace resolution. When the path
 * doesn't exist (test fixtures, ahead-of-mkdir flows) we fall back to
 * the resolved-but-uncanonicalized form rather than throwing — the
 * downstream `spawn({cwd})` will fail with a useful ENOENT if the
 * workspace truly doesn't exist.
 *
 * NOTE: This is a **cross-module contract** (BX9_q) — `config.ts`,
 * `settings.ts`, `sandbox.ts`, and `httpAcpBridge.ts` all need to
 * canonicalize the same way for the bound-workspace check +
 * `sessionScope: 'single'` re-attach to work correctly across paths.
 * The contract: use `realpathSync.native` on the resolved absolute
 * path; fall back to `path.resolve` only when the path doesn't exist
 * yet. If a future change breaks this alignment (e.g. one module
 * starts lowercasing on Windows but this one doesn't), the
 * canonicalized request path won't match the canonicalized bound
 * path → every request returns `workspace_mismatch` even though the
 * human-readable paths look equivalent. There's no test that pins
 * the alignment; the integration suite would catch a divergence only
 * if it tested the specific casing / symlink path the affected
 * module changed.
 *
 * Stage 2 in-process (#3803 §10) collapses the bridge into core,
 * removing the bridge-side path resolution entirely. Stage 1.5
 * `@qwen-code/acp-bridge` lift (chiga0 finding 1) is the natural
 * place to extract a shared `canonicalizeWorkspace` primitive that
 * all four modules consume — the lowest-common-denominator
 * extraction is fine THERE because the package boundary forces the
 * call sites to converge. Until then, *any* change to how those
 * modules resolve workspace paths needs a matching change here.
 *
 * #4175 PR 18 extraction: this file is the new home of the primitive
 * for the serve layer. The bridge re-exports it so existing callers
 * continue to import from `httpAcpBridge.js`. The forthcoming
 * `WorkspaceFileSystem` boundary (PR 18 commits 3+) builds on top of
 * this single resolver.
 */
export function canonicalizeWorkspace(p: string): string {
  const resolved = path.resolve(p);
  try {
    // FIXME(stage-2): switch to `fs.promises.realpath` once the
    // bridge call sites become async-friendly. This sync syscall
    // runs on the hot `spawnOrAttach` path and blocks the event
    // loop for one filesystem stat per call. Single-user loopback
    // (Stage 1's design target) doesn't notice; high-concurrency
    // deployments will. Stage 2 in-process refactor removes the
    // entire bridge-side path resolution anyway, but if Stage 2
    // ever lands without that change, switch to the async version.
    return realpathSync.native(resolved);
  } catch (err) {
    // Only fall back to path.resolve for ENOENT (path doesn't exist
    // yet). Other filesystem errors (EACCES, EIO, ELOOP) should
    // propagate — swallowing them would hide transient I/O failures
    // behind misleading workspace_mismatch rejections.
    if (
      err &&
      typeof err === 'object' &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return resolved;
    }
    throw err;
  }
}

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
 * `policy.ts` module) to decide ignore/trust handling. `resolveWithinWorkspace`
 * itself uses the intent only to differentiate ENOENT semantics: write
 * intents tolerate a non-existent leaf (the file is about to be created),
 * read intents do not.
 *
 * `'edit'` is a distinct intent from `'write'` so the trust gate, audit
 * payload, and exhaustiveness checks can reason about partial-replace
 * semantics separately from full-overwrite. Both gate identically in
 * `assertTrustedForIntent`; the split exists to keep audit events
 * faithful to the operation actually performed.
 */
export type Intent = 'read' | 'write' | 'edit' | 'list' | 'glob' | 'stat';

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
  if (/~\d/.test(p)) return true;
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
    if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(seg)) return true;
  }
  return false;
}

/** Default ancestor-walk depth limit for ENOENT fallback. */
const MAX_ANCESTOR_HOPS = 40;

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
    try {
      await fsp.stat(current);
      return { ancestor: current, tail: tailParts.join(path.sep) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        // ancestor doesn't exist yet; keep walking up
      } else if (code === 'ENOTDIR') {
        // A regular file sits where we expected a directory (e.g.
        // write target `${ws}/file.txt/child`). Walking up would
        // happily realpath the file's parent and return a
        // "canonical" the eventual write cannot use. Reject up-front
        // so the orchestrator emits an `fs.denied` for the actual
        // shape of the user error rather than silently passing
        // boundary inspection and 500-ing later at write time.
        throw new FsError(
          'parse_error',
          `path component is not a directory: ${absolute}`,
          {
            cause: err,
            hint: 'a non-directory file occupies a path segment',
          },
        );
      } else {
        throw err;
      }
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

  const boundCanonical = canonicalizeWorkspace(boundWorkspace);
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
        const linkStat = await fsp.lstat(absolute);
        if (linkStat.isSymbolicLink()) {
          const target = await fsp.readlink(absolute);
          const absTarget = path.isAbsolute(target)
            ? target
            : path.resolve(path.dirname(absolute), target);
          // The symlink target itself doesn't exist (that's why
          // we're in the ENOENT branch), so resolve via the
          // deepest existing ancestor so case-insensitive
          // filesystems and macOS `/var` vs `/private/var`
          // canonicalize consistently with `boundCanonical`.
          const { ancestor: targetAncestor, tail: targetTail } =
            await findExistingAncestor(absTarget);
          const targetAncestorReal = await fsp.realpath(targetAncestor);
          const canonicalTarget = targetTail
            ? path.join(targetAncestorReal, targetTail)
            : targetAncestorReal;
          if (!isWithinRoot(canonicalTarget, boundCanonical)) {
            throw new FsError(
              'symlink_escape',
              `dangling symlink target escapes workspace: ${input}`,
              { hint: `symlink points to ${target}` },
            );
          }
        }
      } catch (err2) {
        if (err2 instanceof FsError) throw err2;
        // `lstat` ENOENT means the input path itself doesn't
        // exist (input is a path through a non-existent
        // ancestor) — no symlink to worry about; fall through
        // to the ancestor walk.
        const code2 = (err2 as NodeJS.ErrnoException)?.code;
        if (code2 !== 'ENOENT') throw err2;
      }
      const { ancestor, tail } = await findExistingAncestor(absolute);
      const ancestorReal = await fsp.realpath(ancestor);
      canonical = tail ? path.join(ancestorReal, tail) : ancestorReal;
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
