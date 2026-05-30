/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger, isGitRepository } from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

export enum PackageManager {
  NPM = 'npm',
  YARN = 'yarn',
  PNPM = 'pnpm',
  PNPX = 'pnpx',
  BUN = 'bun',
  BUNX = 'bunx',
  HOMEBREW = 'homebrew',
  NPX = 'npx',
  UNKNOWN = 'unknown',
}

const debugLogger = createDebugLogger('INSTALLATION_INFO');

export interface InstallationInfo {
  packageManager: PackageManager;
  isGlobal: boolean;
  isStandalone?: boolean;
  standaloneDir?: string;
  updateCommand?: string;
  updateMessage?: string;
}

function findStandaloneDir(realPath: string): string | null {
  let dir = path.dirname(realPath);
  for (let i = 0; i < 3; i++) {
    const manifestPath = path.join(dir, 'manifest.json');
    try {
      if (fs.existsSync(manifestPath)) {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as {
          name?: string;
          target?: string;
        };
        if (manifest.name === '@qwen-code/qwen-code' && manifest.target) {
          return dir;
        }
      }
    } catch {
      // ignore parse errors
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getInstallationInfo(
  projectRoot: string,
  isAutoUpdateEnabled: boolean,
): InstallationInfo {
  const cliPath = process.argv[1];
  if (!cliPath) {
    return { packageManager: PackageManager.UNKNOWN, isGlobal: false };
  }

  try {
    // Normalize path separators to forward slashes for consistent matching.
    const realPath = fs.realpathSync(cliPath).replace(/\\/g, '/');
    const normalizedProjectRoot = projectRoot?.replace(/\\/g, '/');
    const isGit = isGitRepository(process.cwd());

    // Check for local git clone first
    if (
      isGit &&
      normalizedProjectRoot &&
      realPath.startsWith(normalizedProjectRoot) &&
      !realPath.includes('/node_modules/')
    ) {
      return {
        packageManager: PackageManager.UNKNOWN, // Not managed by a package manager in this sense
        isGlobal: false,
        updateMessage:
          'Running from a local git clone. Please update with "git pull".',
      };
    }

    // Check for npx/pnpx
    if (realPath.includes('/.npm/_npx') || realPath.includes('/npm/_npx')) {
      return {
        packageManager: PackageManager.NPX,
        isGlobal: false,
        updateMessage: 'Running via npx, update not applicable.',
      };
    }
    if (realPath.includes('/.pnpm/_pnpx')) {
      return {
        packageManager: PackageManager.PNPX,
        isGlobal: false,
        updateMessage: 'Running via pnpx, update not applicable.',
      };
    }

    // Check for Homebrew
    if (process.platform === 'darwin') {
      try {
        // We do not support homebrew for now, keep forward compatibility for future use
        childProcess.execSync('brew list -1 | grep -q "^qwen-code$"', {
          stdio: 'ignore',
        });
        return {
          packageManager: PackageManager.HOMEBREW,
          isGlobal: true,
          updateMessage:
            'Installed via Homebrew. Please update with "brew upgrade".',
        };
      } catch (_error) {
        // continue to the next check
      }
    }

    // Check for pnpm
    if (realPath.includes('/.pnpm/global')) {
      const updateCommand = 'pnpm add -g @qwen-code/qwen-code@latest';
      return {
        packageManager: PackageManager.PNPM,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with pnpm. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      };
    }

    // Check for yarn
    if (realPath.includes('/.yarn/global')) {
      const updateCommand = 'yarn global add @qwen-code/qwen-code@latest';
      return {
        packageManager: PackageManager.YARN,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with yarn. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      };
    }

    // Check for bun
    if (realPath.includes('/.bun/install/cache')) {
      return {
        packageManager: PackageManager.BUNX,
        isGlobal: false,
        updateMessage: 'Running via bunx, update not applicable.',
      };
    }
    if (realPath.includes('/.bun/bin')) {
      const updateCommand = 'bun add -g @qwen-code/qwen-code@latest';
      return {
        packageManager: PackageManager.BUN,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with bun. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      };
    }

    // Check for local install
    if (
      normalizedProjectRoot &&
      realPath.startsWith(`${normalizedProjectRoot}/node_modules`)
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

    // Check for standalone install (manifest.json with @qwen-code/qwen-code)
    const standaloneDir = findStandaloneDir(realPath);
    if (standaloneDir) {
      return {
        packageManager: PackageManager.UNKNOWN,
        isGlobal: true,
        isStandalone: true,
        standaloneDir,
        updateMessage: isAutoUpdateEnabled
          ? 'Standalone install detected. Attempting to automatically update now...'
          : 'Standalone install detected. Re-run the installer to update.',
      };
    }

    // Assume global npm — check if prefix is writable before offering npm update
    const npmPrefixDir = path.dirname(path.dirname(realPath));
    let npmPrefixWritable = false;
    try {
      fs.accessSync(npmPrefixDir, fs.constants.W_OK);
      npmPrefixWritable = true;
    } catch {
      // Not writable (e.g., /usr/local/lib/node_modules owned by root)
    }

    if (!npmPrefixWritable && isAutoUpdateEnabled) {
      // npm prefix requires sudo — fall back to standalone update path
      // which installs to ~/.local/lib/qwen-code/ (user-writable)
      const installRoot = process.env['HOME'] || os.homedir();
      if (!installRoot || installRoot === '/') {
        // Cannot determine a safe user-writable location; skip migration
        return {
          packageManager: PackageManager.NPM,
          isGlobal: true,
          updateMessage:
            'Update requires sudo. Run: sudo npm install -g @qwen-code/qwen-code@latest',
        };
      }
      const fallbackStandaloneDir = path.join(
        installRoot,
        '.local',
        'lib',
        'qwen-code',
      );
      return {
        packageManager: PackageManager.NPM,
        isGlobal: true,
        isStandalone: true,
        standaloneDir: fallbackStandaloneDir,
        updateMessage:
          'npm install requires sudo. Migrating to standalone installer for automatic updates.',
      };
    }

    const updateCommand = 'npm install -g @qwen-code/qwen-code@latest';
    return {
      packageManager: PackageManager.NPM,
      isGlobal: true,
      updateCommand,
      updateMessage: isAutoUpdateEnabled
        ? 'Installed with npm. Attempting to automatically update now...'
        : `Please run ${updateCommand} to update`,
    };
  } catch (error) {
    debugLogger.error('Failed to detect installation info:', error);
    return { packageManager: PackageManager.UNKNOWN, isGlobal: false };
  }
}
