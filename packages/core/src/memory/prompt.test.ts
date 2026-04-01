/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  appendManagedAutoMemoryToUserMemory,
  buildManagedAutoMemoryPrompt,
  MANAGED_AUTO_MEMORY_HEADER,
  MAX_MANAGED_AUTO_MEMORY_CHARS,
} from './prompt.js';

describe('managed auto-memory prompt helpers', () => {
  it('returns empty string when no managed index content exists', () => {
    expect(buildManagedAutoMemoryPrompt()).toBe('');
    expect(buildManagedAutoMemoryPrompt('   \n\n ')).toBe('');
  });

  it('builds a managed auto-memory prompt block from the index content', () => {
    const prompt = buildManagedAutoMemoryPrompt('# Managed Auto-Memory Index');

    expect(prompt).toContain(MANAGED_AUTO_MEMORY_HEADER);
    expect(prompt).toContain('# Managed Auto-Memory Index');
    expect(prompt).toContain('durable project memory');
  });

  it('appends managed auto-memory after existing hierarchical memory', () => {
    const result = appendManagedAutoMemoryToUserMemory(
      '--- Context from: QWEN.md ---\nProject rules',
      '# Managed Auto-Memory Index',
    );

    expect(result).toContain('Project rules');
    expect(result).toContain('\n\n---\n\n');
    expect(result).toContain(MANAGED_AUTO_MEMORY_HEADER);
  });

  it('returns only managed auto-memory when hierarchical memory is empty', () => {
    const result = appendManagedAutoMemoryToUserMemory(
      '   ',
      '# Managed Auto-Memory Index',
    );

    expect(result).toContain(MANAGED_AUTO_MEMORY_HEADER);
    expect(result.startsWith(MANAGED_AUTO_MEMORY_HEADER)).toBe(true);
  });

  it('truncates oversized managed auto-memory index content', () => {
    const oversizedIndex = 'x'.repeat(MAX_MANAGED_AUTO_MEMORY_CHARS + 100);
    const result = buildManagedAutoMemoryPrompt(oversizedIndex);

    expect(result.length).toBeLessThan(13_000);
    expect(result).toContain('truncated for prompt budget');
  });
});