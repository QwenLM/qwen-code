/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PromptRenderInputs,
  PromptSectionDescriptor,
  PromptSectionInput,
} from '../types.js';

/** inputSection() 自行派生 cacheVariant / render，其余轴由调用方声明。 */
type InputSectionMeta = Omit<
  PromptSectionDescriptor,
  'cacheVariant' | 'render'
>;

/**
 * 声明一个内容完全来自 {@link PromptRenderInputs} 某个条目的 section。
 *
 * cacheVariant 与 render 由同一个 `pick` 派生，因此缓存键不可能和渲染出的文本
 * 失同步。每个 section 各手写一遍 `?? 'none'` / `?? null` 时就会漏——
 * preference.language 等动态输入都需要正确携带 cacheVariant。
 */
export function inputSection(
  meta: InputSectionMeta,
  pick: (inputs: PromptRenderInputs) => PromptSectionInput | undefined,
): PromptSectionDescriptor {
  return {
    ...meta,
    cacheVariant: (context) =>
      pick(context.renderInputs)?.cacheVariant ?? 'none',
    render: (context) => pick(context.renderInputs)?.compute() ?? null,
  };
}
