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
import * as https from 'node:https';
import { stat } from 'node:fs/promises';
import { parseGitHubRepoForReleases } from './github.js';

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
 * Fetch content from a URL
 */
function fetchUrl(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString());
        });
      })
      .on('error', () => resolve(null));
  });
}

/**
 * Fetch marketplace config from GitHub repository.
 * Primary: GitHub API (supports private repos with token)
 * Fallback: raw.githubusercontent.com (no rate limit for public repos)
 */
async function fetchGitHubMarketplaceConfig(
  owner: string,
  repo: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const token = process.env['GITHUB_TOKEN'];

  // Primary: GitHub API (works for private repos, but has rate limits)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/.claude-plugin/marketplace.json`;
  const apiHeaders: Record<string, string> = {
    'User-Agent': 'qwen-code',
    Accept: 'application/vnd.github.v3.raw',
  };
  if (token) {
    apiHeaders['Authorization'] = `token ${token}`;
  }

  let content = await fetchUrl(apiUrl, apiHeaders);

  // Fallback: raw.githubusercontent.com (no rate limit, public repos only)
  if (!content) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.claude-plugin/marketplace.json`;
    const rawHeaders: Record<string, string> = {
      'User-Agent': 'qwen-code',
    };
    content = await fetchUrl(rawUrl, rawHeaders);
  }

  if (!content) {
    return null;
  }

  try {
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

  // Step 2: Determine repo type and convert owner/repo format if needed
  if (isGitUrl(repo)) {
    // Git URL (http://, https://, git@, sso://)
    installMetadata = {
      source: repoSource,
      type: 'git',
      pluginName,
    };

    // Try to fetch marketplace config from GitHub
    try {
      const { owner, repo: repoName } = parseGitHubRepoForReleases(repoSource);
      marketplaceConfig = await fetchGitHubMarketplaceConfig(owner, repoName);
    } catch {
      // Not a valid GitHub URL or failed to fetch, continue without marketplace config
    }
  } else if (isOwnerRepoFormat(repo)) {
    // owner/repo format - convert to GitHub URL
    repoSource = convertOwnerRepoToGitHubUrl(repo);
    installMetadata = {
      source: repoSource,
      type: 'git',
      pluginName,
    };

    // Try to fetch marketplace config from GitHub
    try {
      const [owner, repoName] = repo.split('/');
      marketplaceConfig = await fetchGitHubMarketplaceConfig(owner, repoName);
    } catch {
      // Not a valid GitHub URL or failed to fetch, continue without marketplace config
    }
  } else {
    // Local path
    try {
      await stat(repo);
      installMetadata = {
        source: repo,
        type: 'local',
        pluginName,
      };

      // Try to read marketplace config from local path
      marketplaceConfig = await readLocalMarketplaceConfig(repo);
    } catch {
      throw new Error(`Install source not found: ${repo}`);
    }
  }

  // Step 3: If marketplace config exists, update type to marketplace
  if (marketplaceConfig) {
    installMetadata.type = 'marketplace';
    installMetadata.marketplaceConfig = marketplaceConfig;
    installMetadata.originSource = 'Claude';
  }

  return installMetadata;
}
