/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from './internal.js';

const AGENTS_DIR = '.agents';

export interface DiscoverSkillDirsOptions {
  configDirName?: string;
  loadFromAgentsDirectory?: boolean;
  isPathIgnored?: (dir: string, cwd: string) => Promise<boolean> | boolean;
}

const checkedSkillDirs = new Set<string>();

export function clearCheckedSkillDirs(): void {
  checkedSkillDirs.clear();
}

export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
  options: DiscoverSkillDirsOptions = {},
): Promise<string[]> {
  const normalizedCwd = path.resolve(cwd);
  const configDirName = options.configDirName ?? '.qwen';
  const newSkillDirs: string[] = [];
  const discoveredRealDirs = new Set<string>();

  for (const filePath of filePaths) {
    const absolutePath = path.resolve(filePath);
    let currentDir = path.dirname(absolutePath);

    while (currentDir.startsWith(normalizedCwd + path.sep)) {
      const skillsDir = path.join(currentDir, configDirName, 'skills');

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
            if (stats.isDirectory()) {
              const isIgnored = options.isPathIgnored
                ? await options.isPathIgnored(currentDir, normalizedCwd)
                : false;
              if (!isIgnored) {
                logger.debug(`Discovered subdirectory skill dir: ${dir}`);
                return { dir, realDir: await fs.realpath(dir) };
              }
              logger.debug(`Skipping ignored skill dir: ${dir}`);
            }
          } catch {
            // Directory does not exist.
          }
          return null;
        }),
      );

      for (const result of results) {
        if (result && !discoveredRealDirs.has(result.realDir)) {
          discoveredRealDirs.add(result.realDir);
          newSkillDirs.push(result.dir);
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  return newSkillDirs.sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
}
