/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveTaskListId,
  sanitizeTaskPathSegment,
} from './task-list-id.js';

describe('task path segments', () => {
  it('sanitizes values before using them as path segments', () => {
    expect(sanitizeTaskPathSegment('team/alpha')).toBe('team-alpha');
  });

  it('preserves every legal hyphen without merging distinct IDs', () => {
    expect(sanitizeTaskPathSegment('a-b')).toBe('a-b');
    expect(sanitizeTaskPathSegment('a--b')).toBe('a--b');
    expect(sanitizeTaskPathSegment('-a-')).toBe('-a-');
    expect(sanitizeTaskPathSegment('a//b')).toBe('a--b');
  });

  it('uses an explicit environment value before the session ID', () => {
    expect(
      resolveTaskListId({
        sessionId: 'session',
        env: { QWEN_TASK_LIST_ID: 'explicit' },
      }),
    ).toBe('explicit');
    expect(resolveTaskListId({ sessionId: 'session', env: {} })).toBe(
      'session',
    );
  });

  it('uses the session ID when the environment value is empty', () => {
    expect(
      resolveTaskListId({
        sessionId: 'session',
        env: { QWEN_TASK_LIST_ID: '' },
      }),
    ).toBe('session');
  });
});
