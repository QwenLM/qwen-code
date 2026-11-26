/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { getVersion, isStandaloneBinary } from '@qwen-code/core';
import { readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compare as compareVersions } from 'semver';
import { createNativeInstallation } from '../nativeInstallationService.js';
import type { NativeEvent } from '../nativeInstallationService.js';
import { configurePATHUnix } from '../install/pathConfig.js';
import { configurePATHWindows } from '../install/pathConfigWindows.js';
import { createInstallationSource, PackageManager } from '../source.js';
import { createUpdateLock } from '../update/updateLock.js';
import {
  AUTO_UPDATE_PAUSE_DURATION_MS,
  MAX_KEPT_VERSIONS,
} from '../update/updateTypes.js';
import {
  createQwenReleasePolicy,
  latestQwenRelease,
  qwenVersion,
} from './releasePolicy.js';
import { getQwenPaths, getQwenReleaseBaseURL } from './paths.js';

export function createQwenInstallation() {
  const paths = getQwenPaths();
  const lock = createUpdateLock(paths.lockFile, ['qwen']);
  const source = createInstallationSource({
    cliBin: 'qwen',
    npmPackages: ['@qwen-code/qwen-code'],
    homebrewToken: 'qwen-code',
  });
  const assertPlatform = () => {
    if (!['darwin', 'linux', 'win32'].includes(process.platform))
      throw new Error(
        'Qwen native installation supports macOS, Linux and Windows.',
      );
  };
  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    assertPlatform();
    const handle = await lock.acquireLock();
    try {
      return await operation();
    } finally {
      await lock.releaseLock(handle);
    }
  }
  async function assertManaged() {
    const info = await source.getInstallationInfo(process.cwd(), false);
    if (info.packageManager !== PackageManager.BINARY || !isStandaloneBinary())
      throw new Error(
        `Native updates require a native installation (detected: ${info.packageManager}). Use the original package manager, or reinstall with the Qwen native installer.`,
      );
  }
  function service(
    version?: string,
    force = false,
    events?: (event: NativeEvent) => void,
  ) {
    return createNativeInstallation({
      paths,
      keepVersions: MAX_KEPT_VERSIONS,
      events,
      policy: createQwenReleasePolicy({
        baseURL: getQwenReleaseBaseURL(),
        version,
        force,
      }),
    });
  }
  async function currentVersion() {
    const running = await getVersion();
    const entry = await realpath(paths.linkPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform === 'win32' && error.code !== 'ENOENT')
          throw error;
        return '';
      },
    );
    const versionDir = await realpath(paths.binDir).catch(() => paths.binDir);
    if (process.platform === 'win32' && entry) {
      // Windows may activate by copying qwen.exe, so realpath cannot identify
      // its version. Read the managed entry instead of trusting version.txt,
      // which is not updated by offline rollback. A failed probe aborts changes.
      if (dirname(entry).toLowerCase() !== versionDir.toLowerCase())
        throw new Error(
          'The Qwen entry is outside its managed version directory.',
        );
      const { stdout } = await promisify(execFile)(entry, ['--version'], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return qwenVersion(stdout.trim());
    }
    const active = basename(entry)
      .replace(/^qwen-/, '')
      .replace(/\.exe$/, '');
    // An older running session must not undo an update by another invocation.
    if (dirname(entry) === versionDir) {
      try {
        qwenVersion(active);
        if (compareVersions(active, running) > 0) return active;
      } catch {
        // Only the known versioned layout contributes an active version.
      }
    }
    return running;
  }
  const configureEntryPath = (options?: { rebroadcast: boolean }) =>
    process.platform === 'win32'
      ? configurePATHWindows(dirname(paths.linkPath), options)
      : configurePATHUnix(dirname(paths.linkPath));
  async function check() {
    assertPlatform();
    await assertManaged();
    const current = await currentVersion();
    const manifest = await latestQwenRelease(getQwenReleaseBaseURL());
    return {
      current,
      latest: manifest.latest,
      available: compareVersions(manifest.latest, current) > 0,
    };
  }
  async function install(options: {
    version?: string;
    force?: boolean;
    skipPath?: boolean;
  }) {
    return withLock(async () => {
      // Do not overwrite an entry owned by a package manager.
      const existing = await realpath(paths.linkPath).catch(() => '');
      if (/[/\\](?:node_modules|Cellar|Caskroom)[/\\]/.test(existing))
        throw new Error(
          'The qwen entry is managed by a package manager. Remove that installation before using curl.',
        );
      const native = service(options.version, options.force);
      const result = await native.install({
        sourceMarker: 'curl-bash',
        bootstrap: async () =>
          isStandaloneBinary()
            ? { version: await getVersion(), binaryPath: process.execPath }
            : undefined,
      });
      const pathResult = options.skipPath
        ? undefined
        : await configureEntryPath();
      if (pathResult?.errorMessage)
        throw new Error(
          `Qwen is installed at ${paths.linkPath}, but PATH configuration failed: ${pathResult.errorMessage}`,
        );
      if (!result.reused) await native.cleanup(result.version);
      return { ...result, pathResult };
    });
  }
  async function update(
    options: {
      version?: string;
      automatic?: boolean;
      onUpdateAvailable?: (current: string, target: string) => void;
      onNativeEvent?: (event: NativeEvent) => void;
    } = {},
  ) {
    return withLock(async () => {
      await assertManaged();
      const current = await currentVersion();
      // Recheck after acquiring the lock: rollback may have completed while
      // this background update was waiting. Manual updates remain explicit.
      if (options.automatic && (await isPaused()))
        return { version: current, changed: false };
      const version = options.version
        ? qwenVersion(options.version)
        : (await latestQwenRelease(getQwenReleaseBaseURL())).latest;
      if (compareVersions(version, current) <= 0)
        return { version: current, changed: false };
      options.onUpdateAvailable?.(current, version);
      await service(version, false, options.onNativeEvent).update();
      await rm(paths.pauseFile, { force: true });
      return { version, changed: true };
    });
  }
  async function rollback(version?: string) {
    return withLock(async () => {
      await assertManaged();
      if (version !== undefined) {
        const current =
          process.platform === 'win32'
            ? await currentVersion()
            : await getVersion();
        if (compareVersions(qwenVersion(version), current) >= 0)
          throw new Error(
            'Rollback target must be older than the active Qwen version.',
          );
      }
      const result = await service(version).rollback(
        version === undefined ? { previous: true } : undefined,
      );
      await writeFile(
        paths.pauseFile,
        new Date(Date.now() + AUTO_UPDATE_PAUSE_DURATION_MS).toISOString() +
          '\n',
        { mode: 0o600 },
      );
      return result;
    });
  }
  async function isPaused() {
    const value = await readFile(paths.pauseFile, 'utf8').catch(() => '');
    return Date.parse(value.trim()) > Date.now();
  }
  async function configurePath() {
    assertPlatform();
    const result = await configureEntryPath({ rebroadcast: true });
    if (result.errorMessage) throw new Error(result.errorMessage);
    return result;
  }
  return { install, check, update, rollback, isPaused, configurePath };
}
