/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Monorepo subdirectory auto-discovery for skills.
 *
 * When file operations (Read/Edit/Write) touch files deep inside a monorepo,
 * this module walks up from the file's directory toward the workspace root,
 * checking for `${CONFIG_DIR}/skills/` directories at each level. Discovered
 * skill directories are loaded on-demand as "dynamic skills" that persist
 * across the session.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_DIR } from '../utils/paths.js';
import { isPathGitignored } from '../utils/gitignore.js';
import { runLogger } from '../utils/runLogger.js';

const AGENTS_DIR = '.agents';

export interface DiscoverSkillDirsOptions {
  loadFromAgentsDirectory?: boolean;
  /** 由消费方持有；不同会话不能共享“已检查”状态。 */
  checkedDirs?: Set<string>;
  signal?: AbortSignal;
}

/**
 * Given a set of file paths being accessed, discovers configured skill
 * directories in ancestors between each file's location and the workspace
 * root (exclusive). Legacy `.agents/skills/` directories are included only
 * when `loadFromAgentsDirectory` is enabled.
 *
 * This implements the "walk-up" pattern: for each file, starting from its
 * parent directory and moving upward toward (but not including) `cwd`, we
 * check whether `<dir>/${CONFIG_DIR}/skills/` exists, and optionally whether
 * `<dir>/.agents/skills/` exists. We skip already-checked paths and gitignored
 * paths.
 *
 * @param filePaths - Absolute paths of files being accessed.
 * @param cwd - The workspace root directory (exclusive upper bound).
 * @returns Array of new skill directory paths (deepest first).
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
  options: DiscoverSkillDirsOptions = {},
): Promise<string[]> {
  const checkedSkillDirs = options.checkedDirs ?? new Set<string>();
  const normalizedCwd = path.resolve(cwd);
  const newSkillDirs: string[] = [];
  const discoveredRealDirs = new Set<string>();

  for (const filePath of filePaths) {
    const absolutePath = path.resolve(filePath);
    let currentDir = path.dirname(absolutePath);

    // Walk up from the file's directory toward cwd (exclusive).
    // Stop when we reach or pass beyond cwd.
    while (currentDir.startsWith(normalizedCwd + path.sep)) {
      options.signal?.throwIfAborted();
      const skillsDir = path.join(currentDir, CONFIG_DIR, 'skills');

      const candidateDirs = [
        skillsDir,
        ...(options.loadFromAgentsDirectory
          ? [path.join(currentDir, AGENTS_DIR, 'skills')]
          : []),
      ];
      const dirsToCheck = [...new Set(candidateDirs)].filter(
        (dir) => !checkedSkillDirs.has(dir),
      );

      for (const dir of dirsToCheck) {
        checkedSkillDirs.add(dir);
      }

      const results = await Promise.all(
        dirsToCheck.map(async (dir) => {
          try {
            const stats = await fs.stat(dir);
            options.signal?.throwIfAborted();
            if (stats.isDirectory()) {
              const isIgnored = await isPathGitignored(
                currentDir,
                normalizedCwd,
              );
              if (!isIgnored) {
                runLogger.debug(`Discovered subdirectory skill dir: ${dir}`);
                return { dir, realDir: await fs.realpath(dir) };
              } else {
                runLogger.debug(`Skipping gitignored skill dir: ${dir}`);
              }
            }
          } catch {
            // Directory doesn't exist — this is the common case, not an error.
          }
          return null;
        }),
      );

      options.signal?.throwIfAborted();
      for (const result of results) {
        if (result && !discoveredRealDirs.has(result.realDir)) {
          discoveredRealDirs.add(result.realDir);
          newSkillDirs.push(result.dir);
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }
      currentDir = parentDir;
    }
  }

  // Return deepest directories first (longer paths first)
  return newSkillDirs.sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
}
