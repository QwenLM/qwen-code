/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * Replicates core's `paths.ts#sanitizeCwd` EXACTLY: every non-alphanumeric
 * character becomes a dash. On win32 the cwd is lowercased first (matching
 * `os.platform() === 'win32'` in core). This is the project-id segment of the
 * on-disk chats path; cycle-19's `search/transcripts.ts` used a looser
 * `replace(/[/.]/g,'-')` approximation that diverges for `_`/space/etc. — this
 * is the corrected resolver (the search one is a documented follow-up).
 */
export function sanitizeCwd(cwd: string): string {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Expands a leading `~`/`~/` and resolves relative paths to absolute, mirroring
 * core `Storage#resolvePath` so env-provided base dirs resolve identically.
 */
function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const segments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = join(homedir(), ...segments);
  }
  if (!isAbsolute(resolved)) {
    resolved = resolve(resolved);
  }
  return resolved;
}

/**
 * Replicates core's `Storage.getRuntimeBaseDir()` precedence as visible from
 * OUTSIDE the daemon process: `QWEN_RUNTIME_DIR` env → else `QWEN_HOME` env
 * (= `getGlobalQwenDir`) → else `~/.qwen`.
 *
 * The middle tier in core — a settings-based `setRuntimeBaseDir()`/contextual
 * override — is INVISIBLE to the gateway, which is exactly why the fork route
 * guards on the parent file existing at the derived path (a mismatch becomes a
 * clean 404, never silent corruption).
 */
export function runtimeBaseDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const runtime = env['QWEN_RUNTIME_DIR'];
  if (runtime) {
    return resolvePath(runtime);
  }
  const home = env['QWEN_HOME'];
  if (home) {
    return resolvePath(home);
  }
  return join(homedir(), '.qwen');
}

/**
 * The chats dir for a workspace: `<runtimeBaseDir>/projects/<sanitizeCwd>/chats`
 * — byte-identical to core's `Storage#getProjectDir()` + `'chats'`.
 *
 * `cwd` may come from request input (e.g. `GET /rc/sessions?cwd=`, or
 * `/workspace/:cwd/sessions`), not only the trusted
 * `daemon.capabilities().workspaceCwd`. That is safe only because `sanitizeCwd`
 * flattens every non-alphanumeric character (including `/`, `.`, `\`) to `-`,
 * so no path separator or traversal sequence ever survives into the
 * filesystem path built below. Any future caller of this function MUST keep
 * routing untrusted `cwd` values through `sanitizeCwd` — do not bypass it.
 */
export function resolveChatsDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(runtimeBaseDir(env), 'projects', sanitizeCwd(cwd), 'chats');
}

/**
 * The directory holding this workspace's BM25 search index — a sibling of the
 * `chats` dir under the same project segment, so it is keyed to the same
 * `sanitizeCwd(cwd)` and two workspaces can never read each other's index. The
 * index db (and any transient SQLite journal sibling) lives here; the index
 * store creates this dir `0700` and the db file `0600` because the index is a
 * new at-rest copy of raw transcript content (prompts, tool output).
 */
export function resolveSearchIndexDir(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return join(
    runtimeBaseDir(env),
    'projects',
    sanitizeCwd(cwd),
    'search-index',
  );
}

/**
 * Matches core's `SESSION_FILE_PATTERN` (minus the `.jsonl` suffix): 32–36
 * chars of hex + dashes. Used to reject path-traversal / malformed parent ids
 * before any path join.
 */
export const SESSION_FILE_RE = /^[0-9a-fA-F-]{32,36}$/;

/** True when `id` is a syntactically valid session id (safe to path-join). */
export function isValidSessionId(id: string): boolean {
  return SESSION_FILE_RE.test(id);
}
