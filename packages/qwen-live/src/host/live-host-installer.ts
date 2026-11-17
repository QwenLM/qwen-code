/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';
import {
  liveMessage,
  liveText,
  type LiveMessageKey,
  type LiveMessageParams,
} from '../i18n/messages.js';

class InstallerError extends Error {
  constructor(
    readonly messageKey: LiveMessageKey,
    readonly messageParams: LiveMessageParams = {},
  ) {
    super(liveText('en', messageKey, messageParams));
  }
}

const execFileAsync = promisify(execFile);

export const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host';
export const LIVE_HOST_TEAM_IDENTIFIER = 'NF4574S59H';
export const LIVE_HOST_APP_PATH = '/Applications/Qwen Live Host.app';
export const LIVE_HOST_OSS_BASE_URL =
  'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/live-host';
export const LIVE_HOST_RELEASE_BASE_URL =
  'https://github.com/QwenLM/qwen-code/releases/download/live-host-latest';
export const LIVE_HOST_MANIFEST_NAME = 'Qwen-Live-Host-manifest.json';
export const LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS = 5 * 60 * 1000;
export const LIVE_HOST_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

const LIVE_HOST_APP_NAME = 'Qwen Live Host.app';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type LiveHostArchitecture = 'arm64' | 'x64';

export type LiveHostInstallState =
  | 'missing'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'launching'
  | 'installed'
  | 'error';

export interface LiveHostInstallStatus {
  state: LiveHostInstallState;
  version?: string;
  progress?: number;
  message?: string;
  retryable?: boolean;
}

export interface LiveHostReleaseAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface LiveHostReleaseManifest {
  schemaVersion: 1;
  version: string;
  protocolVersion: number;
  bundleId: string;
  assets: Record<LiveHostArchitecture, LiveHostReleaseAsset>;
}

interface InstalledLiveHost {
  version: string;
  protocolVersion: number;
}

export interface LiveHostInstallerDeps {
  platform?: NodeJS.Platform;
  architecture?: string;
  inspectInstalled?: () => Promise<InstalledLiveHost | undefined>;
  installLatest?: (
    architecture: LiveHostArchitecture,
    onStatus: (status: LiveHostInstallStatus) => void,
  ) => Promise<InstalledLiveHost>;
  launch?: () => Promise<void>;
}

export function isExpectedLiveHostSignature(output: string): boolean {
  return (
    /^Authority=Developer ID Application:/m.test(output) &&
    new RegExp(`^TeamIdentifier=${LIVE_HOST_TEAM_IDENTIFIER}$`, 'm').test(
      output,
    )
  );
}

function architecture(value: string): LiveHostArchitecture {
  if (value === 'arm64' || value === 'x64') return value;
  throw new InstallerError('installer.architecture', { architecture: value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAsset(
  value: unknown,
  expectedName: string,
): LiveHostReleaseAsset {
  if (!isRecord(value)) throw new InstallerError('installer.assetInvalid');
  const name = value['name'];
  const size = value['size'];
  const sha256 = value['sha256'];
  if (
    name !== expectedName ||
    !Number.isSafeInteger(size) ||
    Number(size) <= 0 ||
    Number(size) > MAX_DOWNLOAD_BYTES ||
    typeof sha256 !== 'string' ||
    !SHA256_PATTERN.test(sha256)
  ) {
    throw new InstallerError('installer.assetInvalid');
  }
  return { name, size: Number(size), sha256 };
}

export function parseLiveHostReleaseManifest(
  value: unknown,
): LiveHostReleaseManifest {
  if (!isRecord(value) || !isRecord(value['assets'])) {
    throw new InstallerError('installer.manifestInvalid');
  }
  const version = value['version'];
  if (
    value['schemaVersion'] !== 1 ||
    typeof version !== 'string' ||
    !VERSION_PATTERN.test(version) ||
    value['protocolVersion'] !== LIVE_HOST_PROTOCOL_VERSION ||
    value['bundleId'] !== LIVE_HOST_BUNDLE_ID
  ) {
    throw new InstallerError('installer.manifestIncompatible');
  }
  return {
    schemaVersion: 1,
    version,
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    bundleId: LIVE_HOST_BUNDLE_ID,
    assets: {
      arm64: parseAsset(value['assets']['arm64'], 'Qwen-Live-Host-arm64.zip'),
      x64: parseAsset(value['assets']['x64'], 'Qwen-Live-Host-x64.zip'),
    },
  };
}

async function run(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function readBundleValue(appPath: string, key: string): Promise<string> {
  return await run('/usr/bin/plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    path.join(appPath, 'Contents', 'Info.plist'),
  ]);
}

async function inspectApp(appPath: string): Promise<InstalledLiveHost> {
  const stat = await fsp.lstat(appPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new InstallerError('installer.bundleInvalid');
  }
  const bundleId = await readBundleValue(appPath, 'CFBundleIdentifier');
  if (bundleId !== LIVE_HOST_BUNDLE_ID) {
    throw new InstallerError('installer.identityInvalid');
  }
  const version = await readBundleValue(appPath, 'CFBundleShortVersionString');
  if (!VERSION_PATTERN.test(version)) {
    throw new InstallerError('installer.versionInvalid');
  }
  const rawProtocolVersion = await readBundleValue(
    appPath,
    'QwenLiveProtocolVersion',
  ).catch(() => '0');
  const protocolVersion = Number(rawProtocolVersion);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ]);
  const signature = await execFileAsync(
    '/usr/bin/codesign',
    ['-dv', '--verbose=4', appPath],
    {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  const signatureOutput = `${signature.stdout}${signature.stderr}`;
  if (!isExpectedLiveHostSignature(signatureOutput)) {
    throw new InstallerError('installer.signatureInvalid');
  }
  await run('/usr/sbin/spctl', ['-a', '-t', 'exec', appPath]);
  return {
    version,
    protocolVersion: Number.isSafeInteger(protocolVersion)
      ? protocolVersion
      : 0,
  };
}

function isCompatibleInstalledHost(host: InstalledLiveHost): boolean {
  return host.protocolVersion === LIVE_HOST_PROTOCOL_VERSION;
}

async function inspectInstalledHost(): Promise<InstalledLiveHost | undefined> {
  try {
    return await inspectApp(LIVE_HOST_APP_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function resolveLiveHostManifestUrls(): [string, string] {
  return [
    `${LIVE_HOST_OSS_BASE_URL}/latest/${LIVE_HOST_MANIFEST_NAME}`,
    `${LIVE_HOST_RELEASE_BASE_URL}/${LIVE_HOST_MANIFEST_NAME}`,
  ];
}

export function resolveLiveHostAssetUrls(
  version: string,
  assetName: string,
): [string, string] {
  return [
    `${LIVE_HOST_OSS_BASE_URL}/v${version}/${assetName}`,
    `${LIVE_HOST_RELEASE_BASE_URL}/${assetName}`,
  ];
}

async function fetchManifest(
  url: string,
  fetchImpl: typeof fetch,
): Promise<LiveHostReleaseManifest> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(LIVE_HOST_MANIFEST_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new InstallerError('installer.manifestDownload', {
      status: response.status,
    });
  }
  return parseLiveHostReleaseManifest(await response.json());
}

async function downloadAsset(
  asset: LiveHostReleaseAsset,
  url: string,
  destination: string,
  onProgress: (progress: number) => void,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(LIVE_HOST_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new InstallerError('installer.downloadStatus', {
      status: response.status,
    });
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > 0 &&
    contentLength !== asset.size
  ) {
    await response.body.cancel().catch(() => {});
    throw new InstallerError('installer.sizeMismatch');
  }
  const hash = createHash('sha256');
  let received = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > asset.size || received > MAX_DOWNLOAD_BYTES) {
        callback(new InstallerError('installer.sizeExceeded'));
        return;
      }
      hash.update(chunk);
      onProgress(Math.min(1, received / asset.size));
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    guard,
    fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  );
  if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
    throw new InstallerError('installer.checksum');
  }
}

export async function downloadLiveHostRelease(
  currentArchitecture: LiveHostArchitecture,
  destination: string,
  onProgress: (progress: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  manifest: LiveHostReleaseManifest;
  asset: LiveHostReleaseAsset;
}> {
  const manifestUrls = resolveLiveHostManifestUrls();
  const labels = ['OSS', 'GitHub'];
  const errors: Error[] = [];

  for (let index = 0; index < manifestUrls.length; index += 1) {
    try {
      await fsp.rm(destination, { force: true });
      const manifest = await fetchManifest(manifestUrls[index], fetchImpl);
      const asset = manifest.assets[currentArchitecture];
      const assetUrl = resolveLiveHostAssetUrls(manifest.version, asset.name)[
        index
      ];
      await downloadAsset(asset, assetUrl, destination, onProgress, fetchImpl);
      return { manifest, asset };
    } catch (error) {
      errors.push(
        new Error(
          `${labels[index]}: ${error instanceof Error ? error.message : liveText('en', 'installer.setupFailed')}`,
          { cause: error },
        ),
      );
    }
  }

  await fsp.rm(destination, { force: true });
  throw new AggregateError(
    errors,
    liveText('en', 'installer.downloadFailed', {
      details: errors.map((error) => error.message).join(' '),
    }),
  );
}

async function installLatestHost(
  currentArchitecture: LiveHostArchitecture,
  onStatus: (status: LiveHostInstallStatus) => void,
): Promise<InstalledLiveHost> {
  const temporaryDirectory = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-live-host-'),
  );
  const archivePath = path.join(temporaryDirectory, 'Qwen-Live-Host.zip');
  const extractedPath = path.join(temporaryDirectory, 'extracted');
  const candidatePath = path.join(extractedPath, LIVE_HOST_APP_NAME);
  const stagingPath = `/Applications/.Qwen Live Host.install-${randomUUID()}.app`;
  const backupPath = `/Applications/.Qwen Live Host.backup-${randomUUID()}.app`;
  let movedExisting = false;
  let installedCandidate = false;
  try {
    onStatus({ state: 'downloading', progress: 0 });
    const { manifest } = await downloadLiveHostRelease(
      currentArchitecture,
      archivePath,
      (progress) => {
        onStatus({ state: 'downloading', progress });
      },
    );
    onStatus({ state: 'verifying' });
    await fsp.mkdir(extractedPath, { mode: 0o700 });
    await run('/usr/bin/ditto', ['-x', '-k', archivePath, extractedPath]);
    const candidate = await inspectApp(candidatePath);
    if (
      candidate.version !== manifest.version ||
      !isCompatibleInstalledHost(candidate)
    ) {
      throw new InstallerError('installer.packageVersion');
    }
    onStatus({ state: 'installing', version: manifest.version });
    await run('/usr/bin/ditto', [candidatePath, stagingPath]);
    await inspectApp(stagingPath);
    try {
      await fsp.rename(LIVE_HOST_APP_PATH, backupPath);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fsp.rename(stagingPath, LIVE_HOST_APP_PATH);
    installedCandidate = true;
    const installed = await inspectApp(LIVE_HOST_APP_PATH);
    if (
      installed.version !== manifest.version ||
      !isCompatibleInstalledHost(installed)
    ) {
      throw new InstallerError('installer.installedVersion');
    }
    if (movedExisting) {
      await fsp.rm(backupPath, { recursive: true, force: true });
    }
    return installed;
  } catch (error) {
    if (installedCandidate) {
      await fsp.rm(LIVE_HOST_APP_PATH, { recursive: true, force: true });
    }
    if (movedExisting) {
      await fsp.rename(backupPath, LIVE_HOST_APP_PATH).catch(() => {});
    }
    throw error;
  } finally {
    await fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function launchInstalledHost(): Promise<void> {
  await run('/usr/bin/open', [LIVE_HOST_APP_PATH]);
}

function errorMessage(error: unknown): string {
  if (error instanceof InstallerError)
    return liveMessage(error.messageKey, error.messageParams);
  if (error instanceof AggregateError && error.errors.length === 2) {
    const detail = (entry: unknown) => {
      const cause = entry instanceof Error ? (entry.cause ?? entry) : entry;
      return cause instanceof Error
        ? cause.message
        : liveText('en', 'installer.setupFailed');
    };
    return liveMessage('installer.sourcesFailed', {
      oss: detail(error.errors[0]),
      github: detail(error.errors[1]),
    });
  }
  if (error instanceof Error && error.message) return error.message;
  return liveMessage('installer.setupFailed');
}

export class LiveHostInstaller {
  private status: LiveHostInstallStatus = { state: 'missing' };
  private operation: Promise<LiveHostInstallStatus> | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly currentArchitecture: string;
  private readonly inspectInstalled: () => Promise<
    InstalledLiveHost | undefined
  >;
  private readonly installLatest: NonNullable<
    LiveHostInstallerDeps['installLatest']
  >;
  private readonly launchHost: () => Promise<void>;

  constructor(deps: LiveHostInstallerDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.currentArchitecture = deps.architecture ?? process.arch;
    this.inspectInstalled = deps.inspectInstalled ?? inspectInstalledHost;
    this.installLatest = deps.installLatest ?? installLatestHost;
    this.launchHost = deps.launch ?? launchInstalledHost;
  }

  getStatus(): LiveHostInstallStatus {
    return { ...this.status };
  }

  async refresh(): Promise<LiveHostInstallStatus> {
    if (this.operation) return await this.operation;
    if (this.platform !== 'darwin') {
      return this.setError(liveMessage('installer.macOnly'), false);
    }
    this.status = { state: 'checking' };
    try {
      const installed = await this.inspectInstalled();
      this.status =
        installed && isCompatibleInstalledHost(installed)
          ? { state: 'installed', version: installed.version }
          : { state: 'missing' };
    } catch (error) {
      this.setError(errorMessage(error), true);
    }
    return this.getStatus();
  }

  ensureInstalled(force = false): Promise<LiveHostInstallStatus> {
    if (this.operation) return this.operation;
    const operation = this.runInstall(force).finally(() => {
      if (this.operation === operation) this.operation = undefined;
    });
    this.operation = operation;
    return operation;
  }

  async launch(): Promise<LiveHostInstallStatus> {
    if (this.platform !== 'darwin') {
      return this.setError(liveMessage('installer.macOnly'), false);
    }
    if (this.operation) return await this.operation;
    try {
      const installed = await this.inspectInstalled();
      if (!installed)
        return this.setError(liveMessage('installer.notInstalled'), true);
      if (!isCompatibleInstalledHost(installed)) {
        return this.setError(
          liveMessage('installer.protocol', {
            installed: installed.protocolVersion,
            required: LIVE_HOST_PROTOCOL_VERSION,
          }),
          true,
        );
      }
      this.status = { state: 'launching', version: installed.version };
      await this.launchHost();
      this.status = { state: 'installed', version: installed.version };
    } catch (error) {
      this.setError(errorMessage(error), true);
    }
    return this.getStatus();
  }

  private async runInstall(force: boolean): Promise<LiveHostInstallStatus> {
    if (this.platform !== 'darwin') {
      return this.setError(liveMessage('installer.macOnly'), false);
    }
    let currentArchitecture: LiveHostArchitecture;
    try {
      currentArchitecture = architecture(this.currentArchitecture);
      this.status = { state: 'checking' };
      const installed = force ? undefined : await this.inspectInstalled();
      const ready =
        (installed && isCompatibleInstalledHost(installed)
          ? installed
          : undefined) ??
        (await this.installLatest(currentArchitecture, (status) => {
          this.status = { ...status };
        }));
      this.status = { state: 'launching', version: ready.version };
      await this.launchHost();
      this.status = { state: 'installed', version: ready.version };
    } catch (error) {
      this.setError(errorMessage(error), true);
    }
    return this.getStatus();
  }

  private setError(message: string, retryable: boolean): LiveHostInstallStatus {
    this.status = { state: 'error', message, retryable };
    return this.getStatus();
  }
}
