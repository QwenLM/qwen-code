/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  hasUserPromptSubmitContext,
  isUserPromptSubmitContextPartText,
  stripTrailingUserPromptSubmitContextPart,
  USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG,
  USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG,
} from './user-prompt-submit-context.js';
import { wrapUserPromptSubmitContext } from '../utils/transcript-records.js';

describe('wrapUserPromptSubmitContext', () => {
  it('wraps context between the open and close tags', () => {
    expect(wrapUserPromptSubmitContext('extra context')).toBe(
      `${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG}\nextra context\n${USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG}`,
    );
  });

  it('produces text recognized by isUserPromptSubmitContextPartText', () => {
    expect(
      isUserPromptSubmitContextPartText(
        wrapUserPromptSubmitContext('multi\nline\ncontext'),
      ),
    ).toBe(true);
  });
});

describe('stripTrailingUserPromptSubmitContextPart', () => {
  it('drops a trailing whole-part tagged block when other parts exist', () => {
    const tagged = wrapUserPromptSubmitContext('ctx');
    expect(
      stripTrailingUserPromptSubmitContextPart([
        { text: 'my prompt' },
        { text: tagged },
      ]),
    ).toEqual([{ text: 'my prompt' }]);
  });

  it('keeps a sole part that matches the tag shape', () => {
    const tagged = wrapUserPromptSubmitContext('ctx');
    const parts = [{ text: tagged }];
    expect(stripTrailingUserPromptSubmitContextPart(parts)).toBe(parts);
  });

  it('keeps parts when the trailing part is not a whole tagged block', () => {
    const parts = [
      { text: 'my prompt' },
      { text: `quote: ${wrapUserPromptSubmitContext('ctx')}` },
    ];
    expect(stripTrailingUserPromptSubmitContextPart(parts)).toBe(parts);
  });
});

describe('hasUserPromptSubmitContext', () => {
  it('matches a tagged block in the given entry', () => {
    const entry = {
      role: 'user',
      parts: [
        { text: 'my prompt' },
        { text: wrapUserPromptSubmitContext('ctx') },
      ],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(true);
  });

  it('does not match when the payload bytes differ', () => {
    const entry = {
      role: 'user',
      parts: [
        { text: 'my prompt' },
        { text: wrapUserPromptSubmitContext('older ctx') },
      ],
    };
    expect(hasUserPromptSubmitContext(entry, 'new ctx')).toBe(false);
  });

  it('does not match the same text outside the reserved tag', () => {
    const entry = {
      role: 'user',
      parts: [{ text: 'my prompt' }, { text: 'ctx' }],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(false);
  });

  it('does not match a block with added whitespace', () => {
    const entry = {
      role: 'user',
      parts: [
        { text: 'my prompt' },
        { text: `\n${wrapUserPromptSubmitContext('ctx')}` },
      ],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(false);
  });

  it('does not match a block in a model entry', () => {
    const entry = {
      role: 'model',
      parts: [
        { text: 'my answer' },
        { text: wrapUserPromptSubmitContext('ctx') },
      ],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(false);
  });

  it('does not match a sole tagged part, which is treated as user-authored', () => {
    const entry = {
      role: 'user',
      parts: [{ text: wrapUserPromptSubmitContext('ctx') }],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(false);
  });

  it('does not match a tagged part that is not the trailing one', () => {
    const entry = {
      role: 'user',
      parts: [
        { text: wrapUserPromptSubmitContext('ctx') },
        { text: 'my prompt' },
      ],
    };
    expect(hasUserPromptSubmitContext(entry, 'ctx')).toBe(false);
  });

  it('returns false for an empty or malformed entry', () => {
    expect(hasUserPromptSubmitContext(undefined, 'ctx')).toBe(false);
    expect(hasUserPromptSubmitContext(null, 'ctx')).toBe(false);
    expect(hasUserPromptSubmitContext({}, 'ctx')).toBe(false);
    expect(hasUserPromptSubmitContext({ parts: 'not-an-array' }, 'ctx')).toBe(
      false,
    );
    expect(hasUserPromptSubmitContext({ role: 'user' }, 'ctx')).toBe(false);
    expect(hasUserPromptSubmitContext({ role: 'user', parts: [] }, 'ctx')).toBe(
      false,
    );
  });
});

describe('isUserPromptSubmitContextPartText', () => {
  it('accepts a wrapped block with surrounding whitespace', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `\n  ${wrapUserPromptSubmitContext('ctx')}\n`,
      ),
    ).toBe(true);
  });

  it('rejects text with user prose before the tag', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `my own text ${wrapUserPromptSubmitContext('ctx')}`,
      ),
    ).toBe(false);
  });

  it('rejects text with user prose after the tag', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `${wrapUserPromptSubmitContext('ctx')} trailing text`,
      ),
    ).toBe(false);
  });

  it('rejects nested reserved tags in the body', () => {
    expect(
      isUserPromptSubmitContextPartText(
        wrapUserPromptSubmitContext(
          `inner ${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG} tag`,
        ),
      ),
    ).toBe(false);
  });

  it('rejects an unterminated open tag', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG}\nctx`,
      ),
    ).toBe(false);
  });

  it('rejects a complete block without newline delimiters', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG}ctx${USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG}`,
      ),
    ).toBe(false);
  });

  it('rejects a lone close tag', () => {
    expect(
      isUserPromptSubmitContextPartText(USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG),
    ).toBe(false);
  });

  it('rejects empty text', () => {
    expect(isUserPromptSubmitContextPartText('')).toBe(false);
  });
});
