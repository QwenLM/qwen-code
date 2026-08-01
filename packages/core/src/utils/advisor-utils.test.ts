/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildAdvisorPrompt,
  ADVISOR_MAX_INPUT_LENGTH,
} from './advisor-utils.js';

describe('buildAdvisorPrompt', () => {
  it('should default to reviewing the conversation when focus is empty', () => {
    expect(buildAdvisorPrompt('')).toContain('Review the conversation above.');
  });

  it('should include the focus text', () => {
    const prompt = buildAdvisorPrompt('is the fix correct?');
    expect(prompt).toContain('is the fix correct?');
    expect(prompt).not.toContain('Review the conversation above.');
  });

  it('should contain all four required section headings', () => {
    const prompt = buildAdvisorPrompt('');
    expect(prompt).toContain('## Verdict');
    expect(prompt).toContain('## Risks');
    expect(prompt).toContain('## Missing evidence');
    expect(prompt).toContain('## Recommendation');
  });

  it('should constrain the reviewer to evidence in the visible transcript', () => {
    const prompt = buildAdvisorPrompt('');
    expect(prompt).toContain('may be truncated');
    expect(prompt).toContain(
      'never claim to have verified something you could not observe',
    );
    expect(prompt).toContain('You have NO tools');
  });

  it('should expose a positive max input length', () => {
    expect(ADVISOR_MAX_INPUT_LENGTH).toBeGreaterThan(0);
  });
});
