/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit } from 'simple-git';
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

const debugLogger = createDebugLogger('EXT_GITHUB');
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'] as const;
const ZIP_FILE_TYPE_MASK = 0xf000;
const ZIP_SYMBOLIC_LINK_TYPE = 0xa000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

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

/**
 * Clones a Git repository to a specified local path.
 * @param installMetadata The metadata for the extension to install.
 * @param destination The destination path to clone the repository to.
 */
export async function cloneFromGit(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<void> {
  const redactedSource = redactUrlCredentials(installMetadata.source);
  try {
    const git = simpleGit(destination);
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

    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
      throw new Error(`Unable to find any remotes for repo ${redactedSource}`);
    }

    const refToFetch = installMetadata.ref || 'HEAD';

    await git.fetch(remotes[0].name, refToFetch);

    // Detached HEAD is expected here — we only need the fetched content.
    await git.checkout('FETCH_HEAD');
  } catch (error) {
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
): Promise<GithubReleaseData> {
  const endpoint = ref ? `releases/tags/${ref}` : 'releases/latest';
  const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
  return await fetchJson(url);
}

export async function checkForExtensionUpdate(
  extension: Extension,
  extensionManager: ExtensionManager,
): Promise<ExtensionUpdateState> {
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
        await extractArchiveFile(installMetadata.source, tempDir);
        const converted = await convertGeminiOrClaudeExtension(
          tempDir,
          installMetadata.pluginName,
        );
        extensionDir = converted.extensionDir;
        if (extensionDir !== tempDir) {
          convertedDir = extensionDir;
        }
      }
      latestConfig = extensionManager.loadExtensionConfig({
        extensionDir,
      });
    } catch (e) {
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
    return checkNpmUpdate(installMetadata);
  }
  if (installMetadata?.type === 'archive-url') {
    let tempDir: string | undefined;
    let convertedDir: string | undefined;
    try {
      tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'extension-archive-update-'),
      );
      await downloadFromArchiveUrl(installMetadata, tempDir);
      const converted = await convertGeminiOrClaudeExtension(
        tempDir,
        installMetadata.pluginName,
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
      const git = simpleGit(extension.path);
      const remotes = await git.getRemotes(true);
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

      const refToCheck = installMetadata.ref || 'HEAD';

      const lsRemoteOutput = await git.listRemote([remoteUrl, refToCheck]);

      if (typeof lsRemoteOutput !== 'string' || lsRemoteOutput.trim() === '') {
        debugLogger.error(`Git ref ${refToCheck} not found.`);
        return ExtensionUpdateState.ERROR;
      }

      const remoteHash = lsRemoteOutput.split('\t')[0];
      const localHash = await git.revparse(['HEAD']);

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
      );
      if (releaseData.tag_name !== releaseTag) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    }
  } catch (error) {
    debugLogger.error(
      `Failed to check for updates for extension "${redactUrlCredentials(installMetadata.source)}": ${redactUrlCredentials(getErrorMessage(error))}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}

export async function downloadFromGitHubRelease(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<GitHubDownloadResult> {
  const { source, ref } = installMetadata;
  const { owner, repo } = parseGitHubRepoForReleases(source);

  const releaseData = await fetchReleaseFromGithub(owner, repo, ref);
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
    await downloadFile(archiveUrl, downloadedAssetPath, {
      includeGitHubToken: true,
    });
  } catch (error) {
    throw new Error(
      `Failed to download release from ${redactUrlCredentials(installMetadata.source)}: ${redactUrlCredentials(getErrorMessage(error))}`,
    );
  }

  await extractArchiveFile(downloadedAssetPath, destination);

  await fs.promises.unlink(downloadedAssetPath);
  return {
    tagName: releaseData.tag_name,
    type: 'github-release',
  };
}

export async function downloadFromArchiveUrl(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
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
    await downloadFile(installMetadata.source, downloadedAssetPath, {
      includeGitHubToken: false,
    });
  } catch (error) {
    throw new Error(
      `Failed to download archive from ${redactUrlCredentials(installMetadata.source)}: ${redactUrlCredentials(getErrorMessage(error))}`,
    );
  }

  await extractArchiveFile(downloadedAssetPath, destination);
  await fs.promises.unlink(downloadedAssetPath);
}

export async function extractArchiveFile(
  archivePath: string,
  destination: string,
): Promise<void> {
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(
      `Unsupported archive file for extension install: ${redactUrlCredentials(archivePath)}`,
    );
  }
  try {
    await extractFile(archivePath, destination);
  } catch (error) {
    throw new Error(
      'Extension archive could not be extracted. Make sure it is a valid ' +
        `.zip or .tar.gz file. ${getErrorMessage(error)}`,
    );
  }
  await flattenSingleExtensionDirectory(destination, archivePath);
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

async function fetchJson<T>(url: string): Promise<T> {
  const headers: { 'User-Agent': string; Authorization?: string } = {
    'User-Agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Request failed with status code ${res.statusCode}`),
          );
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString();
          resolve(JSON.parse(data) as T);
        });
      })
      .on('error', reject);
  });
}

async function downloadFile(
  url: string,
  dest: string,
  options: { includeGitHubToken?: boolean } = { includeGitHubToken: false },
  redirectCount = 0,
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
  const parsedUrl = new URL(url);
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
      .get(parsedUrl, { headers }, (res) => {
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
            fail(new Error(`Invalid redirect URL: ${getErrorMessage(error)}`));
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
      })
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

export async function extractFile(file: string, dest: string): Promise<void> {
  if (file.endsWith('.tar.gz')) {
    await assertTarArchiveHasNoLinks(file);
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
}

async function assertTarArchiveHasNoLinks(file: string): Promise<void> {
  let unsupportedLinkPath: string | undefined;
  await tar.t({
    file,
    onReadEntry: (entry) => {
      if (
        !unsupportedLinkPath &&
        (entry.type === 'SymbolicLink' || entry.type === 'Link')
      ) {
        unsupportedLinkPath = entry.path;
      }
    },
  });
  if (unsupportedLinkPath) {
    throw new Error(
      `Tar archive contains unsupported link entry: ${unsupportedLinkPath}`,
    );
  }
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
