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
  COMPRESSION_CONTINUATION_BRIDGE,
  COMPRESSION_SUMMARY_MODEL_ACK,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '@qwen-code/qwen-code-core';

const STARTUP_CONTEXT_MODEL_ACK = 'Got it. Thanks for the context!';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userContent(text: string): Content {
  return { role: 'user', parts: [{ text } as Part] };
}

function modelContent(text: string): Content {
  return { role: 'model', parts: [{ text } as Part] };
}

function functionCallContent(): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: { name: 'tool', args: {} },
      } as unknown as Part,
    ],
  };
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
    modelContent(STARTUP_CONTEXT_MODEL_ACK),
  ];
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeApiTruncationIndex', () => {
  it('returns 0 for empty API history', () => {
    const ui: HistoryItem[] = [userItem(1)];
    const api: Content[] = [];
    expect(computeApiTruncationIndex(ui, 1, api)).toBe(0);
  });

  it('returns -1 when the target user item is absent', () => {
    const ui: HistoryItem[] = [userItem(1), geminiItem(2)];
    const api: Content[] = [
      userContent('prompt 1'),
      modelContent('response 1'),
    ];

    expect(computeApiTruncationIndex(ui, 99, api)).toBe(-1);
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
    it('maps tail user turns after a compression summary pair', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(2);
    });

    it('keeps compressed turns unreachable after a compression summary pair', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 3, api)).toBe(-1);
    });

    it('keeps the first UI turn unreachable when compression absorbed it', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 1, api)).toBe(-1);
    });

    it('does not treat post-compact attachment restoration as a tail turn', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent(
          'Recently accessed file (full current content embedded):\n\n' +
            '## a.ts\n\n```ts\nexport const a = 1;\n```',
        ),
        functionCallContent(),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 3, api)).toBe(-1);
      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });

    it('maps compressed tail turns after startup context', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        ...startupPair(),
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });

    it('ignores the compression continuation bridge when mapping tail turns', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent(COMPRESSION_CONTINUATION_BRIDGE),
        modelContent('continued response'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(4);
    });

    it('skips the legacy visible bridge text without the sentinel', () => {
      const visibleBridgeText =
        'Continue with the prior task using the context above.';
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5, visibleBridgeText),
        geminiItem(6),
        userItem(7),
        geminiItem(8),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent(visibleBridgeText),
        modelContent('continued response'),
        userContent('prompt 7'),
        modelContent('response 7'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(-1);
      expect(computeApiTruncationIndex(ui, 7, api)).toBe(4);
    });

    it('ignores tool-call entries between the bridge and next tail prompt', () => {
      const ui: HistoryItem[] = [
        userItem(1),
        geminiItem(2),
        userItem(3),
        geminiItem(4),
        userItem(5),
        geminiItem(6),
      ];
      const api: Content[] = [
        userContent('compressed summary of prompt 1 and prompt 3'),
        modelContent(COMPRESSION_SUMMARY_MODEL_ACK),
        userContent(COMPRESSION_CONTINUATION_BRIDGE),
        functionCallContent(),
        functionResponseContent(),
        modelContent('tool result response'),
        userContent('prompt 5'),
        modelContent('response 5'),
      ];

      expect(computeApiTruncationIndex(ui, 5, api)).toBe(6);
    });

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
