/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_NAME } from '../../config/brand.js';
import { describe, it, expect } from 'vitest';
import { GeneralPurposeAgent } from './general-purpose-agent.js';
import { makeFakeConfig } from '../../test-utils/config.js';

describe('GeneralPurposeAgent', () => {
  it('should create a valid general-purpose agent definition', () => {
    const config = makeFakeConfig();
    const agent = GeneralPurposeAgent(config);

    expect(agent.name).toBe('general-purpose');
    expect(agent.kind).toBe('local');
    expect(agent.modelConfig.model).toBe('inherit');
    expect(agent.toolConfig?.tools).toEqual(['*']);
    expect(agent.promptConfig.systemPrompt).toContain(BRAND_NAME);
    expect(agent.promptConfig.systemPrompt).toContain('Guidelines');
    expect(agent.promptConfig.systemPrompt).toContain(
      'do not re-delegate your entire assignment',
    );
  });
});
