/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getProjectHash,
  QWEN_DIR,
  realpathNearestExisting,
  sanitizeCwd,
} from '../utils/paths.js';
import { FatalConfigError } from '../utils/errors.js';

// The sweep's debug logger and runtime-status reader are imported lazily
// inside the functions that use them: static edges from storage.ts to
// debugLogger.ts (which imports Storage back) and to runtimeStatus.ts
// (via atomicFileWrite.ts, which also logs at module scope) close a
// module cycle that crashes forked children whose graph reaches
// debugLogger first.
async function storageLogger() {
  const { createDebugLogger } = await import('../utils/debugLogger.js');
  return createDebugLogger('storage');
}

export { QWEN_DIR } from '../utils/paths.js';
export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';
export const OAUTH_FILE = 'oauth_creds.json';
export const SKILL_PROVIDER_CONFIG_DIRS = ['.qwen', '.agents'];
const TMP_DIR_NAME = 'tmp';
const BIN_DIR_NAME = 'bin';
const PROJECT_DIR_NAME = 'projects';
const IDE_DIR_NAME = 'ide';
const PLANS_DIR_NAME = 'plans';
const DEBUG_DIR_NAME = 'debug';
const ARENA_DIR_NAME = 'arena';

function isResolvedPathWithinDirectory(childPath: string, parentPath: string) {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

// realpathSync only resolves existing paths, but sweep candidates are usually
// gone by definition: realpathNearestExisting walks up to the nearest existing
// ancestor and re-appends the missing tail, so a deleted worktree still
// resolves to its real location (on macOS /var/folders vs /private/var/folders
// otherwise never matches). The helper never throws: an unresolvable candidate
// comes back in lexical form, which fails the tmpdir containment check below
// and keeps the bucket.
function resolveSweepCandidate(candidate: string): string {
  return realpathNearestExisting(candidate);
}

// The repo-existence conjunct needs positive proof: only a clean stat counts
// as "the repo is still there". Any stat error (ESTALE/EIO on a downed mount,
// EACCES, ELOOP) keeps the bucket.
function isPositivelyExistingDirectorySync(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Worktree sessions snapshot a project dir under
 * `<runtimeBaseDir>/projects/<sanitizeCwd(worktreePath)>` whose transcripts
 * point at the temp worktree. The worktree is deleted on exit (or lost on
 * crash), but the snapshot dir is never removed, so
 * `%TEMP%/qwen-*-sess-*` entries accumulate forever (#7906). Sweep the
 * project dirs that are keyed by a worktree path and whose worktree
 * sidecars all point at paths that no longer exist, plus the buckets
 * keyed by a sidecar's gone ephemeral launch cwd (its `originalCwd`
 * field) inside the OS temp dir. Anything
 * that cannot prove itself stale (no sidecar, corrupted sidecars, at
 * least one live worktree, a launch cwd outside the temp dir or still
 * present) is kept. Normal project buckets are never touched: they can
 * hold worktree sidecars of their own (enter/exit run from the original
 * repo does not relocate session storage), so a bucket whose launch cwd
 * is not in the temp dir is kept regardless of what its sidecars say.
 */
export async function sweepStaleWorktreeProjects(
  runtimeBaseDir: string,
  keepBucket?: string,
): Promise<string[]> {
  const projectsDir = path.join(runtimeBaseDir, PROJECT_DIR_NAME);
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }

  let realTmpdir: string;
  try {
    realTmpdir = fs.realpathSync(os.tmpdir());
  } catch {
    realTmpdir = os.tmpdir();
  }
  // A tmpdir that IS the filesystem root (TMPDIR=/) would put every launch
  // cwd "inside the temp dir" and turn arm 2 into sweep-everything; treat it
  // as no temp dir at all so arm 2 never fires.
  const tmpdirIsUsable = realTmpdir !== path.parse(realTmpdir).root;

  const removed: string[] = [];
  for (const entry of entries.sort()) {
    // The bucket this process just attached to is in use by definition; never
    // sweep it out from under the live session. Its staleness is re-evaluated
    // at the next start.
    if (keepBucket !== undefined && entry === keepBucket) continue;
    const chatsDir = path.join(projectsDir, entry, 'chats');
    // Archiving is an explicit user retention action, and the sidecar move is
    // best-effort (archived sidecars can be missing, unreadable, or corrupted,
    // and a failed readdir would silently drop them all): any entry at all
    // under chats/archive/ keeps the bucket, no parsing involved.
    try {
      if ((await fsp.readdir(path.join(chatsDir, 'archive'))).length > 0)
        continue;
    } catch {
      // no archive dir: nothing retained
    }
    const sidecars = await readWorktreeSidecarRecords(chatsDir);
    if (sidecars.length === 0) continue;

    const allWorktreesGone = sidecars.every(
      (sidecar) => !isDirectorySync(sidecar.worktreePath),
    );

    let stale: boolean;
    if (
      sidecars.some((sidecar) => entry === sanitizeCwd(sidecar.worktreePath))
    ) {
      // Bucket keyed by a worktree path itself. A normal project bucket can
      // hold worktree sidecars too (enter/exit run from the original repo
      // never relocates the session storage), so only this arm may sweep,
      // and only once every worktree is gone and the owning repo is still
      // there: ENOENT on the worktree path also reads as a downed or
      // unmounted volume, and a sweep while the drive is offline would erase
      // transcripts that come back with it.
      stale =
        allWorktreesGone &&
        sidecars.every(
          (sidecar) =>
            sidecar.originalCwd !== undefined &&
            isPositivelyExistingDirectorySync(sidecar.originalCwd),
        );
      if (stale && (await hasLiveSiblingWorktree(sidecars, entry))) {
        // sanitizeCwd collapses fix.bug and fix-bug to one bucket name, so
        // the gate cannot prove which worktree owns the bucket; a cold but
        // on-disk co-owner worktree must keep it (cold data has no liveness
        // signal for the vetoes below).
        stale = false;
      }
    } else {
      // Bucket keyed by a gone ephemeral launch cwd, #7906's main class:
      // enter_worktree from a throwaway T lands the sidecar here with
      // worktreePath = T/.qwen/worktrees/<slug>, which the arm above can
      // never match. Sweep only when the bucket is actually keyed by that
      // launch cwd (a repo bucket that merely holds such sidecars after a
      // /cd relocation keeps its history), every sidecar places its launch
      // cwd inside the OS temp dir, and that cwd is gone too. A real repo
      // path (or a missing originalCwd) always keeps the bucket: an absent
      // repo dir can mean an unplugged drive, not garbage.
      stale =
        allWorktreesGone &&
        // A tmpdir root that will not stat cleanly is a downed volume, not an
        // ephemeral scratch space: keep every bucket until it comes back.
        tmpdirIsUsable &&
        isPositivelyExistingDirectorySync(realTmpdir) &&
        sidecars.every(
          (sidecar) =>
            sidecar.originalCwd !== undefined &&
            entry === sanitizeCwd(sidecar.originalCwd) &&
            isResolvedPathWithinDirectory(
              resolveSweepCandidate(sidecar.originalCwd),
              realTmpdir,
            ) &&
            !isDirectorySync(sidecar.originalCwd),
        );
    }
    if (!stale) continue;

    // sanitizeCwd collapses distinct worktrees to one bucket name (dots and
    // dashes both become dashes), so the name gate above cannot prove which
    // worktree owns the bucket. A session started with a plain `cd` writes no
    // sidecar, and its live transcript would be deleted with the bucket; a
    // live runtime.json anywhere in the bucket vetoes the sweep. runtime.json
    // is only written by interactive sessions, so a recently touched
    // transcript file vetoes too, covering headless/serve/ACP sessions.
    if (
      (await hasLiveRuntime(chatsDir)) ||
      (await hasRecentTranscriptActivity(chatsDir))
    ) {
      continue;
    }

    // One unreadable entry must not abort the sweep for the rest.
    try {
      await fsp.rm(path.join(projectsDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      (await storageLogger()).debug(
        `Failed to remove stale worktree project snapshot ${entry}: ${String(error)}`,
      );
      continue;
    }
    removed.push(entry);
    (await storageLogger()).debug(
      `Removed stale worktree project snapshot ${entry} (all worktree sidecars point at removed paths)`,
    );
  }
  return removed;
}

/**
 * Collect the worktreePath (and originalCwd when present) of every readable
 * sidecar under `chats/` and `chats/archive/`. A corrupted sidecar proves
 * nothing and is skipped, never treated as a reason to delete or keep on its
 * own.
 */
// True when any on-disk worktree of the owning repo sanitizes to this bucket
// name. The dead worktrees named by the sidecars are gone by definition, so
// any directory found is live.
async function hasLiveSiblingWorktree(
  sidecars: Array<{ worktreePath: string; originalCwd?: string }>,
  entry: string,
): Promise<boolean> {
  for (const sidecar of sidecars) {
    if (sidecar.originalCwd === undefined) continue;
    const worktreesDir = path.join(sidecar.originalCwd, '.qwen', 'worktrees');
    let names: string[];
    try {
      names = await fsp.readdir(worktreesDir);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(worktreesDir, name);
      if (isDirectorySync(candidate) && sanitizeCwd(candidate) === entry) {
        return true;
      }
    }
  }
  return false;
}

async function readWorktreeSidecarRecords(
  chatsDir: string,
): Promise<Array<{ worktreePath: string; originalCwd?: string }>> {
  let names: string[];
  try {
    names = await fsp.readdir(chatsDir);
  } catch {
    return [];
  }
  const sidecars = names
    .filter((name) => name.endsWith('.worktree.json'))
    .map((name) => path.join(chatsDir, name))
    .sort((a, b) => a.localeCompare(b));

  const records: Array<{
    worktreePath: string;
    originalCwd?: string;
  }> = [];
  for (const sidecar of sidecars) {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(sidecar, 'utf-8'));
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>)['worktreePath'] === 'string'
      ) {
        const record = parsed as Record<string, unknown>;
        records.push({
          worktreePath: record['worktreePath'] as string,
          originalCwd:
            typeof record['originalCwd'] === 'string'
              ? (record['originalCwd'] as string)
              : undefined,
        });
      }
    } catch {
      // corrupted sidecar: try the next one before judging the bucket
    }
  }
  return records;
}

function isDirectorySync(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (error) {
    // ENOENT means gone; anything else (permissions, transient fs errors)
    // answers "cannot prove gone", which for a destructive sweep means keep.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const TRANSCRIPT_LIVE_GRACE_MS = 10 * 60 * 1000;

/**
 * True when any chats/*.jsonl in the bucket was touched within the grace
 * window. A running session keeps appending transcript lines regardless of
 * session mode (interactive, headless, serve, ACP, daemon), so transcript
 * freshness is the session-mode-agnostic liveness signal that runtime.json
 * cannot provide for non-interactive sessions.
 */
async function hasRecentTranscriptActivity(chatsDir: string): Promise<boolean> {
  const cutoff = Date.now() - TRANSCRIPT_LIVE_GRACE_MS;
  let names: string[];
  try {
    names = await fsp.readdir(chatsDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const stat = await fsp.stat(path.join(chatsDir, name));
      if (stat.mtimeMs >= cutoff) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * True when any `*.runtime.json` in the bucket reports a live process.
 * Mirrors getRuntimeStatusPathState: a different hostname cannot be verified
 * and counts as live, and a pid probe failure other than ESRCH does too.
 */
async function hasLiveRuntime(chatsDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await fsp.readdir(chatsDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.runtime.json')) continue;
    const { readRuntimeStatus } = await import('../utils/runtimeStatus.js');
    const status = await readRuntimeStatus(path.join(chatsDir, name));
    if (!status) continue;
    if (status.hostname !== os.hostname()) {
      return true;
    }
    try {
      process.kill(status.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return true;
      }
    }
  }
  return false;
}

const staleWorktreeSweepStarted = new Set<string>();

// The constructor-scheduled sweep deletes on-disk state, so it must not fire
// from a bare Storage construction (unit tests build Storage against the real
// default dir). Only the real CLI bootstrap opts in via enableStartupSweep().
let startupSweepEnabled = false;

export function enableStartupSweep(): void {
  startupSweepEnabled = true;
}

function scheduleStaleWorktreeSweep(
  runtimeBaseDir: string,
  keepBucket?: string,
): void {
  if (staleWorktreeSweepStarted.has(runtimeBaseDir)) return;
  staleWorktreeSweepStarted.add(runtimeBaseDir);
  void sweepStaleWorktreeProjects(runtimeBaseDir, keepBucket).catch(
    async (error: unknown) => {
      (await storageLogger()).warn(
        `stale worktree project sweep failed: ${error}`,
      );
    },
  );
}

export class Storage {
  private readonly targetDir: string;
  private readonly runtimeBaseDir: string;

  /**
   * Custom runtime output base directory set via settings.
   * When null, falls back to getGlobalQwenDir().
   */
  private static runtimeBaseDir: string | null = null;
  private static readonly runtimeBaseDirContext = new AsyncLocalStorage<{
    dir: string | null;
    pinned: boolean;
  }>();

  constructor(
    targetDir: string,
    runtimeBaseDir: string = Storage.getRuntimeBaseDir(),
  ) {
    this.targetDir = targetDir;
    this.runtimeBaseDir = path.resolve(runtimeBaseDir);
    if (startupSweepEnabled) {
      scheduleStaleWorktreeSweep(
        this.runtimeBaseDir,
        sanitizeCwd(this.targetDir),
      );
    }
  }

  /**
   * Expands tilde and resolves relative paths to absolute.
   */
  private static resolvePath(dir: string, cwd?: string): string {
    let resolved = dir;
    if (
      resolved === '~' ||
      resolved.startsWith('~/') ||
      resolved.startsWith('~\\')
    ) {
      const relativeSegments =
        resolved === '~'
          ? []
          : resolved
              .slice(2)
              .split(/[/\\]+/)
              .filter(Boolean);
      resolved = path.join(os.homedir(), ...relativeSegments);
    }
    if (!path.isAbsolute(resolved)) {
      resolved = cwd ? path.resolve(cwd, resolved) : path.resolve(resolved);
    }
    return resolved;
  }

  /**
   * Sanitizes a session id for use as a plan filename.
   *
   * Plan files are keyed by session id, but the raw id is public SDK input.
   * Strip directory separators and Windows-invalid filename characters so a
   * hostile value cannot escape the plans directory.
   */
  static sanitizePlanSessionId(sessionId: string): string {
    const safeName = path
      .basename(sessionId.replace(/\\/g, '/'))
      .replace(/^\.+/g, '_')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"|?*\x00-\x1F]/g, '_');
    return safeName || '_';
  }

  private static resolveRuntimeBaseDir(
    dir: string | null | undefined,
    cwd?: string,
  ): string | null {
    if (!dir) {
      return null;
    }
    return Storage.resolvePath(dir, cwd);
  }

  /**
   * Sets the custom runtime output base directory.
   * Handles tilde (~) expansion and resolves relative paths to absolute.
   * Pass null/undefined/empty string to reset to default (getGlobalQwenDir()).
   * @param dir - The directory path, or null/undefined to reset
   * @param cwd - Base directory for resolving relative paths (defaults to process.cwd()).
   *              Pass the project root so that relative values like ".qwen" resolve
   *              per-project, enabling a single global config to work across all projects.
   */
  static setRuntimeBaseDir(dir: string | null | undefined, cwd?: string): void {
    Storage.runtimeBaseDir = Storage.resolveRuntimeBaseDir(dir, cwd);
  }

  /**
   * Runs function execution in an async context with a specific runtime output dir.
   * This is used to isolate runtime output paths between concurrent sessions.
   */
  static runWithRuntimeBaseDir<T>(
    dir: string | null | undefined,
    cwd: string | undefined,
    fn: () => T,
  ): T {
    if (Storage.runtimeBaseDirContext.getStore()?.pinned) {
      return fn();
    }
    const resolved = Storage.resolveRuntimeBaseDir(dir, cwd);
    return Storage.runtimeBaseDirContext.run(
      { dir: resolved, pinned: false },
      fn,
    );
  }

  static runWithResolvedRuntimeBaseDir<T>(dir: string, fn: () => T): T {
    // A managed workspace runtime owns this root for its full lifetime.
    // Unlike the configurable context above, later process-env reloads must
    // not redirect storage created inside this context.
    return Storage.runtimeBaseDirContext.run(
      { dir: path.resolve(dir), pinned: true },
      fn,
    );
  }

  static hasRuntimeBaseDirContext(): boolean {
    return Storage.runtimeBaseDirContext.getStore() !== undefined;
  }

  /**
   * Returns the base directory for all runtime output (temp files, debug logs,
   * session data, todos, insights, etc.).
   *
   * Priority: pinned runtime context > QWEN_RUNTIME_DIR env var > configurable context > setRuntimeBaseDir() value > getGlobalQwenDir()
   * @returns Absolute path to the runtime output base directory
   */
  static getRuntimeBaseDir(): string {
    const contextualDir = Storage.runtimeBaseDirContext.getStore();
    if (contextualDir?.pinned) {
      return contextualDir.dir ?? Storage.getGlobalQwenDir();
    }
    const envDir = process.env['QWEN_RUNTIME_DIR'];
    if (envDir) {
      return (
        Storage.resolveRuntimeBaseDir(envDir) ?? Storage.getGlobalQwenDir()
      );
    }

    if (contextualDir !== undefined) {
      return contextualDir.dir ?? Storage.getGlobalQwenDir();
    }
    if (Storage.runtimeBaseDir) {
      return Storage.runtimeBaseDir;
    }
    return Storage.getGlobalQwenDir();
  }

  static getGlobalQwenDir(): string {
    const envDir = process.env['QWEN_HOME'];
    if (envDir) {
      return Storage.resolvePath(envDir);
    }
    const homeDir = os.homedir();
    if (!homeDir) {
      return path.join(os.tmpdir(), '.qwen');
    }
    return path.join(homeDir, QWEN_DIR);
  }

  static getMcpOAuthTokensPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'mcp-oauth-tokens.json');
  }

  static getGlobalSettingsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'settings.json');
  }

  static getInstallationIdPath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'installation_id');
  }

  static getGoogleAccountsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), GOOGLE_ACCOUNTS_FILENAME);
  }

  static getUserCommandsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'commands');
  }

  static getGlobalMemoryFilePath(): string {
    return path.join(Storage.getGlobalQwenDir(), 'memory.md');
  }

  static getGlobalTempDir(): string {
    return path.join(Storage.getRuntimeBaseDir(), TMP_DIR_NAME);
  }

  static getGlobalDebugDir(): string {
    return path.join(Storage.getRuntimeBaseDir(), DEBUG_DIR_NAME);
  }

  static getDebugLogPath(sessionId: string): string {
    return path.join(Storage.getGlobalDebugDir(), `${sessionId}.txt`);
  }

  static getGlobalIdeDir(): string {
    // Pinned to the global Qwen dir so the VS Code companion (which only
    // sees env vars, not settings-based runtimeOutputDir) finds the same
    // lock-file location as the CLI.
    return path.join(Storage.getGlobalQwenDir(), IDE_DIR_NAME);
  }

  /**
   * Resolves pathToResolve by realpathing its deepest existing ancestor and
   * appending the not-yet-created remainder.
   */
  private static resolvePathThroughExistingAncestor(
    pathToResolve: string,
  ): string {
    let candidate = pathToResolve;
    while (true) {
      try {
        const realCandidate = fs.realpathSync(candidate);
        const remainder = path.relative(candidate, pathToResolve);
        return path.join(realCandidate, remainder);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
          return pathToResolve;
        }
        candidate = parent;
      }
    }
  }

  /**
   * Checks whether {@link childPath} resides within {@link parentPath},
   * resolving symbolic links to prevent traversal bypass attacks.
   */
  private static isPathWithinDirectory(
    childPath: string,
    parentPath: string,
  ): boolean {
    const realParent = Storage.resolvePathThroughExistingAncestor(parentPath);
    const realChild = Storage.resolvePathThroughExistingAncestor(childPath);

    return isResolvedPathWithinDirectory(realChild, realParent);
  }

  static assertPathWithinDirectory(
    childPath: string,
    parentPath: string,
    errorMessage: string,
  ): void {
    if (!Storage.isPathWithinDirectory(childPath, parentPath)) {
      throw new FatalConfigError(errorMessage);
    }
  }

  static getPlansDir(
    projectRoot?: string | null,
    plansDirectory?: string | null,
  ): string {
    const configuredPlansDirectory = plansDirectory?.trim();
    if (configuredPlansDirectory) {
      if (!projectRoot) {
        throw new FatalConfigError(
          'projectRoot is required when plansDirectory is configured.',
        );
      }

      const resolvedProjectRoot = path.resolve(projectRoot);
      const resolvedPlansDirectory = Storage.resolvePath(
        configuredPlansDirectory,
        resolvedProjectRoot,
      );

      Storage.assertPathWithinDirectory(
        resolvedPlansDirectory,
        resolvedProjectRoot,
        `plansDirectory must resolve within the project root.`,
      );

      return resolvedPlansDirectory;
    }

    return path.join(Storage.getGlobalQwenDir(), PLANS_DIR_NAME);
  }

  static getPlanFilePath(
    sessionId: string,
    projectRoot?: string | null,
    plansDirectory?: string | null,
  ): string {
    // Kept for tests and SDK callers that still use Storage helpers directly.
    return path.join(
      Storage.getPlansDir(projectRoot, plansDirectory),
      `${Storage.sanitizePlanSessionId(sessionId)}.md`,
    );
  }

  static getGlobalBinDir(): string {
    return path.join(Storage.getGlobalQwenDir(), BIN_DIR_NAME);
  }

  static getGlobalArenaDir(): string {
    return path.join(Storage.getGlobalQwenDir(), ARENA_DIR_NAME);
  }

  getQwenDir(): string {
    return path.join(this.targetDir, QWEN_DIR);
  }

  getRuntimeBaseDir(): string {
    return this.runtimeBaseDir;
  }

  getProjectDir(): string {
    const projectId = sanitizeCwd(this.getProjectRoot());
    const projectsDir = path.join(this.runtimeBaseDir, PROJECT_DIR_NAME);
    return path.join(projectsDir, projectId);
  }

  getProjectTempDir(): string {
    const hash = getProjectHash(this.getProjectRoot());
    const tempDir = path.join(this.runtimeBaseDir, TMP_DIR_NAME);
    const targetDir = path.join(tempDir, hash);
    return targetDir;
  }

  getToolResultsDir(): string {
    return path.join(this.getProjectTempDir(), 'tool-results');
  }

  ensureProjectTempDirExists(): void {
    fs.mkdirSync(this.getProjectTempDir(), { recursive: true });
  }

  static getOAuthCredsPath(): string {
    return path.join(Storage.getGlobalQwenDir(), OAUTH_FILE);
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getWorkspaceSettingsPath(): string {
    return path.join(this.getQwenDir(), 'settings.json');
  }

  getProjectCommandsDir(): string {
    return path.join(this.getQwenDir(), 'commands');
  }

  /**
   * Project-level saved-workflow scripts directory: `<targetDir>/.qwen/workflows`.
   * Saved workflow scripts (`<name>.js`) here are surfaced as slash commands
   * and resolvable by `workflow('<name>')` from inside a running workflow.
   */
  getProjectWorkflowsDir(): string {
    return path.join(this.getQwenDir(), 'workflows');
  }

  /**
   * User-level saved-workflow scripts directory: `~/.qwen/workflows`. User
   * scope is lower-precedence than project scope when the same `<name>.js`
   * exists in both.
   */
  static getUserWorkflowsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'workflows');
  }

  /**
   * Per-run workflow artifact directory: `<projectDir>/workflows`. Holds
   * completed-run snapshot JSON files (`<runId>.json`) for the `/workflows`
   * recent list, and per-run resume journals (`<runId>/journal.jsonl`).
   */
  getWorkflowRunsDir(): string {
    return path.join(this.getProjectDir(), 'workflows');
  }

  /**
   * Path to the persisted snapshot of a completed workflow run.
   */
  getWorkflowRunSnapshotPath(runId: string): string {
    return path.join(this.getWorkflowRunsDir(), `${runId}.json`);
  }

  /**
   * Path to the resume journal for an in-progress / resumable workflow run.
   */
  getWorkflowRunJournalPath(runId: string): string {
    return path.join(this.getWorkflowRunsDir(), runId, 'journal.jsonl');
  }

  /**
   * Path to the runtime-status sidecar JSON for this session.
   *
   * Co-located with the per-session chat log under
   * `<projectDir>/chats/<sessionId>.runtime.json` so external observers
   * (terminal multiplexers, IDE integrations, status daemons) can scan
   * the same directory used for chat history to find live sessions.
   */
  getRuntimeStatusPath(sessionId: string): string {
    return path.join(
      this.getProjectDir(),
      'chats',
      `${sessionId}.runtime.json`,
    );
  }

  getProjectTempCheckpointsDir(): string {
    return path.join(this.getProjectTempDir(), 'checkpoints');
  }

  getExtensionsDir(): string {
    return path.join(this.getQwenDir(), 'extensions');
  }

  getExtensionsConfigPath(): string {
    return path.join(this.getExtensionsDir(), 'qwen-extension.json');
  }

  getUserSkillsDirs(): string[] {
    const homeDir = os.homedir() || os.tmpdir();
    return SKILL_PROVIDER_CONFIG_DIRS.map((dir) =>
      dir === QWEN_DIR
        ? path.join(Storage.getGlobalQwenDir(), 'skills')
        : path.join(homeDir, dir, 'skills'),
    );
  }

  /**
   * Returns the user-level extensions directory (~/.qwen/extensions/).
   * Extensions installed at user scope are stored here, as opposed to
   * project-level extensions which live in <project>/.qwen/extensions/.
   */
  static getUserExtensionsDir(): string {
    return path.join(Storage.getGlobalQwenDir(), 'extensions');
  }

  getHistoryFilePath(): string {
    return path.join(this.getProjectTempDir(), 'shell_history');
  }
}
