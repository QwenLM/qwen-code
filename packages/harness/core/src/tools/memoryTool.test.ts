/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_FILENAME,
  deriveLocalContextFilenames,
  normalizeContextFilenames,
} from './memoryTool.js';

describe('normalizeContextFilenames', () => {
  it('wraps a single configured name', () => {
    expect(normalizeContextFilenames('CUSTOM_CONTEXT.md')).toEqual([
      'CUSTOM_CONTEXT.md',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContextFilenames('  CUSTOM_CONTEXT.md  ')).toEqual([
      'CUSTOM_CONTEXT.md',
    ]);
  });

  it('keeps every name of an array, in order', () => {
    expect(
      normalizeContextFilenames(['CUSTOM_CONTEXT.md', 'ANOTHER_CONTEXT.md']),
    ).toEqual(['CUSTOM_CONTEXT.md', 'ANOTHER_CONTEXT.md']);
  });

  it.each([undefined, '', '   ', []])(
    'falls back to the default for a blank setting: %#',
    (value) => {
      expect(normalizeContextFilenames(value)).toEqual([
        DEFAULT_CONTEXT_FILENAME,
      ]);
    },
  );
});

describe('deriveLocalContextFilenames', () => {
  it('derives the .local.md variant of a name', () => {
    expect(deriveLocalContextFilenames(['AGENTS.md'])).toEqual([
      'AGENTS.local.md',
    ]);
  });

  it('derives one variant per configured name, preserving order', () => {
    expect(
      deriveLocalContextFilenames(['PRIMARY.md', 'SECONDARY.markdown']),
    ).toEqual(['PRIMARY.local.md', 'SECONDARY.local.markdown']);
  });

  it('derives nothing from an empty list', () => {
    expect(deriveLocalContextFilenames([])).toEqual([]);
  });
});
