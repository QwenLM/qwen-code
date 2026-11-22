/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import { movePromptContextAheadOfUserText } from './prompt-context-order.js';
import { createUserPromptSubmitContextPart } from '../hooks/user-prompt-submit-context.js';
import { wrapAsyncHookContext } from '../hooks/async-hook-context.js';
import { REATTACH_BOUNDARY_METADATA } from '../services/image-payload-references.js';
import { fnResponse } from '../test-utils/model-fixtures.js';

const own = (text: string): Part => ({ text });
const reminder = (text = 'active todo'): Part => ({
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});
const hook = (text = 'hook context'): Part =>
  createUserPromptSubmitContextPart(text);
const asyncHook = (text = 'async hook output'): Part => ({
  text: wrapAsyncHookContext(text),
});

describe('movePromptContextAheadOfUserText', () => {
  it('moves the injected run trailing the caller text ahead of it', () => {
    const content: Content = {
      role: 'user',
      parts: [reminder(), own('do the thing'), hook()],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([
      { role: 'user', parts: [reminder(), hook(), own('do the thing')] },
    ]);
  });

  it('hoists a trailing async hook block ahead of the caller text', () => {
    const content: Content = {
      role: 'user',
      parts: [own('do the thing'), asyncHook()],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([
      { role: 'user', parts: [asyncHook(), own('do the thing')] },
    ]);
  });

  it('hoists async + sync injected blocks ahead of the caller text, keeping their order', () => {
    // The co-occurrence stored shape: the client splices async ahead of the
    // trailing sync receipt, so the entry is [own, async, sync]. The wire
    // copy must end in the user's instruction, not in hook output.
    const content: Content = {
      role: 'user',
      parts: [own('do the thing'), asyncHook(), hook()],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([
      { role: 'user', parts: [asyncHook(), hook(), own('do the thing')] },
    ]);
  });

  it('returns an all-injected entry unchanged', () => {
    const content: Content = { role: 'user', parts: [reminder(), hook()] };

    expect(movePromptContextAheadOfUserText([content])).toEqual([content]);
  });

  // Pins the `lastOwnIndex === -1` half of the early return: without it the
  // splice re-emits parts[0], duplicating one tool_result under the same call
  // id — the shape `nonInteractiveCli` produces for parallel tool calls.
  it('returns an all-tool-result entry unchanged', () => {
    const content: Content = {
      role: 'user',
      parts: [
        fnResponse('read_file', { output: 'one' }, 'c1'),
        fnResponse('read_file', { output: 'two' }, 'c2'),
      ],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([content]);
  });

  it('leaves an entry whose tool result sits mid-entry unchanged', () => {
    const content: Content = {
      role: 'user',
      parts: [
        own('do it'),
        fnResponse('read_file', { output: 'x' }, 'c1'),
        hook(),
      ],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([content]);
  });

  it('keeps a reminder the caller placed between its own parts', () => {
    const content: Content = {
      role: 'user',
      parts: [own('step 1'), reminder('mid'), own('step 2'), hook()],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([
      {
        role: 'user',
        parts: [own('step 1'), reminder('mid'), hook(), own('step 2')],
      },
    ]);
  });

  it('keeps the reattach region last', () => {
    const marker: Part = {
      text: '[Image #abc: image/png, 3 bytes]',
      partMetadata: { [REATTACH_BOUNDARY_METADATA]: true },
    };
    const image: Part = {
      inlineData: { mimeType: 'image/png', data: 'png' },
    };
    const content: Content = {
      role: 'user',
      parts: [own('describe it'), hook(), marker, image],
    };

    expect(movePromptContextAheadOfUserText([content])).toEqual([
      { role: 'user', parts: [hook(), own('describe it'), marker, image] },
    ]);
  });

  it('does not mutate the entries it is given', () => {
    const parts = [reminder(), own('do the thing'), hook()];
    const contents: Content[] = [{ role: 'user', parts }];
    const before = JSON.parse(JSON.stringify(contents));

    movePromptContextAheadOfUserText(contents);

    expect(JSON.parse(JSON.stringify(contents))).toEqual(before);
  });
});
