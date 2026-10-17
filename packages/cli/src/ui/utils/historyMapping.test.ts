/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  computeApiTruncationIndex,
  isRetainedUserTurn,
  isRealUserTurn,
} from './historyMapping.js';
import type { HistoryItem } from '../types.js';
import type { Content, Part } from '@google/genai';
import {
  CompressionStatus,
  markApiHistoryPrompt,
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

function llmItem(id: number): HistoryItem {
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
  it('uses identity for the first user turn when model history starts with a notification', () => {
    const target = {
      ...userItem(3, 'target'),
      promptId: 'session########0',
    } as HistoryItem;
    const targetContent = userContent('target');
    markApiHistoryPrompt(targetContent, 'session########0');

    expect(
      computeApiTruncationIndex(
        [
          { type: 'notification', id: 1, text: 'background result' },
          llmItem(2),
          target,
        ] as HistoryItem[],
        3,
        [
          userContent('background result'),
          modelContent('background response'),
          targetContent,
        ],
      ),
    ).toBe(2);
  });

  it('uses a stable prompt identity instead of positional alignment', () => {
    const target = {
      ...userItem(3, 'target'),
      promptId: 'session########1',
    } as HistoryItem;
    const targetContent = userContent('target');
    markApiHistoryPrompt(targetContent, 'session########1');

    expect(
      computeApiTruncationIndex([userItem(1), llmItem(2), target], 3, [
        userContent('first'),
        modelContent('first response'),
        userContent('unowned entry'),
        modelContent('unowned response'),
        targetContent,
      ]),
    ).toBe(4);
  });

  it('refuses an identified turn whose model entry is unmarked', () => {
    const target = {
      ...userItem(3, 'target'),
      promptId: 'unmarked',
    } as HistoryItem;

    expect(
      computeApiTruncationIndex([userItem(1), llmItem(2), target], 3, [
        userContent('first'),
        modelContent('first response'),
        userContent('target'),
      ]),
    ).toBe(-1);
  });

  it('refuses an identified turn when its identity is duplicated', () => {
    const target = {
      ...userItem(3, 'target'),
      promptId: 'duplicate',
    } as HistoryItem;
    const firstMatch = userContent('first match');
    const secondMatch = userContent('second match');
    markApiHistoryPrompt(firstMatch, 'duplicate');
    markApiHistoryPrompt(secondMatch, 'duplicate');

    expect(
      computeApiTruncationIndex([userItem(1), llmItem(2), target], 3, [
        firstMatch,
        modelContent('response'),
        secondMatch,
      ]),
    ).toBe(-1);
  });

  it('refuses an identity duplicated only in retained UI history', () => {
    const target = {
      ...userItem(3, 'absorbed target'),
      promptId: 'duplicate',
    } as HistoryItem;
    const twin = {
      ...userItem(5, 'surviving twin'),
      promptId: 'duplicate',
    } as HistoryItem;
    const survivingContent = userContent('surviving twin');
    markApiHistoryPrompt(survivingContent, 'duplicate');

    expect(
      computeApiTruncationIndex(
        [userItem(1), llmItem(2), target, llmItem(4), twin],
        3,
        [userContent('first'), modelContent('response'), survivingContent],
      ),
    ).toBe(-1);
  });

  it('resolves an identified turn whose twin was absorbed by compression', () => {
    const absorbedTwin = {
      ...userItem(1, 'absorbed twin'),
      promptId: 'session########1',
    } as HistoryItem;
    const target = {
      ...userItem(4, 'post-compression'),
      promptId: 'session########1',
    } as HistoryItem;
    const targetContent = userContent('post-compression');
    markApiHistoryPrompt(targetContent, 'session########1');

    expect(
      computeApiTruncationIndex(
        [absorbedTwin, llmItem(2), compressionItem(3), target, llmItem(5)],
        4,
        [
          startupEntry(),
          userContent('<state_snapshot>summary\n\nResume the prior task...'),
          modelContent('Got it. Thanks for the additional context!'),
          targetContent,
          modelContent('response'),
        ],
      ),
    ).toBe(3);
  });

  it.each([1, 3])(
    'refuses unlinked legacy target %i without guessing a position',
    (targetId) => {
      const ui = [userItem(1, 'hello'), llmItem(2), userItem(3, 'world')];
      expect(
        computeApiTruncationIndex(ui, targetId, [
          userContent('hello'),
          modelContent('response'),
          userContent('world'),
        ]),
      ).toBe(-1);
      expect(computeApiTruncationIndex(ui, targetId, [])).toBe(-1);
    },
  );

  it('resolves a record-linked target past hidden entries', () => {
    const target = {
      ...userItem(3, 'target'),
      rewindId: 'legacy-record:target',
    } as HistoryItem;
    const content = userContent('target');
    markApiHistoryPrompt(content, 'legacy-record:target');
    expect(
      computeApiTruncationIndex([userItem(1), llmItem(2), target], 3, [
        startupEntry(),
        userContent('notification'),
        functionResponseContent(),
        content,
      ]),
    ).toBe(3);
  });

  it('refuses a record key duplicated in the retained UI', () => {
    const first = {
      ...userItem(1),
      rewindId: 'legacy-record:duplicate',
    } as HistoryItem;
    const second = {
      ...userItem(3),
      rewindId: 'legacy-record:duplicate',
    } as HistoryItem;
    const content = userContent('target');
    markApiHistoryPrompt(content, 'legacy-record:duplicate');
    expect(
      computeApiTruncationIndex([first, llmItem(2), second], 3, [content]),
    ).toBe(-1);
  });

  it('refuses a record-linked target in an old unmarked compression snapshot', () => {
    const target = {
      ...userItem(3, 'target'),
      rewindId: 'legacy-record:target',
    } as HistoryItem;
    const api = [
      startupEntry(),
      userContent('<state_snapshot>summary\\n\\nResume the prior task...'),
      modelContent('Got it. Thanks for the additional context!'),
      userContent('target'),
    ];
    expect(
      computeApiTruncationIndex([compressionItem(1), target], 3, api),
    ).toBe(-1);
  });

  it('resolves a retained identity after marker-less compaction without counting UI turns', () => {
    const target = {
      ...userItem(1, 'target'),
      promptId: 'retained',
    } as HistoryItem;
    const content = userContent('target');
    markApiHistoryPrompt(content, 'retained');
    const api = [
      startupEntry(),
      userContent('<state_snapshot>summary\\n\\nResume the prior task...'),
      modelContent('Got it. Thanks for the additional context!'),
      content,
    ];
    expect(computeApiTruncationIndex([target], 1, api)).toBe(3);
  });

  it.each([
    [CompressionStatus.COMPRESSED, 'summarize', -1],
    [CompressionStatus.COMPRESSED, undefined, -1],
    [CompressionStatus.COMPRESSED, 'fast', 1],
    [CompressionStatus.NOOP, 'summarize', 1],
  ] as const)(
    'honors the %s/%s compression boundary',
    (status, kind, expected) => {
      const target = {
        ...userItem(1, 'target'),
        promptId: 'target',
      } as HistoryItem;
      const content = userContent('target');
      markApiHistoryPrompt(content, 'target');
      const marker = compressionItem(3, status);
      if (marker.type === 'compression')
        marker.compression.compressionKind = kind;
      expect(
        computeApiTruncationIndex([target, llmItem(2), marker], 1, [
          startupEntry(),
          content,
        ]),
      ).toBe(expected);
    },
  );

  it('refuses unknown or local-only targets', () => {
    const ui = [userItem(1, '/help', false)];
    expect(computeApiTruncationIndex(ui, 99, [userContent('prompt')])).toBe(-1);
    expect(computeApiTruncationIndex(ui, 1, [userContent('prompt')])).toBe(-1);
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
    expect(isRealUserTurn(llmItem(1))).toBe(false);
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

describe('isRetainedUserTurn', () => {
  const identified = (id: number, promptId: string) =>
    ({ ...userItem(id, `prompt ${id}`), promptId }) as HistoryItem;

  it('is true for an identified turn after the compression boundary', () => {
    expect(
      isRetainedUserTurn(
        [userItem(1), compressionItem(2), identified(3, 'session########2')],
        3,
      ),
    ).toBe(true);
  });

  it('is false for an identified turn absorbed by compression', () => {
    expect(
      isRetainedUserTurn(
        [identified(1, 'session########0'), llmItem(2), compressionItem(3)],
        1,
      ),
    ).toBe(false);
  });

  it('names an unlinked legacy refusal as a missing association, not compression', () => {
    expect(isRetainedUserTurn([userItem(1), llmItem(2)], 1)).toBe(true);
  });

  it('is false for an unknown target', () => {
    expect(isRetainedUserTurn([userItem(1)], 99)).toBe(false);
  });
});
