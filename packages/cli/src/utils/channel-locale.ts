/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolve the operator's UI language to the prompt language the shared
 * bound-event contract carries. Kept import-free so both the channel worker
 * and the daemon's serve root can read it without pulling the channel
 * runtime's dependency chain into the serve fast path.
 */
export function resolveChannelLocale(value: unknown): 'en' | 'zh' {
  if (typeof value !== 'string') return 'en';
  const language = value.trim().replaceAll('_', '-').toLowerCase();
  return language === 'zh' ||
    language.startsWith('zh-') ||
    language === 'chinese' ||
    language === '中文'
    ? 'zh'
    : 'en';
}
