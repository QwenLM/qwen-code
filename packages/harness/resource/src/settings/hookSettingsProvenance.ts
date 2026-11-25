/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 只保存恢复过程中被压缩的 Hook 数组下标；随配置对象回收，不写入配置或快照。
const originalIndices = new WeakMap<unknown[], number[]>();

/** 在既有过滤逻辑 splice 前记录原始位置，不执行校验或改变过滤策略。 */
export function rememberHookArrayRemoval(
  array: unknown[],
  index: number,
  path: ReadonlyArray<string | number>,
): void {
  if (path[0] !== 'hooks') return;
  const indices =
    originalIndices.get(array) ?? array.map((_, position) => position);
  indices.splice(index, 1);
  originalIndices.set(array, indices);
}

/** 将当前 Hook 配置路径还原到原始文件；路径遍历始终使用运行时下标。 */
export function originalHookSettingsPath(
  settings: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): Array<string | number> {
  if (path[0] !== 'hooks') return [...path];
  let current: unknown = settings;
  return path.map((part) => {
    const original =
      typeof part === 'number' && Array.isArray(current)
        ? (originalIndices.get(current)?.[part] ?? part)
        : part;
    current =
      current && typeof current === 'object'
        ? (current as Record<string | number, unknown>)[part]
        : undefined;
    return original;
  });
}
