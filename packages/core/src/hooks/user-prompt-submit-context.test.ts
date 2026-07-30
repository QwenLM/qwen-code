/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  wrapUserPromptSubmitContext,
  isUserPromptSubmitContextPartText,
  stripTrailingUserPromptSubmitContextPart,
  USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG,
  USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG,
} from './user-prompt-submit-context.js';

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

  it('rejects an unterminated open tag', () => {
    expect(
      isUserPromptSubmitContextPartText(
        `${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG}\nctx`,
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
