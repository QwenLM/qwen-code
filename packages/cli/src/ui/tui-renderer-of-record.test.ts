/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  setTuiRendererOfRecord,
  getTuiRendererOfRecord,
} from './tui-renderer-of-record.js';

describe('tui-renderer-of-record', () => {
  // The module starts empty; this must run before any setter so the absence
  // assertion reads the real initial state, not a value a sibling recorded.
  it('is undefined before a renderer is recorded', () => {
    expect(getTuiRendererOfRecord()).toBeUndefined();
  });

  it('returns the renderer that was recorded, including overwrites', () => {
    setTuiRendererOfRecord('ink');
    expect(getTuiRendererOfRecord()).toBe('ink');
    // A requested OpenTUI that boots after an earlier ink record must win.
    setTuiRendererOfRecord('opentui');
    expect(getTuiRendererOfRecord()).toBe('opentui');
  });
});
