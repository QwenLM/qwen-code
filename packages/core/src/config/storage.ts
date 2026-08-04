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
import { getProjectHash, QWEN_DIR, sanitizeCwd } from '../utils/paths.js';
import { readRuntimeStatus } from '../utils/runtimeStatus.js';
import { FatalConfigError } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const logger = createDebugLogger('storage');

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

/**
 * Worktree sessions snapshot a project dir under
 * `<runtimeBaseDir>/projects/<sanitizeCwd(worktreePath)>` whose transcripts
 * point at the temp worktree. The worktree is deleted on exit (or lost on
 * crash), but the snapshot dir is never removed, so
 * `%TEMP%/qwen-*-sess-*` entries accumulate forever (#7906). Sweep the
 * project dirs that are keyed by a worktree path and whose worktree
 * sidecars all point at paths that no longer exist, plus the buckets
 * keyed by a gone ephemeral launch cwd inside the OS temp dir. Anything
 * that cannot prove itself stale (no sidecar, corrupted sidecars, at
 * least one live worktree, a launch cwd outside the temp dir or still
 * present) is kept. Normal project buckets are never touched: they can
 * hold worktree sidecars of their own (enter/exit run from the original
 * repo does not relocate session storage), so a bucket whose launch cwd
 * is not in the temp dir is kept regardless of what its sidecars say.
 */
export async function sweepStaleWorktreeProjects(
  runtimeBaseDir: string,
): Promise<string[]> {
  const projectsDir = path.join(runtimeBaseDir, PROJECT_DIR_NAME);
  let entries: string[];
  try {
    entries = await fsp.readdir(projectsDir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const entry of entries.sort()) {
    const chatsDir = path.join(projectsDir, entry, 'chats');
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
      // and only once every worktree is gone.
      stale = allWorktreesGone;
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
        sidecars.every(
          (sidecar) =>
            sidecar.originalCwd !== undefined &&
            entry === sanitizeCwd(sidecar.originalCwd) &&
            isResolvedPathWithinDirectory(sidecar.originalCwd, os.tmpdir()) &&
            !isDirectorySync(sidecar.originalCwd),
        );
    }
    if (!stale) continue;

    // sanitizeCwd collapses distinct worktrees to one bucket name (dots and
    // dashes both become dashes), so the name gate above cannot prove which
    // worktree owns the bucket. A session started with a plain `cd` writes no
    // sidecar, and its live transcript would be deleted with the bucket; a
    // live runtime.json anywhere in the bucket vetoes the sweep.
    if (await hasLiveRuntime(chatsDir)) {
      continue;
    }

    // One unreadable entry must not abort the sweep for the rest.
    try {
      await fsp.rm(path.join(projectsDir, entry), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      logger.debug(
        `Failed to remove stale worktree project snapshot ${entry}: ${String(error)}`,
      );
      continue;
    }
    removed.push(entry);
    logger.debug(
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
async function readWorktreeSidecarRecords(
  chatsDir: string,
): Promise<Array<{ worktreePath: string; originalCwd?: string }>> {
  const sidecars: string[] = [];
  for (const dir of [chatsDir, path.join(chatsDir, 'archive')]) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    sidecars.push(
      ...names
        .filter((name) => name.endsWith('.worktree.json'))
        .map((name) => path.join(dir, name)),
    );
  }
  sidecars.sort();

  const records: Array<{ worktreePath: string; originalCwd?: string }> = [];
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

function scheduleStaleWorktreeSweep(runtimeBaseDir: string): void {
  if (staleWorktreeSweepStarted.has(runtimeBaseDir)) return;
  staleWorktreeSweepStarted.add(runtimeBaseDir);
  void sweepStaleWorktreeProjects(runtimeBaseDir).catch((error: unknown) => {
    logger.warn(`stale worktree project sweep failed: ${error}`);
  });
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
    scheduleStaleWorktreeSweep(this.runtimeBaseDir);
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
