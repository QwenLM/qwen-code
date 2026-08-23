/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeApiTruncationIndex, isRealUserTurn } from './historyMapping.js';
import type { HistoryItem } from '../types.js';
import type { Content, Part } from '@google/genai';
import {
  CompressionStatus,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '@qwen-code/qwen-code-core';

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

function startupEntry(): Content {
  return userContent(
    `${SYSTEM_REMINDER_OPEN}\nEnvironment context...\n${SYSTEM_REMINDER_CLOSE}`,
  );
}

function userItem(
  id: number,
  text = `prompt ${id}`,
  sentToModel?: boolean,
): HistoryItem {
  return {
    type: 'user',
    id,
    text,
    ...(sentToModel === undefined ? {} : { sentToModel }),
  } as HistoryItem;
}

function geminiItem(id: number): HistoryItem {
  return { type: 'gemini', id, text: `response ${id}` } as HistoryItem;
}

function compressionItem(
  id: number,
  compressionStatus = CompressionStatus.COMPRESSED,
  compressionKind: 'summarize' | 'fast' = 'summarize',
): HistoryItem {
  return {
    type: 'compression',
    id,
    compression: {
      isPending: false,
      originalTokenCount: 100,
      newTokenCount: 40,
      compressionStatus,
      compressionKind,
    },
  } as HistoryItem;
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

  describe('with startup context entry', () => {
    it('keeps startup context when rewinding to the first turn', () => {
      const ui: HistoryItem[] = [userItem(1), geminiItem(2)];
      const api: Content[] = [
        startupEntry(),
        userContent('prompt 1'),
        modelContent('response 1'),
      ];
      // Rewind to turn 1 -> keep startup entry.
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(1);
    });

    it('keeps startup + first turn when rewinding to second turn', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('prompt 1'),
        modelContent('response 1'),
        userContent('prompt 3'),
        modelContent('response 3'),
      ];
      // startup(1) + turn1(2) = 3 entries to keep.
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(3);
    });
  });

  describe('with mid-history system-reminder entries', () => {
    const mcpReminder = (): Content =>
      userContent(
        `${SYSTEM_REMINDER_OPEN}\nNew tools available: foo\n${SYSTEM_REMINDER_CLOSE}`,
      );

    it('does not count an MCP added-tool reminder as a user prompt', () => {
      // drainPendingAddedMcpToolsReminder injects a pure <system-reminder>
      // user entry mid-history. It is role:'user' with text, so a naive count
      // treats it as a real prompt and lands the truncation index one turn
      // early, silently dropping a turn's context.
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('prompt 1'),
        modelContent('response 1'),
        mcpReminder(), // must NOT count as a user turn
        userContent('prompt 3'),
        modelContent('response 3'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];
      // Rewind to turn 5 (2 real turns before it). If the reminder counted,
      // the walk would stop at its successor (idx 4) and drop turn 3's
      // context; excluding it lands correctly at prompt 5 (idx 6).
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(6);
    });

    it('still counts a real turn that has a per-turn reminder prepended', () => {
      // In plan mode the reminder is an extra part on the SAME Content as the
      // prompt: parts = [<system-reminder>…, prompt]. That entry IS a real
      // user turn (it has a non-reminder prompt part), so it must be counted —
      // a parts[0]-only exclusion would wrongly skip it and miscount.
      const planTurn = (id: number): Content => ({
        role: 'user',
        parts: [
          {
            text: `${SYSTEM_REMINDER_OPEN}\nPlan mode is active.\n${SYSTEM_REMINDER_CLOSE}`,
          } as Part,
          { text: `prompt ${id}` } as Part,
        ],
      });
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        planTurn(1),
        modelContent('response 1'),
        planTurn(3),
        modelContent('response 3'),
      ];
      // Rewind to turn 3 → keep startup + turn 1 = 3 entries.
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(3);
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

    it('maps post-compression UI turns from the latest compressed marker', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'pre-compression prompt'),
        geminiItem(2),
        compressionItem(3),
        userItem(4, 'post 1'),
        geminiItem(5),
        userItem(6, 'post 2'),
        geminiItem(7),
        userItem(8, 'post 3'),
        geminiItem(9),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('<state_snapshot>summary\n\nResume the prior task...'),
        modelContent('Got it. Thanks for the additional context!'),
        userContent('post 1'),
        modelContent('response 1'),
        userContent('post 2'),
        modelContent('response 2'),
        userContent('post 3'),
        modelContent('response 3'),
      ];

      expect(computeApiTruncationIndex(ui, 4, api)).toBe(3);
      expect(computeApiTruncationIndex(ui, 6, api)).toBe(5);
      expect(computeApiTruncationIndex(ui, 8, api)).toBe(7);
    });

    it('does not rewind to UI turns before a successful compression marker', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'pre-compression prompt'),
        geminiItem(2),
        compressionItem(3),
        userItem(4, 'post compression'),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('<state_snapshot>summary\n\nResume the prior task...'),
        modelContent('Got it. Thanks for the additional context!'),
        userContent('post compression'),
      ];

      expect(computeApiTruncationIndex(ui, 1, api)).toBe(-1);
    });

    it('does not treat no-op compression markers as collapsed history', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'first prompt'),
        geminiItem(2),
        compressionItem(3, CompressionStatus.NOOP),
        userItem(4, 'second prompt'),
        geminiItem(5),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('first prompt'),
        modelContent('response 1'),
        userContent('second prompt'),
        modelContent('response 2'),
      ];

      expect(computeApiTruncationIndex(ui, 4, api)).toBe(3);
    });

    it('fails loud when marker-less auto-compaction left a compressed prefix', () => {
      // Auto-compaction adds no UI compression marker, but leaves the API
      // history with a [summary, ack] prefix. Rewinding to the first turn
      // must abort (-1) rather than silently truncate to the compressed
      // prefix and drop every real turn (R5-1 entrance 3).
      const ui: HistoryItem[] = [
        userItem(1, 'pre 1'),
        geminiItem(2),
        userItem(3, 'pre 2'),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('<state_snapshot>summary\n\nResume the prior task...'),
        modelContent('Got it. Thanks for the additional context!'),
      ];
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(-1);
    });
  });

  describe('with fast (non-summarizing) compression markers', () => {
    // /compress-fast keeps every user prompt in the API history and inserts
    // no summary prefix, so its marker must not act as a rewind boundary.
    // Shaped after the report in #9320: rewinding to the first post-marker
    // turn used to collapse the anchor to the startup entry and silently
    // drop the entire pre-marker conversation.
    const fastCompressedHistory = () => {
      const ui: HistoryItem[] = [
        userItem(1, 'pre 1'),
        geminiItem(2),
        userItem(3, 'pre 2'),
        geminiItem(4),
        userItem(5, 'pre 3'),
        geminiItem(6),
        compressionItem(7, CompressionStatus.COMPRESSED, 'fast'),
        userItem(8, 'post 1'),
        geminiItem(9),
        userItem(10, 'post 2'),
        geminiItem(11),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('pre 1'),
        modelContent('response 1'),
        userContent('pre 2'),
        modelContent('response 2'),
        userContent('pre 3'),
        modelContent('response 3'),
        userContent('post 1'),
        modelContent('response post 1'),
        userContent('post 2'),
        modelContent('response post 2'),
      ];
      return { ui, api };
    };

    it('keeps the full pre-marker history when rewinding to the first post-marker turn', () => {
      const { ui, api } = fastCompressedHistory();
      // Keep startup + all three pre-marker turns, truncate before 'post 1'.
      expect(computeApiTruncationIndex(ui, 8, api)).toBe(7);
    });

    it('maps later post-marker turns against the full history', () => {
      const { ui, api } = fastCompressedHistory();
      // 4 real user turns precede 'post 2' → truncate before idx 9.
      expect(computeApiTruncationIndex(ui, 10, api)).toBe(9);
    });

    it('allows rewinding to turns before a fast-compression marker', () => {
      const { ui, api } = fastCompressedHistory();
      // Fast compression absorbs no prompts, so pre-marker turns stay
      // reachable (summarizing compression would return -1 here).
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(3);
    });

    it('still blocks turns absorbed by a later summarizing compression', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'pre fast'),
        geminiItem(2),
        compressionItem(3, CompressionStatus.COMPRESSED, 'fast'),
        userItem(4, 'between compressions'),
        geminiItem(5),
        compressionItem(6, CompressionStatus.COMPRESSED, 'summarize'),
        userItem(7, 'post summarize'),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('<state_snapshot>summary\n\nResume the prior task...'),
        modelContent('Got it. Thanks for the additional context!'),
        userContent('post summarize'),
      ];

      expect(computeApiTruncationIndex(ui, 4, api)).toBe(-1);
      expect(computeApiTruncationIndex(ui, 7, api)).toBe(3);
    });

    it('treats legacy markers without a kind as summarizing', () => {
      const legacyMarker: HistoryItem = {
        type: 'compression',
        id: 3,
        compression: {
          isPending: false,
          originalTokenCount: 100,
          newTokenCount: 40,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      } as HistoryItem;
      const ui: HistoryItem[] = [
        userItem(1, 'pre-compression prompt'),
        geminiItem(2),
        legacyMarker,
        userItem(4, 'post compression'),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('<state_snapshot>summary\n\nResume the prior task...'),
        modelContent('Got it. Thanks for the additional context!'),
        userContent('post compression'),
      ];

      // Pre-marker turns stay unreachable, matching pre-fix behavior for
      // sessions persisted before compressionKind existed.
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(-1);
      expect(computeApiTruncationIndex(ui, 4, api)).toBe(3);
    });
  });

  describe('with microcompaction media-clear placeholders', () => {
    // /compress-fast's forced microcompaction replaces the top-level
    // inlineData/fileData parts of user entries with text placeholders
    // ('[Old inline media cleared: <mime>]'). A media-only user entry
    // (e.g. an image-only ACP prompt) never produced a UI user turn, but
    // once cleared it satisfies a naive 'text' in part check — counting it
    // desynchronizes the API prompt count from the UI turn count and makes
    // the walk truncate one turn early, silently dropping a turn the UI
    // still shows (the same hazard this PR's fast-marker change addresses,
    // newly reachable through cross-fast-marker rewinds).

    function clearedMediaContent(mime = 'image/png'): Content {
      return {
        role: 'user',
        parts: [{ text: `[Old inline media cleared: ${mime}]` } as Part],
      };
    }

    function inlineMediaContent(): Content {
      return {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } } as Part],
      };
    }

    it('does not count a cleared media-only entry as a user prompt', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'hello'),
        geminiItem(2),
        userItem(3, 'world'),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        clearedMediaContent(), // media-only entry, cleared; NOT a UI turn
        userContent('hello'),
        modelContent('response hello'),
        userContent('world'),
        modelContent('response world'),
      ];
      // Witness: with the uncleared inlineData entry the index is 4; the
      // cleared placeholder must land on the same index, not one turn early.
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(4);

      const apiUncleared: Content[] = [
        startupEntry(),
        inlineMediaContent(),
        userContent('hello'),
        modelContent('response hello'),
        userContent('world'),
        modelContent('response world'),
      ];
      expect(computeApiTruncationIndex(ui, 3, apiUncleared)).toBe(4);
    });

    it('keeps the full pre-marker history when a cleared entry precedes a fast marker', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'pre 1'),
        geminiItem(2),
        compressionItem(3, CompressionStatus.COMPRESSED, 'fast'),
        userItem(4, 'post 1'),
        geminiItem(5),
        userItem(6, 'post 2'),
        geminiItem(7),
      ];
      const api: Content[] = [
        startupEntry(),
        clearedMediaContent(), // cleared by /compress-fast microcompaction
        userContent('pre 1'),
        modelContent('response pre 1'),
        userContent('post 1'),
        modelContent('response post 1'),
        userContent('post 2'),
        modelContent('response post 2'),
      ];
      // 2 real turns precede 'post 2'; the cleared entry must not shift the
      // count. Without the exclusion the walk stops at 'post 1' (idx 4).
      expect(computeApiTruncationIndex(ui, 6, api)).toBe(6);
    });

    it('still counts an entry mixing a placeholder with real prompt text', () => {
      const mixedTurn: Content = {
        role: 'user',
        parts: [
          { text: '[Old inline media cleared: image/png]' } as Part,
          { text: 'check this image' } as Part,
        ],
      };
      const ui: HistoryItem[] = [
        userItem(1, 'check this image'),
        geminiItem(2),
        userItem(3, 'world'),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        mixedTurn,
        modelContent('response 1'),
        userContent('world'),
        modelContent('response world'),
      ];
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(3);
    });

    it('still counts a genuine prompt that merely begins with the placeholder prefix', () => {
      // Microcompaction never rewrites text parts, so a user prompt that
      // starts with '[Old inline media cleared:' (e.g. a pasted
      // placeholder) is genuine. A bare-prefix match would drop it from
      // the API prompt count: rewinding to a later turn truncated one
      // prompt LATE (index 4 instead of 3) and rewinding to the prefix
      // turn itself returned -1 with a spurious "compressed" error.
      const prefixPromptText =
        '[Old inline media cleared: image/png] why is this in my history?';
      const prefixPrompt: Content = {
        role: 'user',
        parts: [{ text: prefixPromptText } as Part],
      };
      const ui: HistoryItem[] = [
        userItem(1, prefixPromptText),
        geminiItem(2),
        userItem(3, 'world'),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        prefixPrompt,
        modelContent('response 1'),
        userContent('world'),
        modelContent('response world'),
      ];
      // Prefix turn AS the rewind target lands on its own entry…
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(1);
      // …and a later rewind target is not shifted one turn late.
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(3);
    });

    it('pins the exact-match collision corner as a loud block, not silent loss', () => {
      // Known limitation, documented next to the exclusion in
      // historyMapping.ts: microcompaction never rewrites text parts, so a
      // genuine prompt whose entire text equals a generated placeholder is
      // indistinguishable from a cleared media-only entry. It is excluded
      // from the API prompt count, so every later rewind target returns
      // -1 — AppContainer turns that into a loud "Cannot rewind to a turn
      // that was compressed" abort. This pins the fail-safe shape: a
      // visible error, never silent history loss. A durable fix needs a
      // structural sentinel on cleared parts (persisted-format change, out
      // of scope here) and would update this expectation.
      const exactPlaceholderText = '[Old inline media cleared: image/png]';
      const collidingPrompt: Content = {
        role: 'user',
        parts: [{ text: exactPlaceholderText } as Part],
      };
      const ui: HistoryItem[] = [
        userItem(1, exactPlaceholderText),
        geminiItem(2),
        userItem(3, 'world'),
        geminiItem(4),
      ];
      const api: Content[] = [
        startupEntry(),
        collidingPrompt,
        modelContent('response 1'),
        userContent('world'),
        modelContent('response world'),
      ];
      // Rewinding to the colliding turn itself still works via the
      // uiUserTurnCount === 0 shortcut…
      expect(computeApiTruncationIndex(ui, 1, api)).toBe(1);
      // …while every later target fails loud (-1) instead of truncating
      // against a misaligned prompt count.
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(-1);
    });

    it('pins the mid-history exact-match collision: own turn one-late, later turns loud', () => {
      // Same known limitation as the test above, with the colliding turn in
      // a mid-history position (uiUserTurnCount >= 1): the shortcut does
      // not apply, so rewinding TO the colliding turn lands on the next
      // counted prompt and truncates one turn LATE — the colliding turn's
      // prompt+response stays in model context while the UI removes the
      // turn (under-deletion, not loss of context the UI keeps). Every
      // later target still fails loud (-1). Pinned so a structural fix
      // (sentinel on cleared parts) updates both expectations.
      const exactPlaceholderText = '[Old inline media cleared: image/png]';
      const ui: HistoryItem[] = [
        userItem(1, 'hello'),
        geminiItem(2),
        userItem(3, exactPlaceholderText),
        geminiItem(4),
        userItem(5, 'world'),
        geminiItem(6),
      ];
      const api: Content[] = [
        startupEntry(),
        userContent('hello'),
        modelContent('response hello'),
        userContent(exactPlaceholderText),
        modelContent('response colliding'),
        userContent('world'),
        modelContent('response world'),
      ];
      // Rewinding TO the colliding turn keeps its prompt+response (index 5,
      // one turn late)…
      expect(computeApiTruncationIndex(ui, 3, api)).toBe(5);
      // …while every later target fails loud (-1).
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(-1);
    });
  });

  describe('mid-turn user messages (notification type)', () => {
    it('skips notification items so btw merged into functionResponse does not cause mismatch', () => {
      // Mid-turn messages are type 'notification' in UI (not counted by
      // isRealUserTurn) and merged into tool_result in API (skipped by
      // isUserTextContent). Both sides agree → correct truncation index.
      const ui: HistoryItem[] = [
        userItem(1, 'first prompt'),
        geminiItem(2),
        {
          type: 'notification',
          id: 3,
          text: 'btw side question',
        } as HistoryItem,
        userItem(5, 'next prompt'),
        geminiItem(6),
      ];
      const btwMergedIntoToolResult: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'tool', response: { result: 'ok' } },
          } as unknown as Part,
          { text: 'btw side question' } as Part,
        ],
      };
      const api: Content[] = [
        userContent('first prompt'),
        modelContent('response with tool call'),
        btwMergedIntoToolResult,
        modelContent('response after btw'),
        userContent('next prompt'),
        modelContent('response 5'),
      ];
      // notification is not counted → uiUserTurnCount=1 before 'next prompt'
      // API has 2 user text entries (idx 0 and 4) → finds idx 4 correctly
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
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

    it('counts slash command invocations explicitly marked as sent to the model', () => {
      const ui: HistoryItem[] = [
        userItem(1, 'hello'),
        geminiItem(2),
        userItem(3, '/filecmd', true),
        geminiItem(4),
        userItem(5, 'world'),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('hello'),
        modelContent('response 1'),
        userContent('expanded file command prompt'),
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

  it('uses explicit model-sent metadata for slash commands', () => {
    expect(isRealUserTurn(userItem(1, '/filecmd', true))).toBe(true);
    expect(isRealUserTurn(userItem(1, '/help', false))).toBe(false);
  });

  it('ignores corrupted non-boolean sentToModel metadata', () => {
    const item = {
      type: 'user',
      id: 1,
      text: '/filecmd',
      sentToModel: 'true',
    } as unknown as HistoryItem;

    expect(isRealUserTurn(item)).toBe(false);
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
    expect(
      isRealUserTurn({ type: 'info', id: 1, text: 'info' } as HistoryItem),
    ).toBe(false);
  });

  it('returns true for user items with suppressOnRestore', () => {
    const item = userItem(1, 'hello world');
    item.display = { suppressOnRestore: true };
    expect(isRealUserTurn(item)).toBe(true);
  });
});
