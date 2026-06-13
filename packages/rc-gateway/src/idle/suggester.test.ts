/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { generateSuggestions, type TurnText } from './suggester.js';
import type { ChatTransport } from './chatTransport.js';

const TURNS: TurnText[] = [
  { role: 'user', text: 'fix the login bug' },
  { role: 'assistant', text: 'done, the null check was missing' },
];

describe('generateSuggestions', () => {
  it('feeds the turns as context and returns parsed suggestions', async () => {
    let seen: string | undefined;
    const chat: ChatTransport = async (messages) => {
      seen = messages.map((m) => m.content).join('\n');
      return '["Run the tests","Commit the fix"]';
    };
    const out = await generateSuggestions({ turns: TURNS, chat });
    expect(out).toEqual(['Run the tests', 'Commit the fix']);
    // The conversation (both roles) is included in the prompt context.
    expect(seen).toContain('fix the login bug');
    expect(seen).toContain('null check');
  });

  it('returns [] (never throws) when the transport errors/times out', async () => {
    const chat: ChatTransport = async () => {
      throw new Error('timeout');
    };
    await expect(generateSuggestions({ turns: TURNS, chat })).resolves.toEqual(
      [],
    );
  });

  it('returns [] and makes NO model call when there are no turns', async () => {
    let called = false;
    const chat: ChatTransport = async () => {
      called = true;
      return '["x"]';
    };
    expect(await generateSuggestions({ turns: [], chat })).toEqual([]);
    expect(called).toBe(false);
  });

  it('respects the max (passed through to the parser)', async () => {
    const chat: ChatTransport = async () => '["a","b","c","d","e"]';
    const out = await generateSuggestions({ turns: TURNS, chat, max: 2 });
    expect(out).toEqual(['a', 'b']);
  });

  it('drops a malformed reply to []', async () => {
    const chat: ChatTransport = async () => 'sorry, I cannot help with that';
    expect(await generateSuggestions({ turns: TURNS, chat })).toEqual([]);
  });
});
