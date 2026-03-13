/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { extractSessionListItems } from './qwenAgentManager.js';

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

describe('extractSessionListItems', () => {
  it('returns sessions array from the "sessions" field', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'session-1' }],
    });
    expect(items).toEqual([{ sessionId: 'session-1' }]);
  });

  it('returns items array from the legacy "items" field', () => {
    const items = extractSessionListItems({
      items: [{ sessionId: 'session-2' }],
    });
    expect(items).toEqual([{ sessionId: 'session-2' }]);
  });

  it('prefers "sessions" over "items" when both are present', () => {
    const items = extractSessionListItems({
      sessions: [{ sessionId: 'from-sessions' }],
      items: [{ sessionId: 'from-items' }],
    });
    expect(items).toEqual([{ sessionId: 'from-sessions' }]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(extractSessionListItems(null)).toEqual([]);
    expect(extractSessionListItems(undefined)).toEqual([]);
  });

  it('returns empty array for non-object input', () => {
    expect(extractSessionListItems('string')).toEqual([]);
    expect(extractSessionListItems(42)).toEqual([]);
  });

  it('returns empty array when neither field is an array', () => {
    expect(extractSessionListItems({ sessions: 'not-array' })).toEqual([]);
    expect(extractSessionListItems({ items: 123 })).toEqual([]);
    expect(extractSessionListItems({})).toEqual([]);
  });
});
