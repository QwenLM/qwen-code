/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as snippets from '../snippets.js';
import type { PromptSectionDescriptor } from '../types.js';
import { inputSection } from './input-section.js';

const FULL_ONLY = ['full'] as const;
const VERIFIED_VS_ASSUMED_GATE = 'behavior.verified_vs_assumed' as const;

export const CORE_FULL_SECTIONS: readonly PromptSectionDescriptor[] = [
  {
    id: 'core.system.full',
    version: 1,
    systemBlock: 'stable',
    order: 50,
    eligibleBundles: FULL_ONLY,
    render: snippets.renderSystemSection,
  },
  {
    id: 'core.doing_tasks.full',
    version: 3,
    systemBlock: 'stable',
    order: 60,
    eligibleBundles: FULL_ONLY,
    cacheVariant: ({ enabledSectionGates, renderInputs, frontendGuidance }) => {
      if (renderInputs.outputStyle?.keepCodingInstructions === false) {
        return 'omit-coding';
      }
      const verified = enabledSectionGates.includes(VERIFIED_VS_ASSUMED_GATE);
      return `verified=${verified}:frontend=${frontendGuidance !== undefined}`;
    },
    render: (context) =>
      context.renderInputs.outputStyle?.keepCodingInstructions === false
        ? null
        : snippets.renderDoingTasksSection(
            context.enabledSectionGates.includes(VERIFIED_VS_ASSUMED_GATE),
            !context.frontendGuidance,
          ),
  },
  {
    id: 'core.executing_actions.full',
    version: 2,
    systemBlock: 'stable',
    order: 70,
    eligibleBundles: FULL_ONLY,
    render: snippets.renderExecutingActionsSection,
  },
  inputSection(
    {
      id: 'core.using_tools.full',
      version: 1,
      systemBlock: 'stable',
      order: 80,
      eligibleBundles: FULL_ONLY,
    },
    (inputs) => inputs.usingTools,
  ),
  {
    id: 'core.tone_style.full',
    version: 1,
    systemBlock: 'stable',
    order: 90,
    eligibleBundles: FULL_ONLY,
    render: snippets.renderToneAndStyleSection,
  },
];
