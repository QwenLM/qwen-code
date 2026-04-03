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
  it('parses and renders richer schema fields', () => {
    const body = [
      '# User Memory',
      '',
      '- User prefers terse responses.',
      '  - Why: This reduces back-and-forth.',
      '  - How to apply: Prefer concise summaries first.',
      '  - Stability: stable',
    ].join('\n');

    const entries = parseAutoMemoryEntries(body);
    expect(entries).toEqual([
      {
        summary: 'User prefers terse responses.',
        why: 'This reduces back-and-forth.',
        howToApply: 'Prefer concise summaries first.',
        stability: 'stable',
      },
    ]);

    expect(renderAutoMemoryBody('# User Memory', entries)).toContain(
      '  - How to apply: Prefer concise summaries first.',
    );
  });
});