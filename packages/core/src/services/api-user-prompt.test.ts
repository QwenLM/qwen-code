/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  countApiUserPrompts,
  findApiRewindCutPoint,
  isApiUserPrompt,
} from './api-user-prompt.js';
import {
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '../core/environmentContext.js';

const user = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});
const model = (text: string): Content => ({
  role: 'model',
  parts: [{ text }],
});
const reminder = (text: string): Content => ({
  role: 'user',
  parts: [{ text: `${SYSTEM_REMINDER_OPEN}${text}${SYSTEM_REMINDER_CLOSE}` }],
});
const toolResult = (): Content => ({
  role: 'user',
  parts: [{ functionResponse: { name: 'x', response: { output: 'ok' } } }],
});

const CLEARED_MEDIA = '[Old inline media cleared: image/png]';
const TODO_GUARD = '[Todo Stop Guard] continue';
const isTodoGuard = (text: string) => text.startsWith('[Todo Stop Guard] ');

describe('isApiUserPrompt', () => {
  it('accepts a plain user prompt and rejects non-prompt entries', () => {
    expect(isApiUserPrompt(user('hello'))).toBe(true);
    expect(isApiUserPrompt(model('hi'))).toBe(false);
    expect(isApiUserPrompt(toolResult())).toBe(false);
    expect(isApiUserPrompt(reminder('startup'))).toBe(false);
    expect(isApiUserPrompt({ role: 'user', parts: [] })).toBe(false);
  });

  it('keeps a genuine turn that merely carries a prepended reminder', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { text: `${SYSTEM_REMINDER_OPEN}ctx${SYSTEM_REMINDER_CLOSE}` },
        { text: 'the real prompt' },
      ],
    };
    expect(isApiUserPrompt(content)).toBe(true);
  });

  it('rejects an entry mixing a tool result with prompt text', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { functionResponse: { name: 'x', response: { output: 'ok' } } },
        { text: 'trailing text' },
      ],
    };
    expect(isApiUserPrompt(content)).toBe(false);
  });

  describe('excludeClearedMediaPlaceholders (the TUI binding)', () => {
    it('drops a placeholder-only entry only when the option is set', () => {
      expect(isApiUserPrompt(user(CLEARED_MEDIA))).toBe(true);
      expect(
        isApiUserPrompt(user(CLEARED_MEDIA), {
          excludeClearedMediaPlaceholders: true,
        }),
      ).toBe(false);
    });

    it('keeps a prompt that merely begins with the placeholder prefix', () => {
      const prefixed = user('[Old inline media cleared: what does this mean?');
      expect(
        isApiUserPrompt(prefixed, { excludeClearedMediaPlaceholders: true }),
      ).toBe(true);
    });

    it('keeps an entry that mixes a placeholder with real prompt text', () => {
      const mixed: Content = {
        role: 'user',
        parts: [{ text: CLEARED_MEDIA }, { text: 'and my question' }],
      };
      expect(
        isApiUserPrompt(mixed, { excludeClearedMediaPlaceholders: true }),
      ).toBe(true);
    });
  });

  describe('excludeTextPart (the ACP binding)', () => {
    it('drops an entry carrying a matching text part', () => {
      expect(isApiUserPrompt(user(TODO_GUARD))).toBe(true);
      expect(
        isApiUserPrompt(user(TODO_GUARD), { excludeTextPart: isTodoGuard }),
      ).toBe(false);
    });

    it('is not applied unless the caller opts in', () => {
      // The two bindings differ here by design: the TUI binding does not
      // exclude guard prompts, the ACP binding does.
      expect(
        isApiUserPrompt(user(TODO_GUARD), {
          excludeClearedMediaPlaceholders: true,
        }),
      ).toBe(true);
    });
  });
});

describe('findApiRewindCutPoint', () => {
  const history: Content[] = [
    reminder('startup'),
    user('A'),
    model('ra'),
    user('B'),
    model('rb'),
    user('C'),
  ];

  it('rewinding to the first turn keeps only the startup prefix', () => {
    expect(findApiRewindCutPoint(history, 0)).toBe(1);
    expect(findApiRewindCutPoint(history, -1)).toBe(1);
  });

  it('cuts immediately before the target turn prompt', () => {
    expect(findApiRewindCutPoint(history, 1)).toBe(3);
    expect(findApiRewindCutPoint(history, 2)).toBe(5);
  });

  it('returns -1 when the history holds fewer prompts than requested', () => {
    expect(findApiRewindCutPoint(history, 3)).toBe(-1);
  });

  it('skips tool results rather than counting them as turns', () => {
    const withTools: Content[] = [
      user('A'),
      model('call'),
      toolResult(),
      model('ra'),
      user('B'),
    ];
    expect(findApiRewindCutPoint(withTools, 1)).toBe(4);
  });

  it('shifts the boundary when the two bindings disagree', () => {
    // The same history yields different cut points under the TUI and ACP
    // bindings — which is why the divergence is an explicit option instead
    // of a copy that can drift.
    const withPlaceholder: Content[] = [
      user('A'),
      model('ra'),
      user(CLEARED_MEDIA),
      model('rb'),
      user('C'),
    ];
    expect(
      findApiRewindCutPoint(withPlaceholder, 1, {
        excludeClearedMediaPlaceholders: true,
      }),
    ).toBe(4);
    expect(findApiRewindCutPoint(withPlaceholder, 1)).toBe(2);
  });
});

describe('countApiUserPrompts', () => {
  it('counts prompts after the startup prefix', () => {
    const history: Content[] = [
      reminder('startup'),
      user('A'),
      model('ra'),
      toolResult(),
      model('rb'),
      user('B'),
    ];
    expect(countApiUserPrompts(history)).toBe(2);
    expect(countApiUserPrompts([])).toBe(0);
  });

  it('honours the binding options', () => {
    const history: Content[] = [user('A'), user(TODO_GUARD), user('B')];
    expect(countApiUserPrompts(history)).toBe(3);
    expect(countApiUserPrompts(history, { excludeTextPart: isTodoGuard })).toBe(
      2,
    );
  });
});
