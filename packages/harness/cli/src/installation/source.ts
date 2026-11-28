/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  runLogger,
  resolveGitRepositoryLayout,
  isStandaloneBinary,
  BRAND_CLI_BIN,
  BRAND_NPM_PACKAGES,
  BRAND_HOMEBREW_TOKEN,
} from '@qwen-code/core';
import * as fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import process from 'node:process';

export const isDevelopment = process.env['NODE_ENV'] === 'development';

export interface InstallationIdentity {
  readonly cliBin: string;
  readonly npmPackages: readonly string[];
  readonly homebrewToken: string;
}

export function getInstallationIdentity(): InstallationIdentity {
  return {
    cliBin: BRAND_CLI_BIN,
    npmPackages: BRAND_NPM_PACKAGES,
    homebrewToken: BRAND_HOMEBREW_TOKEN,
  };
}

export function readInstallSourceMarker(): string {
  return createInstallationSource(
    getInstallationIdentity(),
  ).readInstallSourceMarker();
}

export function getInstallationInfo(
  projectRoot: string,
  _autoUpdate = false,
): Promise<InstallationInfo> {
  return createInstallationSource(
    getInstallationIdentity(),
  ).getInstallationInfo(projectRoot, _autoUpdate);
}

/** One reader may be shared by a product invocation; no global plugin/service instance. */
export enum PackageManager {
  NPM = 'npm',
  YARN = 'yarn',
  PNPM = 'pnpm',
  PNPX = 'pnpx',
  BUN = 'bun',
  BUNX = 'bunx',
  HOMEBREW = 'homebrew',
  NPX = 'npx',
  BINARY = 'binary',
  UNKNOWN = 'unknown',
}

export interface InstallationInfo {
  packageManager: PackageManager;
  isGlobal: boolean;
  updateCommand?: string;
  updateMessage?: string;
}

export function createInstallationSource(identity: InstallationIdentity) {
  const BRAND_CLI_BIN = identity.cliBin;

  /**
   * Read the `.qwen-install-resource` marker file near the running binary/script.
   * Returns the trimmed content (e.g. "curl-bash", "homebrew-cask", "npm") or empty string.
   *
   * Each installer writes this marker during installation so the CLI can determine
   * how it was installed and route updates accordingly.
   *
   * Search order:
   *   1. Next to the executable (standalone binary: curl-bash, homebrew-cask)
   *   2. Package root relative to the entry script (npm postinstall writes here)
   */
  function readInstallSourceMarker(): string {
    try {
      // 1. Standalone binary: marker next to the executable
      const execPath = process.execPath;
      const execDir = path.dirname(fs.realpathSync(execPath));
      const execMarker = path.join(execDir, `.${BRAND_CLI_BIN}-install-resource`);
      try {
        const content = fs.readFileSync(execMarker, 'utf-8').trim();
        if (content) return content;
      } catch {
        // Not found next to executable, try script-relative path
      }

      // 2. npm install: marker at package root (two levels up from bundle/qwen.js)
      const cliPath = process.argv[1];
      if (cliPath) {
        const scriptDir = path.dirname(fs.realpathSync(cliPath));
        const pkgRoot = path.dirname(scriptDir); // bundle/ -> package root
        const scriptMarker = path.join(
          pkgRoot,
          `.${BRAND_CLI_BIN}-install-resource`,
        );
        try {
          const content = fs.readFileSync(scriptMarker, 'utf-8').trim();
          if (content) return content;
        } catch {
          // Not found
        }
      }

      return '';
    } catch {
      return '';
    }
  }

  const cachedInfoPromises = new Map<string, Promise<InstallationInfo>>();

  /** @internal Reset cached result (for testing only). */
  function _resetInstallationInfoCache(): void {
    cachedInfoPromises.clear();
  }

  async function getInstallationInfo(
    projectRoot: string,
    _isAutoUpdateEnabled: boolean,
  ): Promise<InstallationInfo> {
    const cacheKey = [
      process.argv[1] ?? '',
      projectRoot ?? '',
      process.cwd(),
      String(_isAutoUpdateEnabled),
    ].join('\0');
    const cachedInfoPromise = cachedInfoPromises.get(cacheKey);
    if (cachedInfoPromise) return cachedInfoPromise;

    const infoPromise = getInstallationInfoUncached(
      projectRoot,
      _isAutoUpdateEnabled,
    );
    cachedInfoPromises.set(cacheKey, infoPromise);
    infoPromise.catch(() => {
      cachedInfoPromises.delete(cacheKey);
    });
    return infoPromise;
  }

  async function getInstallationInfoUncached(
    projectRoot: string,
    _isAutoUpdateEnabled: boolean,
  ): Promise<InstallationInfo> {
    const cliPath = process.argv[1];
    if (!cliPath) {
      return { packageManager: PackageManager.UNKNOWN, isGlobal: false };
    }

    try {
      const installSource = readInstallSourceMarker();
      const markerInfo = await installationInfoFromMarker(
        installSource,
        _isAutoUpdateEnabled,
      );
      if (markerInfo) {
        return markerInfo;
      }

      // Check for standalone binary first (Bun-compiled or Node SEA).
      if (isStandaloneBinary()) {
        // Unknown install source — cannot route updates without a marker.
        // Manual `qwen update` will prompt the user to reinstall via curl.
        return {
          packageManager: PackageManager.UNKNOWN,
          isGlobal: true,
          updateMessage: 'Unable to determine installation method.',
        };
      }

      // Normalize path separators to forward slashes for consistent matching.
      const cliRealPath = (await realpath(cliPath)).replace(/\\/g, '/');
      const normalizedProjectRoot = projectRoot?.replace(/\\/g, '/');
      const isGit = Boolean(await resolveGitRepositoryLayout(process.cwd()));

      // Check for local git clone first
      if (
        isGit &&
        normalizedProjectRoot &&
        cliRealPath.startsWith(normalizedProjectRoot) &&
        !cliRealPath.includes('/node_modules/')
      ) {
        return {
          packageManager: PackageManager.UNKNOWN, // Not managed by a package manager in this sense
          isGlobal: false,
          updateMessage:
            'Running from a local git clone. Please update with "git pull".',
        };
      }

      // Check for npx/pnpx
      if (
        cliRealPath.includes('/.npm/_npx') ||
        cliRealPath.includes('/npm/_npx')
      ) {
        return {
          packageManager: PackageManager.NPX,
          isGlobal: false,
          updateMessage: 'Running via npx, update not applicable.',
        };
      }
      if (
        cliRealPath.includes('/.pnpm/_pnpx') ||
        cliRealPath.includes('/.cache/pnpm/dlx')
      ) {
        return {
          packageManager: PackageManager.PNPX,
          isGlobal: false,
          updateMessage: 'Running via pnpx, update not applicable.',
        };
      }

      // Check for pnpm
      if (
        cliRealPath.includes('/.pnpm/global') ||
        cliRealPath.includes('/.local/share/pnpm')
      ) {
        return {
          packageManager: PackageManager.PNPM,
          isGlobal: true,
        };
      }

      // Check for yarn
      if (cliRealPath.includes('/.yarn/global')) {
        return {
          packageManager: PackageManager.YARN,
          isGlobal: true,
        };
      }

      // Check for bun
      if (cliRealPath.includes('/.bun/install/cache')) {
        return {
          packageManager: PackageManager.BUNX,
          isGlobal: false,
          updateMessage: 'Running via bunx, update not applicable.',
        };
      }
      if (cliRealPath.includes('/.bun/install/global')) {
        return {
          packageManager: PackageManager.BUN,
          isGlobal: true,
        };
      }

      if (isGlobalNpmPath(cliRealPath)) {
        return npmInstallationInfo(_isAutoUpdateEnabled);
      }

      // Check for local install
      if (
        normalizedProjectRoot &&
        cliRealPath.startsWith(`${normalizedProjectRoot}/node_modules`)
      ) {
        let pm = PackageManager.NPM;
        if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
          pm = PackageManager.YARN;
        } else if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
          pm = PackageManager.PNPM;
        } else if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
          pm = PackageManager.BUN;
        }
        return {
          packageManager: pm,
          isGlobal: false,
          updateMessage:
            "Locally installed. Please update via your project's package.json.",
        };
      }

      // Check for Homebrew only after cheap package-manager signals failed.
      if (isLikelyHomebrewPath(cliRealPath)) {
        const homebrewInfo = await detectHomebrewInstallation(
          cliRealPath,
          _isAutoUpdateEnabled,
        );
        if (homebrewInfo) {
          return homebrewInfo;
        }
      }

      // Assume global npm
      return npmInstallationInfo(_isAutoUpdateEnabled);
    } catch (error) {
      runLogger.log(error);
      return { packageManager: PackageManager.UNKNOWN, isGlobal: false };
    }
  }

  async function installationInfoFromMarker(
    installSource: string,
    _isAutoUpdateEnabled: boolean,
  ): Promise<InstallationInfo | null> {
    if (installSource === 'curl-bash') {
      return {
        packageManager: PackageManager.BINARY,
        isGlobal: true,
      };
    }

    if (installSource === 'homebrew-cask') {
      return homebrewInstallationInfo(_isAutoUpdateEnabled);
    }

    // npm-installed standalone binary: the postinstall script downloads a
    // compiled binary and writes "npm" into .qwen-install-resource.
    // Route updates through npm just like a regular global npm install.
    if (installSource === 'npm') {
      return npmInstallationInfo(_isAutoUpdateEnabled);
    }

    return null;
  }

  function npmInstallationInfo(
    _isAutoUpdateEnabled: boolean,
  ): InstallationInfo {
    return {
      packageManager: PackageManager.NPM,
      isGlobal: true,
    };
  }

  async function homebrewInstallationInfo(
    _isAutoUpdateEnabled: boolean,
  ): Promise<InstallationInfo> {
    return {
      packageManager: PackageManager.HOMEBREW,
      isGlobal: true,
    };
  }

  function isGlobalNpmPath(cliRealPath: string): boolean {
    return identity.npmPackages.some((name) =>
      cliRealPath.includes(`/node_modules/${name}/`),
    );
  }

  function isLikelyHomebrewPath(cliRealPath: string): boolean {
    const escapedBin = identity.homebrewToken.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    return new RegExp(`/(Cellar|Caskroom)/${escapedBin}(/|$)`).test(
      cliRealPath,
    );
  }

  async function detectHomebrewInstallation(
    cliRealPath: string,
    _isAutoUpdateEnabled: boolean,
  ): Promise<InstallationInfo | null> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return null;
    }

    try {
      const brewPrefix = await new Promise<string>((resolve, reject) => {
        childProcess.execFile(
          'brew',
          ['--prefix', identity.homebrewToken],
          { timeout: 3000 },
          (err, out) => (err ? reject(err) : resolve(out.trim())),
        );
      });
      const brewRealPath = (await realpath(brewPrefix)).replace(/\\/g, '/');

      if (cliRealPath.startsWith(brewRealPath)) {
        return await homebrewInstallationInfo(_isAutoUpdateEnabled);
      }
    } catch {
      // Brew is not installed, this package is not installed via brew, or the
      // Homebrew prefix could not be resolved. Continue to the fallback channel.
    }

    return null;
  }

  return {
    readInstallSourceMarker,
    getInstallationInfo,
    resetCache: _resetInstallationInfoCache,
  };
}
