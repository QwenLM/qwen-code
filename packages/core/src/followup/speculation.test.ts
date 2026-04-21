/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ensureToolResultPairing } from './speculation.js';
import type { Content } from '@google/genai';

describe('ensureToolResultPairing', () => {
  it('returns empty array unchanged', () => {
    expect(ensureToolResultPairing([])).toEqual([]);
  });

  it('preserves complete messages (no function calls)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('preserves paired functionCall + functionResponse', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'edit file' }] },
      {
        role: 'model',
        parts: [
          { text: 'editing...' },
          { functionCall: { name: 'edit', args: { file: 'a.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'edit',
              response: { output: 'done' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'file edited' }] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('strips unpaired functionCalls from last model message (keeps text)', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { text: 'I will edit the file' },
          { functionCall: { name: 'edit', args: {} } },
        ],
      },
      // No functionResponse follows — boundary truncation
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(2);
    expect(result[1].parts).toEqual([{ text: 'I will edit the file' }]);
  });

  it('removes last model message entirely if only functionCalls', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'edit', args: {} } },
          { functionCall: { name: 'shell', args: {} } },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('does not modify messages when last message is user role', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'response' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: { output: 'result' },
            },
          },
        ],
      },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });

  it('handles model message with no parts', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [] },
    ];
    const result = ensureToolResultPairing(messages);
    expect(result).toEqual(messages);
  });
});
