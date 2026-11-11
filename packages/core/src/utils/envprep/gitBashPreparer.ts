/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Bash preparer — downloads and installs Portable Git for Windows.
 *
 * Steps:
 * 1. Download PortableGit.7z.exe to a temp file
 * 2. Extract to a staging directory (<installPath>.staging)
 * 3. Validate critical files in staging
 * 4. Remove any existing (possibly broken) installation
 * 5. Atomically rename staging → target
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import path from 'node:path';
import {
  BRAND_CLI_BIN,
  ENV_GIT_BASH_PATH,
  ENV_BASH_PATH,
} from '../../config/brand.js';
import { Downloader } from '../downloader.js';
import { WELL_KNOWN_BASH_PATHS } from './types.js';
import { getErrorMessage, isAbortError } from '../errors.js';
import { isWindowsShellScriptWrapper } from '../windowsExecutable.js';
import { runLogger } from '../runLogger.js';
import { runWindowsExecutableProbe } from '../windowsExecutableProbe.js';
import {
  validateGitBashFiles,
  validateGitBashInstallation,
} from './validation.js';
import { Extractor } from './extractor.js';
import { getSevenZrPath } from './sevenZrPreparer.js';
import { getWindowsEnvironmentUrls } from './urls.js';
import type { WindowsEnvironmentUrls } from './types.js';
import type { EnvironmentPreparer, PrepEnvironment } from './types.js';

/**
 * Checks whether a usable Git Bash exists at the system level, without
 * considering the managed installation under the config bin directory.
 *
 * This mirrors the Go version's hasSystemShell() — it does NOT use
 * exec.LookPath("bash.exe") to avoid picking up WSL / MSYS2 / Cygwin.
 */
async function hasSystemShell(signal?: AbortSignal): Promise<boolean> {
  // 1. User-configured env var (brand-specific)
  const envBash = process.env[ENV_GIT_BASH_PATH];
  if (envBash && existsSync(envBash) && !isWindowsShellScriptWrapper(envBash)) {
    runLogger.debug(
      `[envprep/git-bash] System shell found via ${ENV_GIT_BASH_PATH}: "${envBash}"`,
    );
    return true;
  }

  // 2. Brand-prefixed BASH_PATH
  const bashPath = process.env[ENV_BASH_PATH];
  if (
    bashPath &&
    existsSync(bashPath) &&
    !isWindowsShellScriptWrapper(bashPath)
  ) {
    runLogger.debug(
      `[envprep/git-bash] System shell found via ${ENV_BASH_PATH}: "${bashPath}"`,
    );
    return true;
  }

  // 3. Generic GIT_BASH env var (used by some CI environments)
  const gitBash = process.env['GIT_BASH'];
  if (gitBash && existsSync(gitBash) && !isWindowsShellScriptWrapper(gitBash)) {
    runLogger.debug(
      `[envprep/git-bash] System shell found via GIT_BASH: "${gitBash}"`,
    );
    return true;
  }

  // 4. Raw BASH_PATH (without brand prefix — Go also checks this)
  const rawBashPath = process.env['BASH_PATH'];
  if (
    rawBashPath &&
    existsSync(rawBashPath) &&
    !isWindowsShellScriptWrapper(rawBashPath)
  ) {
    runLogger.debug(
      `[envprep/git-bash] System shell found via BASH_PATH: "${rawBashPath}"`,
    );
    return true;
  }

  // 5. Common Git for Windows installation paths
  for (const p of WELL_KNOWN_BASH_PATHS) {
    if (existsSync(p)) {
      runLogger.debug(
        `[envprep/git-bash] System shell found at well-known path: "${p}"`,
      );
      return true;
    }
  }

  // 6. Infer from git.exe location
  try {
    const result = await runWindowsExecutableProbe('git', signal);
    const first = result.split('\r\n')[0];
    if (first) {
      const gitRoot = path.dirname(path.dirname(first));
      // Check both bin/ and usr/bin/ (some Git installations)
      for (const rel of ['bin', path.join('usr', 'bin')]) {
        if (existsSync(path.join(gitRoot, rel, 'bash.exe'))) {
          runLogger.debug(
            `[envprep/git-bash] System shell found via git.exe at: "${path.join(gitRoot, rel, 'bash.exe')}"`,
          );
          return true;
        }
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw error;
    }
    // git not found
  }

  runLogger.debug(
    '[envprep/git-bash] No system shell found, managed installation is required',
  );
  return false;
}

export class GitBashPreparer implements EnvironmentPreparer {
  private readonly env: PrepEnvironment;
  private readonly downloader: Downloader;

  constructor(
    private readonly baseDir: string,
    private readonly urls: WindowsEnvironmentUrls = getWindowsEnvironmentUrls(),
  ) {
    this.env = {
      name: 'git-bash',
      version: '2.52.0',
      description: 'Git for Windows with Bash environment',
      platform: 'windows',
      arch: 'amd64',
      installPath: path.join(baseDir, 'git'),
      binaryPath: path.join(baseDir, 'git', 'bin', 'bash.exe'),
    };
    this.downloader = new Downloader();
  }

  name(): string {
    return 'git-bash';
  }

  /**
   * Only required on Windows when no system-level Git Bash is found.
   */
  async isRequired(signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    return !(await hasSystemShell(signal));
  }

  isInstalled(): boolean {
    return validateGitBashInstallation(this.env.installPath) === null;
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const stagingDir = this.env.installPath + '.staging';
    const sevenZrPath = getSevenZrPath(this.baseDir);

    // Clean up any leftover staging directory from a previous failed attempt
    rmSync(stagingDir, { recursive: true, force: true });

    // Try primary URL, fallback to secondary
    try {
      await this.downloadAndExtract(
        this.urls.gitBashPrimaryUrl,
        stagingDir,
        sevenZrPath,
        signal,
      );
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      signal?.throwIfAborted();
      if (
        isAbortError(err) ||
        (err instanceof Error && err.name === 'TimeoutError')
      ) {
        throw err;
      }
      runLogger.warn(
        `[envprep/git-bash] Primary URL failed: ${getErrorMessage(err)}, trying fallback`,
      );

      try {
        await this.downloadAndExtract(
          this.urls.gitBashFallbackUrl,
          stagingDir,
          sevenZrPath,
          signal,
        );
      } catch (fallbackErr) {
        rmSync(stagingDir, { recursive: true, force: true });
        signal?.throwIfAborted();
        if (
          isAbortError(fallbackErr) ||
          (fallbackErr instanceof Error && fallbackErr.name === 'TimeoutError')
        ) {
          throw fallbackErr;
        }
        runLogger.warn(
          `[envprep/git-bash] Fallback URL also failed: ${getErrorMessage(fallbackErr)}`,
        );
        throw new Error(
          `Git Bash environment preparation failed. ` +
            `Please try again later or manually install Git for Windows from https://git-scm.com/download/win. ` +
            `Error: ${getErrorMessage(fallbackErr)}`,
        );
      }
    }

    // Structural validation only — confirm extraction produced the right files.
    // We intentionally do NOT run execFileSync here because Windows Defender
    // may temporarily lock freshly-extracted .exe files for AV scanning.
    const validationError = validateGitBashFiles(stagingDir);
    if (validationError) {
      runLogger.warn(
        `[envprep/git-bash] Validation failed in staging: ${validationError}`,
      );
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Git Bash extraction incomplete: ${validationError}`);
    }

    // Atomic promotion: remove old → rename staging → target
    if (existsSync(this.env.installPath)) {
      runLogger.debug(
        '[envprep/git-bash] Removing existing (possibly broken) installation',
      );
      try {
        rmSync(this.env.installPath, { recursive: true });
      } catch (removeErr) {
        // Clean up staging before propagating
        rmSync(stagingDir, { recursive: true, force: true });
        throw new Error(
          `Failed to remove existing Git Bash installation at ${this.env.installPath}: ${getErrorMessage(removeErr)}`,
        );
      }
    }

    try {
      renameSync(stagingDir, this.env.installPath);
    } catch (renameErr) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(
        `Failed to activate Git Bash installation: ${getErrorMessage(renameErr)}`,
      );
    }

    runLogger.log(
      '[envprep/git-bash] Git Bash successfully prepared (atomic install)',
    );
  }

  getEnvironment(): PrepEnvironment {
    return this.env;
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async downloadAndExtract(
    url: string,
    destDir: string,
    sevenZrPath?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    // Use a program-specific temp dir for downloads
    const tmpDir = path.join(os.tmpdir(), `${BRAND_CLI_BIN}-downloads`);
    mkdirSync(tmpDir, { recursive: true });

    const ext = getArchiveExtension(url);
    const tmpPath = path.join(
      tmpDir,
      `gitbash-download-${process.pid}-${randomUUID()}${ext}`,
    );

    try {
      runLogger.debug(`[envprep/git-bash] Downloading ${url} → ${tmpPath}`);
      await this.downloader.download(url, tmpPath, signal);
      signal?.throwIfAborted();

      const extractor = new Extractor(sevenZrPath);
      await extractor.extract(tmpPath, destDir, signal);
      signal?.throwIfAborted();
    } finally {
      // Always clean up the downloaded archive
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Extracts the archive extension from a URL/filename.
 * Handles `.7z.exe` (self-extracting 7z) as a special case.
 */
function getArchiveExtension(urlOrPath: string): string {
  const name = path.basename(urlOrPath).toLowerCase();
  if (name.endsWith('.7z.exe')) return '.7z.exe';
  const ext = path.extname(name);
  return ext || '.tmp';
}
