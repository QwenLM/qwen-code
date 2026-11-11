/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic skill discovery for monorepo subdirectories.
 *
 * This module owns the skill-domain workflow that discovers ancestor skill
 * directories, loads their definitions, and registers them with SkillManager.
 * Tool-layer JIT context only decides whether project skill discovery is
 * allowed and supplies the runtime inputs.
 */

import * as path from 'node:path';
import { CONFIG_DIR } from '../utils/paths.js';
import { discoverSkillDirsForPaths } from './discoverSkillDirs.js';
import { loadSkillsFromDir } from '@qwen-code/resource';
import type { SkillManager } from './skillManager.js';

type DynamicSkillManager = Pick<
  SkillManager,
  'hasDynamicSkillDir' | 'addDynamicSkills'
>;

// 发现缓存与已加载 Skill 使用同一生命周期，Config 重建及 ACP 多会话互不干扰。
const checkedDirsByManager = new WeakMap<DynamicSkillManager, Set<string>>();

export interface DynamicSkillDiscoveryRequest {
  accessedPaths: string[];
  cwd: string;
  loadFromAgentsDirectory?: boolean;
  skillManager: DynamicSkillManager;
  signal?: AbortSignal;
}

/**
 * Discovers and registers skills from monorepo subdirectories touched by file
 * operations. Already-loaded dynamic skill directories are skipped.
 *
 * @returns Whether at least one new skill directory was registered.
 */
export async function discoverAndRegisterDynamicSkills({
  accessedPaths,
  cwd,
  loadFromAgentsDirectory,
  skillManager,
  signal,
}: DynamicSkillDiscoveryRequest): Promise<boolean> {
  signal?.throwIfAborted();
  let checkedDirs = checkedDirsByManager.get(skillManager);
  if (!checkedDirs) {
    checkedDirs = new Set();
    checkedDirsByManager.set(skillManager, checkedDirs);
  }
  // 可取消的发现先使用局部缓存，避免失败后把未完成目录标记为已检查。
  const pendingCheckedDirs = signal ? new Set(checkedDirs) : checkedDirs;
  const newDirs = await discoverSkillDirsForPaths(accessedPaths, cwd, {
    loadFromAgentsDirectory,
    checkedDirs: pendingCheckedDirs,
    signal,
  });
  signal?.throwIfAborted();

  const dirsToLoad = newDirs.filter(
    (dir) => !skillManager.hasDynamicSkillDir(dir),
  );
  const loadResults = await Promise.all(
    dirsToLoad.map(async (dir) => ({
      dir,
      skills: await loadSkillsFromDir(dir),
    })),
  );

  signal?.throwIfAborted();
  for (const dir of pendingCheckedDirs) checkedDirs.add(dir);
  let registeredAny = false;
  for (const { dir, skills } of loadResults) {
    if (skills.length === 0) continue;

    const ancestorDir = path.dirname(path.dirname(dir));
    const relativeAncestor = path.relative(cwd, ancestorDir);
    const ancestorDepth = relativeAncestor.split(path.sep).filter(Boolean).length;
    const source =
      path.basename(path.dirname(dir)) === CONFIG_DIR
        ? 'configured'
        : 'legacy-agents';

    skillManager.addDynamicSkills(dir, skills, { ancestorDepth, source });
    registeredAny = true;
  }

  return registeredAny;
}
