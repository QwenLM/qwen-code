/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会被 prompts 层之外显式失效的 section id。
 *
 * `SystemPromptAssembler.clearCache(sectionId)` 按 id 前缀失效，所以调用方必须
 * 和 descriptor 写完全一样的字符串。两边都用这里的常量，改名时调用处会编译
 * 报错——而不是静默地不再失效，留着一份错的 system prompt 直到会话结束。
 */
export const PROMPT_SECTION_ID = Object.freeze({
  memoryAuto: 'memory.auto',
} as const);

export type InvalidatablePromptSectionId =
  (typeof PROMPT_SECTION_ID)[keyof typeof PROMPT_SECTION_ID];
