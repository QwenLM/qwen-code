/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  COMPRESSION_SUMMARY_MODEL_ACK,
  POST_COMPACT_ATTACHMENT_TEXT_PREFIXES,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '@qwen-code/qwen-code-core';
import {
  hasTextPart,
  hasModelTextPart,
  isApiUserTextContent,
  hasCompressionSummaryPair,
  getCompressionTailStartIndex,
  getApiUserTextIndices,
  isPostCompactAttachmentContent,
} from './api-history-utils.js';

const STARTUP_CONTEXT_MODEL_ACK = 'Got it. Thanks for the context!';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userTextContent(text: string): Content {
  return { role: 'user', parts: [{ text } as Part] };
}

function modelTextContent(text: string): Content {
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

function functionCallContent(): Content {
  return {
    role: 'model',
    parts: [{ functionCall: { name: 'tool', args: {} } } as unknown as Part],
  };
}

// ---------------------------------------------------------------------------
// hasTextPart
// ---------------------------------------------------------------------------

describe('hasTextPart', () => {
  it('returns true when content has a text part matching exactly', () => {
    expect(hasTextPart(userTextContent('hello'), 'hello')).toBe(true);
  });

  it('returns false when text does not match', () => {
    expect(hasTextPart(userTextContent('hello'), 'world')).toBe(false);
  });

  it('returns false for undefined content', () => {
    expect(hasTextPart(undefined, 'hello')).toBe(false);
  });

  it('returns false when parts is undefined', () => {
    expect(hasTextPart({ role: 'user' }, 'hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasModelTextPart
// ---------------------------------------------------------------------------

describe('hasModelTextPart', () => {
  it('returns true when model content has matching text', () => {
    expect(hasModelTextPart(modelTextContent('ack'), 'ack')).toBe(true);
  });

  it('returns false when role is not model', () => {
    expect(hasModelTextPart(userTextContent('ack'), 'ack')).toBe(false);
  });

  it('returns false when text does not match', () => {
    expect(hasModelTextPart(modelTextContent('ack'), 'other')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isApiUserTextContent
// ---------------------------------------------------------------------------

describe('isApiUserTextContent', () => {
  it('returns true for user text content', () => {
    expect(isApiUserTextContent(userTextContent('hello'))).toBe(true);
  });

  it('returns false for model content', () => {
    expect(isApiUserTextContent(modelTextContent('hello'))).toBe(false);
  });

  it('returns false for functionResponse content', () => {
    expect(isApiUserTextContent(functionResponseContent())).toBe(false);
  });

  it('returns false for empty parts', () => {
    expect(isApiUserTextContent({ role: 'user', parts: [] })).toBe(false);
  });

  it('returns false for undefined parts', () => {
    expect(isApiUserTextContent({ role: 'user' })).toBe(false);
  });

  it('returns false for functionCall content (model role)', () => {
    expect(isApiUserTextContent(functionCallContent())).toBe(false);
  });

  it('returns false for pure system reminder content', () => {
    const content = userTextContent(
      `${SYSTEM_REMINDER_OPEN}\nNew tools available: foo\n${SYSTEM_REMINDER_CLOSE}`,
    );

    expect(isApiUserTextContent(content)).toBe(false);
  });

  it('rejects user content with no text (only functionResponse)', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { functionResponse: { name: 't', response: {} } } as unknown as Part,
        { text: 'some text' } as Part,
      ],
    };
    expect(isApiUserTextContent(content)).toBe(false);
  });

  it('returns false for question-prefixed side queries', () => {
    expect(isApiUserTextContent(userTextContent('?help'))).toBe(false);
    expect(
      isApiUserTextContent({
        role: 'user',
        parts: [{ text: '?' } as Part, { text: 'status' } as Part],
      }),
    ).toBe(false);
  });

  it('returns false for background task notifications', () => {
    expect(
      isApiUserTextContent(
        userTextContent(
          '<task-notification><status>completed</status></task-notification>',
        ),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCompressionSummaryPair
// ---------------------------------------------------------------------------

describe('hasCompressionSummaryPair', () => {
  it('detects a compression summary pair', () => {
    const history: Content[] = [
      userTextContent('summary text'),
      modelTextContent(COMPRESSION_SUMMARY_MODEL_ACK),
    ];
    expect(hasCompressionSummaryPair(history, 0)).toBe(true);
  });

  it('returns false when the ack text does not match', () => {
    const history: Content[] = [
      userTextContent('summary text'),
      modelTextContent('different ack'),
    ];
    expect(hasCompressionSummaryPair(history, 0)).toBe(false);
  });

  it('returns false when startIndex is out of bounds', () => {
    const history: Content[] = [userTextContent('only one')];
    expect(hasCompressionSummaryPair(history, 1)).toBe(false);
  });

  it('respects startIndex offset', () => {
    const history: Content[] = [
      userTextContent('env context'),
      modelTextContent(STARTUP_CONTEXT_MODEL_ACK),
      userTextContent('summary'),
      modelTextContent(COMPRESSION_SUMMARY_MODEL_ACK),
    ];
    expect(hasCompressionSummaryPair(history, 0)).toBe(false);
    expect(hasCompressionSummaryPair(history, 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// post-compact tail detection
// ---------------------------------------------------------------------------

describe('post-compact tail detection', () => {
  it.each(POST_COMPACT_ATTACHMENT_TEXT_PREFIXES)(
    'detects post-compact attachment content for %s',
    (prefix) => {
      expect(
        isPostCompactAttachmentContent(userTextContent(`${prefix}\nbody`)),
      ).toBe(true);
    },
  );

  it('does not classify real prompts as post-compact attachment content', () => {
    expect(isPostCompactAttachmentContent(userTextContent('real prompt'))).toBe(
      false,
    );
  });

  it('returns the summary/ack boundary when there are no attachments', () => {
    const history: Content[] = [
      userTextContent('summary'),
      modelTextContent(COMPRESSION_SUMMARY_MODEL_ACK),
      userTextContent('tail turn'),
    ];

    expect(getCompressionTailStartIndex(history, 0)).toBe(2);
  });

  it('skips the post-compact attachment block and trailing functionCall', () => {
    const history: Content[] = [
      userTextContent('summary'),
      modelTextContent(COMPRESSION_SUMMARY_MODEL_ACK),
      userTextContent(
        'Recently accessed file (full current content embedded):\n\n## a.ts',
      ),
      functionCallContent(),
      userTextContent('tail turn'),
    ];

    expect(getCompressionTailStartIndex(history, 0)).toBe(4);
  });

  it('respects startup context offsets when skipping post-compact output', () => {
    const history: Content[] = [
      userTextContent('Environment context...'),
      modelTextContent(STARTUP_CONTEXT_MODEL_ACK),
      userTextContent('summary'),
      modelTextContent(COMPRESSION_SUMMARY_MODEL_ACK),
      userTextContent('<plan-mode-active>\nplan reminder\n</plan-mode-active>'),
      userTextContent('tail turn'),
    ];

    expect(getCompressionTailStartIndex(history, 2)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// getApiUserTextIndices
// ---------------------------------------------------------------------------

describe('getApiUserTextIndices', () => {
  it('returns indices of all user text entries from startIndex', () => {
    const history: Content[] = [
      userTextContent('first'),
      modelTextContent('ack'),
      userTextContent('second'),
      modelTextContent('resp'),
      userTextContent('third'),
    ];
    expect(getApiUserTextIndices(history, 0)).toEqual([0, 2, 4]);
  });

  it('respects startIndex', () => {
    const history: Content[] = [
      userTextContent('first'),
      modelTextContent('ack'),
      userTextContent('second'),
      modelTextContent('resp'),
    ];
    expect(getApiUserTextIndices(history, 2)).toEqual([2]);
  });

  it('skips functionResponse entries', () => {
    const history: Content[] = [
      userTextContent('first'),
      modelTextContent('resp'),
      functionResponseContent(),
      modelTextContent('resp2'),
      userTextContent('second'),
    ];
    expect(getApiUserTextIndices(history, 0)).toEqual([0, 4]);
  });
});
