/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';

const MAX_CLONE_URL_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 240;
const DEFAULT_MAX_RUNNING = 2;
const DEFAULT_MAX_RETAINED = 8;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const SCP_LIKE_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);
const OSC_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\][^${String.fromCharCode(7)}]*(?:${String.fromCharCode(7)}|${String.fromCharCode(27)}\\\\)`,
  'g',
);
const C1_CSI_PATTERN = new RegExp(
  `${String.fromCharCode(155)}[0-9;?]*[ -/]*[@-~]`,
  'g',
);
const SINGLE_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}[@-_]`,
  'g',
);
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  'g',
);
const ALLOWED_PROTOCOLS = new Set([
  'http:',
  'https:',
  'ssh:',
  'git:',
  'git+ssh:',
  'file:',
]);
/** Environment channels that re-apply host Git config or host transports. */
const CLONE_ENV_DENIED_KEYS = new Set([
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
]);

export type GitCloneJobStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface GitCloneJobSnapshot {
  jobId: string;
  status: GitCloneJobStatus;
  startedAt: number;
  finishedAt?: number;
  percent?: number;
  message?: string;
  cwd?: string;
  error?: { code: string; message: string };
}

export interface GitCloneRequest {
  url: string;
  target: string;
  /**
   * Route-owned check for registered, reserved, and nesting conflicts. The
   * cloner owns filesystem shape and existence checks.
   */
  validateTarget?: (absoluteTarget: string) => TargetRejection | undefined;
  /** Reserves the canonical target for the job's lifetime. */
  reserveTarget?: (canonicalTarget: string) => void;
  /** Releases the reservation after the job and its cleanup settle. */
  releaseTarget?: (canonicalTarget: string) => void;
}

export interface TargetRejection {
  status: number;
  code: string;
  message: string;
}

export class GitCloneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitCloneRequestError';
  }
}

export interface GitCloneCredentials {
  username: string;
  password: string;
}

export interface GitCloneProcess {
  /**
   * Must settle after `signal` aborts. The cloner removes the target only
   * once this promise settles, so a runner that ignores the signal leaves a
   * partially written directory behind.
   */
  run(input: {
    url: string;
    credentials?: GitCloneCredentials;
    target: string;
    signal: AbortSignal;
    onProgress: (line: string) => void;
  }): Promise<void>;
}

export interface WorkspaceGitCloner {
  start(request: GitCloneRequest): Promise<{ jobId: string }>;
  get(jobId: string): GitCloneJobSnapshot | undefined;
  cancel(jobId: string): Promise<GitCloneJobSnapshot | undefined>;
  sealAndWait(): Promise<void>;
}

interface CloneJob {
  snapshot: GitCloneJobSnapshot;
  controller: AbortController;
  settled: Promise<void>;
}

interface ClonerOptions {
  runner?: GitCloneProcess;
  timeoutMs?: number;
  retentionMs?: number;
  maxRunning?: number;
  maxRetained?: number;
  now?: () => number;
  createJobId?: () => string;
  /** Test seam for the success-path canonical path resolution. */
  resolveCwd?: (target: string) => Promise<string>;
  /** Test seam for the claim's final canonical path resolution. */
  resolveClaimedTarget?: (target: string) => Promise<string>;
}

function requestError(
  status: number,
  code: string,
  message: string,
): GitCloneRequestError {
  return new GitCloneRequestError(status, code, message);
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code < 0x20 || code === 0x7f)) return true;
  }
  return false;
}

/** Rejects transports that could execute local commands or inject options. */
export function normalizeGitCloneUrl(raw: string): string {
  const url = raw.trim();
  if (url.length === 0 || url.length > MAX_CLONE_URL_LENGTH) {
    throw requestError(400, 'invalid_url', 'Git URL is empty or too long');
  }
  if (hasControlCharacters(url)) {
    throw requestError(
      400,
      'invalid_url',
      'Git URL contains control characters',
    );
  }
  if (url.startsWith('-') || url.startsWith('ext::')) {
    throw requestError(
      400,
      'invalid_url',
      'Git URL uses an unsupported transport',
    );
  }
  if (SCP_LIKE_URL.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw requestError(400, 'invalid_url', 'Git URL is not a valid address');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw requestError(
      400,
      'invalid_url',
      'Git URL uses an unsupported transport',
    );
  }
  if (parsed.protocol === 'file:') {
    if (parsed.hostname.length > 0 || !parsed.pathname.startsWith('/')) {
      throw requestError(
        400,
        'invalid_url',
        'File URL must name an absolute local path',
      );
    }
  } else if (parsed.hostname.length === 0) {
    throw requestError(400, 'invalid_url', 'Git URL must name a host');
  }
  return url;
}

/** Removes URL credentials before a message can reach a client or a log. */
export function redactGitUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = '***';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function sanitizeGitCloneMessage(line: string, url: string): string {
  const withoutControl = line
    .replace(OSC_ESCAPE_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(C1_CSI_PATTERN, '')
    .replace(SINGLE_ESCAPE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '');
  const withoutUrl = withoutControl.split(url).join(redactGitUrl(url));
  const withoutUserinfo = withoutUrl.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g,
    '$1***@',
  );
  return withoutUserinfo.trim().slice(0, MAX_MESSAGE_LENGTH);
}

function parsePercent(line: string): number | undefined {
  const matches = [
    ...line.matchAll(/(?:Receiving objects|Resolving deltas):\s*(\d{1,3})%/gi),
  ];
  const last = matches.at(-1);
  if (!last) return undefined;
  const value = Number(last[1]);
  return Number.isFinite(value) && value <= 100 ? value : undefined;
}

/** Removes credential userinfo before the URL becomes a git argv entry. */
export function extractGitCredentials(raw: string): {
  url: string;
  credentials?: GitCloneCredentials;
} {
  // A hand-pasted userinfo often keeps a literal `%` that is not an escape;
  // git decodes such values literally, so a decode failure must not fall
  // through to returning the credential-bearing URL.
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  try {
    const parsed = new URL(raw);
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!parsed.password && !(isHttp && parsed.username)) {
      return { url: raw };
    }
    const credentials = {
      username: safeDecode(parsed.username),
      password: safeDecode(parsed.password),
    };
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.toString(), credentials };
  } catch {
    return { url: raw };
  }
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\taskkill.exe`;
      const child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // A failed launch emits 'error' asynchronously; without a listener it
      // becomes an uncaught exception and takes the daemon down.
      child.on('error', () => undefined);
      child.unref();
      return;
    }
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * The daemon may be started from inside a Git command (a hook, a rebase
 * shell); repository-locating variables would redirect the clone or make it
 * fail with a confusing error, so they are removed for this child only.
 * Global/system config is disabled as well: a cloned repository's
 * `.gitattributes` must not be able to run filter commands configured on the
 * daemon host during the clone's own checkout.
 *
 * The environment-carried config channels outrank those config files, so they
 * are swept too: `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` re-apply host
 * config, `GIT_ASKPASS` / `SSH_ASKPASS` would answer a client-chosen host with
 * the host's own credentials, and `GIT_SSH*` / `GIT_PROXY_COMMAND` /
 * `GIT_EXEC_PATH` / `GIT_TEMPLATE_DIR` would run host transports and
 * templates for a browser-supplied URL. `SSH_AUTH_SOCK` is outside the swept
 * namespaces, so SSH-agent authentication still works.
 *
 * `LC_ALL`/`LANG` are pinned because the progress and fatal lines this module
 * parses are git's English strings; a localized git would report no percent
 * and a `fatal:` prefix that does not match.
 */
export function cloneEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_') || CLONE_ENV_DENIED_KEYS.has(key)) {
      delete env[key];
    }
  }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    LC_ALL: 'C',
    LANG: 'C',
  };
}

export const spawnGitClone: GitCloneProcess = {
  run({ url, credentials, target, signal, onProgress }) {
    return new Promise<void>((resolveRun, rejectRun) => {
      const env = cloneEnvironment();
      const args = ['clone', '--progress', '--', url, target];
      if (credentials) {
        // The URL itself is credential-free; the helper reads the secret from
        // the child's environment, so it never appears in /proc/<pid>/cmdline.
        // `printf`, not `echo`: git runs a `!`-prefixed helper through /bin/sh,
        // and dash's echo interprets backslash escapes in the token.
        args.unshift(
          '-c',
          'credential.helper=!f() { printf \'username=%s\\n\' "$QWEN_GIT_USERNAME"; printf \'password=%s\\n\' "$QWEN_GIT_PASSWORD"; }; f',
        );
        env['QWEN_GIT_USERNAME'] = credentials.username;
        env['QWEN_GIT_PASSWORD'] = credentials.password;
      }
      const child = spawn('git', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      let settled = false;
      let lastLine = '';
      let fatalLine = '';
      let buffered = '';
      let abortFallback: ReturnType<typeof setTimeout> | undefined;
      const settle = (failure?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (abortFallback !== undefined) clearTimeout(abortFallback);
        if (failure) rejectRun(failure);
        else resolveRun();
      };
      // Wait for the process to exit before settling, so the cloner removes
      // the target only after git has stopped writing to it. The fallback
      // bounds a kill that cannot complete.
      const onAbort = (): void => {
        killProcessTree(child.pid);
        abortFallback ??= setTimeout(() => {
          settle(new Error('cancelled'));
        }, 5000);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        buffered += chunk;
        if (buffered.length > 8192) buffered = buffered.slice(-4096);
        const parts = buffered.split(/[\r\n]/);
        buffered = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trim().length === 0) continue;
          const line = part.length > 4096 ? part.slice(0, 4096) : part;
          if (!fatalLine && /^(?:fatal|error):/i.test(line.trim())) {
            fatalLine = line;
          }
          lastLine = line;
          onProgress(line);
        }
      });
      child.on('error', (error) => settle(error));
      child.on('close', (code) => {
        if (signal.aborted) {
          settle(new Error('cancelled'));
          return;
        }
        settle(
          code === 0
            ? undefined
            : new Error(
                (fatalLine || lastLine).trim() ||
                  `git clone exited with ${code}`,
              ),
        );
      });
    });
  },
};

function expandCloneTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw requestError(400, 'invalid_target', 'Target path is empty');
  }
  if (trimmed.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw requestError(400, 'invalid_target', 'Target path is too long');
  }
  if (hasControlCharacters(trimmed)) {
    throw requestError(
      400,
      'invalid_target',
      'Target path contains control characters',
    );
  }
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded)) {
    throw requestError(400, 'invalid_target', 'Target path must be absolute');
  }
  const target = resolve(expanded);
  if (target === resolve('/')) {
    throw requestError(
      400,
      'invalid_target',
      'Target path must name a new directory',
    );
  }
  return target;
}

/**
 * Validates the target's parent and claims the target with a non-recursive
 * mkdir, so two requests cannot clone into the same path.
 */
export async function claimCloneTarget(
  absoluteTarget: string,
  validateTarget?: (canonicalTarget: string) => TargetRejection | undefined,
  reserveTarget?: (canonicalTarget: string) => void,
  releaseTarget?: (canonicalTarget: string) => void,
  resolveTarget: (target: string) => Promise<string> = realpath,
): Promise<string> {
  const parent = dirname(absoluteTarget);
  let parentStats;
  try {
    parentStats = await stat(parent);
  } catch {
    throw requestError(400, 'invalid_target', 'Target parent does not exist');
  }
  if (!parentStats.isDirectory()) {
    throw requestError(
      400,
      'invalid_target',
      'Target parent is not a directory',
    );
  }
  try {
    await access(parent, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw requestError(400, 'invalid_target', 'Target parent is not writable');
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    throw requestError(
      400,
      'invalid_target',
      'Target parent is not accessible',
    );
  }
  const target = join(canonicalParent, basename(absoluteTarget));
  const rejection = validateTarget?.(target);
  if (rejection) {
    throw requestError(rejection.status, rejection.code, rejection.message);
  }
  // mkdir exposes the directory to concurrent registration; the claim still
  // awaits the existence check and the final realpath afterwards. Reserve
  // before mkdir so registration can never admit the target in that window.
  reserveTarget?.(target);
  try {
    try {
      await lstat(target);
      throw requestError(409, 'target_exists', 'Target path already exists');
    } catch (error) {
      if (error instanceof GitCloneRequestError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw requestError(
          400,
          'invalid_target',
          'Target path is not accessible',
        );
      }
    }
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw requestError(409, 'target_exists', 'Target path already exists');
      }
      throw requestError(400, 'invalid_target', 'Failed to create target path');
    }
    return await resolveTarget(target);
  } catch (error) {
    releaseTarget?.(target);
    throw error;
  }
}

function abortError(): Error {
  const error = new Error('cancelled');
  error.name = 'GitCloneCancelledError';
  return error;
}

export function createWorkspaceGitCloner(
  options: ClonerOptions = {},
): WorkspaceGitCloner {
  const runner = options.runner ?? spawnGitClone;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxRunning = options.maxRunning ?? DEFAULT_MAX_RUNNING;
  const maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED;
  const now = options.now ?? Date.now;
  const createJobId = options.createJobId ?? (() => randomUUID());
  const resolveCwd = options.resolveCwd ?? ((target) => realpath(target));
  const resolveClaimedTarget =
    options.resolveClaimedTarget ?? ((target) => realpath(target));
  const jobs = new Map<string, CloneJob>();
  let sealed = false;

  const runningCount = (): number => {
    let count = 0;
    for (const job of jobs.values()) {
      if (job.snapshot.status === 'running') count++;
    }
    return count;
  };
  const prune = (): void => {
    const expired: string[] = [];
    for (const [jobId, job] of jobs) {
      if (job.snapshot.status === 'running') continue;
      const finishedAt = job.snapshot.finishedAt ?? job.snapshot.startedAt;
      if (now() - finishedAt >= retentionMs) expired.push(jobId);
    }
    for (const jobId of expired) jobs.delete(jobId);
  };
  const removeOldestFinished = (): boolean => {
    for (const [jobId, job] of jobs) {
      if (job.snapshot.status === 'running') continue;
      jobs.delete(jobId);
      return true;
    }
    return false;
  };
  const isAbort = (error: unknown): boolean =>
    error instanceof Error && error.name === 'GitCloneCancelledError';

  const start = async (
    request: GitCloneRequest,
  ): Promise<{ jobId: string }> => {
    if (sealed) {
      throw requestError(
        503,
        'daemon_shutting_down',
        'Daemon is shutting down',
      );
    }
    prune();
    if (runningCount() >= maxRunning) {
      throw requestError(
        409,
        'clone_limit_reached',
        'Too many workspace clones are running',
      );
    }
    const normalizedUrl = normalizeGitCloneUrl(request.url);
    const { url, credentials } = extractGitCredentials(normalizedUrl);
    // A decoded newline would split the helper's credential-protocol lines;
    // reject here, after `extractGitCredentials` has parsed the URL, because
    // its own catch turns every throw into the raw (credential-bearing) URL.
    if (
      credentials &&
      (hasControlCharacters(credentials.username) ||
        hasControlCharacters(credentials.password))
    ) {
      throw requestError(
        400,
        'invalid_url',
        'Git URL credentials contain control characters',
      );
    }
    const target = expandCloneTarget(request.target);
    const claimed = await claimCloneTarget(
      target,
      request.validateTarget,
      request.reserveTarget,
      request.releaseTarget,
      resolveClaimedTarget,
    );
    if (sealed) {
      await rm(claimed, { recursive: true, force: true }).catch(
        () => undefined,
      );
      request.releaseTarget?.(claimed);
      throw requestError(
        503,
        'daemon_shutting_down',
        'Daemon is shutting down',
      );
    }
    // The pre-claim check can go stale while the target claim awaits, so the
    // authoritative concurrency check runs again before the job exists. The
    // window between this check and `jobs.set` is synchronous.
    if (runningCount() >= maxRunning) {
      await rm(claimed, { recursive: true, force: true }).catch(
        () => undefined,
      );
      request.releaseTarget?.(claimed);
      throw requestError(
        409,
        'clone_limit_reached',
        'Too many workspace clones are running',
      );
    }
    while (jobs.size >= maxRetained && removeOldestFinished()) {
      // Evict one finished job per iteration.
    }
    if (jobs.size >= maxRetained) {
      await rm(claimed, { recursive: true, force: true }).catch(
        () => undefined,
      );
      request.releaseTarget?.(claimed);
      throw requestError(
        409,
        'clone_limit_reached',
        'Too many workspace clones are running',
      );
    }

    const jobId = createJobId();
    const controller = new AbortController();
    const snapshot: GitCloneJobSnapshot = {
      jobId,
      status: 'running',
      startedAt: now(),
    };
    // The target was reserved inside claimCloneTarget, before mkdir exposed
    // it to a concurrent registration.
    jobs.set(jobId, { snapshot, controller, settled: Promise.resolve() });
    const job = jobs.get(jobId)!;

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    job.settled = (async () => {
      try {
        await runner.run({
          url,
          credentials,
          target: claimed,
          signal: controller.signal,
          onProgress: (line) => {
            const message = sanitizeGitCloneMessage(line, url);
            const percent = parsePercent(message);
            const current = job.snapshot.percent;
            // git reports some phases from 0% again (remote counting, then
            // receiving); keep the bar at the running maximum so it never
            // jumps backwards.
            const movesForward =
              percent !== undefined &&
              (current === undefined || percent >= current);
            if (message.length > 0) job.snapshot.message = message;
            if (movesForward) job.snapshot.percent = percent;
          },
        });
        if (controller.signal.aborted) throw abortError();
        // Resolve the result before publishing the terminal state: a reader
        // must never observe `succeeded` without the `cwd` it registers.
        const cwd = await resolveCwd(claimed).catch(() => claimed);
        job.snapshot.cwd = cwd;
        job.snapshot.percent = 100;
        job.snapshot.status = 'succeeded';
        delete job.snapshot.message;
      } catch (error) {
        const nextError = timedOut
          ? { code: 'clone_timeout', message: 'git clone timed out' }
          : controller.signal.aborted || isAbort(error)
            ? undefined
            : {
                code: 'clone_failed',
                message: sanitizeGitCloneMessage(
                  error instanceof Error ? error.message : String(error),
                  url,
                ),
              };
        await rm(claimed, { recursive: true, force: true }).catch(
          () => undefined,
        );
        job.snapshot.status = nextError ? 'failed' : 'cancelled';
        if (nextError) job.snapshot.error = nextError;
      } finally {
        clearTimeout(timeout);
        job.snapshot.finishedAt = now();
        if (job.snapshot.status === 'running') {
          job.snapshot.status = 'cancelled';
        }
        request.releaseTarget?.(claimed);
      }
    })();

    return { jobId };
  };

  return {
    start,
    get(jobId) {
      prune();
      return jobs.get(jobId)?.snapshot;
    },
    async cancel(jobId) {
      prune();
      const job = jobs.get(jobId);
      if (!job) return undefined;
      if (job.snapshot.status === 'running') {
        job.controller.abort();
        await job.settled;
      }
      return job.snapshot;
    },
    async sealAndWait() {
      sealed = true;
      const running = [...jobs.values()].filter(
        (job) => job.snapshot.status === 'running',
      );
      for (const job of running) job.controller.abort();
      await Promise.all(running.map((job) => job.settled));
    },
  };
}
