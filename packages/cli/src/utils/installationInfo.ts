/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger, isGitRepository } from '@qwen-code/qwen-code-core';
import * as fs from 'node:fs';
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
  STANDALONE = 'standalone',
  NPX = 'npx',
  UNKNOWN = 'unknown',
}

const debugLogger = createDebugLogger('INSTALLATION_INFO');
const STANDALONE_UNIX_INSTALLER =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh';
const STANDALONE_WINDOWS_INSTALLER =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1';

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

    const standaloneInfo = getStandaloneInstallInfo(
      realPath,
      isAutoUpdateEnabled,
    );
    if (standaloneInfo) {
      return standaloneInfo;
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

    // Assume global npm
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

function getStandaloneInstallInfo(
  realPath: string,
  isAutoUpdateEnabled: boolean,
): InstallationInfo | null {
  const installDir = standaloneInstallDirForCliPath(realPath);
  if (!installDir || !isStandaloneInstallDir(installDir)) {
    return null;
  }

  const updateCommand =
    process.platform === 'win32'
      ? `powershell -ExecutionPolicy Bypass -c "irm ${STANDALONE_WINDOWS_INSTALLER} | iex"`
      : `curl -fsSL ${STANDALONE_UNIX_INSTALLER} | bash`;
  const updatePrefix = isAutoUpdateEnabled
    ? 'Standalone install detected. Automatic in-place updates are not supported yet.'
    : 'Standalone install detected.';

  return {
    packageManager: PackageManager.STANDALONE,
    isGlobal: true,
    updateMessage: `${updatePrefix} Please rerun the standalone installer to update: ${updateCommand}`,
  };
}

function standaloneInstallDirForCliPath(realPath: string): string | null {
  const normalized = realPath.replace(/\\/g, '/');
  const suffix = '/lib/cli.js';
  if (!normalized.endsWith(suffix)) {
    return null;
  }
  return realPath.slice(0, -suffix.length);
}

function isStandaloneInstallDir(installDir: string): boolean {
  try {
    const manifestPath = path.join(installDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return false;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
      target?: unknown;
    };
    // Manifest format is produced by writeManifest in create-standalone-package.js.
    if (
      manifest.name !== '@qwen-code/qwen-code' ||
      typeof manifest.target !== 'string' ||
      !isStandaloneTargetForCurrentPlatform(manifest.target)
    ) {
      return false;
    }

    const qwenBin =
      process.platform === 'win32'
        ? path.join(installDir, 'bin', 'qwen.cmd')
        : path.join(installDir, 'bin', 'qwen');
    const nodeBin =
      process.platform === 'win32'
        ? path.join(installDir, 'node', 'node.exe')
        : path.join(installDir, 'node', 'bin', 'node');

    return (
      fs.existsSync(qwenBin) &&
      fs.existsSync(nodeBin) &&
      isStandaloneRuntimeFile(qwenBin) &&
      isStandaloneRuntimeFile(nodeBin)
    );
  } catch (err) {
    debugLogger.error('Standalone detection failed:', installDir, err);
    return false;
  }
}

function isStandaloneTargetForCurrentPlatform(target: string): boolean {
  switch (process.platform) {
    case 'darwin':
      return /^darwin-(arm64|x64)$/.test(target);
    case 'linux':
      return /^linux-(arm64|x64)$/.test(target);
    case 'win32':
      return /^win-(arm64|x64)$/.test(target);
    default:
      return false;
  }
}

function isStandaloneRuntimeFile(filePath: string): boolean {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return false;
  }
  return process.platform === 'win32' || (stats.mode & 0o111) !== 0;
}
