/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_IDS,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_HOST_REVISION,
} from './bridge/protocol.js';
import type { ChromeProfileDescriber } from './bridge/discovery.js';

const LAUNCHER_MARKER = '# qwen-browser-use native host';
const INSTALLATION_MARKER = '# installation ';
const MANIFEST_FILE = CHROME_NATIVE_HOST_NAME + '.json';
const ALLOWED_ORIGINS = CHROME_EXTENSION_IDS.map(
  (id) => 'chrome-extension://' + id + '/',
);

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

export interface NativeHostStatus extends NativeHostInstallResult {
  installedPaths: string[];
  protocolVersion: number | null;
  hostRevision: number | null;
  nativeHostPath: string | null;
  ready: boolean;
}

interface InstalledHost {
  protocolVersion: number;
  revision: number;
  nativeHostPath: string;
  nodePath: string;
}

export async function installChromeNativeHost(
  options: NativeHostInstallOptions,
): Promise<NativeHostStatus> {
  const resolved = resolveOptions(options);
  const hostContents = await readFile(resolved.nativeHostPath, 'utf8');
  await access(resolved.nodePath, constants.X_OK);
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
  const installedHostPath = join(
    dirname(resolved.launcherPath),
    'hosts',
    createHash('sha256').update(hostContents).digest('hex'),
    'native-host.mjs',
  );
  await mkdir(dirname(installedHostPath), { recursive: true, mode: 0o700 });
  const existingHost = await readExistingFile(installedHostPath);
  if (existingHost !== null && existingHost !== hostContents) {
    throw new Error(
      'Installed Native Host content has changed: ' + installedHostPath,
    );
  }
  await atomicWrite(installedHostPath, hostContents, 0o600, existingHost);
  const installation: InstalledHost = {
    protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
    revision: CHROME_NATIVE_HOST_REVISION,
    nativeHostPath: installedHostPath,
    nodePath: resolved.nodePath,
  };
  await atomicWrite(
    resolved.launcherPath,
    [
      '#!/bin/sh',
      LAUNCHER_MARKER,
      INSTALLATION_MARKER + JSON.stringify(installation),
      'exec ' +
        shellQuote(resolved.nodePath) +
        ' ' +
        shellQuote(installedHostPath) +
        ' "$@"',
      '',
    ].join('\n'),
    0o700,
    existingLauncher,
  );

  await writeManifests(resolved);
  return await statusChromeNativeHost(options);
}

export class NativeHostNewerError extends Error {
  constructor(readonly installedProtocolVersion: number) {
    super(
      'The installed Browser Use Native Host speaks protocol ' +
        installedProtocolVersion +
        ', newer than this Qwen Code (protocol ' +
        CHROME_BRIDGE_PROTOCOL_VERSION +
        '). Update Qwen Code; the installed Host was left unchanged.',
    );
    this.name = 'NativeHostNewerError';
  }
}

/**
 * First-use setup. A usable Host of the same protocol and at least this
 * revision is reused rather than repointed at this CLI's copy, so CLIs from
 * different checkouts do not take turns replacing it. Never downgrades.
 */
export async function ensureChromeNativeHost(
  options: NativeHostInstallOptions,
): Promise<NativeHostStatus & { action: 'installed' | 'reused' }> {
  const status = await statusChromeNativeHost(options);
  if (
    status.protocolVersion !== null &&
    status.protocolVersion > CHROME_BRIDGE_PROTOCOL_VERSION
  )
    throw new NativeHostNewerError(status.protocolVersion);
  if (
    !status.ready ||
    status.protocolVersion !== CHROME_BRIDGE_PROTOCOL_VERSION ||
    (status.hostRevision ?? 0) < CHROME_NATIVE_HOST_REVISION
  ) {
    return { ...(await installChromeNativeHost(options)), action: 'installed' };
  }
  await writeManifests(resolveOptions(options));
  return { ...(await statusChromeNativeHost(options)), action: 'reused' };
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
      // The launcher is the only reference to the installed Host copies, so
      // they are unreachable once it is gone. A running Host keeps working:
      // its script is already loaded.
      await rm(join(dirname(resolved.launcherPath), 'hosts'), {
        recursive: true,
        force: true,
      });
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
): Promise<NativeHostStatus> {
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
  const installation = readInstallation(launcher);
  return {
    launcherPath: resolved.launcherPath,
    manifestPaths: resolved.manifestPaths,
    installedPaths,
    skippedForeignPaths,
    protocolVersion: installation?.protocolVersion ?? null,
    hostRevision: installation?.revision ?? null,
    nativeHostPath: installation?.nativeHostPath ?? null,
    ready:
      installation !== null &&
      installedPaths.length > 1 &&
      (await pathExists(installation.nativeHostPath, constants.R_OK)) &&
      (await pathExists(resolved.launcherPath, constants.X_OK)) &&
      (await pathExists(installation.nodePath, constants.X_OK)),
  };
}

function readInstallation(launcher: string | null): InstalledHost | null {
  if (launcher === null || !isOwnedLauncher(launcher)) return null;
  const line = launcher.split('\n')[2];
  if (!line?.startsWith(INSTALLATION_MARKER)) return null;
  try {
    const value = JSON.parse(
      line.slice(INSTALLATION_MARKER.length),
    ) as Partial<InstalledHost>;
    if (
      Number.isInteger(value.protocolVersion) &&
      Number.isInteger(value.revision) &&
      typeof value.nativeHostPath === 'string' &&
      isAbsolute(value.nativeHostPath) &&
      typeof value.nodePath === 'string' &&
      isAbsolute(value.nodePath)
    )
      return value as InstalledHost;
  } catch {
    // Legacy launchers are upgraded by the explicit installer.
  }
  return null;
}

// Bytes scanned per extension storage file; the instance id is written once.
const MAX_STORAGE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Maps extension instance ids to Chrome profiles. The extension keeps its id
 * in `chrome.storage.local`, which Chrome stores per profile under
 * `Local Extension Settings/<extension id>`; LevelDB writes the short string
 * verbatim. Unmatched ids are omitted, so callers keep their fallback.
 */
export async function describeChromeProfiles(
  options: Pick<NativeHostInstallOptions, 'homeDir' | 'platform'>,
  instanceIds: readonly string[],
): ReturnType<ChromeProfileDescriber> {
  const described: Awaited<ReturnType<ChromeProfileDescriber>> = new Map();
  if (instanceIds.length === 0) return described;
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return described;
  const { manifestPaths } = resolveOptions({
    ...options,
    nativeHostPath: '/unused',
    nodePath: '/unused',
  });
  for (const manifestPath of manifestPaths) {
    const browserRoot = dirname(dirname(manifestPath));
    const localState = await readExistingFile(join(browserRoot, 'Local State'))
      .then((contents) =>
        contents === null
          ? null
          : (JSON.parse(contents) as {
              profile?: {
                last_used?: unknown;
                info_cache?: Record<string, { name?: unknown }>;
              };
            }),
      )
      .catch(() => null);
    if (localState === null) continue;
    const browser = browserLabel(browserRoot);
    const infoCache = localState.profile?.info_cache ?? {};
    for (const profileDirectory of Object.keys(infoCache)) {
      if (!/^(Default|Profile \d+)$/.test(profileDirectory)) continue;
      // A store install and a build loaded from source store under their own
      // extension id, so both directories are searched.
      const storages = CHROME_EXTENSION_IDS.map((id) =>
        join(browserRoot, profileDirectory, 'Local Extension Settings', id),
      );
      const files: string[] = [];
      for (const storage of storages) {
        for (const file of await readdir(storage).catch(() => [] as string[]))
          files.push(join(storage, file));
      }
      for (const path of files) {
        if (!/\.(log|ldb)$/.test(path)) continue;
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_STORAGE_FILE_BYTES) continue;
        const bytes = await readFile(path).catch(() => undefined);
        if (bytes === undefined) continue;
        for (const id of instanceIds) {
          if (described.has(id) || !bytes.includes(id)) continue;
          const name = infoCache[profileDirectory]?.name;
          const profileName =
            typeof name === 'string' && name.trim() !== ''
              ? name.trim()
              : profileDirectory;
          described.set(id, {
            name: browser + ' · ' + profileName,
            lastUsed: localState.profile?.last_used === profileDirectory,
          });
        }
      }
    }
  }
  return described;
}

function browserLabel(browserRoot: string): string {
  if (/Chrome for Testing|google-chrome-for-testing/.test(browserRoot))
    return 'Chrome for Testing';
  if (/chromium/i.test(browserRoot)) return 'Chromium';
  return 'Chrome';
}

export function nativeHostInstallHome(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment['QWEN_BROWSER_USE_INSTALL_HOME']?.trim();
  return resolve(configured ? configured : homedir());
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
    // Not `native-host.sh`: protocol 2 installers own and rewrite that path.
    launcherPath: join(homeDir, '.qwen/browser-use/host.sh'),
    manifestPaths: manifestRoots.map((root) =>
      join(homeDir, root, MANIFEST_FILE),
    ),
  };
}

async function writeManifests(
  resolved: ReturnType<typeof resolveOptions>,
): Promise<void> {
  const manifest =
    JSON.stringify(
      {
        name: CHROME_NATIVE_HOST_NAME,
        description: 'Qwen Browser Use',
        path: resolved.launcherPath,
        type: 'stdio',
        allowed_origins: ALLOWED_ORIGINS,
      },
      null,
      2,
    ) + '\n';
  for (const manifestPath of resolved.manifestPaths) {
    const existing = await readExistingFile(manifestPath);
    if (
      existing === null
        ? !(await pathExists(dirname(dirname(manifestPath))))
        : !isOwnedManifest(existing, resolved.launcherPath)
    )
      continue;
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicWrite(manifestPath, manifest, 0o600, existing);
  }
}

function isOwnedManifest(contents: string, launcherPath: string): boolean {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    return (
      value['name'] === CHROME_NATIVE_HOST_NAME &&
      value['type'] === 'stdio' &&
      value['path'] === launcherPath &&
      Array.isArray(value['allowed_origins']) &&
      value['allowed_origins'].length > 0 &&
      // A registration listing only some of our origins is an older install of
      // ours to upgrade; one naming any other extension belongs to someone else.
      value['allowed_origins'].every((origin) =>
        ALLOWED_ORIGINS.includes(origin as string),
      )
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
  existingContents: string | null,
): Promise<void> {
  if (existingContents === contents) {
    if (((await stat(target)).mode & 0o777) !== mode) {
      await chmod(target, mode);
    }
    return;
  }
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pathExists(
  path: string,
  mode = constants.F_OK,
): Promise<boolean> {
  return await access(path, mode).then(
    () => true,
    () => false,
  );
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
