/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../utils/errors.js';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
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
  convertCompatibleExtension,
  SUPPORTED_EXTENSION_MANIFESTS,
} from './extension-converter.js';
import {
  AGENT_PLUGIN_MANIFEST,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';
import {
  MAX_ARCHIVE_EXPANDED_BYTES,
  assertDirectorySymlinksAreSafe,
  assertTarArchiveLinksAreSafe,
  type TarArchiveSafetyOptions,
} from './archive-safety.js';
import { resolveNetworkTarget } from './network-policy.js';
import { extractZipArchive } from './zip-extraction.js';
import { loadSimpleGit } from '../utils/load-simple-git.js';
import {
  ExtensionCredentialUnavailableError,
  resolveStoredGitCredential,
  type GitCredential,
} from './extension-git-credentials.js';
import { createExtensionGitClient } from './extension-git-client.js';

const debugLogger = createDebugLogger('EXT_GITHUB');
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'] as const;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const ARCHIVE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const MINIMUM_PINNED_GIT_VERSION = { major: 2, minor: 37 } as const;

interface GithubReleaseData {
  assets: Asset[];
  tag_name: string;
  tarball_url?: string;
  zipball_url?: string;
}

interface GitHubCommitData {
  sha: string;
}

interface GitHubTreeEntry {
  path?: string;
  type?: string;
}

interface GitHubTreeData {
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
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

function getGitHubCredential(source: string): GitCredential | undefined {
  const token = getGitHubToken();
  if (!token) return undefined;
  try {
    const parsedUrl = new URL(source);
    if (
      parsedUrl.protocol === 'https:' &&
      parsedUrl.hostname === 'github.com' &&
      !parsedUrl.username
    ) {
      return { username: token, password: '' };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type LocalGitVersion = {
  major: number;
  minor: number;
  patch?: number | string;
};

// The local Git version cannot change within a process lifetime, so probe it
// once instead of spawning a `git version` subprocess from both the fallback
// gate and the pinned-Git assert for every extension.
let localGitVersionPromise: Promise<LocalGitVersion> | undefined;

function getLocalGitVersion(): Promise<LocalGitVersion> {
  localGitVersionPromise ??= (async () => {
    const { simpleGit } = await loadSimpleGit();
    return await simpleGit().version();
  })();
  return localGitVersionPromise;
}

export function resetLocalGitVersionCacheForTesting(): void {
  localGitVersionPromise = undefined;
}

function isPinnedGitVersionSupported(version: {
  major: number;
  minor: number;
}): boolean {
  return (
    version.major > MINIMUM_PINNED_GIT_VERSION.major ||
    (version.major === MINIMUM_PINNED_GIT_VERSION.major &&
      version.minor >= MINIMUM_PINNED_GIT_VERSION.minor)
  );
}

async function isPinnedGitSupported(): Promise<boolean> {
  return isPinnedGitVersionSupported(await getLocalGitVersion());
}

async function assertPinnedGitSupported(): Promise<void> {
  const version = await getLocalGitVersion();
  if (!isPinnedGitVersionSupported(version)) {
    const detectedVersion = [version.major, version.minor, version.patch]
      .filter((component) => component !== undefined)
      .join('.');
    throw new Error(
      `Public extension Git installs require Git 2.37 or newer unless the source is an anonymous public GitHub root repository; found Git ${detectedVersion}. Upgrade Git for credentialed, non-GitHub, nested, submodule, or Git LFS installs.`,
    );
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

function resolveGitRef(ref: string | undefined): string {
  const resolvedRef = ref || 'HEAD';
  if (resolvedRef.startsWith('-')) {
    throw new Error('Git refs must not start with "-".');
  }
  return resolvedRef;
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
  credential?: GitCredential,
  hideSource = false,
): Promise<string> {
  const redactedSource = hideSource
    ? 'credentialed HTTPS Git source'
    : redactUrlCredentials(installMetadata.source);
  try {
    const refToFetch = resolveGitRef(installMetadata.ref);
    const { simpleGit } = await loadSimpleGit();
    let networkConfig: string[] = [];
    if (installMetadata.networkPolicy === 'public') {
      if (!/^https:/i.test(installMetadata.source)) {
        throw new Error('Public extension Git installs must use HTTPS.');
      }
      await assertPinnedGitSupported();
      const networkTarget = await resolveNetworkTarget(
        installMetadata.source,
        installMetadata.networkPolicy,
        signal,
      );
      networkConfig = networkTarget.curlResolve
        ? createPinnedGitConfig(networkTarget.curlResolve)
        : [];
    }
    const effectiveCredential =
      credential ?? getGitHubCredential(installMetadata.source);
    const git = createExtensionGitClient(simpleGit, {
      baseDir: destination,
      signal,
      networkPolicy: installMetadata.networkPolicy,
      networkConfig,
      authentication: effectiveCredential
        ? { source: installMetadata.source, credential: effectiveCredential }
        : undefined,
    });
    signal?.throwIfAborted();
    // On Windows, symlinks require elevated privileges by default, so we
    // disable them to avoid "Permission denied" errors during checkout.
    const symlinkValue = os.platform() === 'win32' ? 'false' : 'true';
    await git.clone(installMetadata.source, './', [
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

    const remoteUrl = remotes[0].refs.fetch;
    if (!remoteUrl) {
      throw new Error(`Unable to find a fetch URL for repo ${redactedSource}`);
    }
    await git.fetch(remoteUrl, refToFetch);
    signal?.throwIfAborted();

    // Detached HEAD is expected here — we only need the fetched content.
    await git.checkout('FETCH_HEAD');
    signal?.throwIfAborted();
    return (await git.revparse(['HEAD'])).trim();
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
  // Strip a trailing `.git` suffix (from clone-style URLs like `owner/repo.git`)
  // only. An unanchored replace would mangle repo names that merely contain
  // `.git`, e.g. GitHub Pages repos named `<user>.github.io`.
  const repo = parts[1].replace(/\.git$/, '');

  if (owner.startsWith('git@github.com')) {
    throw new Error(
      `GitHub release-based extensions are not supported for SSH. You must use an HTTPS URI with a personal access token to download releases from private repositories. You can set your personal access token in the GITHUB_TOKEN environment variable and install the extension via SSH.`,
    );
  }

  return { owner, repo };
}

function parseAnonymousPublicGitHubRepo(source: string): {
  owner: string;
  repo: string;
} {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Older-Git fallback requires a valid GitHub HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Older-Git fallback only supports anonymous https://github.com/{owner}/{repo}[.git] sources.',
    );
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      'Older-Git fallback only supports a GitHub repository root URL.',
    );
  }
  return { owner: match[1], repo: match[2] };
}

export async function shouldUsePublicGitHubArchiveFallback(
  installMetadata: ExtensionInstallMetadata,
): Promise<boolean> {
  if (
    installMetadata.type !== 'git' ||
    installMetadata.networkPolicy !== 'public' ||
    installMetadata.credentialPersistence ||
    installMetadata.marketplaceConfig ||
    installMetadata.pluginName ||
    installMetadata.externalContent
  ) {
    return false;
  }
  try {
    parseAnonymousPublicGitHubRepo(installMetadata.source);
  } catch {
    return false;
  }
  return !(await isPinnedGitSupported());
}

// A Git LFS pointer is a small text file (~130 bytes). Only files small
// enough to plausibly be pointers are read, keeping the scan cheap.
const GIT_LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MAX_LFS_POINTER_SCAN_BYTES = 512;

async function assertArchivePreservesGitSemantics(destination: string) {
  const pending = [destination];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const isArchiveRoot = directory === destination;
    for (const entry of await fs.promises.readdir(directory, {
      withFileTypes: true,
    })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      // Git gives submodule semantics only to a root-level `.gitmodules`;
      // a nested copy is an inert regular file.
      if (isArchiveRoot && entry.name === '.gitmodules') {
        throw new Error(
          'Older-Git fallback does not support repositories with submodules.',
        );
      }
      // Detect Git LFS by pointer-file content rather than `.gitattributes`
      // grammar: codeload archives honor `.gitattributes` `export-ignore`,
      // so the attributes file itself can be hidden from the extracted tree,
      // and attribute macros or case-variant names also bypass a
      // grammar-only check. Any LFS-tracked file arrives as a raw pointer
      // file, so scanning for pointer content catches every variant.
      const stats = await fs.promises.stat(entryPath);
      if (stats.size > MAX_LFS_POINTER_SCAN_BYTES) {
        continue;
      }
      const content = await fs.promises.readFile(entryPath, 'utf8');
      if (content.startsWith(GIT_LFS_POINTER_PREFIX)) {
        throw new Error(
          'Older-Git fallback does not support repositories using Git LFS.',
        );
      }
    }
  }
}

// codeload archives honor `.gitattributes` `export-ignore`, so a repository
// can strip its root `.gitmodules` from the archive and slip past the
// extracted-tree presence check above. The commit's tree object still lists
// every path regardless of export-ignore, so verify it directly: a root
// `.gitmodules` blob or any gitlink (type `commit`) entry means the archive
// would silently drop submodule content.
async function assertGitHubTreeHasNoSubmodules(
  owner: string,
  repo: string,
  commitSha: string,
  signal?: AbortSignal,
): Promise<void> {
  const treeData = await fetchJson<GitHubTreeData>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    signal,
    'public',
    false,
  );
  if (treeData.truncated) {
    throw new Error(
      'Older-Git fallback cannot verify that the repository is free of submodules because GitHub truncated the tree listing.',
    );
  }
  const entries = Array.isArray(treeData.tree) ? treeData.tree : [];
  const hasSubmoduleSemantics = entries.some(
    (entry) => entry?.path === '.gitmodules' || entry?.type === 'commit',
  );
  if (hasSubmoduleSemantics) {
    throw new Error(
      'Older-Git fallback does not support repositories with submodules.',
    );
  }
}

async function resolvePublicGitHubCommitSha(
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  const commitData = await fetchJson<GitHubCommitData>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
    signal,
    'public',
    false,
  );
  if (!/^[a-f0-9]{40}$/i.test(commitData.sha)) {
    throw new Error('GitHub returned an invalid commit SHA.');
  }
  return commitData.sha.toLowerCase();
}

export async function downloadPublicGitHubArchiveFallback(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  const { owner, repo } = parseAnonymousPublicGitHubRepo(
    installMetadata.source,
  );
  const commitSha = await resolvePublicGitHubCommitSha(
    owner,
    repo,
    installMetadata.ref || 'HEAD',
    signal,
  );
  await assertGitHubTreeHasNoSubmodules(owner, repo, commitSha, signal);
  // A random staging name avoids clobbering (or being filtered out as) a
  // repository file that happens to share the archive name.
  const archivePath = path.join(
    destination,
    `github-source-${crypto.randomUUID()}.tar.gz`,
  );
  await downloadFile(
    `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${commitSha}`,
    archivePath,
    { includeGitHubToken: false, networkPolicy: 'public' },
    0,
    signal,
  );
  await extractArchiveFile(archivePath, destination, signal, {
    enforceResourceLimits: true,
    // Public repositories legitimately carry in-repo symlinks (the reported
    // case is a root `AGENTS.md -> CLAUDE.md`), and this fallback is the only
    // way to install them without Git 2.37+. Targets that escape the archive
    // root or do not point directly to an archived file are still refused.
    allowContainedSymlinks: true,
  });
  await fs.promises.unlink(archivePath);
  await assertArchivePreservesGitSemantics(destination);
  return commitSha;
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
    if (installMetadata.source.startsWith('upload:')) {
      return ExtensionUpdateState.NOT_UPDATABLE;
    }
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
        extensionDir = tempDir;
      }
      if (tempDir !== undefined || installMetadata.originSource === 'Qoder') {
        const sourceBeforeConversion = extensionDir;
        const converted = await convertCompatibleExtension(
          sourceBeforeConversion,
          installMetadata.pluginName,
          installMetadata.networkPolicy,
          signal,
        );
        extensionDir = converted.extensionDir;
        if (extensionDir !== sourceBeforeConversion) {
          convertedDir = extensionDir;
        }
      }
      signal?.throwIfAborted();
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
      const converted = await convertCompatibleExtension(
        tempDir,
        installMetadata.pluginName,
        installMetadata.networkPolicy,
        signal,
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
    (installMetadata.type !== 'git' &&
      installMetadata.type !== 'github-release')
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  if (
    installMetadata.externalContent === true ||
    (installMetadata.externalContent === undefined &&
      installMetadata.originSource === 'Claude' &&
      installMetadata.pluginName !== undefined)
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  try {
    if (installMetadata.type === 'git') {
      const refToCheck = resolveGitRef(installMetadata.ref);
      const storedCredential =
        installMetadata.credentialPersistence === 'stored'
          ? (await resolveStoredGitCredential(extension.path)).credential
          : undefined;
      if (await shouldUsePublicGitHubArchiveFallback(installMetadata)) {
        if (!installMetadata.gitCommit) {
          return ExtensionUpdateState.NOT_UPDATABLE;
        }
        const { owner, repo } = parseAnonymousPublicGitHubRepo(
          installMetadata.source,
        );
        const remoteSha = await resolvePublicGitHubCommitSha(
          owner,
          repo,
          refToCheck,
          signal,
        );
        return remoteSha === installMetadata.gitCommit
          ? ExtensionUpdateState.UP_TO_DATE
          : ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      const { simpleGit } = await loadSimpleGit();
      if (installMetadata.networkPolicy === 'public') {
        await assertPinnedGitSupported();
      }
      let remoteUrl: string;
      let localHash: string;
      if (installMetadata.gitCommit) {
        remoteUrl = installMetadata.source;
        localHash = installMetadata.gitCommit;
      } else {
        if (
          installMetadata.originSource === 'Claude' ||
          installMetadata.originSource === 'Qoder'
        ) {
          return ExtensionUpdateState.NOT_UPDATABLE;
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
        const fetchedRemoteUrl = remotes[0].refs.fetch;
        if (!fetchedRemoteUrl) {
          debugLogger.error(
            `No fetch URL found for git remote ${remotes[0].name}.`,
          );
          return ExtensionUpdateState.ERROR;
        }
        remoteUrl = fetchedRemoteUrl;
        localHash = await localGit.revparse(['HEAD']);
      }
      let networkConfig: string[] = [];
      if (installMetadata.networkPolicy === 'public') {
        const parsedRemote = new URL(remoteUrl);
        parsedRemote.username = '';
        parsedRemote.password = '';
        const remoteTarget = await resolveNetworkTarget(
          parsedRemote,
          installMetadata.networkPolicy,
          signal,
        );
        networkConfig = remoteTarget.curlResolve
          ? createPinnedGitConfig(remoteTarget.curlResolve)
          : [];
      }
      signal?.throwIfAborted();
      const effectiveCredential =
        storedCredential ?? getGitHubCredential(remoteUrl);
      const git = createExtensionGitClient(simpleGit, {
        baseDir: extension.path,
        signal,
        networkPolicy: installMetadata.networkPolicy,
        networkConfig,
        authentication: effectiveCredential
          ? { source: remoteUrl, credential: effectiveCredential }
          : undefined,
      });
      const refPatterns = installMetadata.ref
        ? [refToCheck, `${refToCheck}^{}`]
        : [refToCheck];

      const lsRemoteOutput = await git.listRemote([remoteUrl, ...refPatterns]);
      signal?.throwIfAborted();

      if (typeof lsRemoteOutput !== 'string' || lsRemoteOutput.trim() === '') {
        debugLogger.error(`Git ref ${refToCheck} not found.`);
        return ExtensionUpdateState.ERROR;
      }

      const remoteLines = lsRemoteOutput.trim().split('\n');
      const peeledLine = remoteLines.find((line) =>
        line.split('\t')[1]?.endsWith('^{}'),
      );
      const remoteLine = peeledLine ?? remoteLines[0];
      const remoteHash = remoteLine?.split('\t')[0];
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
    if (error instanceof ExtensionCredentialUnavailableError) throw error;
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
  options: TarArchiveSafetyOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(
      `Unsupported archive file for extension install: ${redactUrlCredentials(archivePath)}`,
    );
  }
  try {
    await extractFile(archivePath, destination, signal, options);
    signal?.throwIfAborted();
    await flattenSingleExtensionDirectory(destination, archivePath);
    signal?.throwIfAborted();
    if (options.allowContainedSymlinks === true) {
      await assertDirectorySymlinksAreSafe(destination, signal, {
        maxExpandedBytes:
          options.enforceResourceLimits === true
            ? MAX_ARCHIVE_EXPANDED_BYTES
            : undefined,
        excludePath: archivePath,
      });
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      'Extension archive could not be extracted. Make sure it is a valid ' +
        `.zip or .tar.gz file. ${getErrorMessage(error)}`,
    );
  }
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

const MAX_API_REDIRECTS = 5;

async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'],
  includeGitHubToken = true,
  redirectCount = 0,
): Promise<T> {
  const timeoutError = new Error('Timed out fetching GitHub API response');
  const timeoutController = new AbortController();
  const hardDeadline = setTimeout(
    () => timeoutController.abort(timeoutError),
    ARCHIVE_DOWNLOAD_TIMEOUT_MS,
  );
  hardDeadline.unref();
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const headers: { 'User-Agent': string; Authorization?: string } = {
    'User-Agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (includeGitHubToken && token) {
    headers.Authorization = `token ${token}`;
  }
  let target;
  try {
    target = networkPolicy
      ? await resolveNetworkTarget(url, networkPolicy, requestSignal)
      : { url: new URL(url) };
    requestSignal.throwIfAborted();
  } catch (error) {
    clearTimeout(hardDeadline);
    throw requestSignal.aborted ? requestSignal.reason : error;
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(hardDeadline);
      requestSignal.removeEventListener('abort', onAbort);
    };
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(requestSignal.aborted ? requestSignal.reason : error);
    };
    let req: ReturnType<typeof https.get> | undefined;
    const onAbort = () => {
      req?.destroy();
      fail(requestSignal.reason);
    };
    try {
      req = https.get(
        url,
        {
          headers,
          signal: requestSignal,
          lookup: target.lookup,
          ...(target.lookup ? { agent: false } : {}),
        },
        (res) => {
          res.on('error', fail);
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            res.resume();
            if (redirectCount >= MAX_API_REDIRECTS) {
              return fail(
                new Error('Too many redirects while fetching GitHub API data'),
              );
            }
            if (!res.headers.location) {
              return fail(
                new Error('Redirect response missing location header'),
              );
            }
            let redirectUrl: URL;
            try {
              redirectUrl = new URL(res.headers.location, url);
            } catch (error) {
              return fail(
                new Error(`Invalid redirect URL: ${getErrorMessage(error)}`),
              );
            }
            if (redirectUrl.protocol !== 'https:') {
              return fail(
                new Error(
                  `Unsupported redirect URL protocol: ${redirectUrl.protocol}`,
                ),
              );
            }
            cleanup();
            // Every hop is re-resolved against the network policy above, and
            // the token never follows a redirect to a different host.
            fetchJson<T>(
              redirectUrl.toString(),
              signal,
              networkPolicy,
              redirectUrl.host === target.url.host ? includeGitHubToken : false,
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
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString()) as T);
            } catch (error) {
              fail(error);
            }
          });
        },
      );
      req.on('error', fail);
    } catch (error) {
      fail(error);
      return;
    }
    requestSignal.addEventListener('abort', onAbort, { once: true });
    if (requestSignal.aborted) {
      onAbort();
    }
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
  const timeoutError = new Error('Timed out downloading extension archive');
  const timeoutController = new AbortController();
  const hardDeadline = setTimeout(
    () => timeoutController.abort(timeoutError),
    ARCHIVE_DOWNLOAD_TIMEOUT_MS,
  );
  hardDeadline.unref();
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const headers: { 'User-agent': string; Authorization?: string } = {
    'User-agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (options.includeGitHubToken === true && token) {
    headers.Authorization = `token ${token}`;
  }
  let target;
  try {
    target = options.networkPolicy
      ? await resolveNetworkTarget(url, options.networkPolicy, requestSignal)
      : { url: new URL(url) };
    requestSignal.throwIfAborted();
  } catch (error) {
    clearTimeout(hardDeadline);
    throw requestSignal.aborted ? requestSignal.reason : error;
  }
  const parsedUrl = target.url;
  if (parsedUrl.protocol !== 'https:') {
    clearTimeout(hardDeadline);
    throw new Error(`Unsupported download URL protocol: ${parsedUrl.protocol}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(hardDeadline);
      requestSignal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(requestSignal.aborted ? requestSignal.reason : error);
    };
    const onAbort = () => {
      req.destroy();
      fail(requestSignal.reason);
    };
    const req = https
      .get(
        url,
        {
          headers,
          signal: requestSignal,
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
      requestSignal.addEventListener('abort', onAbort, { once: true });
      if (requestSignal.aborted) {
        onAbort();
      } else {
        req.setTimeout(ARCHIVE_DOWNLOAD_TIMEOUT_MS, () => {
          req.destroy();
          fail(timeoutError);
        });
      }
    }
  });
}

export async function extractFile(
  file: string,
  dest: string,
  signal?: AbortSignal,
  options: TarArchiveSafetyOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  if (file.endsWith('.tar.gz')) {
    await assertTarArchiveLinksAreSafe(file, signal, options);
    signal?.throwIfAborted();
    try {
      await pipeline(
        fs.createReadStream(file),
        tar.x({
          cwd: dest,
          // The opt-in fallback intentionally treats every tar warning as a
          // failure; see docs/design/safe-archive-symlinks.md.
          strict: options.allowContainedSymlinks === true,
        }),
        { signal },
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  } else if (file.endsWith('.zip')) {
    await extractZipArchive(file, dest, signal);
  } else {
    throw new Error(`Unsupported file extension for extraction: ${file}`);
  }
  signal?.throwIfAborted();
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
  return [
    ...SUPPORTED_EXTENSION_MANIFESTS,
    `${AGENT_PLUGIN_MANIFEST} (Agent Plugins)`,
  ].join(', ');
}

function hasSupportedExtensionSourceManifest(rootPath: string): boolean {
  return (
    getAgentPluginSchemaStatus(rootPath) !== 'unrelated' ||
    SUPPORTED_EXTENSION_MANIFESTS.some((manifestPath) =>
      fs.existsSync(path.join(rootPath, manifestPath)),
    )
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
