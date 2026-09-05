/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  setMemoryFilename,
  getCurrentMemoryFilename,
  getAllMemoryFilenames,
} from '../utils/memory-constants.js';
import {
  getAllGeminiMdFilenames as getToolAllGeminiMdFilenames,
  setMemoryFilename as setToolMemoryFilename,
  getCurrentMemoryFilename as getToolCurrentMemoryFilename,
  getAllMemoryFilenames as getToolAllMemoryFilenames,
  setGeminiMdFilename as setToolGeminiMdFilename,
} from '../tools/memory-config.js';

// Mock dependencies
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock('os');

describe('setMemoryFilename', () => {
  beforeEach(() => {
    setMemoryFilename([DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME]);
  });

  it('should update currentMemoryFilename when a valid new name is provided', () => {
    const newName = 'CUSTOM_CONTEXT.md';
    setMemoryFilename(newName);
    expect(getCurrentMemoryFilename()).toBe(newName);
  });

  it('should not update currentMemoryFilename if the new name is empty or whitespace', () => {
    const initialName = getCurrentMemoryFilename(); // Get current before trying to change
    setMemoryFilename('  ');
    expect(getCurrentMemoryFilename()).toBe(initialName);

    setMemoryFilename('');
    expect(getCurrentMemoryFilename()).toBe(initialName);
  });

  it('should handle an array of filenames', () => {
    const newNames = ['CUSTOM_CONTEXT.md', 'ANOTHER_CONTEXT.md'];
    setMemoryFilename(newNames);
    expect(getCurrentMemoryFilename()).toBe('CUSTOM_CONTEXT.md');
    expect(getAllMemoryFilenames()).toEqual(newNames);
  });

  it('shares filename state with the legacy tools memory config entrypoint', () => {
    setMemoryFilename(['CUSTOM_CONTEXT.md', 'AGENTS.md']);
    expect(getToolCurrentMemoryFilename()).toBe('CUSTOM_CONTEXT.md');
    expect(getToolAllMemoryFilenames()).toEqual(getAllMemoryFilenames());

    setToolMemoryFilename('LEGACY_CONTEXT.md');
    expect(getCurrentMemoryFilename()).toBe('LEGACY_CONTEXT.md');
    expect(getAllMemoryFilenames()).toEqual(['LEGACY_CONTEXT.md']);
  });

  it('keeps the legacy public names wired to the renamed state', () => {
    setToolGeminiMdFilename('LEGACY_NAME.md');
    expect(getCurrentMemoryFilename()).toBe('LEGACY_NAME.md');
    expect(getToolAllGeminiMdFilenames()).toEqual(['LEGACY_NAME.md']);
  });
});
