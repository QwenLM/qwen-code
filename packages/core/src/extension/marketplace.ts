/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionConfig } from './extensionManager.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { stat } from 'node:fs/promises';
import { parseGitHubRepoForReleases } from './github.js';
import { isScopedNpmPackage } from './npm.js';
import { redactUrlCredentials } from './redaction.js';
import { QWEN_MARKETPLACE_CONFIG_FILENAME } from './variables.js';
import {
  type MarketplaceConfig,
  parseMarketplaceDocument,
} from './marketplaceTypes.js';

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

/** Max time to wait for a single marketplace network request. */
const MARKETPLACE_FETCH_TIMEOUT_MS = 10000;

/**
 * Fetch content from a URL. Resolves to null on non-200, error, or timeout so a
 * slow/unreachable marketplace can never hang discovery indefinitely.
 */
function fetchUrl(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain so the socket can be freed
        done(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(Buffer.concat(chunks).toString()));
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.setTimeout(MARKETPLACE_FETCH_TIMEOUT_MS, () => {
      req.destroy();
      done(null);
    });
  });
}

/**
 * Candidate manifest paths within a marketplace repo, probed in order. The
 * Qwen-native manifest takes priority over the Claude one.
 */
const MARKETPLACE_MANIFEST_PATHS = [
  QWEN_MARKETPLACE_CONFIG_FILENAME,
  '.claude-plugin/marketplace.json',
] as const;

function parseMarketplaceJson(content: string): MarketplaceConfig | null {
  try {
    return parseMarketplaceDocument(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Fetch a file from a GitHub repository.
 * Primary: GitHub API (supports private repos with token)
 * Fallback: raw.githubusercontent.com (no rate limit for public repos)
 */
async function fetchGitHubFile(
  owner: string,
  repo: string,
  filePath: string,
): Promise<string | null> {
  const token = process.env['GITHUB_TOKEN'];

  // Primary: GitHub API (works for private repos, but has rate limits)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
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
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`;
    const rawHeaders: Record<string, string> = {
      'User-Agent': 'qwen-code',
    };
    content = await fetchUrl(rawUrl, rawHeaders);
  }

  return content;
}

/**
 * Fetch marketplace config from a GitHub repository, probing the Qwen-native
 * manifest first and falling back to the Claude one.
 */
async function fetchGitHubMarketplaceConfig(
  owner: string,
  repo: string,
): Promise<MarketplaceConfig | null> {
  for (const manifestPath of MARKETPLACE_MANIFEST_PATHS) {
    const content = await fetchGitHubFile(owner, repo, manifestPath);
    if (!content) {
      continue;
    }
    const config = parseMarketplaceJson(content);
    if (config) {
      return config;
    }
  }
  return null;
}

/**
 * Read marketplace config from local path
 */
async function readLocalMarketplaceConfig(
  localPath: string,
): Promise<MarketplaceConfig | null> {
  for (const manifestPath of MARKETPLACE_MANIFEST_PATHS) {
    try {
      const content = await fs.promises.readFile(
        path.join(localPath, manifestPath),
        'utf-8',
      );
      const config = parseMarketplaceJson(content);
      if (config) {
        return config;
      }
    } catch {
      // Manifest missing or unreadable; try the next candidate.
    }
  }
  return null;
}

/**
 * Loads a marketplace config from any supported source string, without
 * installing anything. Both manifest formats are supported — the Qwen-native
 * `qwen-marketplace.json` (probed first) and the Claude
 * `.claude-plugin/marketplace.json` — and the result is normalized into the
 * unified {@link MarketplaceConfig} model. Used by the marketplace registry /
 * Discover view to enumerate installable extensions.
 *
 * Supported sources:
 * - Local directory containing either manifest
 * - Local path directly to a marketplace JSON file (format auto-detected)
 * - `owner/repo`, `https://github.com/owner/repo`, `git@github.com:owner/repo.git`
 * - Arbitrary `https://host/.../marketplace.json` returning the JSON document
 *
 * Returns `null` when no marketplace config can be resolved.
 */
export async function loadMarketplaceConfigFromSource(
  source: string,
): Promise<MarketplaceConfig | null> {
  const trimmed = source.trim();

  // Priority 1: local path (directory holding a manifest, or a direct
  // marketplace JSON file).
  try {
    const stats = await stat(trimmed);
    if (stats.isDirectory()) {
      return await readLocalMarketplaceConfig(trimmed);
    }
    if (stats.isFile()) {
      try {
        const content = await fs.promises.readFile(trimmed, 'utf-8');
        return parseMarketplaceJson(content);
      } catch {
        return null;
      }
    }
  } catch {
    // Not a local path; continue.
  }

  // Priority 2: http(s) URL — try GitHub repo first, then a direct JSON doc.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const { owner, repo } = parseGitHubRepoForReleases(trimmed);
      const ghConfig = await fetchGitHubMarketplaceConfig(owner, repo);
      if (ghConfig) {
        return ghConfig;
      }
    } catch {
      // Not a github.com repo URL — fall through to direct-JSON fetch.
    }
    const content = await fetchUrl(trimmed, { 'User-Agent': 'qwen-code' });
    if (!content) {
      return null;
    }
    return parseMarketplaceJson(content);
  }

  // Priority 3: ssh/sso git URLs -> resolve owner/repo via github.
  if (trimmed.startsWith('git@') || trimmed.startsWith('sso://')) {
    // `git@github.com:owner/repo(.git)` isn't a parseable URL, so extract
    // owner/repo directly before falling back to the URL-based parser.
    const sshMatch = trimmed.match(
      /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    );
    if (sshMatch) {
      return fetchGitHubMarketplaceConfig(sshMatch[1], sshMatch[2]);
    }
    try {
      const { owner, repo } = parseGitHubRepoForReleases(trimmed);
      return await fetchGitHubMarketplaceConfig(owner, repo);
    } catch {
      return null;
    }
  }

  // Priority 4: owner/repo shorthand.
  if (isOwnerRepoFormat(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    return await fetchGitHubMarketplaceConfig(owner, repo);
  }

  return null;
}

export async function parseInstallSource(
  source: string,
): Promise<ExtensionInstallMetadata> {
  // Step 1: Parse source into repo and optional pluginName
  const { repo, pluginName } = parseSourceAndPluginName(source);

  let installMetadata: ExtensionInstallMetadata;
  let repoSource = repo;
  let marketplaceConfig: MarketplaceConfig | null = null;

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
  } else if (isGitUrl(repo)) {
    // Priority 2: Git URL (http://, https://, git@, sso://)
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
  } else if (isScopedNpmPackage(repo)) {
    // Priority 3: Scoped npm package (@scope/name, optionally @version)
    installMetadata = {
      source: repo,
      type: 'npm',
      pluginName,
    };
  } else if (isOwnerRepoFormat(repo)) {
    // Priority 3: owner/repo format - convert to GitHub URL
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
    // None of the above formats matched
    throw new Error(`Install source not found: ${redactUrlCredentials(repo)}`);
  }

  // Step 3: If marketplace config exists, tag the metadata with it
  if (marketplaceConfig) {
    installMetadata.marketplaceConfig = marketplaceConfig;
    installMetadata.originSource =
      marketplaceConfig.format === 'qwen' ? 'QwenCode' : 'Claude';
  }

  return installMetadata;
}
