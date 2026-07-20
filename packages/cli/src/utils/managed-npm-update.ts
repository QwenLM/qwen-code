/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Storage } from '@qwen-code/qwen-code-core';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import semver from 'semver';

const PACKAGE_NAME = '@qwen-code/qwen-code';
const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const ABANDONED_STAGING_MS = 60 * 60 * 1000;
const MAX_LOCK_AGE_MS = 5 * 60 * 1000;
const MAX_STAGING_AGE_MS = 24 * 60 * 60 * 1000;
const STAGING_OWNER_FILE = '.qwen-update-owner';
const execFileAsync = promisify(execFile);

export const MANAGED_NPM_UPDATE_ENV_VAR = 'QWEN_CODE_MANAGED_NPM_UPDATE';

export interface ManagedNpmUpdate {
  stagingDir: string;
  versionDir: string;
  launcherRoot: string;
  baseVersion: string;
  bootstrapFingerprint: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;
  installArgs: string[];
}

interface ActiveInstallation {
  version?: unknown;
  bootstrap?: unknown;
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
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
  await Promise.all([
    fsPromises.access(path.join(root, 'dist', 'cli.js')),
    fsPromises.access(path.join(root, 'scripts', 'cli-entry.js')),
  ]);
}

async function smokeTest(prefix: string, version: string): Promise<void> {
  const launcher = path.join(packageDir(prefix), 'scripts', 'cli-entry.js');
  const env = { ...process.env };
  delete env['CLI_VERSION'];
  delete env['QWEN_CODE_RELAUNCH_ARGS'];
  const { stdout } = await execFileAsync(
    process.execPath,
    [launcher, '--version'],
    {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    },
  );
  const output = stdout.trim();
  if (output !== version) {
    throw new Error(
      `Installed package reported version ${output || 'unknown'}`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function releaseActivationLock(
  lockPath: string,
  token: string,
): Promise<void> {
  try {
    const owner = JSON.parse(
      await fsPromises.readFile(path.join(lockPath, 'owner.json'), 'utf8'),
    ) as { token?: unknown };
    if (owner.token !== token) return;
    const releasedPath = `${lockPath}.release-${token}`;
    await fsPromises.rename(lockPath, releasedPath);
    await fsPromises.rm(releasedPath, { recursive: true, force: true });
  } catch {
    // A missing or replaced lock is no longer ours to release.
  }
}

async function acquireActivationLock(lockPath: string): Promise<string> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const token = randomUUID();
    try {
      await fsPromises.mkdir(lockPath);
      try {
        await fsPromises.writeFile(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, token }),
        );
      } catch (error) {
        await fsPromises.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let lockStats: fs.Stats;
      try {
        lockStats = await fsPromises.stat(lockPath);
      } catch {
        continue;
      }
      let owner = Number.NaN;
      let ownerToken: string | undefined;
      try {
        const metadata = JSON.parse(
          await fsPromises.readFile(path.join(lockPath, 'owner.json'), 'utf8'),
        ) as { pid?: unknown; token?: unknown };
        owner = typeof metadata.pid === 'number' ? metadata.pid : Number.NaN;
        ownerToken =
          typeof metadata.token === 'string' ? metadata.token : undefined;
      } catch {
        // The lock owner may still be creating its metadata.
      }
      const hasOwner = Number.isInteger(owner) && owner > 0;
      const lockAge = Date.now() - lockStats.mtimeMs;
      if (
        (!hasOwner && lockAge >= STALE_LOCK_MS) ||
        (hasOwner && !processIsAlive(owner)) ||
        lockAge >= MAX_LOCK_AGE_MS
      ) {
        const staleIdentity =
          ownerToken ??
          `${lockStats.dev}-${lockStats.ino}-${lockStats.mtimeMs}`;
        const staleId = createHash('sha256')
          .update(staleIdentity)
          .digest('hex')
          .slice(0, 16);
        const stalePath = `${lockPath}.stale-${staleId}`;
        try {
          await fsPromises.rename(lockPath, stalePath);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
            (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' &&
            !(
              ((error as NodeJS.ErrnoException).code === 'EPERM' ||
                (error as NodeJS.ErrnoException).code === 'EACCES') &&
              fs.existsSync(stalePath)
            )
          ) {
            throw error;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting to activate the npm update');
      }
      await delay(25);
    }
  }
}

async function quarantineAbandonedWork(
  launcherRoot: string,
): Promise<string[]> {
  const trash: string[] = [];
  try {
    const entries = await fsPromises.readdir(launcherRoot, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.trash-')) {
        trash.push(path.join(launcherRoot, entry.name));
      } else if (
        entry.isDirectory() &&
        entry.name.startsWith('activation.lock.release-')
      ) {
        const candidate = path.join(launcherRoot, entry.name);
        try {
          const age = Date.now() - (await fsPromises.stat(candidate)).mtimeMs;
          if (age >= STALE_LOCK_MS * 2) trash.push(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const versionsDir = path.join(launcherRoot, 'versions');
  let versions: fs.Dirent[];
  try {
    versions = await fsPromises.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return trash;
    throw error;
  }
  for (const entry of versions) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
    const stagingDir = path.join(versionsDir, entry.name);
    let stagingAge: number;
    try {
      stagingAge = Date.now() - (await fsPromises.stat(stagingDir)).mtimeMs;
      if (stagingAge < ABANDONED_STAGING_MS) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let owner = Number.NaN;
    try {
      owner = Number.parseInt(
        await fsPromises.readFile(
          path.join(stagingDir, STAGING_OWNER_FILE),
          'utf8',
        ),
        10,
      );
    } catch {
      // The age grace is sufficient when owner metadata is missing.
    }
    if (
      stagingAge < MAX_STAGING_AGE_MS &&
      Number.isInteger(owner) &&
      owner > 0 &&
      processIsAlive(owner)
    ) {
      continue;
    }
    const trashDir = path.join(
      launcherRoot,
      `.trash-staging-${process.pid}-${randomUUID()}`,
    );
    try {
      await fsPromises.rename(stagingDir, trashDir);
      trash.push(trashDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return trash;
}

async function hasLiveLease(versionDir: string): Promise<boolean> {
  const leasesDir = path.join(versionDir, '.leases');
  let leases: string[];
  try {
    leases = await fsPromises.readdir(leasesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let live = false;
  for (const lease of leases) {
    const pid = Number.parseInt(lease, 10);
    if (Number.isInteger(pid) && pid > 0 && processIsAlive(pid)) {
      live = true;
    } else {
      await fsPromises.rm(path.join(leasesDir, lease), { force: true });
    }
  }
  return live;
}

async function quarantineUnusedVersions(
  launcherRoot: string,
  activeVersion: string,
): Promise<string[]> {
  const versionsDir = path.join(launcherRoot, 'versions');
  const trash: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(versionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return trash;
    throw error;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      entry.name === activeVersion
    ) {
      continue;
    }
    const versionDir = path.join(versionsDir, entry.name);
    if (await hasLiveLease(versionDir)) continue;
    const trashDir = path.join(
      launcherRoot,
      `.trash-${entry.name}-${process.pid}-${Date.now()}`,
    );
    await fsPromises.rename(versionDir, trashDir);
    trash.push(trashDir);
  }
  return trash;
}

function readBaseInstallation(bootstrapPath: string): {
  version: string;
  fingerprint: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;
} {
  const packageJsonPath = path.join(
    path.dirname(path.dirname(bootstrapPath)),
    'package.json',
  );
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error('Unable to identify the base Qwen Code npm installation');
  }
  const { dev, ino, size, mtimeMs } = fs.statSync(bootstrapPath);
  return {
    version: manifest.version,
    fingerprint: { dev, ino, size, mtimeMs },
  };
}

export function prepareManagedNpmUpdate(
  version: string,
  bootstrapPath = process.env['QWEN_CODE_CLI'],
  updateRoot = path.join(Storage.getGlobalQwenDir(), 'updates', 'npm'),
): ManagedNpmUpdate {
  assertVersion(version);
  const resolvedBootstrapPath = resolveBootstrapPath(bootstrapPath);
  const base = readBaseInstallation(resolvedBootstrapPath);
  const launcherRoot = path.join(updateRoot, launcherId(resolvedBootstrapPath));
  const versionsDir = path.join(launcherRoot, 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(
    path.join(versionsDir, `.${version}-${process.pid}-`),
  );
  fs.writeFileSync(
    path.join(stagingDir, STAGING_OWNER_FILE),
    String(process.pid),
    { mode: 0o600 },
  );
  return {
    stagingDir,
    versionDir: path.join(versionsDir, version),
    launcherRoot,
    baseVersion: base.version,
    bootstrapFingerprint: base.fingerprint,
    installArgs: [
      'install',
      '--prefix',
      stagingDir,
      '--no-save',
      '--package-lock=false',
      `${PACKAGE_NAME}@${version}`,
    ],
  };
}

export async function activateManagedNpmUpdate(
  update: ManagedNpmUpdate,
  version: string,
  bootstrapPath = process.env['QWEN_CODE_CLI'],
): Promise<void> {
  assertVersion(version);
  const resolvedBootstrapPath = resolveBootstrapPath(bootstrapPath);
  const expectedLauncherRoot = path.join(
    path.dirname(update.launcherRoot),
    launcherId(resolvedBootstrapPath),
  );
  if (expectedLauncherRoot !== update.launcherRoot) {
    throw new Error('The npm update does not match the active launcher');
  }

  await validateInstallation(update.stagingDir, version);
  await smokeTest(update.stagingDir, version);
  const activeFile = path.join(update.launcherRoot, 'active.json');
  const lockPath = path.join(update.launcherRoot, 'activation.lock');
  const abandoned = await quarantineAbandonedWork(update.launcherRoot);
  await Promise.allSettled(
    abandoned.map((trashDir) =>
      fsPromises.rm(trashDir, { recursive: true, force: true }),
    ),
  );
  const trash: string[] = [];
  const lockToken = await acquireActivationLock(lockPath);
  try {
    const base = readBaseInstallation(resolvedBootstrapPath);
    if (
      base.version !== update.baseVersion ||
      base.fingerprint.dev !== update.bootstrapFingerprint.dev ||
      base.fingerprint.ino !== update.bootstrapFingerprint.ino ||
      base.fingerprint.size !== update.bootstrapFingerprint.size ||
      base.fingerprint.mtimeMs !== update.bootstrapFingerprint.mtimeMs
    ) {
      throw new Error(
        'The base Qwen Code npm installation changed during update',
      );
    }
    let active: ActiveInstallation | undefined;
    try {
      active = JSON.parse(await fsPromises.readFile(activeFile, 'utf8')) as {
        version?: unknown;
        bootstrap?: unknown;
      };
    } catch {
      active = undefined;
    }
    if (
      active?.bootstrap === resolvedBootstrapPath &&
      typeof active.version === 'string' &&
      semver.valid(active.version) !== null &&
      semver.gt(active.version, version)
    ) {
      await validateInstallation(
        path.join(update.launcherRoot, 'versions', active.version),
        active.version,
      );
      trash.push(
        ...(await quarantineUnusedVersions(
          update.launcherRoot,
          active.version,
        )),
      );
      trash.push(update.stagingDir);
      return;
    }

    try {
      await fsPromises.rename(update.stagingDir, update.versionDir);
      await fsPromises.rm(path.join(update.versionDir, STAGING_OWNER_FILE), {
        force: true,
      });
    } catch (error) {
      if (!fs.existsSync(update.versionDir)) throw error;
      await validateInstallation(update.versionDir, version);
      trash.push(update.stagingDir);
    }

    const temporaryActivePath = `${activeFile}.${process.pid}.${Date.now()}`;
    try {
      await fsPromises.writeFile(
        temporaryActivePath,
        JSON.stringify({
          version,
          bootstrap: resolvedBootstrapPath,
          baseVersion: base.version,
          bootstrapFingerprint: base.fingerprint,
        }),
        { mode: 0o600 },
      );
      await fsPromises.rename(temporaryActivePath, activeFile);
    } finally {
      await fsPromises.rm(temporaryActivePath, { force: true });
    }
    trash.push(
      ...(await quarantineUnusedVersions(update.launcherRoot, version)),
    );
  } finally {
    await releaseActivationLock(lockPath, lockToken);
    await Promise.allSettled(
      trash.map((trashDir) =>
        fsPromises.rm(trashDir, { recursive: true, force: true }),
      ),
    );
  }
}

export async function cleanupManagedNpmUpdate(
  update: ManagedNpmUpdate,
): Promise<void> {
  try {
    await fsPromises.rm(update.stagingDir, { recursive: true, force: true });
  } catch {
    // A later update retries abandoned staging cleanup.
  }
}
