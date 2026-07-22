/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@qwen-code/qwen-code-core';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import semver from 'semver';
import { getNpmCliPath } from './installationInfo.js';

const PACKAGE_NAME = '@qwen-code/qwen-code';
const execFileAsync = promisify(execFile);

interface ManagedNpmUpdate {
  stagingDir: string;
  versionDir: string;
  launcherRoot: string;
  baseVersion: string;
  bootstrapCtimeMs: number;
  installArgs: string[];
}

function assertVersion(version: string): void {
  if (semver.valid(version) !== version) {
    throw new Error(`Invalid update version: ${version}`);
  }
}

function packageDir(prefix: string): string {
  return path.join(prefix, 'node_modules', '@qwen-code', 'qwen-code');
}

function resolveBootstrapPath(bootstrapPath?: string): string {
  if (!bootstrapPath) {
    throw new Error('Unable to identify the Qwen Code npm launcher');
  }
  return fs.realpathSync(bootstrapPath);
}

function launcherId(bootstrapPath: string): string {
  return createHash('sha256').update(bootstrapPath).digest('hex').slice(0, 16);
}

function processDoesNotExist(pidText: string): boolean {
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function readDirectoryEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function cleanupOrphanedManagedNpmUpdateArtifacts(
  launcherRoot: string,
  versionsDir: string,
): void {
  for (const entry of readDirectoryEntries(versionsDir)) {
    const match = /^\.(.+)-([1-9]\d*)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !match ||
      semver.valid(match[1]) !== match[1] ||
      !processDoesNotExist(match[2])
    ) {
      continue;
    }
    try {
      fs.rmSync(path.join(versionsDir, entry.name), {
        recursive: true,
        force: true,
      });
    } catch {
      continue;
    }
  }

  for (const entry of readDirectoryEntries(launcherRoot)) {
    const match = /^active\.json\.([1-9]\d*)$/.exec(entry.name);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !match ||
      !processDoesNotExist(match[1])
    ) {
      continue;
    }
    try {
      fs.rmSync(path.join(launcherRoot, entry.name), { force: true });
    } catch {
      continue;
    }
  }
}

function resolveNpmGlobalConfigPath(): string {
  const configured = process.env['NPM_CONFIG_GLOBALCONFIG'];
  if (configured) return path.resolve(configured);
  const output = execFileSync(
    process.execPath,
    [
      getNpmCliPath(process.execPath, process.platform),
      'config',
      'get',
      'globalconfig',
      '--global',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  ).trim();
  if (!output || output === 'null' || output === 'undefined') {
    throw new Error('Unable to resolve the global npm configuration');
  }
  return output;
}

function readBaseInstallation(bootstrapPath: string): {
  version: string;
  ctimeMs: number;
} {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(bootstrapPath), 'package.json'),
      'utf8',
    ),
  ) as { name?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error('Unable to identify the base Qwen Code npm installation');
  }
  return {
    version: manifest.version,
    ctimeMs: fs.statSync(bootstrapPath).ctimeMs,
  };
}

async function validateInstallation(
  prefix: string,
  version: string,
): Promise<void> {
  const root = packageDir(prefix);
  const manifest = JSON.parse(
    await fsPromises.readFile(path.join(root, 'package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new Error(
      `Installed package did not match ${PACKAGE_NAME}@${version}`,
    );
  }
  await fsPromises.access(path.join(root, 'cli.js'));
}

async function smokeTest(prefix: string): Promise<void> {
  const env = { ...process.env };
  delete env['CLI_VERSION'];
  delete env['QWEN_CODE_RELAUNCH_ARGS'];
  await execFileAsync(
    process.execPath,
    [path.join(packageDir(prefix), 'cli-entry.js'), '--help'],
    { encoding: 'utf8', env, timeout: 10_000 },
  );
}

async function readActiveVersion(
  activeFile: string,
  expected: {
    bootstrap: string;
    baseVersion: string;
    bootstrapCtimeMs: number;
  },
): Promise<string | null> {
  try {
    const active = JSON.parse(
      await fsPromises.readFile(activeFile, 'utf8'),
    ) as {
      version?: unknown;
      bootstrap?: unknown;
      baseVersion?: unknown;
      bootstrapCtimeMs?: unknown;
    };
    return typeof active.version === 'string' &&
      semver.valid(active.version) !== null &&
      active.bootstrap === expected.bootstrap &&
      active.baseVersion === expected.baseVersion &&
      active.bootstrapCtimeMs === expected.bootstrapCtimeMs
      ? active.version
      : null;
  } catch {
    return null;
  }
}

export function prepareManagedNpmUpdate(
  version: string,
  bootstrapPath = process.env['QWEN_CODE_CLI'],
  updateRoot = process.env['QWEN_CODE_MANAGED_NPM_ROOT'] ??
    path.join(Storage.getGlobalQwenDir(), 'updates', 'npm'),
): ManagedNpmUpdate {
  assertVersion(version);
  const resolvedBootstrapPath = resolveBootstrapPath(bootstrapPath);
  const base = readBaseInstallation(resolvedBootstrapPath);
  const npmGlobalConfigPath = resolveNpmGlobalConfigPath();
  const launcherRoot = path.join(updateRoot, launcherId(resolvedBootstrapPath));
  const versionsDir = path.join(launcherRoot, 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  cleanupOrphanedManagedNpmUpdateArtifacts(launcherRoot, versionsDir);
  const stagingDir = fs.mkdtempSync(
    path.join(versionsDir, `.${version}-${process.pid}-`),
  );
  return {
    stagingDir,
    versionDir: path.join(versionsDir, version),
    launcherRoot,
    baseVersion: base.version,
    bootstrapCtimeMs: base.ctimeMs,
    installArgs: [
      'install',
      '--globalconfig',
      npmGlobalConfigPath,
      '--prefix',
      stagingDir,
      '--global=false',
      '--no-save',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      `${PACKAGE_NAME}@${version}`,
    ],
  };
}

export async function installManagedNpmUpdate(
  version: string,
  bootstrapPath = process.env['QWEN_CODE_CLI'],
  updateRoot = process.env['QWEN_CODE_MANAGED_NPM_ROOT'] ??
    path.join(Storage.getGlobalQwenDir(), 'updates', 'npm'),
  spawnFn: typeof spawn = spawn,
): Promise<void> {
  const update = prepareManagedNpmUpdate(version, bootstrapPath, updateRoot);
  const env = { ...process.env };
  for (const key of ['NPM_CONFIG_USERCONFIG', 'npm_config_userconfig']) {
    const configured = env[key];
    if (configured) env[key] = path.resolve(configured);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnFn(
        process.execPath,
        [
          getNpmCliPath(process.execPath, process.platform),
          ...update.installArgs,
        ],
        {
          cwd: update.stagingDir,
          env,
          stdio: ['ignore', 'ignore', 'inherit'],
          timeout: 10 * 60_000,
          windowsHide: true,
        },
      );
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install exited with code ${code}`));
      });
    });
    await activateManagedNpmUpdate(update, version, bootstrapPath);
  } catch (error) {
    await cleanupManagedNpmUpdate(update);
    throw error;
  }
}

export async function activateManagedNpmUpdate(
  update: ManagedNpmUpdate,
  version: string,
  bootstrapPath = process.env['QWEN_CODE_CLI'],
): Promise<void> {
  assertVersion(version);
  const resolvedBootstrapPath = resolveBootstrapPath(bootstrapPath);
  if (
    path.join(
      path.dirname(update.launcherRoot),
      launcherId(resolvedBootstrapPath),
    ) !== update.launcherRoot
  ) {
    throw new Error('The npm update does not match the active launcher');
  }

  await validateInstallation(update.stagingDir, version);
  await smokeTest(update.stagingDir);

  const activeFile = path.join(update.launcherRoot, 'active.json');
  const release = await lockfile.lock(activeFile, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
  });
  try {
    const base = readBaseInstallation(resolvedBootstrapPath);
    if (
      base.version !== update.baseVersion ||
      base.ctimeMs !== update.bootstrapCtimeMs
    ) {
      throw new Error(
        'The base Qwen Code npm installation changed during update',
      );
    }

    const activeVersion = await readActiveVersion(activeFile, {
      bootstrap: resolvedBootstrapPath,
      baseVersion: base.version,
      bootstrapCtimeMs: base.ctimeMs,
    });
    if (activeVersion && semver.gt(activeVersion, version)) {
      try {
        await validateInstallation(
          path.join(update.launcherRoot, 'versions', activeVersion),
          activeVersion,
        );
        await cleanupManagedNpmUpdate(update);
        return;
      } catch {
        // Replace a pointer whose payload is missing or incomplete.
      }
    }

    try {
      await fsPromises.rename(update.stagingDir, update.versionDir);
    } catch (error) {
      if (!fs.existsSync(update.versionDir)) throw error;
      await validateInstallation(update.versionDir, version);
      await cleanupManagedNpmUpdate(update);
    }

    const temporaryActivePath = `${activeFile}.${process.pid}`;
    try {
      await fsPromises.writeFile(
        temporaryActivePath,
        JSON.stringify({
          version,
          bootstrap: resolvedBootstrapPath,
          baseVersion: base.version,
          bootstrapCtimeMs: base.ctimeMs,
        }),
        { mode: 0o600 },
      );
      await fsPromises.rename(temporaryActivePath, activeFile);
    } finally {
      await fsPromises.rm(temporaryActivePath, { force: true });
    }
  } finally {
    await release();
  }
}

export async function cleanupManagedNpmUpdate(
  update: ManagedNpmUpdate,
): Promise<void> {
  await fsPromises
    .rm(update.stagingDir, { recursive: true, force: true })
    .catch(() => {});
}

// ponytail: immutable versions are retained because a live older session may
// still import them; add measured, lease-based GC only if disk use warrants it.
