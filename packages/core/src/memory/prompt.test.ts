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
  it('builds the Claude-style memory mechanics prompt even when MEMORY.md is empty', () => {
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

  it('truncates oversized managed auto-memory index content', () => {
    const oversizedIndex = Array.from(
      { length: MAX_MANAGED_AUTO_MEMORY_INDEX_LINES + 50 },
      (_, index) => `- [Memory ${index}](memory-${index}.md) — hook ${index}`,
    ).join('\n');
    const result = buildManagedAutoMemoryPrompt(
      '/tmp/project/.qwen/memory',
      oversizedIndex,
    );

    expect(result).toContain('WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded.');
    expect(result.split('\n').length).toBeLessThan(400);
  });
});