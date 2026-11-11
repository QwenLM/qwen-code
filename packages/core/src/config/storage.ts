/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { BRAND_NAME } from './brand.js';
import { stripBOM } from '../utils/stripBom.js';
import { computeIsolatedTaskOutputDir } from '../utils/task/diskOutput.js';
import {
  CONFIG_DIR,
  getConfigHomeDir,
  homedir,
  isSubpath,
  resolveToRealPath,
  normalizePath,
  sanitizePath,
} from '../utils/paths.js';

export const OAUTH_FILE = 'oauth_creds.json';
const TMP_DIR_NAME = 'tmp';
const BIN_DIR_NAME = 'bin';
const AGENTS_DIR_NAME = '.agents';

export class Storage {
  private readonly targetDir: string;
  private readonly sessionId: string | undefined;
  private projectIdentifier: string | undefined;
  private initPromise: Promise<void> | undefined;
  private customPlansDir: string | undefined;

  constructor(targetDir: string, sessionId?: string) {
    this.targetDir = targetDir;
    this.sessionId = sessionId;
  }

  setCustomPlansDir(dir: string | undefined): void {
    this.customPlansDir = dir;
  }

  static getGlobalConfigDir(): string {
    return getConfigHomeDir();
  }

  static getGlobalAgentsDir(): string {
    const homeDir = homedir();
    if (!homeDir) {
      return '';
    }
    return path.join(homeDir, AGENTS_DIR_NAME);
  }

  static getMcpOAuthTokensPath(): string {
    return path.join(Storage.getGlobalConfigDir(), 'mcp-oauth-tokens.json');
  }

  static getGlobalSettingsPath(): string {
    return path.join(Storage.getGlobalConfigDir(), 'settings.json');
  }

  static getInstallationIdPath(): string {
    return path.join(Storage.getGlobalConfigDir(), 'installation_id');
  }

  static getUserCommandsDir(): string {
    return path.join(Storage.getGlobalConfigDir(), 'commands');
  }

  static getUserSkillsDir(): string {
    return path.join(Storage.getGlobalConfigDir(), 'skills');
  }

  static getUserAgentSkillsDir(): string {
    return path.join(Storage.getGlobalAgentsDir(), 'skills');
  }

  static getGlobalMemoryFilePath(): string {
    return path.join(Storage.getGlobalConfigDir(), 'memory.md');
  }

  static getUserPoliciesDir(): string {
    return path.join(Storage.getGlobalConfigDir(), 'policies');
  }

  static getUserKeybindingsPath(): string {
    return path.join(Storage.getGlobalConfigDir(), 'keybindings.json');
  }

  static getUserAgentsDir(): string {
    return path.join(Storage.getGlobalConfigDir(), 'agents');
  }

  static getGlobalTempDir(): string {
    return path.join(Storage.getGlobalConfigDir(), TMP_DIR_NAME);
  }

  static getGlobalBinDir(): string {
    return path.join(Storage.getGlobalTempDir(), BIN_DIR_NAME);
  }

  getConfigDir(): string {
    return path.join(this.targetDir, CONFIG_DIR);
  }

  getAgentsDir(): string {
    return path.join(this.targetDir, AGENTS_DIR_NAME);
  }

  /**
   * Checks if the current workspace storage location is the same as the global/user storage location.
   * This handles symlinks and platform-specific path normalization.
   */
  isWorkspaceHomeDir(): boolean {
    return (
      normalizePath(resolveToRealPath(this.targetDir)) ===
      normalizePath(resolveToRealPath(homedir()))
    );
  }

  getProjectTempDir(): string {
    const identifier = this.getProjectIdentifier();
    const tempDir = Storage.getGlobalTempDir();
    return path.join(tempDir, identifier);
  }

  /** 任意项目根对应的临时目录，供未初始化 Storage 的跨项目清理使用。 */
  static getProjectTempDirForProjectRoot(projectRoot: string): string {
    return path.join(Storage.getGlobalTempDir(), sanitizePath(projectRoot));
  }

  ensureProjectTempDirExists(): void {
    fs.mkdirSync(this.getProjectTempDir(), { recursive: true });
  }

  static getOAuthCredsPath(): string {
    return path.join(Storage.getGlobalConfigDir(), OAUTH_FILE);
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  private getProjectIdentifier(): string {
    if (!this.projectIdentifier) {
      throw new Error('Storage must be initialized before use');
    }
    return this.projectIdentifier;
  }

  /**
   * Initializes storage by computing the current project identifier.
   *
   * The identifier is a deterministic sanitization of the absolute project
   * root path (see `sanitizePath`). No registry file or legacy
   * directory migration is involved.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (this.projectIdentifier) {
        return;
      }

      this.projectIdentifier = sanitizePath(this.getProjectRoot());
    })();

    return this.initPromise;
  }

  getProjectMemoryDir(): string {
    return this.getProjectMemoryTempDir();
  }

  getProjectMemoryTempDir(): string {
    const identifier = this.getProjectIdentifier();
    return path.join(
      Storage.getGlobalConfigDir(),
      'projects',
      identifier,
      'memory',
    );
  }

  getProjectSkillsMemoryDir(): string {
    return path.join(this.getProjectMemoryTempDir(), 'skills');
  }

  /**
   * Project-scoped state root: `<globalConfigDir>/projects/<projectId>`.
   *
   * Static (and synchronously derived from the project root) because callers
   * such as Config.getGoalManager() run synchronously during startup, before
   * Storage.initialize() has necessarily resolved the project identifier. The
   * identifier uses the same `sanitizePath` rule as initialize(), so both
   * resolve to the same project directory.
   *
   * @param projectRoot Project root; defaults to the current working directory.
   */
  static getProjectStateDir(projectRoot?: string): string {
    const identifier = sanitizePath(projectRoot ?? process.cwd());
    return path.join(Storage.getGlobalConfigDir(), 'projects', identifier);
  }

  getWorkspaceSettingsPath(): string {
    return path.join(this.getConfigDir(), 'settings.json');
  }

  getWorkspaceLocalSettingsPath(): string {
    return path.join(this.getConfigDir(), 'settings.local.json');
  }

  getProjectCommandsDir(): string {
    return path.join(this.getConfigDir(), 'commands');
  }

  getProjectSkillsDir(): string {
    return path.join(this.getConfigDir(), 'skills');
  }

  getProjectAgentSkillsDir(): string {
    return path.join(this.getAgentsDir(), 'skills');
  }

  getProjectAgentsDir(): string {
    return path.join(this.getConfigDir(), 'agents');
  }

  getProjectTempLogsDir(): string {
    return path.join(this.getProjectTempDir(), 'logs');
  }

  getProjectTempPlansDir(): string {
    if (this.sessionId) {
      return path.join(this.getProjectTempDir(), this.sessionId, 'plans');
    }
    return path.join(this.getProjectTempDir(), 'plans');
  }

  getPlansDir(): string {
    if (this.customPlansDir) {
      const resolvedPath = path.resolve(
        this.getProjectRoot(),
        this.customPlansDir,
      );
      const realProjectRoot = resolveToRealPath(this.getProjectRoot());
      const realResolvedPath = resolveToRealPath(resolvedPath);

      if (!isSubpath(realProjectRoot, realResolvedPath)) {
        throw new Error(
          `Custom plans directory '${this.customPlansDir}' resolves to '${realResolvedPath}', which is outside the project root '${realProjectRoot}'.`,
        );
      }

      return resolvedPath;
    }
    // Default: global shared plans directory (~/${CONFIG_DIR}/plans).
    // All sessions share this directory; files are distinguished by wordSlug
    // (e.g. tender-juggling-karp.md). This mirrors the ~/.claude/plans design.
    return path.join(Storage.getGlobalConfigDir(), 'plans');
  }

  getProjectTempTasksDir(): string {
    if (this.sessionId) {
      return path.join(this.getProjectTempDir(), this.sessionId, 'tasks');
    }
    return path.join(this.getProjectTempDir(), 'tasks');
  }

  /**
   * Spill directory for oversized MCP tool output. Must stay under the project
   * temp dir: tool path validation only allows workspace directories plus that
   * dir, so a system-tmpdir path would not be readable by the model.
   */
  getProjectTempToolResultsDir(): string {
    if (this.sessionId) {
      return path.join(
        this.getProjectTempDir(),
        this.sessionId,
        'tool-results',
      );
    }
    return path.join(this.getProjectTempDir(), 'tool-results');
  }

  /**
   * Returns an isolated tasks directory under the system tmpdir.
   * This prevents grep self-chasing by placing .output files outside ~/.qwen/.
   */
  getIsolatedTasksDir(): string {
    return computeIsolatedTaskOutputDir(
      this.getProjectIdentifier(),
      this.sessionId ?? 'default',
    );
  }

  async loadProjectTempFile<T>(filePath: string): Promise<T | null> {
    const absolutePath = path.join(this.getProjectTempDir(), filePath);
    try {
      const content = await fs.promises.readFile(absolutePath, 'utf8');

      return JSON.parse(stripBOM(content)) as T;
    } catch (e) {
      // If file doesn't exist, return null
      if (
        e instanceof Error &&
        'code' in e &&
        (e as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw e;
    }
  }

  getExtensionsDir(): string {
    return path.join(this.getConfigDir(), 'extensions');
  }

  getExtensionsConfigPath(): string {
    return path.join(this.getExtensionsDir(), 'cli-extension.json');
  }

  getHistoryFilePath(): string {
    return path.join(this.getProjectTempDir(), 'shell_history');
  }
}

/**
 * Ensures local files (AGENTS.local.md, settings.local.json) are added to
 * the global gitignore (~/.config/git/ignore) so they are never accidentally
 * committed in any repository.
 *
 * This is a defense-in-depth measure. settings.local.json inside ${CONFIG_DIR}/
 * is typically already covered by .gitignore patterns, but AGENTS.local.md at
 * the project root is not.
 */
export async function ensureLocalFilesGitignored(): Promise<void> {
  const patterns = ['AGENTS.local.md', '*.local.md'];
  const xdgConfigHome =
    process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  const globalIgnorePath = path.join(xdgConfigHome, 'git', 'ignore');

  try {
    const ignoreDir = path.dirname(globalIgnorePath);
    await fsPromises.mkdir(ignoreDir, { recursive: true });

    let existingContent = '';
    try {
      existingContent = await fsPromises.readFile(globalIgnorePath, 'utf-8');
    } catch {
      // File doesn't exist yet, that's fine
    }

    const linesToAdd = patterns.filter((p) => !existingContent.includes(p));

    if (linesToAdd.length > 0) {
      const separator =
        existingContent.endsWith('\n') || !existingContent ? '' : '\n';
      const addition = `${separator}# ${BRAND_NAME} local files (private, not committed)\n${linesToAdd.join('\n')}\n`;
      await fsPromises.appendFile(globalIgnorePath, addition);
    }
  } catch {
    // Non-fatal: if we can't write the global gitignore, just skip
  }
}
