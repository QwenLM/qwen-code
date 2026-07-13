/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import { getErrorMessage } from '../utils/errors.js';
import * as os from 'node:os';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar';
import extract from 'extract-zip';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  ExtensionUpdateState,
  type Extension,
  type ExtensionConfig,
  type ExtensionManager,
} from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { checkNpmUpdate } from './npm.js';
import { redactUrlCredentials } from './redaction.js';
import {
  convertGeminiOrClaudeExtension,
  SUPPORTED_EXTENSION_MANIFESTS,
} from './extension-converter.js';
import { assertTarArchiveHasNoLinks } from './archive-safety.js';
import { resolveNetworkTarget } from './network-policy.js';

const debugLogger = createDebugLogger('EXT_GITHUB');
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'] as const;
const ZIP_FILE_TYPE_MASK = 0xf000;
const ZIP_SYMBOLIC_LINK_TYPE = 0xa000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const MINIMUM_PINNED_GIT_VERSION = { major: 2, minor: 37 } as const;

interface GithubReleaseData {
  assets: Asset[];
  tag_name: string;
  tarball_url?: string;
  zipball_url?: string;
}

interface Asset {
  name: string;
  browser_download_url: string;
}

export interface GitHubDownloadResult {
  tagName: string;
  type: 'git' | 'github-release';
}

function getSupportedArchiveExtensionFromPathname(
  pathname: string,
): string | undefined {
  const normalizedPathname = pathname.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.find((extension) =>
    normalizedPathname.endsWith(extension),
  );
}

function getSupportedArchiveExtension(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  return getSupportedArchiveExtensionFromPathname(pathname);
}

export function isSupportedArchivePath(source: string): boolean {
  return getSupportedArchiveExtensionFromPathname(source) !== undefined;
}

export function isSupportedArchiveUrl(source: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    return false;
  }

  return (
    parsedUrl.protocol === 'https:' &&
    getSupportedArchiveExtension(source) !== undefined
  );
}

function createRedactedErrorCause(error: unknown, message: string): Error {
  if (!(error instanceof Error)) {
    return new Error(message);
  }
  const cause = Object.create(Object.getPrototypeOf(error)) as Error;
  Object.defineProperties(cause, Object.getOwnPropertyDescriptors(error));
  Object.defineProperty(cause, 'message', {
    value: message,
    configurable: true,
    writable: true,
  });
  return cause;
}

function getGitHubToken(): string | undefined {
  return process.env['GITHUB_TOKEN'];
}

async function assertPinnedGitSupported(): Promise<void> {
  const version = await simpleGit().version();
  if (
    version.major < MINIMUM_PINNED_GIT_VERSION.major ||
    (version.major === MINIMUM_PINNED_GIT_VERSION.major &&
      version.minor < MINIMUM_PINNED_GIT_VERSION.minor)
  ) {
    throw new Error('Public extension Git installs require Git 2.37 or newer.');
  }
}

function createPinnedGitConfig(curlResolve: string): string[] {
  return [
    `http.curloptResolve=${curlResolve}`,
    'http.followRedirects=false',
    'http.proxy=',
    'protocol.allow=never',
    'protocol.https.allow=always',
  ];
}

function restrictGitEnvironment(
  git: SimpleGit,
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
): SimpleGit {
  if (networkPolicy !== 'public') return git;
  return git.env({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
  });
}

/**
 * Clones a Git repository to a specified local path.
 * @param installMetadata The metadata for the extension to install.
 * @param destination The destination path to clone the repository to.
 */
export async function cloneFromGit(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const redactedSource = redactUrlCredentials(installMetadata.source);
  try {
    if (installMetadata.networkPolicy === 'public') {
      if (!/^https:/i.test(installMetadata.source)) {
        throw new Error('Public extension Git installs must use HTTPS.');
      }
      await assertPinnedGitSupported();
    }
    const networkTarget = await resolveNetworkTarget(
      installMetadata.source,
      installMetadata.networkPolicy,
    );
    const networkConfig = networkTarget.curlResolve
      ? createPinnedGitConfig(networkTarget.curlResolve)
      : [];
    const git = restrictGitEnvironment(
      simpleGit(destination, {
        ...(signal ? { abort: signal } : {}),
        ...(networkConfig.length > 0 ? { config: networkConfig } : {}),
      }),
      installMetadata.networkPolicy,
    );
    signal?.throwIfAborted();
    let sourceUrl = installMetadata.source;
    const token = getGitHubToken();
    if (token) {
      try {
        const parsedUrl = new URL(sourceUrl);
        if (
          parsedUrl.protocol === 'https:' &&
          parsedUrl.hostname === 'github.com'
        ) {
          if (!parsedUrl.username) {
            parsedUrl.username = token;
          }
          sourceUrl = parsedUrl.toString();
        }
      } catch {
        // If source is not a valid URL, we don't inject the token.
        // We let git handle the source as is.
      }
    }
    // On Windows, symlinks require elevated privileges by default, so we
    // disable them to avoid "Permission denied" errors during checkout.
    const symlinkValue = os.platform() === 'win32' ? 'false' : 'true';
    await git.clone(sourceUrl, './', [
      '-c',
      `core.symlinks=${symlinkValue}`,
      '--depth',
      '1',
    ]);
    signal?.throwIfAborted();

    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
      throw new Error(`Unable to find any remotes for repo ${redactedSource}`);
    }

    const refToFetch = installMetadata.ref || 'HEAD';

    const remoteUrl = remotes[0].refs.fetch;
    if (!remoteUrl) {
      throw new Error(`Unable to find a fetch URL for repo ${redactedSource}`);
    }
    await git.fetch(remoteUrl, refToFetch);
    signal?.throwIfAborted();

    // Detached HEAD is expected here — we only need the fetched content.
    await git.checkout('FETCH_HEAD');
    signal?.throwIfAborted();
  } catch (error) {
    if (
      signal?.aborted &&
      (error === signal.reason ||
        (error instanceof Error && error.name === 'AbortError'))
    ) {
      signal.throwIfAborted();
    }
    const redactedErrorMessage = redactUrlCredentials(getErrorMessage(error));
    throw new Error(
      `Failed to clone Git repository from ${redactedSource} ${redactedErrorMessage}`,
      {
        cause: createRedactedErrorCause(error, redactedErrorMessage),
      },
    );
  }
}

export function parseGitHubRepoForReleases(source: string): {
  owner: string;
  repo: string;
} {
  // Default to a github repo path, so `source` can be just an org/repo
  const parsedUrl = URL.parse(source, 'https://github.com');
  // The pathname should be "/owner/repo".
  const parts = parsedUrl?.pathname.substring(1).split('/');
  if (parts?.length !== 2 || parsedUrl?.host !== 'github.com') {
    throw new Error(
      `Invalid GitHub repository source: ${redactUrlCredentials(source)}. Expected "owner/repo" or a github repo uri.`,
    );
  }
  const owner = parts[0];
  const repo = parts[1].replace('.git', '');

  if (owner.startsWith('git@github.com')) {
    throw new Error(
      `GitHub release-based extensions are not supported for SSH. You must use an HTTPS URI with a personal access token to download releases from private repositories. You can set your personal access token in the GITHUB_TOKEN environment variable and install the extension via SSH.`,
    );
  }

  return { owner, repo };
}

async function fetchReleaseFromGithub(
  owner: string,
  repo: string,
  ref?: string,
  signal?: AbortSignal,
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
): Promise<GithubReleaseData> {
  const endpoint = ref ? `releases/tags/${ref}` : 'releases/latest';
  const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
  return await fetchJson(url, signal, networkPolicy);
}

export async function checkForExtensionUpdate(
  extension: Extension,
  extensionManager: ExtensionManager,
  signal?: AbortSignal,
): Promise<ExtensionUpdateState> {
  signal?.throwIfAborted();
  const installMetadata = extension.installMetadata;
  if (installMetadata?.type === 'local') {
    let latestConfig: ExtensionConfig | undefined;
    let tempDir: string | undefined;
    let convertedDir: string | undefined;
    try {
      let extensionDir = installMetadata.source;
      if (isSupportedArchivePath(installMetadata.source)) {
        tempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), 'extension-archive-update-'),
        );
        signal?.throwIfAborted();
        await extractArchiveFile(installMetadata.source, tempDir, signal);
        signal?.throwIfAborted();
        const converted = await convertGeminiOrClaudeExtension(
          tempDir,
          installMetadata.pluginName,
          installMetadata.networkPolicy,
        );
        extensionDir = converted.extensionDir;
        if (extensionDir !== tempDir) {
          convertedDir = extensionDir;
        }
        signal?.throwIfAborted();
      }
      latestConfig = extensionManager.loadExtensionConfig({
        extensionDir,
      });
    } catch (e) {
      signal?.throwIfAborted();
      debugLogger.error(
        `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${redactUrlCredentials(installMetadata.source)}. Error: ${redactUrlCredentials(getErrorMessage(e))}`,
      );
      return ExtensionUpdateState.NOT_UPDATABLE;
    } finally {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
      if (convertedDir) {
        await fs.promises.rm(convertedDir, { recursive: true, force: true });
      }
    }

    if (!latestConfig) {
      debugLogger.error(
        `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${redactUrlCredentials(installMetadata.source)}`,
      );
      return ExtensionUpdateState.NOT_UPDATABLE;
    }
    if (latestConfig.version !== extension.version) {
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    }
    return ExtensionUpdateState.UP_TO_DATE;
  }
  if (installMetadata?.type === 'npm') {
    return checkNpmUpdate(installMetadata, signal);
  }
  if (installMetadata?.type === 'archive-url') {
    let tempDir: string | undefined;
    let convertedDir: string | undefined;
    try {
      tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'extension-archive-update-'),
      );
      await downloadFromArchiveUrl(installMetadata, tempDir, signal);
      const converted = await convertGeminiOrClaudeExtension(
        tempDir,
        installMetadata.pluginName,
        installMetadata.networkPolicy,
      );
      const extensionDir = converted.extensionDir;
      if (extensionDir !== tempDir) {
        convertedDir = extensionDir;
      }
      const latestConfig = extensionManager.loadExtensionConfig({
        extensionDir,
      });
      if (!latestConfig) {
        debugLogger.error(
          `Failed to check for update for archive URL extension "${extension.name}". Could not load extension from source URL: ${redactUrlCredentials(installMetadata.source)}`,
        );
        return ExtensionUpdateState.ERROR;
      }
      if (latestConfig.version !== extension.version) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    } catch (error) {
      signal?.throwIfAborted();
      debugLogger.error(
        `Failed to check for update for archive URL extension "${extension.name}" from ${redactUrlCredentials(installMetadata.source)}: ${redactUrlCredentials(getErrorMessage(error))}`,
      );
      return ExtensionUpdateState.ERROR;
    } finally {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
      if (convertedDir) {
        await fs.promises.rm(convertedDir, { recursive: true, force: true });
      }
    }
  }
  if (
    !installMetadata ||
    installMetadata.originSource === 'Claude' ||
    (installMetadata.type !== 'git' &&
      installMetadata.type !== 'github-release')
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  try {
    if (installMetadata.type === 'git') {
      if (installMetadata.networkPolicy === 'public') {
        await assertPinnedGitSupported();
      }
      const localGit = simpleGit(
        extension.path,
        signal ? { abort: signal } : undefined,
      );
      const remotes = await localGit.getRemotes(true);
      signal?.throwIfAborted();
      if (remotes.length === 0) {
        debugLogger.error('No git remotes found.');
        return ExtensionUpdateState.ERROR;
      }
      const remoteUrl = remotes[0].refs.fetch;
      if (!remoteUrl) {
        debugLogger.error(
          `No fetch URL found for git remote ${remotes[0].name}.`,
        );
        return ExtensionUpdateState.ERROR;
      }
      let resolutionUrl = remoteUrl;
      if (installMetadata.networkPolicy === 'public') {
        const parsedRemote = new URL(remoteUrl);
        parsedRemote.username = '';
        parsedRemote.password = '';
        resolutionUrl = parsedRemote.toString();
      }
      const remoteTarget = await resolveNetworkTarget(
        resolutionUrl,
        installMetadata.networkPolicy,
      );
      const git = restrictGitEnvironment(
        simpleGit(extension.path, {
          ...(signal ? { abort: signal } : {}),
          ...(remoteTarget.curlResolve
            ? {
                config: createPinnedGitConfig(remoteTarget.curlResolve),
              }
            : {}),
        }),
        installMetadata.networkPolicy,
      );
      const refToCheck = installMetadata.ref || 'HEAD';

      const lsRemoteOutput = await git.listRemote([remoteUrl, refToCheck]);
      signal?.throwIfAborted();

      if (typeof lsRemoteOutput !== 'string' || lsRemoteOutput.trim() === '') {
        debugLogger.error(`Git ref ${refToCheck} not found.`);
        return ExtensionUpdateState.ERROR;
      }

      const remoteHash = lsRemoteOutput.split('\t')[0];
      const localHash = await git.revparse(['HEAD']);
      signal?.throwIfAborted();

      if (!remoteHash) {
        debugLogger.error(
          `Unable to parse hash from git ls-remote output "${lsRemoteOutput}"`,
        );
        return ExtensionUpdateState.ERROR;
      }
      if (remoteHash === localHash) {
        return ExtensionUpdateState.UP_TO_DATE;
      }
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    } else {
      const { source, releaseTag } = installMetadata;
      if (!source) {
        debugLogger.error('No "source" provided for extension.');
        return ExtensionUpdateState.ERROR;
      }
      const { owner, repo } = parseGitHubRepoForReleases(source);

      const releaseData = await fetchReleaseFromGithub(
        owner,
        repo,
        installMetadata.ref,
        signal,
        installMetadata.networkPolicy,
      );
      if (releaseData.tag_name !== releaseTag) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    }
  } catch (error) {
    signal?.throwIfAborted();
    debugLogger.error(
      `Failed to check for updates for extension "${redactUrlCredentials(installMetadata.source)}": ${redactUrlCredentials(getErrorMessage(error))}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}

export async function downloadFromGitHubRelease(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
  signal?: AbortSignal,
): Promise<GitHubDownloadResult> {
  const { source, ref } = installMetadata;
  const { owner, repo } = parseGitHubRepoForReleases(source);

  const releaseData = await fetchReleaseFromGithub(
    owner,
    repo,
    ref,
    signal,
    installMetadata.networkPolicy,
  );
  if (!releaseData) {
    throw new Error(`No release data found for ${owner}/${repo} at tag ${ref}`);
  }

  const asset = findReleaseAsset(releaseData.assets);
  let archiveUrl: string | undefined;
  let isTar = false;
  let isZip = false;
  if (asset) {
    archiveUrl = asset.browser_download_url;
  } else {
    if (releaseData.tarball_url) {
      archiveUrl = releaseData.tarball_url;
      isTar = true;
    } else if (releaseData.zipball_url) {
      archiveUrl = releaseData.zipball_url;
      isZip = true;
    }
  }
  if (!archiveUrl) {
    throw new Error(
      `No assets found for release with tag ${releaseData.tag_name}`,
    );
  }
  let downloadedAssetPath = path.join(
    destination,
    path.basename(new URL(archiveUrl).pathname),
  );
  if (isTar && !downloadedAssetPath.endsWith('.tar.gz')) {
    downloadedAssetPath += '.tar.gz';
  } else if (isZip && !downloadedAssetPath.endsWith('.zip')) {
    downloadedAssetPath += '.zip';
  }

  try {
    await downloadFile(
      archiveUrl,
      downloadedAssetPath,
      {
        includeGitHubToken: true,
        networkPolicy: installMetadata.networkPolicy,
      },
      0,
      signal,
    );
  } catch (error) {
    throw new Error(
      `Failed to download release from ${redactUrlCredentials(installMetadata.source)}: ${redactUrlCredentials(getErrorMessage(error))}`,
    );
  }

  signal?.throwIfAborted();
  await extractArchiveFile(downloadedAssetPath, destination, signal);
  signal?.throwIfAborted();

  await fs.promises.unlink(downloadedAssetPath);
  return {
    tagName: releaseData.tag_name,
    type: 'github-release',
  };
}

export async function downloadFromArchiveUrl(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const archiveExtension = getSupportedArchiveExtension(installMetadata.source);
  if (!archiveExtension) {
    throw new Error(
      `Unsupported archive URL for extension install: ${redactUrlCredentials(installMetadata.source)}`,
    );
  }

  const archiveName =
    path.basename(new URL(installMetadata.source).pathname) ||
    `extension${archiveExtension}`;
  const downloadedAssetPath = path.join(destination, archiveName);

  try {
    await downloadFile(
      installMetadata.source,
      downloadedAssetPath,
      {
        includeGitHubToken: false,
        networkPolicy: installMetadata.networkPolicy,
      },
      0,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Failed to download archive from ${redactUrlCredentials(installMetadata.source)}: ${redactUrlCredentials(getErrorMessage(error))}`,
    );
  }

  signal?.throwIfAborted();
  await extractArchiveFile(downloadedAssetPath, destination, signal);
  signal?.throwIfAborted();
  await fs.promises.unlink(downloadedAssetPath);
}

export async function extractArchiveFile(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(
      `Unsupported archive file for extension install: ${redactUrlCredentials(archivePath)}`,
    );
  }
  try {
    await extractFile(archivePath, destination, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      'Extension archive could not be extracted. Make sure it is a valid ' +
        `.zip or .tar.gz file. ${getErrorMessage(error)}`,
    );
  }
  signal?.throwIfAborted();
  await flattenSingleExtensionDirectory(destination, archivePath);
  signal?.throwIfAborted();
  assertExtractedArchiveContainsExtensionSource(destination);
}

export function findReleaseAsset(assets: Asset[]): Asset | undefined {
  const platform = os.platform();
  const arch = os.arch();

  const platformArchPrefix = `${platform}.${arch}.`;
  const platformPrefix = `${platform}.`;

  // Check for platform + architecture specific asset
  const platformArchAsset = assets.find((asset) =>
    asset.name.toLowerCase().startsWith(platformArchPrefix),
  );
  if (platformArchAsset) {
    return platformArchAsset;
  }

  // Check for platform specific asset
  const platformAsset = assets.find((asset) =>
    asset.name.toLowerCase().startsWith(platformPrefix),
  );
  if (platformAsset) {
    return platformAsset;
  }

  // Check for generic asset if only one is available
  const genericAsset = assets.find(
    (asset) =>
      !asset.name.toLowerCase().includes('darwin') &&
      !asset.name.toLowerCase().includes('linux') &&
      !asset.name.toLowerCase().includes('win32'),
  );
  if (assets.length === 1) {
    return genericAsset;
  }

  return undefined;
}

async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
): Promise<T> {
  const headers: { 'User-Agent': string; Authorization?: string } = {
    'User-Agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  const target = networkPolicy
    ? await resolveNetworkTarget(url, networkPolicy)
    : { url: new URL(url) };
  return new Promise((resolve, reject) => {
    const rejectRequest = (error: unknown) => {
      reject(signal?.aborted ? signal.reason : error);
    };
    https
      .get(
        url,
        {
          headers,
          signal,
          lookup: target.lookup,
          ...(target.lookup ? { agent: false } : {}),
        },
        (res) => {
          res.on('error', rejectRequest);
          if (res.statusCode !== 200) {
            res.resume();
            return reject(
              new Error(`Request failed with status code ${res.statusCode}`),
            );
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
            } catch (error) {
              rejectRequest(error);
            }
          });
        },
      )
      .on('error', rejectRequest);
  });
}

async function downloadFile(
  url: string,
  dest: string,
  options: {
    includeGitHubToken?: boolean;
    networkPolicy?: ExtensionInstallMetadata['networkPolicy'];
  } = { includeGitHubToken: false },
  redirectCount = 0,
  signal?: AbortSignal,
): Promise<void> {
  if (redirectCount > 10) {
    throw new Error('Too many redirects while downloading extension archive');
  }
  const headers: { 'User-agent': string; Authorization?: string } = {
    'User-agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (options.includeGitHubToken === true && token) {
    headers.Authorization = `token ${token}`;
  }
  const target = options.networkPolicy
    ? await resolveNetworkTarget(url, options.networkPolicy)
    : { url: new URL(url) };
  const parsedUrl = target.url;
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Unsupported download URL protocol: ${parsedUrl.protocol}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardDeadline: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (hardDeadline) {
        clearTimeout(hardDeadline);
        hardDeadline = undefined;
      }
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const req = https
      .get(
        url,
        {
          headers,
          signal,
          lookup: target.lookup,
          ...(target.lookup ? { agent: false } : {}),
        },
        (res) => {
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            if (!res.headers.location) {
              res.resume();
              fail(new Error('Redirect response missing location header'));
              return;
            }
            res.resume();
            let redirectUrl: URL;
            try {
              redirectUrl = new URL(res.headers.location, url);
            } catch (error) {
              fail(
                new Error(`Invalid redirect URL: ${getErrorMessage(error)}`),
              );
              return;
            }
            const redirectHost = redirectUrl.host;
            const redirectOptions =
              redirectHost === parsedUrl.host
                ? options
                : { ...options, includeGitHubToken: false };
            cleanup();
            downloadFile(
              redirectUrl.toString(),
              dest,
              redirectOptions,
              redirectCount + 1,
              signal,
            )
              .then(finish)
              .catch(fail);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return fail(
              new Error(`Request failed with status code ${res.statusCode}`),
            );
          }
          const file = fs.createWriteStream(dest);
          let bytesWritten = 0;
          res.on('data', (chunk: Buffer) => {
            bytesWritten += chunk.length;
            if (bytesWritten > ARCHIVE_DOWNLOAD_MAX_BYTES) {
              res.destroy();
              file.destroy();
              fail(
                new Error(
                  `Extension archive download exceeded maximum size of ${ARCHIVE_DOWNLOAD_MAX_BYTES} bytes`,
                ),
              );
            }
          });
          res.on('error', (error) => {
            file.destroy();
            fail(error);
          });
          file.on('error', (error) => {
            res.destroy();
            fail(error);
          });
          res.pipe(file);
          file.on('finish', () => file.close(finish));
        },
      )
      .on('error', fail);
    if (!settled) {
      hardDeadline = setTimeout(() => {
        req.destroy();
        fail(new Error('Timed out downloading extension archive'));
      }, ARCHIVE_DOWNLOAD_TIMEOUT_MS);
      req.setTimeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy();
        fail(new Error('Timed out downloading extension archive'));
      });
    }
  });
}

export async function extractFile(
  file: string,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (file.endsWith('.tar.gz')) {
    await assertTarArchiveHasNoLinks(file);
    signal?.throwIfAborted();
    await tar.x({
      file,
      cwd: dest,
    });
  } else if (file.endsWith('.zip')) {
    await extract(file, {
      dir: dest,
      onEntry: (entry) => {
        if (isZipSymlinkEntry(entry.externalFileAttributes)) {
          throw new Error(
            `Zip archive contains unsupported symbolic link entry: ${entry.fileName}`,
          );
        }
      },
    });
  } else {
    throw new Error(`Unsupported file extension for extraction: ${file}`);
  }
  signal?.throwIfAborted();
}

function isZipSymlinkEntry(externalFileAttributes: number): boolean {
  const mode = externalFileAttributes >>> 16;
  return (mode & ZIP_FILE_TYPE_MASK) === ZIP_SYMBOLIC_LINK_TYPE;
}

async function flattenSingleExtensionDirectory(
  destination: string,
  archivePath: string,
) {
  // GitHub source archives and many uploaded archives wrap content in a single
  // top-level directory. Flatten only when that directory looks like a valid
  // extension root or a compatible source that can be converted later.
  const archiveNameToIgnore = getContainedArchiveName(destination, archivePath);
  const entries = (
    await fs.promises.readdir(destination, {
      withFileTypes: true,
    })
  ).filter((entry) => entry.name !== archiveNameToIgnore);
  if (hasSupportedExtensionSourceManifest(destination)) {
    return;
  }
  if (entries.length > 2) {
    return;
  }

  const lonelyDir = entries.find((entry) => entry.isDirectory());
  if (!lonelyDir) {
    return;
  }

  const rootPath = path.join(destination, lonelyDir.name);
  if (!hasSupportedExtensionSourceManifest(rootPath)) {
    return;
  }

  const extractedDirFiles = await fs.promises.readdir(rootPath);
  for (const file of extractedDirFiles) {
    const destinationPath = path.join(destination, file);
    if (fs.existsSync(destinationPath)) {
      throw new Error(
        `Extension archive cannot be flattened because "${file}" exists at both the archive root and inside "${lonelyDir.name}".`,
      );
    }
  }
  for (const file of extractedDirFiles) {
    const destinationPath = path.join(destination, file);
    await fs.promises.rename(path.join(rootPath, file), destinationPath);
  }
  await fs.promises.rmdir(rootPath);
}

function getSupportedManifestList(): string {
  return SUPPORTED_EXTENSION_MANIFESTS.join(', ');
}

function hasSupportedExtensionSourceManifest(rootPath: string): boolean {
  return SUPPORTED_EXTENSION_MANIFESTS.some((manifestPath) =>
    fs.existsSync(path.join(rootPath, manifestPath)),
  );
}

function assertExtractedArchiveContainsExtensionSource(
  destination: string,
): void {
  if (hasSupportedExtensionSourceManifest(destination)) {
    return;
  }

  throw new Error(
    'Extension archive is missing a supported extension manifest. ' +
      `Expected one of: ${getSupportedManifestList()} at the archive root, ` +
      'or inside a single top-level extension directory.',
  );
}

function getContainedArchiveName(
  destination: string,
  archivePath: string,
): string | undefined {
  const resolvedDestination = path.resolve(destination);
  const resolvedArchivePath = path.resolve(archivePath);
  if (path.dirname(resolvedArchivePath) === resolvedDestination) {
    return path.basename(resolvedArchivePath);
  }
  return undefined;
}
