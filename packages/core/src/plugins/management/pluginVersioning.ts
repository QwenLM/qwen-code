/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createGitCommandEnv,
  readGitHead,
  resolveGitRepositoryLayout,
} from '../../utils/gitUtils.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { internalGitArgs } from '../../utils/gitCommandPolicy.js';

import { runLogger } from '../../utils/runLogger.js';
import type { PluginManifest, PluginSource } from '../schemas.js';

const execFileAsync = promisify(execFile);

/**
 * Calculate the version for a plugin based on its source.
 *
 * Version sources (in order of priority):
 * 1. plugin.json version field (highest priority)
 * 2. Provided version (typically from marketplace entry)
 * 3. Pre-resolved git commit SHA
 * 4. Git commit SHA from install path
 * 5. 'unknown' as last resort
 *
 * @param pluginId - Plugin identifier (e.g., "plugin@marketplace")
 * @param source - Plugin source configuration
 * @param manifest - Optional plugin manifest with version field
 * @param installPath - Optional path to installed plugin (for git SHA extraction)
 * @param providedVersion - Optional version from marketplace entry or caller
 * @param gitCommitSha - Optional pre-resolved git SHA
 */
export async function calculatePluginVersion(
  pluginId: string,
  source: PluginSource,
  manifest?: PluginManifest,
  installPath?: string,
  providedVersion?: string,
  gitCommitSha?: string,
): Promise<string> {
  // 1. Use explicit version from plugin.json
  if (manifest?.version) {
    runLogger.log(
      `[PluginVersioning] Using manifest version for ${pluginId}: ${manifest.version}`,
    );
    return manifest.version;
  }

  // 2. Use provided version (typically from marketplace entry)
  if (providedVersion) {
    runLogger.log(
      `[PluginVersioning] Using provided version for ${pluginId}: ${providedVersion}`,
    );
    return providedVersion;
  }

  // 3. Use pre-resolved git SHA
  if (gitCommitSha) {
    const shortSha = gitCommitSha.substring(0, 12);
    // For git-subdir sources, encode the subdir path in the version so cache
    // keys differ when the path changes but the monorepo SHA doesn't.
    if (typeof source === 'object' && source.source === 'git-subdir') {
      const normPath = source.path
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      const pathHash = createHash('sha256')
        .update(normPath)
        .digest('hex')
        .substring(0, 8);
      const v = `${shortSha}-${pathHash}`;
      runLogger.log(
        `[PluginVersioning] Using git-subdir SHA+path for ${pluginId}: ${v}`,
      );
      return v;
    }
    runLogger.log(
      `[PluginVersioning] Using pre-resolved git SHA for ${pluginId}: ${shortSha}`,
    );
    return shortSha;
  }

  // 4. Try to get git SHA from install path
  if (installPath) {
    const sha = await getGitCommitSha(installPath);
    if (sha) {
      const shortSha = sha.substring(0, 12);
      runLogger.log(
        `[PluginVersioning] Using git SHA for ${pluginId}: ${shortSha}`,
      );
      return shortSha;
    }
  }

  // 5. Return 'unknown' as last resort
  runLogger.log(
    `[PluginVersioning] No version found for ${pluginId}, using 'unknown'`,
  );
  return 'unknown';
}

/**
 * Get the git commit SHA for a directory.
 *
 * @param dirPath - Path to directory (should be a git repository)
 * @returns Full commit SHA, or null when Git metadata is unavailable.
 */
export async function getGitCommitSha(dirPath: string): Promise<string | null> {
  try {
    const layout = await resolveGitRepositoryLayout(dirPath, {
      throwOnTimeout: true,
    });
    if (!layout) return null;
    const head = await readGitHead(layout, { throwOnTimeout: true });
    if (head?.commit) return head.commit;

    // Ordinary repositories need no Git child. Use a bounded fallback for
    // formats the file reader cannot resolve; version metadata stays optional.
    const { stdout } = await execFileAsync(
      'git',
      [...internalGitArgs(), 'rev-parse', '--verify', 'HEAD'],
      {
        cwd: dirPath,
        env: createGitCommandEnv(),
        timeout: 2000,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    );
    const sha = stdout.trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
