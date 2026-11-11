/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AutoMemoryGenerationStrategySession,
  resolveAutoMemoryGenerationSelection,
} from './strategy-selection.js';

describe('auto-memory generation strategy selection', () => {
  it('keeps SDK-controlled generation on the caller-provided path', () => {
    expect(resolveAutoMemoryGenerationSelection(true)).toEqual({
      kind: 'existing',
    });
  });

  it('generates in the parent context by default', () => {
    expect(resolveAutoMemoryGenerationSelection(false)).toEqual({
      kind: 'fork_full_context',
    });
  });

  it('freezes the selection for the session', () => {
    const session = new AutoMemoryGenerationStrategySession();

    expect(session.resolve(false)).toEqual({ kind: 'fork_full_context' });
    expect(session.resolve(true)).toBe(session.resolve(false));
  });
});
