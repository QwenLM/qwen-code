/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SessionError,
  sessionManager,
  sessionTranscriptStore,
  getConfigHomeDir,
  setConfigHomeDir,
} from './index.js';

describe('public surface smoke test', () => {
  it('exports the sessionManager instance', async () => {
    expect(sessionManager).toBeDefined();
    await expect(sessionManager.list('/tmp')).resolves.toEqual([]);
  });

  it('exports the sessionTranscriptStore instance', () => {
    expect(sessionTranscriptStore).toBeDefined();
    expect(typeof sessionTranscriptStore.acquireWriter).toBe('function');
    expect(typeof sessionTranscriptStore.flushAll).toBe('function');
    expect(typeof sessionTranscriptStore.close).toBe('function');
  });

  it('exports SessionError', () => {
    const error = SessionError.noSessionsFound();
    expect(error.code).toBe('NO_SESSIONS_FOUND');
    expect(error).toBeInstanceOf(SessionError);
  });

  it('exports config root helpers', () => {
    expect(typeof getConfigHomeDir).toBe('function');
    expect(typeof setConfigHomeDir).toBe('function');
  });
});
