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
  it('builds a condensed memory prompt when MEMORY.md is empty', () => {
    const prompt = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');

    expect(prompt).toContain('# auto memory');
    expect(prompt).toContain('persistent, file-based memory system');
    expect(prompt).toContain('/tmp/project/.qwen/memory');
    expect(prompt).toContain('currently empty');
    // Condensed prompt omits verbose sections
    expect(prompt).not.toContain('## What NOT to save in memory');
    expect(prompt).not.toContain('## When to access memories');
    expect(prompt).not.toContain('## Before recommending from memory');
    expect(prompt).not.toContain('## Memory and other forms of persistence');
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
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [Note](note.md) — a note.',
    );

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
    // The team index is auto-generated; the model must not hand-edit it.
    expect(prompt).toContain('generated automatically from the saved files');
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

  it('condensed prompt with empty indexes is significantly shorter than full', () => {
    const condensed = buildManagedAutoMemoryPrompt('/tmp/project/.qwen/memory');
    const full = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      undefined,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );

    // Condensed should be less than half the length of full
    expect(condensed.length).toBeLessThan(full.length / 2);
  });

  it('emits full prompt when at least one index has content', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      '- [User Memory](user/terse.md) — User prefers terse responses.',
    );

    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('emits full prompt with forceFullProtocol even when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );

    expect(prompt).toContain('## Types of memory');
    expect(prompt).toContain('## What NOT to save in memory');
    expect(prompt).toContain('## When to access memories');
    expect(prompt).toContain('## Before recommending from memory');
  });

  it('emits condensed prompt for multi-tier setup when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
    );

    // Condensed multi-tier still shows both dirs
    expect(prompt).toContain('two persistent, file-based memory directories');
    expect(prompt).toContain('/home/u/.qwen/memories');
    expect(prompt).toContain('/tmp/project/.qwen/memory');
    // Uses condensed sections
    expect(prompt).toContain('## Memory types');
    expect(prompt).toContain('## How to save memories');
    // Omits verbose full-protocol sections
    expect(prompt).not.toContain('## Types of memory');
    expect(prompt).not.toContain('## What NOT to save in memory');
  });

  it('emits condensed prompt for three-tier setup with team section when all indexes are empty', () => {
    const prompt = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      null,
      { memoryDir: '/home/u/.qwen/memories', indexContent: null },
      { memoryDir: '/tmp/project/.qwen/team-memory', indexContent: null },
    );

    expect(prompt).toContain('three persistent, file-based memory directories');
    expect(prompt).toContain('TEAM memory');
    // Condensed team guidance is present
    expect(prompt).toContain('route project-wide conventions and shared references to TEAM');
    // Full team scope section is omitted
    expect(prompt).not.toContain('## Saving to team memory');
  });

  it('appendManagedAutoMemoryToUserMemory passes through options', () => {
    const withOptions = appendManagedAutoMemoryToUserMemory(
      '',
      '/tmp/project/.qwen/memory',
      null,
      undefined,
      undefined,
      { forceFullProtocol: true },
    );
    const without = appendManagedAutoMemoryToUserMemory(
      '',
      '/tmp/project/.qwen/memory',
      null,
    );

    // With forceFullProtocol, full verbose sections are present
    expect(withOptions).toContain('## Types of memory');
    // Without it, condensed prompt is returned
    expect(without).not.toContain('## Types of memory');
    expect(without).toContain('## Memory types');
  });
});
