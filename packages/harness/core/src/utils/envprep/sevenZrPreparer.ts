/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 7zr.exe preparer — downloads the standalone 7-Zip console extractor.
 *
 * 7zr.exe (~500 KB) is a prerequisite for extracting the Portable Git
 * archive (PortableGit.7z.exe). It is downloaded first and validated
 * before the git-bash preparer runs.
 *
 * Installation uses an atomic temp→rename pattern.
 */

import { existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getWindowsEnvironmentUrls } from './urls.js';
import type { WindowsEnvironmentUrls } from './types.js';
import { Downloader } from '../downloader.js';
import { getErrorMessage } from '../errors.js';
import { runLogger } from '../runLogger.js';
import { findSystem7zPath } from './extractor.js';
import type { EnvironmentPreparer, PrepEnvironment } from './types.js';

/** Minimum expected size of 7zr.exe — below this it is likely corrupt. */
const MIN_7ZR_SIZE = 100 * 1024; // 100 KB

export class SevenZrPreparer implements EnvironmentPreparer {
  private readonly env: PrepEnvironment;
  private readonly downloader: Downloader;

  constructor(
    baseDir: string,
    private readonly urls: WindowsEnvironmentUrls = getWindowsEnvironmentUrls(),
  ) {
    this.env = {
      name: '7zr',
      version: '24.09',
      description: '7-Zip standalone console extractor',
      platform: 'windows',
      arch: 'amd64',
      installPath: baseDir,
      binaryPath: path.join(baseDir, '7zr.exe'),
    };
    this.downloader = new Downloader();
  }

  name(): string {
    return '7zr';
  }

  /**
   * Only required on Windows when no system-level 7z is available.
   * If the user has 7-Zip installed, the extractor will use it directly
   * and there is no need to download a separate 7zr.exe.
   */
  async isRequired(signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    return (await findSystem7zPath(signal)) === null;
  }

  isInstalled(): boolean {
    try {
      const stat = statSync(this.env.binaryPath);
      if (stat.size < MIN_7ZR_SIZE) return false;
    } catch {
      return false;
    }

    try {
      execFileSync(this.env.binaryPath, ['i'], {
        timeout: 5000,
        stdio: 'pipe',
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const tmpPath = this.env.binaryPath + '.tmp';

    const cleanup = () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    };

    try {
      // Try primary URL
      try {
        await this.downloader.download(
          this.urls.sevenZrPrimaryUrl,
          tmpPath,
          signal,
        );
      } catch (primaryErr) {
        signal?.throwIfAborted();
        runLogger.warn(
          `[envprep/7zr] Primary URL failed: ${getErrorMessage(primaryErr)}, trying fallback`,
        );
        cleanup();
        await this.downloader.download(
          this.urls.sevenZrFallbackUrl,
          tmpPath,
          signal,
        );
      }

      signal?.throwIfAborted();
      // Verify file size
      const info = statSync(tmpPath);
      if (info.size < MIN_7ZR_SIZE) {
        runLogger.warn(
          `[envprep/7zr] File too small: ${info.size} bytes (expected >= ${MIN_7ZR_SIZE})`,
        );
        throw new Error(
          `7zr.exe download appears truncated: ${info.size} bytes (expected >= ${MIN_7ZR_SIZE})`,
        );
      }

      // Atomic promotion: temp → final
      renameSync(tmpPath, this.env.binaryPath);
      runLogger.log('[envprep/7zr] Successfully prepared 7zr.exe');
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  getEnvironment(): PrepEnvironment {
    return this.env;
  }
}

/**
 * Returns the path to the prepared 7zr.exe under `baseDir`, or `undefined`
 * if it has not been downloaded yet.
 */
export function getSevenZrPath(baseDir: string): string | undefined {
  const p = path.join(baseDir, '7zr.exe');
  return existsSync(p) ? p : undefined;
}
