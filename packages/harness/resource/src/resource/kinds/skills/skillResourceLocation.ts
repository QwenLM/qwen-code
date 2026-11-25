/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillDefinition } from './types.js';

/** 记录加载入口的相对路径；遇到软链接也不替换成真实目标路径。 */
export async function resolveSkillResourceLocation(
  location: string,
  origin: { root: string; base: string; isFile: boolean },
): Promise<NonNullable<SkillDefinition['resourceLocation']>> {
  const empty = Object.freeze({
    base: '',
    relativePath: '',
    softlink: '' as const,
  });
  const paths = /^[a-z]:[\\/]|^\\\\/i.test(origin.root) ? path.win32 : path;

  if (
    !origin.isFile ||
    !origin.base ||
    !origin.root ||
    !paths.isAbsolute(origin.root) ||
    !paths.isAbsolute(location) ||
    location.split(/[\\/]/).includes('__inline__')
  ) {
    return empty;
  }

  const root = paths.resolve(origin.root);
  const relative = paths.relative(root, paths.resolve(location));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    return empty;
  }

  let softlink: boolean | '' = false;

  try {
    // 从根目录到定义文件逐级检查，任意一级是软链接都要保留这个事实。
    let entry = root;
    const entries = [entry];

    for (const segment of relative.split(paths.sep)) {
      entry = paths.join(entry, segment);
      entries.push(entry);
    }

    for (const entryPath of entries) {
      const stats = await fs.lstat(entryPath);

      if (stats.isSymbolicLink()) softlink = true;
    }
  } catch {
    softlink = '';
  }

  return Object.freeze({
    base: origin.base,
    relativePath: relative.replace(/\\/g, '/'),
    softlink,
  });
}
