/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { toFleetEntry } from './FleetViewContext.js';
import type { SessionListItem } from '@qwen-code/qwen-code-core';

function makeSessionListItem(
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    sessionId: 'abc-123',
    cwd: '/home/user/project',
    startTime: '2026-01-01T00:00:00Z',
    mtime: Date.now(),
    prompt: 'Fix the login bug',
    filePath: '/home/user/.qwen/sessions/abc-123.jsonl',
    ...overrides,
  };
}

describe('toFleetEntry', () => {
  it('marks the session matching currentSessionId as current', () => {
    const item = makeSessionListItem({ sessionId: 'sess-1' });
    const entry = toFleetEntry(item, 'sess-1');
    expect(entry.status).toBe('current');
  });

  it('marks non-matching sessions as idle', () => {
    const item = makeSessionListItem({ sessionId: 'sess-2' });
    const entry = toFleetEntry(item, 'sess-1');
    expect(entry.status).toBe('idle');
  });

  it('marks all sessions as idle when currentSessionId is null', () => {
    const item = makeSessionListItem({ sessionId: 'sess-1' });
    const entry = toFleetEntry(item, null);
    expect(entry.status).toBe('idle');
  });

  it('uses customTitle as displayName when present', () => {
    const item = makeSessionListItem({ customTitle: 'My Session' });
    const entry = toFleetEntry(item, null);
    expect(entry.displayName).toBe('My Session');
  });

  it('uses prompt as displayName when no customTitle', () => {
    const item = makeSessionListItem({ prompt: 'Fix the bug' });
    const entry = toFleetEntry(item, null);
    expect(entry.displayName).toBe('Fix the bug');
  });

  it('truncates long prompts in displayName', () => {
    const longPrompt = 'a'.repeat(80);
    const item = makeSessionListItem({ prompt: longPrompt });
    const entry = toFleetEntry(item, null);
    expect(entry.displayName).toBe('a'.repeat(57) + '...');
    expect(entry.displayName.length).toBe(60);
  });

  it('falls back to sessionId prefix when no title or prompt', () => {
    const item = makeSessionListItem({
      sessionId: 'abcdef12-3456-7890',
      prompt: '',
    });
    const entry = toFleetEntry(item, null);
    expect(entry.displayName).toBe('abcdef12');
  });

  it('preserves all SessionListItem fields', () => {
    const item = makeSessionListItem({
      gitBranch: 'main',
      messageCount: 42,
    });
    const entry = toFleetEntry(item, null);
    expect(entry.cwd).toBe(item.cwd);
    expect(entry.gitBranch).toBe('main');
    expect(entry.messageCount).toBe(42);
    expect(entry.filePath).toBe(item.filePath);
  });
});
