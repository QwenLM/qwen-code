/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildVoiceKeyterms } from './voiceKeyterms.js';

describe('buildVoiceKeyterms', () => {
  it('returns the static global vocabulary', () => {
    const terms = buildVoiceKeyterms();
    expect(terms).toContain('TypeScript');
    expect(terms).toContain('worktree');
  });

  it('does not include project- or branch-derived terms (no metadata sent)', () => {
    const terms = buildVoiceKeyterms();
    expect(terms).not.toContain('qwen-code');
    expect(terms).not.toContain('mvp');
  });
});
