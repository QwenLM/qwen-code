/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
  setGeminiMdFilename,
  getCurrentGeminiMdFilename,
  getAllGeminiMdFilenames,
} from './const.js';
import {
  setGeminiMdFilename as setToolGeminiMdFilename,
  getCurrentGeminiMdFilename as getToolCurrentGeminiMdFilename,
  getAllGeminiMdFilenames as getToolAllGeminiMdFilenames,
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

describe('setGeminiMdFilename', () => {
  beforeEach(() => {
    setGeminiMdFilename([DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME]);
  });

  it('should update currentGeminiMdFilename when a valid new name is provided', () => {
    const newName = 'CUSTOM_CONTEXT.md';
    setGeminiMdFilename(newName);
    expect(getCurrentGeminiMdFilename()).toBe(newName);
  });

  it('should not update currentGeminiMdFilename if the new name is empty or whitespace', () => {
    const initialName = getCurrentGeminiMdFilename(); // Get current before trying to change
    setGeminiMdFilename('  ');
    expect(getCurrentGeminiMdFilename()).toBe(initialName);

    setGeminiMdFilename('');
    expect(getCurrentGeminiMdFilename()).toBe(initialName);
  });

  it('should handle an array of filenames', () => {
    const newNames = ['CUSTOM_CONTEXT.md', 'ANOTHER_CONTEXT.md'];
    setGeminiMdFilename(newNames);
    expect(getCurrentGeminiMdFilename()).toBe('CUSTOM_CONTEXT.md');
    expect(getAllGeminiMdFilenames()).toEqual(newNames);
  });

  it('shares filename state with the legacy tools memory config entrypoint', () => {
    setGeminiMdFilename(['CUSTOM_CONTEXT.md', 'AGENTS.md']);
    expect(getToolCurrentGeminiMdFilename()).toBe('CUSTOM_CONTEXT.md');
    expect(getToolAllGeminiMdFilenames()).toEqual(getAllGeminiMdFilenames());

    setToolGeminiMdFilename('LEGACY_CONTEXT.md');
    expect(getCurrentGeminiMdFilename()).toBe('LEGACY_CONTEXT.md');
    expect(getAllGeminiMdFilenames()).toEqual(['LEGACY_CONTEXT.md']);
  });
});
