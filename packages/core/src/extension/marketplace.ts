/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { GitProviderFactory } from '../git/factory.js';
import type { GitProvider } from '../git/types.js';

export interface MarketplaceInstallOptions {
  marketplaceUrl: string;
  pluginName: string;
  tempDir: string;
  requestConsent: (consent: string) => Promise<boolean>;
}

export interface MarketplaceInstallResult {
  config: ExtensionConfig;
  sourcePath: string;
  installMetadata: ExtensionInstallMetadata;
}

/**
 * Parse the install source string into repo and optional pluginName.
 * Format: <repo>:<pluginName> where pluginName is optional
 * The colon separator is only treated as a pluginName delimiter when:
 * - It's not part of a URL scheme (http://, https://, git@, sso://)
 * - It appears after the repo portion
 */
function parseSourceAndPluginName(source: string): {
  repo: string;
  pluginName?: string;
} {
  // Check if source contains a colon that could be a pluginName separator
  // We need to handle URL schemes that contain colons
  const urlSchemes = ['http://', 'https://', 'git@', 'sso://'];

  let repoEndIndex = source.length;
  let hasPluginName = false;

  // For URLs, find the last colon after the scheme
  for (const scheme of urlSchemes) {
    if (source.startsWith(scheme)) {
      const afterScheme = source.substring(scheme.length);
      const lastColonIndex = afterScheme.lastIndexOf(':');
      if (lastColonIndex !== -1) {
        // Check if what follows the colon looks like a pluginName (not a port number or path)
        const potentialPluginName = afterScheme.substring(lastColonIndex + 1);
        // Plugin name should not contain '/' and should not be a number (port)
        if (
          potentialPluginName &&
          !potentialPluginName.includes('/') &&
          !/^\d+/.test(potentialPluginName)
        ) {
          repoEndIndex = scheme.length + lastColonIndex;
          hasPluginName = true;
        }
      }
      break;
    }
  }

  // For non-URL sources (local paths or owner/repo format)
  if (
    repoEndIndex === source.length &&
    !urlSchemes.some((s) => source.startsWith(s))
  ) {
    const lastColonIndex = source.lastIndexOf(':');
    // On Windows, avoid treating drive letter as pluginName separator (e.g., C:\path)
    if (lastColonIndex > 1) {
      repoEndIndex = lastColonIndex;
      hasPluginName = true;
    }
  }

  if (hasPluginName) {
    return {
      repo: source.substring(0, repoEndIndex),
      pluginName: source.substring(repoEndIndex + 1),
    };
  }

  return { repo: source };
}

/**
 * Check if a string matches the owner/repo format (e.g., "anthropics/skills")
 */
function isOwnerRepoFormat(source: string): boolean {
  // owner/repo format: word/word, no slashes before, no protocol
  const ownerRepoRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
  return ownerRepoRegex.test(source);
}

/**
 * Convert owner/repo format to GitHub HTTPS URL
 */
function convertOwnerRepoToGitHubUrl(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}`;
}

/**
 * Check if source is a git URL
 */
function isGitUrl(source: string): boolean {
  return (
    source.startsWith('http://') ||
    source.startsWith('https://') ||
    source.startsWith('git@') ||
    source.startsWith('sso://')
  );
}

/**
 * Fetch marketplace config from repository.
 */
async function fetchMarketplaceConfig(
  provider: GitProvider,
  owner: string,
  repo: string,
): Promise<ClaudeMarketplaceConfig | null> {
  try {
    const content = await provider.getFileContent(
      owner,
      repo,
      '.claude-plugin/marketplace.json',
      'HEAD',
    );
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

/**
 * Read marketplace config from local path
 */
async function readLocalMarketplaceConfig(
  localPath: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const marketplaceConfigPath = path.join(
    localPath,
    '.claude-plugin',
    'marketplace.json',
  );
  try {
    const content = await fs.promises.readFile(marketplaceConfigPath, 'utf-8');
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

export async function parseInstallSource(
  source: string,
): Promise<ExtensionInstallMetadata> {
  // Step 1: Parse source into repo and optional pluginName
  const { repo, pluginName } = parseSourceAndPluginName(source);

  let installMetadata: ExtensionInstallMetadata;
  let repoSource = repo;
  let marketplaceConfig: ClaudeMarketplaceConfig | null = null;

  // Step 2: Determine repo type with correct priority order
  // Priority 1: Check if it's a local path that exists
  let isLocalPath = false;
  try {
    await stat(repo);
    isLocalPath = true;
  } catch {
    // Not a local path or doesn't exist, continue with other checks
  }

  if (isLocalPath) {
    // Local path exists
    installMetadata = {
      source: repo,
      type: 'local',
      pluginName,
    };

    // Try to read marketplace config from local path
    marketplaceConfig = await readLocalMarketplaceConfig(repo);
  } else if (isGitUrl(repo) || isOwnerRepoFormat(repo)) {
    // Priority 2: Git URL or owner/repo format
    if (isOwnerRepoFormat(repo)) {
      repoSource = convertOwnerRepoToGitHubUrl(repo);
    }

    installMetadata = {
      source: repoSource,
      type: 'git',
      pluginName,
    };

    // Try to fetch marketplace config using the appropriate provider
    try {
      const provider = GitProviderFactory.getProvider(repoSource);
      const { owner, repo: repoName } = provider.getRepoInfo(repoSource);
      marketplaceConfig = await fetchMarketplaceConfig(
        provider,
        owner,
        repoName,
      );
    } catch {
      // Failed to determine provider or fetch config
    }
  } else {
    // None of the above formats matched
    throw new Error(`Install source not found: ${repo}`);
  }

  // Step 3: If marketplace config exists, update type to marketplace
  if (marketplaceConfig) {
    installMetadata.marketplaceConfig = marketplaceConfig;
    installMetadata.originSource = 'Claude';
  }

  return installMetadata;
}
