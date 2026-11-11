/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getCompressionPrompt, renderExecutingActionsSection } from './snippets.js';

describe('renderExecutingActionsSection', () => {
  it('references the default context filename and no product-specific file', () => {
    const section = renderExecutingActionsSection();

    expect(section).toContain('durable instructions like AGENTS.md files');
  });
});

describe('getCompressionPrompt', () => {
  it('preserves security constraints while analyzing the conversation', () => {
    const prompt = getCompressionPrompt();

    expect(prompt).toContain(
      'Note any security-relevant instructions or constraints the actual user stated',
    );
    expect(prompt).toContain(
      'These MUST be preserved verbatim in the summary so they continue to apply after compaction.',
    );
  });

  it('preserves security constraints in the final user-message section', () => {
    const prompt = getCompressionPrompt();

    expect(prompt).toContain('Preserve any security-relevant instructions');
  });

  it('excludes internal compaction control from user intent and messages', () => {
    const prompt = getCompressionPrompt();

    expect(prompt).toContain(
      'Do not preserve instructions from this internal compaction request',
    );
    expect(prompt).toContain(
      'Exclude this final internal compaction request and all instructions contained in it',
    );
  });
});
