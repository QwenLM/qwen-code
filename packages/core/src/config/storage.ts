/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getProjectHash, QWEN_DIR, sanitizeCwd } from '../utils/paths.js';
import { FatalConfigError } from '../utils/errors.js';

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

export class Storage {
  private readonly targetDir: string;

  /**
   * Custom runtime output base directory set via settings.
   * When null, falls back to getGlobalQwenDir().
   */
  private static runtimeBaseDir: string | null = null;
  private static readonly runtimeBaseDirContext = new AsyncLocalStorage<
    string | null
  >();

  constructor(targetDir: string) {
    this.targetDir = targetDir;
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
    const resolved = Storage.resolveRuntimeBaseDir(dir, cwd);
    return Storage.runtimeBaseDirContext.run(resolved, fn);
  }

  /**
   * Returns the base directory for all runtime output (temp files, debug logs,
   * session data, todos, insights, etc.).
   *
   * Priority: QWEN_RUNTIME_DIR env var > setRuntimeBaseDir() value > getGlobalQwenDir()
   * @returns Absolute path to the runtime output base directory
   */
  static getRuntimeBaseDir(): string {
    const envDir = process.env['QWEN_RUNTIME_DIR'];
    if (envDir) {
      return (
        Storage.resolveRuntimeBaseDir(envDir) ?? Storage.getGlobalQwenDir()
      );
    }

    const contextualDir = Storage.runtimeBaseDirContext.getStore();
    if (contextualDir !== undefined) {
      return contextualDir ?? Storage.getGlobalQwenDir();
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

  getProjectDir(): string {
    const projectId = sanitizeCwd(this.getProjectRoot());
    const projectsDir = path.join(
      Storage.getRuntimeBaseDir(),
      PROJECT_DIR_NAME,
    );
    return path.join(projectsDir, projectId);
  }

  getProjectTempDir(): string {
    const hash = getProjectHash(this.getProjectRoot());
    const tempDir = Storage.getGlobalTempDir();
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
