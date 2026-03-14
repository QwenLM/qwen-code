/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit } from 'simple-git';
import { getErrorMessage } from '../utils/errors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { GitProviderFactory } from '../git/index.js';
import {
  ExtensionUpdateState,
  type Extension,
  type ExtensionConfig,
  type ExtensionManager,
} from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';

const debugLogger = createDebugLogger('EXT_GITHUB');

export interface GitReleaseDownloadResult {
  tagName: string;
  type: 'git' | 'github-release' | 'gitlab-release' | string;
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
  const provider = GitProviderFactory.getProvider(installMetadata.source);
  await provider.clone(
    installMetadata.source,
    destination,
    installMetadata.ref,
  );
}

export function getRepoInfoFromSource(source: string): {
  owner: string;
  repo: string;
} {
  const provider = GitProviderFactory.getProvider(source);
  return provider.getRepoInfo(source);
}

export async function checkForExtensionUpdate(
  extension: Extension,
  extensionManager: ExtensionManager,
): Promise<ExtensionUpdateState> {
  const installMetadata = extension.installMetadata;
  if (installMetadata?.type === 'local') {
    let latestConfig: ExtensionConfig | undefined;
    try {
      latestConfig = extensionManager.loadExtensionConfig({
        extensionDir: installMetadata.source,
      });
    } catch (e) {
      debugLogger.error(
        `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${installMetadata.source}. Error: ${getErrorMessage(e)}`,
      );
      return ExtensionUpdateState.NOT_UPDATABLE;
    }

    if (!latestConfig) {
      debugLogger.error(
        `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${installMetadata.source}`,
      );
      return ExtensionUpdateState.NOT_UPDATABLE;
    }
    if (latestConfig.version !== extension.version) {
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    }
    return ExtensionUpdateState.UP_TO_DATE;
  }
  if (
    !installMetadata ||
    installMetadata.originSource === 'Claude' ||
    (installMetadata.type !== 'git' &&
      installMetadata.type !== 'github-release' &&
      installMetadata.type !== 'gitlab-release')
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  try {
    const provider = GitProviderFactory.getProvider(installMetadata.source);
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

      // Determine the ref to check on the remote.
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
      const { owner, repo } = provider.getRepoInfo(source);

      const latestReleaseTag = await provider.getLatestRelease(owner, repo);
      if (latestReleaseTag !== releaseTag) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    }
  } catch (error) {
    debugLogger.error(
      `Failed to check for updates for extension "${installMetadata.source}": ${getErrorMessage(error)}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}

export async function downloadFromGitRelease(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<GitReleaseDownloadResult> {
  const { source, ref } = installMetadata;
  const provider = GitProviderFactory.getProvider(source);

  try {
    const result = await provider.downloadRelease(source, destination, ref);

    // For regular git releases (GitHub, GitLab), the repository is put inside
    // of a top level directory. In this case we should see exactly two file
    // in the destination dir, the archive and the directory.
    // If we see that, validate that the dir has a extension configuration
    // file and then move all files from the directory up one level
    // into the destination directory.
    const entries = await fs.promises.readdir(destination, {
      withFileTypes: true,
    });
    if (entries.length === 1) {
      // if archive was already deleted by provider
      const lonelyDir = entries.find((entry) => entry.isDirectory());
      if (lonelyDir) {
        await moveFilesUp(destination, lonelyDir.name);
      }
    } else if (entries.length === 2) {
      const lonelyDir = entries.find((entry) => entry.isDirectory());
      if (lonelyDir) {
        await moveFilesUp(destination, lonelyDir.name);
      }
    }

    return result as GitReleaseDownloadResult;
  } catch (error) {
    throw new Error(
      `Failed to download release from ${installMetadata.source}: ${getErrorMessage(error)}`,
    );
  }
}

async function moveFilesUp(
  destination: string,
  dirName: string,
): Promise<void> {
  const hasQwenConfig = fs.existsSync(
    path.join(destination, dirName, EXTENSIONS_CONFIG_FILENAME),
  );
  const hasGeminiConfig = fs.existsSync(
    path.join(destination, dirName, 'gemini-extension.json'),
  );
  const hasMarketplaceConfig = fs.existsSync(
    path.join(destination, dirName, '.claude-plugin/marketplace.json'),
  );
  const hasClaudePluginConfig = fs.existsSync(
    path.join(destination, dirName, '.claude-plugin/plugin.json'),
  );
  if (
    hasQwenConfig ||
    hasGeminiConfig ||
    hasMarketplaceConfig ||
    hasClaudePluginConfig
  ) {
    const dirPathToExtract = path.join(destination, dirName);
    const extractedDirFiles = await fs.promises.readdir(dirPathToExtract);
    for (const file of extractedDirFiles) {
      await fs.promises.rename(
        path.join(dirPathToExtract, file),
        path.join(destination, file),
      );
    }
    await fs.promises.rmdir(dirPathToExtract);
  }
}
