/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeApiTruncationIndex, isRealUserTurn } from './historyMapping.js';
import type { HistoryItem } from '../types.js';
import type { Content, Part } from '@google/genai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userContent(text: string): Content {
  return { role: 'user', parts: [{ text } as Part] };
}

function modelContent(text: string): Content {
  return { role: 'model', parts: [{ text } as Part] };
}

function functionResponseContent(): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: { name: 'tool', response: { result: 'ok' } },
      } as unknown as Part,
    ],
  };
}

function startupPair(): [Content, Content] {
  return [
    userContent('Environment context...'),
    modelContent('Got it. Thanks for the context!'),
  ];
}

function userItem(id: number, text = `prompt ${id}`): HistoryItem {
  return { type: 'user', id, text } as HistoryItem;
}

function geminiItem(id: number): HistoryItem {
  return { type: 'gemini', id, text: `response ${id}` } as HistoryItem;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeApiTruncationIndex', () => {
  it('returns 0 for empty API history', () => {
    const ui: HistoryItem[] = [userItem(1)];
    const api: Content[] = [];
    expect(computeApiTruncationIndex(ui, 1, api)).toBe(0);
  });

  describe('without startup context', () => {
    it('rewinds to the first user turn (keep nothing)', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
      ];
      const api: Content[] = [
        userContent('prompt 1'),
        modelContent('response 1'),
        userContent('prompt 3'),
        modelContent('response 3'),
      ];
      // Rewind to turn 1 → keep 0 entries before it
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(0);
    });

    it('rewinds to the second user turn (keep first turn)', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
      ];
      const api: Content[] = [
        userContent('prompt 1'),
        modelContent('response 1'),
        userContent('prompt 3'),
        modelContent('response 3'),
      ];
      // Rewind to turn 3 → keep entries before the second user Content
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(2);
    });

    it('rewinds to the third user turn', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('prompt 1'),
        modelContent('response 1'),
        userContent('prompt 3'),
        modelContent('response 3'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });
  });

  describe('with startup context pair', () => {
    it('keeps startup context when rewinding to the first turn', () => {
      const ui: HistoryItem[] = [userItem(1), geminiItem(2)];
      const api: Content[] = [
        ...startupPair(),
        userContent('prompt 1'),
        modelContent('response 1'),
      ];
      // Rewind to turn 1 → keep startup pair (2 entries)
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(2);
    });

    it('keeps startup + first turn when rewinding to second turn', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
      ];
      const api: Content[] = [
        ...startupPair(),
        userContent('prompt 1'),
        modelContent('response 1'),
        userContent('prompt 3'),
        modelContent('response 3'),
      ];
      // startup(2) + turn1(2) = 4 entries to keep
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(4);
    });
  });

  describe('with tool call entries (functionResponse)', () => {
    it('skips functionResponse entries when counting user prompts', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        // tool_group items are not type 'user', they don't affect the count
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('prompt 1'),
        modelContent('response with tool call'),
        functionResponseContent(), // tool result — should be skipped
        modelContent('response after tool'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];
      // Rewind to turn 5: 1 user turn before it → find the 2nd user text
      // API walk: idx 0 = user text (count=1), idx 4 = user text (count=2 > 1) → return 4
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });
  });

  describe('compression fallback', () => {
    it('returns -1 when not enough user prompts found', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      // After compression, API history may be shorter than expected
      const api: Content[] = [
        modelContent('compressed summary'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];
      // Rewind to turn 5 → 2 user turns before it, but API only has 1 user text
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(-1);
    });
  });

  describe('with slash-command items in UI history', () => {
    it('ignores slash-command items when counting user turns', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'hello'),
        geminiItem(2),
        userItem(3, '/help'), // slash command — should be skipped
        userItem(5, 'world'),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('hello'),
        modelContent('response 1'),
        userContent('world'),
        modelContent('response 2'),
      ];
      // Rewind to 'world' (id=5): 1 real user turn before it (id=1)
      // Slash '/help' (id=3) should not be counted
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(2);
    });

    it('counts path-like slash prompts that were sent to the model', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'hello'),
        geminiItem(2),
        userItem(3, '/api/apiFunction/接口的实现'),
        geminiItem(4),
        userItem(5, 'world'),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('hello'),
        modelContent('response 1'),
        userContent('/api/apiFunction/接口的实现'),
        modelContent('response 2'),
        userContent('world'),
        modelContent('response 3'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });
  });

  describe('single turn', () => {
    it('handles rewinding the only turn', () => {
      const ui: HistoryItem[] = [userItem(1), geminiItem(2)];
      const api: Content[] = [
        userContent('prompt 1'),
        modelContent('response 1'),
      ];
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(0);
    });
  });
});

describe('isRealUserTurn', () => {
  it('returns true for normal user prompts', () => {
    expect(isRealUserTurn(userItem(1, 'hello world'))).toBe(true);
  });

  it('returns false for slash commands', () => {
    expect(isRealUserTurn(userItem(1, '/help'))).toBe(false);
    expect(isRealUserTurn(userItem(1, '/rewind'))).toBe(false);
    expect(isRealUserTurn(userItem(1, '/stats'))).toBe(false);
  });

  it('returns true for path-like slash prompts', () => {
    expect(isRealUserTurn(userItem(1, '/api/apiFunction/接口的实现'))).toBe(
      true,
    );
    expect(isRealUserTurn(userItem(1, '/Users/name/project 帮我安装'))).toBe(
      true,
    );
  });

  it('returns false for ? commands', () => {
    expect(isRealUserTurn(userItem(1, '?help'))).toBe(false);
  });

  it('returns false for non-user items', () => {
    expect(isRealUserTurn(geminiItem(1))).toBe(false);
  });
});
