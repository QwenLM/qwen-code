/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptSectionDescriptor } from '../types.js';
import { PROMPT_SECTION_ID } from '../section-ids.js';
import { inputSection } from './input-section.js';

const CONTEXT_MANAGEMENT = `# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.`;

export const PREFERENCE_SECTIONS: readonly PromptSectionDescriptor[] = [
  inputSection(
    {
      id: 'preference.language',
      version: 2,
      systemBlock: 'dynamic',
      order: 150,
    },
    (inputs) => inputs.language,
  ),
  inputSection(
    {
      id: 'preference.output_style',
      version: 1,
      systemBlock: 'dynamic',
      order: 160,
    },
    (inputs) => inputs.outputStyle,
  ),
  {
    id: 'session.context_management',
    version: 1,
    systemBlock: 'dynamic',
    order: 170,
    requiredCapabilities: ['compression'],
    render: () => CONTEXT_MANAGEMENT,
  },
  {
    // memory 输入自己决定 lean 下渲染什么。SDK 明确提供的 prompt
    // 两种 bundle 返回同一份；CLI fallback 则提供两版。
    id: PROMPT_SECTION_ID.memoryAuto,
    version: 2,
    systemBlock: 'dynamic',
    order: 130,
    requiredCapabilities: ['memory'],
    cacheVariant: (context) =>
      `${context.bundle}:${context.renderInputs.memory?.cacheVariant ?? 'none'}`,
    render: (context) =>
      context.renderInputs.memory?.computeForBundle(context.bundle) ?? null,
  },
  {
    id: 'session.guidance',
    version: 3,
    systemBlock: 'dynamic',
    order: 120,
    cacheVariant: (context) =>
      `${context.bundle}:${context.renderInputs.sessionGuidance?.cacheVariant ?? 'none'}`,
    render: (context) =>
      context.renderInputs.sessionGuidance?.computeForBundle(context.bundle) ??
      null,
  },
];
