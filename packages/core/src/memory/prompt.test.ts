/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  appendManagedAutoMemoryToUserMemory,
  buildManagedAutoMemoryPrompt,
  MAX_MANAGED_AUTO_MEMORY_INDEX_LINES,
} from './prompt.js';

describe('managed auto-memory prompt helpers', () => {
  it('builds the memory mechanics prompt even when MEMORY.md is empty', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('# auto memory');
    expect(prompt).toContain('persistent, file-based memory system');
    expect(prompt).toContain('/tmp/project/.qwen/memory');
    expect(prompt).toContain('Your MEMORY.md is currently empty');
  });

  it('embeds the current MEMORY.md index content', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [User Memory](user/terse.md) — User prefers terse responses.',
    );

    expect(prompt).toContain('## /tmp/project/.qwen/memory/MEMORY.md');
    expect(prompt).toContain('[User Memory](user/terse.md)');
    expect(prompt).toContain('User prefers terse responses.');
  });

  it('warns extraction not to save MCP tool schemas or failed calls', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain(
      'MCP tool names, parameter schemas, field mappings, guessed tool-call formats, or raw failed tool-call transcripts',
    );
    expect(prompt).toContain('confirmed durable workaround');
    expect(prompt).toContain('live tool definitions are authoritative');
  });

  it('appends managed auto-memory after existing hierarchical memory', () => {
    const result = appendManagedAutoMemoryToUserMemory(
      '--- Context from: QWEN.md ---\nProject rules',
      '/tmp/project/.qwen/memory',
      '- [Project Memory](project/release-freeze.md) — Release freeze starts Friday.',
    );

    expect(result).toContain('Project rules');
    expect(result).toContain('\n\n---\n\n');
    expect(result).toContain('# auto memory');
  });

  it('returns only managed auto-memory when hierarchical memory is empty', () => {
    const result = appendManagedAutoMemoryToUserMemory(
      '   ',
      '/tmp/project/.qwen/memory',
      '- [Reference](reference/grafana.md) — Grafana dashboard link.',
    );

    expect(result).toContain('# auto memory');
    expect(result.startsWith('# auto memory')).toBe(true);
  });

  it('adds a shared team tier when a team section is provided', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Project](project/x.md) — note.',
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
      {
        memoryDir: '/tmp/project/.qwen/team-memory',
        indexContent: '- [Convention](feedback/tests.md) — use real DBs.',
      },
    );

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).toContain('/tmp/project/.qwen/team-memory');
    expect(prompt).toContain('## Saving to team memory');
    expect(prompt).toContain('MUST NOT save sensitive data to TEAM memory');
    // The team index block is rendered with its own content.
    expect(prompt).toContain('## /tmp/project/.qwen/team-memory/MEMORY.md');
    expect(prompt).toContain('[Convention](feedback/tests.md)');
    // PROJECT is now described as private; the old misleading wording is gone.
    expect(prompt).toContain(
      'PROJECT memory (this project only, private to you)',
    );
    expect(prompt).not.toContain('may be shared with teammates');
  });

  it('renders a two-tier project+team prompt when no user section is given', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Project](project/x.md) — note.',
      undefined,
      {
        memoryDir: '/tmp/project/.qwen/team-memory',
        indexContent: '- [Convention](feedback/tests.md) — use real DBs.',
      },
    );

    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).not.toContain('USER memory');
    expect(prompt).toContain('TEAM memory');
    expect(prompt).toContain('## Saving to team memory');
    // PROJECT index block comes before the TEAM index block.
    expect(
      prompt.indexOf('## /tmp/project/.qwen/memory/MEMORY.md'),
    ).toBeLessThan(
      prompt.indexOf('## /tmp/project/.qwen/team-memory/MEMORY.md'),
    );
  });

  it('omits the team tier when no team section is provided', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      {
        memoryDir: '/home/u/.qwen/memories',
        indexContent: null,
      },
    );

    expect(prompt).not.toContain('TEAM memory');
    expect(prompt).not.toContain('## Saving to team memory');
    expect(prompt).toContain('two persistent, file-based memory directories');
  });

  it('truncates oversized managed auto-memory index content', () => {
    const oversizedIndex = Array.from(
      { length: MAX_MANAGED_AUTO_MEMORY_INDEX_LINES + 50 },
      (_, index) => `- [Memory ${index}](memory-${index}.md) — hook ${index}`,
    ).join('\n');
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      oversizedIndex,
    );

    expect(result).toContain(
      'WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded.',
    );
    expect(result.split('\n').length).toBeLessThan(400);
  });
});
