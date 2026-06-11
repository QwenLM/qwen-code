/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution of Qwen-native marketplace entries (`qwen-marketplace.json`).
 * Locates the extension code an entry points at; the located directory then
 * goes through the regular format-detection/conversion chain, so entries may
 * reference Qwen, Gemini, or Claude extensions alike.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { cloneFromGit, downloadFromGitHubRelease } from './github.js';
import { downloadFromNpmRegistry } from './npm.js';
import { redactUrlCredentials } from './redaction.js';
import { ExtensionStorage } from './storage.js';
import { QWEN_MARKETPLACE_CONFIG_FILENAME } from './variables.js';
import type {
  QwenMarketplaceConfig,
  QwenMarketplaceEntryConfig,
} from './marketplaceTypes.js';

/** Result of locating a marketplace entry's extension code. */
export interface ResolvedMarketplaceEntry {
  /** Directory holding the entry's extension code. */
  extensionDir: string;
  /**
   * Temporary download directory created for a remote entry (git/github/npm/
   * URL). The caller owns its lifecycle and must remove it after use. Unset for
   * local entries resolved inside the marketplace checkout.
   */
  tempDownloadDir?: string;
}

export function readQwenMarketplaceConfig(
  marketplaceDir: string,
): QwenMarketplaceConfig | null {
  const configPath = path.join(
    marketplaceDir,
    QWEN_MARKETPLACE_CONFIG_FILENAME,
  );
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as QwenMarketplaceConfig;
    if (typeof parsed?.name !== 'string' || !Array.isArray(parsed.extensions)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function downloadFromGit(
  source: string,
  ref: string | undefined,
  destination: string,
): Promise<void> {
  const installMetadata: ExtensionInstallMetadata = {
    source,
    type: 'git',
    ref,
    originSource: 'QwenCode',
  };
  if (ref) {
    await cloneFromGit(installMetadata, destination);
    return;
  }
  try {
    await downloadFromGitHubRelease(installMetadata, destination);
  } catch {
    await cloneFromGit(installMetadata, destination);
  }
}

/**
 * Throws if `target` resolves outside `baseDir`. Guards against marketplace
 * entries whose `source` / `path` / `extensionRoot` use `..` or an absolute
 * path to escape the marketplace checkout and pull unrelated files into the
 * install.
 */
function assertWithin(baseDir: string, target: string, label: string): void {
  const rel = path.relative(path.resolve(baseDir), path.resolve(target));
  if (rel === '') {
    return;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Marketplace entry ${label} "${target}" escapes the marketplace directory`,
    );
  }
}

function resolveSubdir(baseDir: string, subPath: string | undefined): string {
  if (!subPath) {
    return baseDir;
  }
  const subDir = path.join(baseDir, subPath);
  assertWithin(baseDir, subDir, 'path');
  if (!fs.existsSync(subDir)) {
    throw new Error(`Extension subdirectory "${subPath}" not found`);
  }
  return subDir;
}

/**
 * Creates a temp dir, fetches into it, and locates the extension subdir within
 * it. If the fetch or subdir resolution throws, the temp dir is removed before
 * propagating so a failed remote entry never leaks a download directory.
 */
async function downloadEntry(
  fetch: (downloadDir: string) => Promise<void>,
  locate: (downloadDir: string) => string = (downloadDir) => downloadDir,
): Promise<ResolvedMarketplaceEntry> {
  const downloadDir = await ExtensionStorage.createTmpDir();
  try {
    await fetch(downloadDir);
    return { extensionDir: locate(downloadDir), tempDownloadDir: downloadDir };
  } catch (error) {
    await fs.promises.rm(downloadDir, { recursive: true, force: true });
    throw error;
  }
}

async function resolveEntrySource(
  entry: QwenMarketplaceEntryConfig,
  marketplaceDir: string,
  extensionRoot: string | undefined,
): Promise<ResolvedMarketplaceEntry> {
  const source = entry.source;

  if (typeof source === 'string') {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return downloadEntry((downloadDir) =>
        downloadFromGit(source, undefined, downloadDir),
      );
    }
    // Other git protocols can't be expressed as a string source (a string is
    // either an http(s) URL or a path); point the author at the structured
    // form rather than treating the URL as a bogus relative path.
    if (
      source.startsWith('git@') ||
      source.startsWith('ssh://') ||
      source.startsWith('git://') ||
      source.startsWith('sso://')
    ) {
      throw new Error(
        `Git URL source "${redactUrlCredentials(source)}" must use the ` +
          `structured form { "type": "git", "url": "..." }`,
      );
    }
    const root = extensionRoot
      ? path.join(marketplaceDir, extensionRoot)
      : marketplaceDir;
    const sourcePath = path.resolve(root, source);
    assertWithin(marketplaceDir, sourcePath, 'source');
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Extension source not found at ${sourcePath}`);
    }
    return { extensionDir: sourcePath };
  }

  if (source.type === 'github') {
    return downloadEntry(
      (downloadDir) =>
        downloadFromGit(
          `https://github.com/${source.repo}`,
          source.ref,
          downloadDir,
        ),
      (downloadDir) => resolveSubdir(downloadDir, source.path),
    );
  }

  if (source.type === 'git') {
    return downloadEntry(
      (downloadDir) => downloadFromGit(source.url, source.ref, downloadDir),
      (downloadDir) => resolveSubdir(downloadDir, source.path),
    );
  }

  if (source.type === 'npm') {
    return downloadEntry((downloadDir) => {
      const installMetadata: ExtensionInstallMetadata = {
        source: source.package,
        type: 'npm',
        originSource: 'QwenCode',
      };
      return downloadFromNpmRegistry(installMetadata, downloadDir).then(
        () => undefined,
      );
    });
  }

  throw new Error(
    `Unsupported qwen marketplace entry source: ${redactUrlCredentials(
      JSON.stringify(source),
    )}`,
  );
}

/**
 * Resolves the directory holding the extension code for a named entry of a
 * Qwen marketplace checkout. Relative entries resolve inside the checkout
 * (honoring `metadata.extensionRoot`); remote entries (git/github/npm/URL) are
 * fetched into a fresh temporary directory, reported as `tempDownloadDir` so
 * the caller can clean it up.
 */
export async function resolveQwenMarketplaceExtensionDir(
  marketplaceDir: string,
  extensionName: string,
): Promise<ResolvedMarketplaceEntry> {
  const config = readQwenMarketplaceConfig(marketplaceDir);
  if (!config) {
    throw new Error(
      `Marketplace configuration not found at ${path.join(
        marketplaceDir,
        QWEN_MARKETPLACE_CONFIG_FILENAME,
      )}`,
    );
  }
  const entry = config.extensions.find((e) => e?.name === extensionName);
  if (!entry) {
    throw new Error(
      `Extension ${extensionName} not found in ${QWEN_MARKETPLACE_CONFIG_FILENAME}`,
    );
  }
  if (!entry.source) {
    throw new Error(
      `Extension ${extensionName} has no source in ${QWEN_MARKETPLACE_CONFIG_FILENAME}`,
    );
  }
  return resolveEntrySource(
    entry,
    marketplaceDir,
    config.metadata?.extensionRoot,
  );
}
