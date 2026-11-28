/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import type { MarketplaceSource } from './schemas.js';
import { checkGitAvailable } from './pluginGit.js';

/**
 * Parse a marketplace input string into a MarketplaceSource.
 *
 * @returns MarketplaceSource, an error object, or null if format is unrecognized
 */
export async function parseMarketplaceInput(
  input: string,
): Promise<MarketplaceSource | { error: string } | null> {
  const trimmed = input.trim();

  // Handle git SSH URLs with any valid username
  // Supports: user@host:path, user@host:path.git, and with #ref suffix
  const sshMatch = trimmed.match(
    /^([a-zA-Z0-9._-]+@[^:]+:.+?(?:\.git)?)(#(.+))?$/,
  );
  if (sshMatch?.[1]) {
    const gitAvailable = await checkGitAvailable();
    if (!gitAvailable) {
      return {
        error: 'Git is not available. Cannot use SSH URLs without git.',
      };
    }
    const url = sshMatch[1];
    const ref = sshMatch[3];
    return ref ? { source: 'git', url, ref } : { source: 'git', url };
  }

  // Handle URLs
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const fragmentMatch = trimmed.match(/^([^#]+)(#(.+))?$/);
    const urlWithoutFragment = fragmentMatch?.[1] || trimmed;
    const ref = fragmentMatch?.[3];

    // Detect git repos: .git suffix or Azure DevOps /_git/ pattern
    if (
      urlWithoutFragment.endsWith('.git') ||
      urlWithoutFragment.includes('/_git/')
    ) {
      return ref
        ? { source: 'git', url: urlWithoutFragment, ref }
        : { source: 'git', url: urlWithoutFragment };
    }

    // Parse URL to check hostname for GitHub
    let url: URL;
    try {
      url = new URL(urlWithoutFragment);
    } catch {
      return { source: 'url', url: urlWithoutFragment };
    }

    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const match = url.pathname.match(/^\/([^/]+\/[^/]+?)(\/|\.git|$)/);
      if (match?.[1]) {
        const gitUrl = urlWithoutFragment.endsWith('.git')
          ? urlWithoutFragment
          : `${urlWithoutFragment}.git`;
        return ref
          ? { source: 'git', url: gitUrl, ref }
          : { source: 'git', url: gitUrl };
      }
    }
    return { source: 'url', url: urlWithoutFragment };
  }

  // Handle local paths
  const isWindows = process.platform === 'win32';
  const isWindowsPath =
    isWindows &&
    (trimmed.startsWith('.\\') ||
      trimmed.startsWith('..\\') ||
      /^[a-zA-Z]:[/\\]/.test(trimmed));

  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    isWindowsPath
  ) {
    const resolvedPath = resolve(
      trimmed.startsWith('~') ? trimmed.replace(/^~/, homedir()) : trimmed,
    );

    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        error:
          code === 'ENOENT'
            ? `Path does not exist: ${resolvedPath}`
            : `Cannot access path: ${resolvedPath} (${code ?? e})`,
      };
    }

    if (stats.isFile()) {
      if (resolvedPath.endsWith('.json')) {
        return { source: 'file', path: resolvedPath };
      }
      return {
        error: `File path must point to a .json file (marketplace.json), but got: ${resolvedPath}`,
      };
    }
    if (stats.isDirectory()) {
      return { source: 'directory', path: resolvedPath };
    }
    return {
      error: `Path is neither a file nor a directory: ${resolvedPath}`,
    };
  }

  // Handle GitHub shorthand (owner/repo, owner/repo#ref, owner/repo@ref)
  if (trimmed.includes('/') && !trimmed.startsWith('@')) {
    if (trimmed.includes(':')) return null;
    const fragmentMatch = trimmed.match(/^([^#@]+)(?:[#@](.+))?$/);
    const repo = fragmentMatch?.[1] || trimmed;
    const ref = fragmentMatch?.[2];
    return ref ? { source: 'github', repo, ref } : { source: 'github', repo };
  }

  return null;
}
