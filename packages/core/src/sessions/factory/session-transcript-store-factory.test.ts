/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createSessionTranscriptStore } from './session-transcript-store-factory.js';

describe('createSessionTranscriptStore', () => {
  it('returns a SessionTranscriptStore with writer lifecycle methods', () => {
    const store = createSessionTranscriptStore();

    expect(typeof store.acquireWriter).toBe('function');
    expect(typeof store.flushAll).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});
