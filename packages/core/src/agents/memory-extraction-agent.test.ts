/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildIndependentIncrementalMemoryDirective,
  buildMemoryExtractionDirective,
} from './memory-extraction-agent.js';

describe('buildMemoryExtractionDirective', () => {
  it('restricts extraction to USER memory when PROJECT scope is disabled', () => {
    const prompt = buildMemoryExtractionDirective(
      [
        {
          scope: 'user',
          dir: '/tmp/user-memory',
          files: [],
          index: '',
        },
      ],
      4,
    );

    expect(prompt).toContain('## Active memory scope: USER');
    expect(prompt).toContain(
      'Do not save `type: project` memories while the PROJECT scope is disabled.',
    );
  });
});

describe('buildIndependentIncrementalMemoryDirective', () => {
  it('provides a compact prompt with explicit shortest execution paths', () => {
    const prompt = buildIndependentIncrementalMemoryDirective(
      [
        {
          scope: 'project',
          dir: '/tmp/project-memory',
          files: ['current.md'],
          index: '- [Current](current.md) — current project memory',
        },
      ],
      7,
      [
        {
          filePath: '/tmp/project-memory/preference.md',
          content: 'previous content',
        },
      ],
    );

    expect(prompt).toContain('exactly 7 raw transcript messages');
    expect(prompt).toContain('assistant tool calls and their tool results');
    expect(prompt).toContain('previous content');
    expect(prompt).toContain('current.md');
    expect(prompt).toContain('## Current MEMORY.md');
    expect(prompt).toContain(
      'No durable change: call no tools and finish immediately.',
    );
    expect(prompt).toContain(
      'Only new memory files or index-only changes: skip Read',
    );
    expect(prompt).toContain(
      'issue every necessary Read in one parallel tool batch',
    );
    expect(prompt).toContain(
      'Never Read MEMORY.md.',
    );
    expect(prompt).toContain(
      'whether tests, builds, and typechecks passed',
    );
    expect(prompt).toContain('Available tools: Read and Edit/Write');
    expect(prompt).not.toContain('Available tools: Read, Grep, Glob');
    expect(prompt).not.toContain('<types>');
  });
});
