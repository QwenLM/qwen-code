/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExtractRunning,
  isExtractRunning,
  markExtractRunning,
  resetAutoMemoryStateForTests,
} from './state.js';

describe('auto-memory state', () => {
  afterEach(() => {
    resetAutoMemoryStateForTests();
  });

  it('tracks extract running state per project', () => {
    expect(isExtractRunning('/tmp/project')).toBe(false);
    markExtractRunning('/tmp/project');
    expect(isExtractRunning('/tmp/project')).toBe(true);
    clearExtractRunning('/tmp/project');
    expect(isExtractRunning('/tmp/project')).toBe(false);
  });
});