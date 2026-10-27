/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readHumanInputFromSdkMessage } from './sdk-human-input.js';

const humanMessage = {
  type: 'user',
  origin: { kind: 'human' },
  parent_tool_use_id: null,
  message: { role: 'user', content: '  ultracode audit\n' },
};

describe('readHumanInputFromSdkMessage', () => {
  it('keeps explicitly declared original text intact', () => {
    expect(readHumanInputFromSdkMessage(humanMessage)).toEqual({
      text: '  ultracode audit\n',
    });
  });

  it.each([
    undefined,
    null,
    [],
    'human',
    true,
    { kind: 'automatic' },
    { kind: true },
  ])('downgrades an invalid origin to unknown: %j', (origin) => {
    expect(
      readHumanInputFromSdkMessage({ ...humanMessage, origin }),
    ).toBeUndefined();
  });

  it.each([
    { type: 'assistant' },
    { parent_tool_use_id: 'tool-1' },
    { parent_tool_use_id: '' },
    { message: { role: 'assistant', content: 'ultracode' } },
    { message: null },
    { message: { role: 'user', content: {} } },
  ])('does not promote ineligible message shapes: %j', (overrides) => {
    expect(
      readHumanInputFromSdkMessage({ ...humanMessage, ...overrides }),
    ).toBeUndefined();
  });

  it('reads only top-level text blocks in order', () => {
    expect(
      readHumanInputFromSdkMessage({
        ...humanMessage,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            { type: 'image', data: 'ultracode' },
            { type: 'resource', resource: { text: 'workflow' } },
            { type: 'text', text: 42 },
            { type: 'text', text: 'next' },
          ],
        },
      }),
    ).toEqual({ text: 'inspect this\nnext' });
  });

  it.each(['tool_use', 'tool_result'])(
    'rejects the entire mixed message containing %s',
    (type) => {
      expect(
        readHumanInputFromSdkMessage({
          ...humanMessage,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'workflow' },
              { type, content: [{ type: 'text', text: 'ultracode' }] },
            ],
          },
        }),
      ).toBeUndefined();
    },
  );
});
