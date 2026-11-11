/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git collection and startup prefetch for session_context attachments.
 *
 * Lifecycle:
 *   - Startup callers prefetch with getSystemContext(). The first request takes
 *     that flight once, only if the working directory still matches.
 *   - Retained attachments own snapshot reuse. After compaction removes them,
 *     collectGitContext() reads fresh state without a session-long cache.
 *   - Cleared on `/clear` via `clearSystemContext()`.
 */

import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import {
  createGitCommandEnv,
  GitMetadataProbeTimeoutError,
  readGitHead,
  resolveGitRepositoryLayout,
} from '../utils/gitUtils.js';
import { runLogger } from '../utils/runLogger.js';
import type { Config } from '../config/config.js';

const MAX_STATUS_CHARS = 2000;
const GIT_SYSTEM_CONTEXT_TIMEOUT_MS = 6_000;

class GitSystemContextTimeoutError extends Error {
  constructor() {
    super(`Git system context exceeded ${GIT_SYSTEM_CONTEXT_TIMEOUT_MS}ms`);
    this.name = 'GitSystemContextTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function execGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; value: string; timedOut?: boolean }> {
  signal.throwIfAborted();
  const result = await execFileNoThrow(
    'git',
    [...internalGitArgs(), '-C', cwd, ...args],
    {
      timeout: 5000,
      signal,
      env: createGitCommandEnv(),
      windowsProcessTreeCleanup: { source: 'system-context' },
    },
  );
  signal.throwIfAborted();
  return {
    ok: result.code === 0,
    value: result.code === 0 ? result.stdout.trim() : '',
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

/**
 * Best-effort preflight, not an isolation boundary: configuration can change
 * between this query and status. Query all effective scopes/includes, rather
 * than parsing only .git/config. Never log filter values (they can hold secrets).
 */
async function getAutomaticStatus(cwd: string, signal: AbortSignal) {
  let skipped: string | undefined;
  try {
    const filters = await execGit(
      ['config', '--includes', '--null', '--name-only', '--list'],
      cwd,
      signal,
    );
    // --list succeeds even with no keys. Unlike --get-regexp, an exit code of
    // 1 cannot be confused with "no matches" after a spawn/read failure.
    if (
      !filters.ok ||
      filters.timedOut ||
      (filters.value && !filters.value.endsWith('\0'))
    ) {
      skipped = 'not collected: Git filter configuration could not be verified';
    } else if (
      filters.value
        .split('\0')
        .some((key) => /^filter\.[\s\S]*\.(clean|process)$/i.test(key))
    ) {
      skipped = 'not collected: Git content filters are configured';
    }
  } catch {
    signal.throwIfAborted();
    skipped = 'not collected: Git filter configuration could not be verified';
  }
  if (skipped) return { ok: true, value: '', skipped, timedOut: false };
  return {
    ...(await execGit(
      ['--no-optional-locks', 'status', '--short'],
      cwd,
      signal,
    )),
    skipped,
  };
}

async function getDefaultBranch(
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  // Try symbolic-ref first (remote HEAD)
  const ref = await execGit(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
    cwd,
    signal,
  );
  if (ref.ok && ref.value) {
    // "origin/main" → "main"
    return ref.value.replace(/^origin\//, '');
  }
  // Fallback: check common names in parallel
  const [main, master] = await Promise.all([
    execGit(['rev-parse', '--verify', 'refs/heads/main'], cwd, signal),
    execGit(['rev-parse', '--verify', 'refs/heads/master'], cwd, signal),
  ]);
  return main.ok && main.value
    ? 'main'
    : master.ok && master.value
      ? 'master'
      : 'main';
}

/**
 * Gather a Git snapshot for a new retained-context baseline.
 */
async function getGitStatusForCwd(
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  if (process.env['NODE_ENV'] === 'test') return null;

  const startedAt = Date.now();
  const layout = await resolveGitRepositoryLayout(cwd, {
    signal,
    timeoutMs: GIT_SYSTEM_CONTEXT_TIMEOUT_MS,
    throwOnTimeout: true,
  });
  if (!layout) {
    runLogger.debug(
      `[system-context] git status skipped is_git=false duration_ms=${Date.now() - startedAt}`,
    );
    return null;
  }

  try {
    const [head, mainBranch, status, log, userName] = await Promise.all([
      readGitHead(layout, {
        signal,
        timeoutMs: GIT_SYSTEM_CONTEXT_TIMEOUT_MS,
        throwOnTimeout: true,
      }),
      getDefaultBranch(cwd, signal),
      getAutomaticStatus(cwd, signal),
      execGit(
        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
        cwd,
        signal,
      ),
      execGit(['config', 'user.name'], cwd, signal),
    ]);

    // An empty successful status is clean. Any failure is unknown and must not
    // be presented to the model as a clean working tree.
    if (!status.ok) {
      if (status.timedOut) throw new GitSystemContextTimeoutError();
      return null;
    }

    const branch = head?.branch ?? 'HEAD';
    const statusValue = status.value;
    const logValue = log.ok ? log.value : '';
    const userNameValue = userName.ok ? userName.value : '';

    const truncated = statusValue.length > MAX_STATUS_CHARS;
    const truncatedStatus = truncated
      ? statusValue.substring(0, MAX_STATUS_CHARS) +
        `\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using the available shell tool)`
      : statusValue;

    runLogger.debug(
      `[system-context] git status collected duration_ms=${Date.now() - startedAt} skipped=${Boolean(status.skipped)} status_length=${statusValue.length} truncated=${truncated}`,
    );

    return [
      'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userNameValue ? [`Git user: ${userNameValue}`] : []),
      `Status:\n${status.skipped ? `(${status.skipped}; working-tree cleanliness is unknown)` : truncatedStatus || '(clean)'}`,
      `Recent commits:\n${logValue}`,
    ].join('\n\n');
  } catch (err) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    if (
      err instanceof GitSystemContextTimeoutError ||
      err instanceof GitMetadataProbeTimeoutError
    ) {
      throw err;
    }
    runLogger.debug(
      `[system-context] git status failed duration_ms=${Date.now() - startedAt}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memoized system context
// ---------------------------------------------------------------------------

// Cache the promise (not the result) to prevent duplicate git command flights
// when concurrent callers race on the first turn. The key pairs the session with
// the directory the snapshot came from: a startup prewarm and the turn that
// consumes it may disagree on the working directory (a worktree switch in
// between), and reusing a snapshot taken elsewhere would silently describe the
// wrong repository state.
interface SystemContextCacheEntry {
  promise: Promise<Record<string, string>>;
  abortController: AbortController;
  reuseLogged: boolean;
}

export interface SystemContextOptions {
  /**
   * Cancels a newly-created system-context flight. Cache hits keep sharing the
   * flight that already owns the key.
   */
  signal?: AbortSignal;
}

const cachedPromises = new Map<string, SystemContextCacheEntry>();

const CACHE_KEY_SEPARATOR = '\u0000';

function buildCacheKey(sessionId: string, cwd: string): string {
  return `${sessionId}${CACHE_KEY_SEPARATOR}${cwd}`;
}

/** Collect without consulting the startup cache (also used by child agents). */
export async function collectGitContext(
  cwd: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new GitSystemContextTimeoutError();
      controller.abort(error);
      reject(error);
    }, GIT_SYSTEM_CONTEXT_TIMEOUT_MS);
    timeout.unref?.();
  });

  try {
    const gitStatus = await Promise.race([
      getGitStatusForCwd(cwd, controller.signal),
      deadline,
    ]);
    return {
      ...(gitStatus ? { gitStatus } : {}),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Prefetch Git once per session and directory. Request preparation must take
 * this flight with takeSystemContextPrefetch(), not retain it across compaction.
 */
export function getSystemContext(
  sessionId: string,
  cwd: string,
  options: SystemContextOptions = {},
): Promise<Record<string, string>> {
  const cacheKey = buildCacheKey(sessionId, cwd);
  const cachedEntry = cachedPromises.get(cacheKey);
  if (cachedEntry) {
    if (!cachedEntry.reuseLogged) {
      cachedEntry.reuseLogged = true;
      runLogger.log(
        `[system-context] cache lookup cache_hit=true session_id=${sessionId} cwd=${cwd}`,
      );
    }
    return cachedEntry.promise;
  }

  runLogger.log(
    `[system-context] cache lookup cache_hit=false session_id=${sessionId} cwd=${cwd}`,
  );

  const abortController = new AbortController();
  const externalSignal = options.signal;
  let removeExternalAbortListener: (() => void) | undefined;
  if (externalSignal) {
    const abortFromExternalSignal = () => {
      abortController.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, {
        once: true,
      });
      removeExternalAbortListener = () =>
        externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }
  }

  let evictAfterSettle = false;
  const promise = collectGitContext(cwd, abortController.signal)
    .catch((error: unknown) => {
      if (
        error instanceof GitSystemContextTimeoutError ||
        error instanceof GitMetadataProbeTimeoutError
      ) {
        evictAfterSettle = true;
        runLogger.debug(
          `[system-context] collection deadline exceeded session_id=${sessionId} cwd=${cwd}`,
        );
        return {};
      }
      throw error;
    })
    .finally(() => {
      removeExternalAbortListener?.();
      if (
        evictAfterSettle &&
        cachedPromises.get(cacheKey)?.abortController === abortController
      ) {
        cachedPromises.delete(cacheKey);
      }
    });
  const cacheEntry: SystemContextCacheEntry = {
    promise,
    abortController,
    reuseLogged: false,
  };
  cachedPromises.set(cacheKey, cacheEntry);

  // A cancelled flight must not poison the cache. A later caller can retry
  // with a fresh controller instead of inheriting a rejected promise.
  void promise.catch(() => {
    if (cachedPromises.get(cacheKey)?.abortController === abortController) {
      cachedPromises.delete(cacheKey);
    }
  });

  return promise;
}

/** Take the matching startup flight and discard prefetches for other cwd's. */
export function takeSystemContextPrefetch(
  sessionId: string,
  cwd: string,
): Promise<Record<string, string>> | undefined {
  const key = buildCacheKey(sessionId, cwd);
  const entry = cachedPromises.get(key);
  // Detach before clearing: clearSystemContext aborts every remaining flight.
  cachedPromises.delete(key);
  clearSystemContext(sessionId);
  // A caller with retained history may discard this promise without awaiting it.
  void entry?.promise.catch(() => {});
  return entry?.promise;
}

/**
 * Clear the cached system context for every working directory the session has
 * collected. Call on `/clear` or session reset.
 */
export function clearSystemContext(sessionId: string): void {
  const prefix = `${sessionId}${CACHE_KEY_SEPARATOR}`;
  for (const [cacheKey, cacheEntry] of cachedPromises) {
    if (cacheKey.startsWith(prefix)) {
      cacheEntry.abortController.abort(
        new Error(
          'System context collection cancelled because the cache cleared',
        ),
      );
      cachedPromises.delete(cacheKey);
    }
  }
}

/**
 * Drop assembled prompt sections and pending Git prefetches after a working
 * directory change. Retained session_context attachments still own the Git
 * snapshot; changing cwd alone does not invalidate what the model was told.
 */
export function clearSessionPromptCaches(config: Config): void {
  const assembler = config.getPromptAssembler?.();
  if (assembler && typeof assembler.clearCache === 'function') {
    assembler.clearCache();
  }
  clearSystemContext(config.getSessionId());
}
