/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isMissingPathError } from '../../utils/errors.js';
import { isWithinRoot } from '../../utils/fileUtils.js';
import type { WorktreeSettings } from './contracts.js';

/** 资源按同一相对位置从原项目加载；执行路径与额外 workspace 不变。 */
export function resolveWorktreeResourcePath(
  filePath: string,
  worktree: WorktreeSettings | undefined,
): string {
  if (!worktree?.originalCwd || !isWithinRoot(filePath, worktree.path)) {
    return filePath;
  }
  return path.resolve(
    worktree.originalCwd,
    path.relative(worktree.worktreeCwd, filePath),
  );
}

/** 仅用于物理路径身份比较；目标缺失时仍解析已有父目录，不改写 artifact 归属。 */
export async function canonicalizeWorktreePath(target: string): Promise<string> {
  const absolutePath = path.resolve(target);
  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    const parent = path.dirname(absolutePath);
    if (!isMissingPathError(error) || parent === absolutePath) throw error;
    return path.join(
      await canonicalizeWorktreePath(parent),
      path.basename(absolutePath),
    );
  }
}
