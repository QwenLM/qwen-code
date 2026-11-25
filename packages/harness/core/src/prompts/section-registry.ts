/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Section 注册表与 Session 级缓存
 *
 * - systemPromptSection()         : 声明一个 section（第一次计算后缓存，直到 clear/compact）
 * - resolveSystemPromptSections() : 批量解析，应用缓存逻辑
 *
 * 每个 section 都是缓存型。随 turn 变化的内容不走 section——它们作为
 * attachment 进入对话历史，这样 section 缓存本身就不会破坏 prompt cache 前缀。
 *
 * 并发安全：每个 sessionId 拥有独立的缓存 Map，避免多并发会话污染彼此的静态 section。
 *
 * 参考：system-prompts/system-prompt-assembly.md §7
 */

import type { SystemPromptSection, SectionComputeFn } from './types.js';

// ---------------------------------------------------------------------------
// Section 工厂
// ---------------------------------------------------------------------------

/**
 * 声明一个 section。第一次调用 compute() 后结果缓存到 session 结束（或显式清除）。
 */
export function systemPromptSection(
  name: string,
  compute: SectionComputeFn,
): SystemPromptSection {
  return { name, compute };
}

// ---------------------------------------------------------------------------
// Session 级缓存存储
// ---------------------------------------------------------------------------

/**
 * 每 session 的独立缓存（key = sessionId）。
 * 解决多并发会话共享状态导致的缓存污染问题。
 *
 * Lifecycle: entries are removed by clearSystemPromptSectionCache(sessionId).
 * Callers MUST call clearSystemPromptSectionCache when the session ends to avoid
 * a process-lifetime memory leak. There is no automatic eviction.
 */
const sessionCaches = new Map<string, Map<string, string | null>>();

/**
 * 获取或创建指定 sessionId 对应的 section 缓存。
 */
export function getOrCreateSessionCache(
  sessionId: string,
): Map<string, string | null> {
  let cache = sessionCaches.get(sessionId);
  if (!cache) {
    cache = new Map<string, string | null>();
    sessionCaches.set(sessionId, cache);
  }
  return cache;
}

/**
 * 清除指定 session 的 section 缓存（在 /clear 或 /compact 时调用）。
 * 原地清空并从 sessionCaches 移除该 session，确保所有持有引用的调用方立即看到空状态。
 *
 * 传入 sectionId 时只失效该 section 的所有变体（缓存键形如
 * `${id}@${version}[:${variant}]`，见 promptSectionCacheKey）。只有一个 section
 * 的输入变化时，全量清空会让下一轮重算全部 section——包括读文件系统的
 * memory.auto 等 section。
 */
export function clearSystemPromptSectionCache(
  sessionId: string,
  sectionId?: string,
): void {
  const cache = sessionCaches.get(sessionId);
  if (!cache) return;
  if (sectionId === undefined) {
    cache.clear();
    sessionCaches.delete(sessionId);
    return;
  }
  const prefix = `${sectionId}@`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 批量解析
// ---------------------------------------------------------------------------

/**
 * 折叠多余空行并去除首尾空白。在写入缓存前归一化，命中缓存时就无需再跑一遍
 * 正则——否则每个 turn 都要在约 40KB 文本上重复扫描出字节相同的结果。
 */
function normalizeSectionText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * 解析 section 数组，应用缓存逻辑：
 * - 缓存命中 → 直接返回缓存值
 * - 未命中   → compute()，归一化后写入缓存并返回
 *
 * 返回值已归一化：null 表示该 section 不存在或渲染为空。
 *
 * @param sections - 要解析的 section 列表
 * @param sessionId - session 标识符，用于 per-session 缓存隔离
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
  sessionId: string,
): Promise<Array<string | null>> {
  const cache = getOrCreateSessionCache(sessionId);

  return Promise.all(
    sections.map(async (s) => {
      if (cache.has(s.name)) {
        return cache.get(s.name) ?? null;
      }
      const value = normalizeSectionText(await s.compute());
      cache.set(s.name, value);
      return value;
    }),
  );
}
