/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from './bridge/protocol.js';

const LAUNCHER_MARKER = '# qwen-browser-use native host';
const MANIFEST_FILE = CHROME_NATIVE_HOST_NAME + '.json';
const ALLOWED_ORIGIN = 'chrome-extension://' + CHROME_EXTENSION_ID + '/';

export interface NativeHostInstallOptions {
  nativeHostPath: string;
  homeDir?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}

export interface NativeHostInstallResult {
  launcherPath: string;
  manifestPaths: string[];
  skippedForeignPaths: string[];
}

export async function isChromeExtensionInstalled(
  options: NativeHostInstallOptions,
): Promise<boolean> {
  for (const manifestPath of resolveOptions(options).manifestPaths) {
    const browserRoot = dirname(dirname(manifestPath));
    let profiles: Dirent[];
    try {
      profiles = await readdir(browserRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const profile of profiles) {
      if (
        !profile.isDirectory() ||
        !/^(Default|Profile \d+)$/.test(profile.name)
      ) {
        continue;
      }
      const profilePath = join(browserRoot, profile.name);
      for (const file of ['Secure Preferences', 'Preferences']) {
        const contents = await readExistingFile(join(profilePath, file));
        if (contents === null) continue;
        let preferences: {
          extensions?: {
            settings?: Record<string, { path?: unknown }>;
          };
        } | null;
        try {
          preferences = JSON.parse(contents) as typeof preferences;
        } catch {
          continue;
        }
        const extension =
          preferences?.extensions?.settings?.[CHROME_EXTENSION_ID];
        if (extension === undefined) continue;
        if (
          typeof extension?.path === 'string' &&
          extension.path.length > 0 &&
          (await pathExists(
            join(
              resolve(profilePath, 'Extensions', extension.path),
              'manifest.json',
            ),
          ))
        ) {
          return true;
        }
        break;
      }
    }
  }
  return false;
}

export async function installChromeNativeHost(
  options: NativeHostInstallOptions,
): Promise<NativeHostInstallResult> {
  const resolved = resolveOptions(options);
  await access(resolved.nativeHostPath);
  const existingLauncher = await readExistingFile(resolved.launcherPath);
  if (existingLauncher !== null && !isOwnedLauncher(existingLauncher)) {
    throw new Error(
      'Refusing to replace a foreign Native Host launcher: ' +
        resolved.launcherPath,
    );
  }
  await mkdir(dirname(resolved.launcherPath), {
    recursive: true,
    mode: 0o700,
  });
  await atomicWrite(
    resolved.launcherPath,
    [
      '#!/bin/sh',
      LAUNCHER_MARKER,
      'exec ' +
        shellQuote(resolved.nodePath) +
        ' ' +
        shellQuote(resolved.nativeHostPath) +
        ' "$@"',
      '',
    ].join('\n'),
    0o700,
  );

  const manifest =
    JSON.stringify(
      {
        name: CHROME_NATIVE_HOST_NAME,
        description: 'Qwen Browser Use',
        path: resolved.launcherPath,
        type: 'stdio',
        allowed_origins: [ALLOWED_ORIGIN],
      },
      null,
      2,
    ) + '\n';
  const skippedForeignPaths: string[] = [];
  for (const manifestPath of resolved.manifestPaths) {
    const existing = await readExistingFile(manifestPath);
    if (
      existing === null &&
      !(await pathExists(dirname(dirname(manifestPath))))
    ) {
      continue;
    }
    if (
      existing !== null &&
      !isOwnedManifest(existing, resolved.launcherPath)
    ) {
      skippedForeignPaths.push(manifestPath);
      continue;
    }
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicWrite(manifestPath, manifest, 0o600);
  }
  return {
    launcherPath: resolved.launcherPath,
    manifestPaths: resolved.manifestPaths,
    skippedForeignPaths,
  };
}

export async function uninstallChromeNativeHost(
  options: NativeHostInstallOptions,
): Promise<NativeHostInstallResult> {
  const resolved = resolveOptions(options);
  const skippedForeignPaths: string[] = [];
  for (const manifestPath of resolved.manifestPaths) {
    const contents = await readExistingFile(manifestPath);
    if (contents === null) continue;
    if (isOwnedManifest(contents, resolved.launcherPath)) {
      await rm(manifestPath, { force: true });
    } else {
      skippedForeignPaths.push(manifestPath);
    }
  }

  const launcher = await readExistingFile(resolved.launcherPath);
  if (launcher !== null) {
    if (isOwnedLauncher(launcher)) {
      await rm(resolved.launcherPath, { force: true });
    } else {
      skippedForeignPaths.push(resolved.launcherPath);
    }
  }
  return {
    launcherPath: resolved.launcherPath,
    manifestPaths: resolved.manifestPaths,
    skippedForeignPaths,
  };
}

export async function statusChromeNativeHost(
  options: NativeHostInstallOptions,
): Promise<NativeHostInstallResult & { installedPaths: string[] }> {
  const resolved = resolveOptions(options);
  const installedPaths: string[] = [];
  const skippedForeignPaths: string[] = [];
  for (const manifestPath of resolved.manifestPaths) {
    const contents = await readExistingFile(manifestPath);
    if (contents === null) continue;
    if (isOwnedManifest(contents, resolved.launcherPath)) {
      installedPaths.push(manifestPath);
    } else {
      skippedForeignPaths.push(manifestPath);
    }
  }
  const launcher = await readExistingFile(resolved.launcherPath);
  if (launcher !== null && isOwnedLauncher(launcher)) {
    installedPaths.push(resolved.launcherPath);
  } else if (launcher !== null) {
    skippedForeignPaths.push(resolved.launcherPath);
  }
  return {
    launcherPath: resolved.launcherPath,
    manifestPaths: resolved.manifestPaths,
    installedPaths,
    skippedForeignPaths,
  };
}

export function nativeHostInstallHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(environment['QWEN_BROWSER_USE_INSTALL_HOME'] ?? homedir());
}

function resolveOptions(options: NativeHostInstallOptions): {
  nativeHostPath: string;
  nodePath: string;
  launcherPath: string;
  manifestPaths: string[];
} {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      'Automatic Native Messaging installation supports macOS and Linux',
    );
  }
  const homeDir = resolve(options.homeDir ?? nativeHostInstallHome());
  const nativeHostPath = options.nativeHostPath;
  const nodePath = options.nodePath ?? process.execPath;
  if (!isAbsolute(nativeHostPath) || !isAbsolute(nodePath)) {
    throw new Error('Native Host and Node paths must be absolute');
  }
  const manifestRoots =
    platform === 'darwin'
      ? [
          'Library/Application Support/Google/Chrome/NativeMessagingHosts',
          'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts',
          'Library/Application Support/Chromium/NativeMessagingHosts',
        ]
      : [
          '.config/google-chrome/NativeMessagingHosts',
          '.config/google-chrome-for-testing/NativeMessagingHosts',
          '.config/chromium/NativeMessagingHosts',
        ];
  return {
    nativeHostPath,
    nodePath,
    launcherPath: join(homeDir, '.qwen/browser-use/native-host.sh'),
    manifestPaths: manifestRoots.map((root) =>
      join(homeDir, root, MANIFEST_FILE),
    ),
  };
}

function isOwnedManifest(contents: string, launcherPath: string): boolean {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    return (
      value['name'] === CHROME_NATIVE_HOST_NAME &&
      value['type'] === 'stdio' &&
      value['path'] === launcherPath &&
      Array.isArray(value['allowed_origins']) &&
      value['allowed_origins'].length === 1 &&
      value['allowed_origins'][0] === ALLOWED_ORIGIN
    );
  } catch {
    return false;
  }
}

function isOwnedLauncher(contents: string): boolean {
  return contents.startsWith('#!/bin/sh\n' + LAUNCHER_MARKER + '\n');
}

async function readExistingFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(
  target: string,
  contents: string,
  mode: number,
): Promise<void> {
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
