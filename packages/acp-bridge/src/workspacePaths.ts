/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

const WINDOWS_ABSOLUTE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Maps a Windows-shaped absolute path to the container mount produced by the
 * host-side sandbox launcher (`C:\work\proj` → `/c/work/proj`, mirroring
 * `getContainerPath` in `cli/src/utils/sandbox.ts`).
 *
 * A Windows host relaunching `qwen serve` into a Linux Docker/Podman sandbox
 * translates the bind mount and `--workdir`, but path-valued CLI arguments
 * (`--workspace C:\…`), client-registered workspaces, and persisted
 * registrations reach the in-container daemon in host shape. Left alone,
 * `path.resolve` on Linux mangles them further (prepends the cwd) and every
 * ACP child spawn fails with `chdir(2) ENOENT` before running anything
 * (#7139).
 *
 * Deliberately conservative — the input is returned unchanged unless ALL of:
 * - the daemon is running on POSIX inside a container sandbox (`SANDBOX` env
 *   set by the launcher; macOS `sandbox-exec` does not remap paths and is
 *   excluded),
 * - the path is Windows-absolute (`<drive>:\…` or `<drive>:/…`),
 * - the translated candidate actually exists (i.e. the drive really is
 *   mounted the way the launcher mounts workspaces).
 *
 * The `opts` seams exist for tests; production callers use the defaults.
 */
export function translateWindowsWorkspaceForPosixSandbox(
  p: string,
  opts: {
    platform?: NodeJS.Platform;
    sandboxEnv?: string | undefined;
    exists?: (candidate: string) => boolean;
  } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const sandboxEnv =
    'sandboxEnv' in opts ? opts.sandboxEnv : process.env['SANDBOX'];
  const exists = opts.exists ?? existsSync;
  if (platform === 'win32' || !sandboxEnv || sandboxEnv === 'sandbox-exec') {
    return p;
  }
  const match = WINDOWS_ABSOLUTE_PATH_RE.exec(p);
  if (!match) return p;
  const translated = `/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
  return exists(translated) ? translated : p;
}

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
 * NOTE: This is a **cross-module contract** — `config.ts`,
 * `settings.ts`, `sandbox.ts`, and the bridge layer all need to
 * canonicalize the same way for the bound-workspace check +
 * `sessionScope: 'single'` re-attach to work correctly across paths.
 * The contract: use `realpathSync.native` on the resolved absolute
 * path; fall back to `path.resolve` only when the path doesn't exist
 * yet.
 *
 * Lifted to `@qwen-code/acp-bridge` in #4175 PR 22b so the bridge
 * package owns the cross-module primitive directly.
 * `cli/src/serve/fs/paths.ts` re-exports for callers still pointing
 * at the original location.
 */
export function canonicalizeWorkspace(p: string): string {
  // #7139: inside a Linux container sandbox, host-shaped Windows workspace
  // paths must be mapped to their bind-mount location BEFORE resolution —
  // `path.resolve('C:\\x')` on POSIX treats the whole string as relative
  // and prepends the cwd.
  const resolved = path.resolve(translateWindowsWorkspaceForPosixSandbox(p));
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

export function canonicalizeWorkspaces(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const canonical = canonicalizeWorkspace(p);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * PATH_MAX on Linux is 4096; macOS / BSD is 1024. We use the Linux
 * value as a generous ceiling — anything bigger is either a
 * malformed client request (memory amplification attack against the
 * 400 / stderr / error-message echo paths) or a synthetic test
 * input. The HTTP route's POST /session pre-check rejects bodies past
 * this; `WorkspaceMismatchError` truncates for any caller that
 * skips the pre-check.
 */
export const MAX_WORKSPACE_PATH_LENGTH = 4096;
