/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseAutoMemoryEntries,
  renderAutoMemoryBody,
} from './entries.js';

describe('managed auto-memory entries', () => {
  it('parses and renders Claude-style why/apply fields', () => {
    const body = [
      '# User Memory',
      '',
      '- User prefers terse responses.',
      '  - Why: This reduces back-and-forth.',
      '  - How to apply: Prefer concise summaries first.',
    ].join('\n');

    const entries = parseAutoMemoryEntries(body);
    expect(entries).toEqual([
      {
        summary: 'User prefers terse responses.',
        why: 'This reduces back-and-forth.',
        howToApply: 'Prefer concise summaries first.',
      },
    ]);

    const rendered = renderAutoMemoryBody('# User Memory', entries);
    expect(rendered).toContain('User prefers terse responses.');
    expect(rendered).toContain('Why: This reduces back-and-forth.');
    expect(rendered).toContain('How to apply: Prefer concise summaries first.');
  });
});