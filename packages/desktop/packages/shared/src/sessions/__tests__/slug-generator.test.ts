import { describe, expect, it } from 'bun:test';
import {
  generateSlugFromHint,
  generateUniqueSessionId,
  parseSessionId,
} from '../slug-generator.ts';

describe('session slug generator', () => {
  const date = new Date(2026, 3, 29);

  it('derives readable session IDs from prompt hints', () => {
    expect(generateUniqueSessionId([], date, 'Fix Qwen ACP session names')).toBe(
      '260429-fix-qwen-acp-session-names',
    );
  });

  it('keeps unicode letters in prompt-derived slugs', () => {
    expect(generateUniqueSessionId([], date, '你好，帮我看看会话')).toBe(
      '260429-你好-帮我看看会话',
    );
  });

  it('adds numeric suffixes when prompt-derived IDs collide', () => {
    expect(
      generateUniqueSessionId(
        ['260429-fix-qwen-acp-session-names'],
        date,
        'Fix Qwen ACP session names',
      ),
    ).toBe('260429-fix-qwen-acp-session-names-2');
  });

  it('falls back to random human slugs when hints contain no words', () => {
    expect(generateSlugFromHint('🔥🚀')).toBeNull();
    expect(generateUniqueSessionId([], date, '🔥🚀')).toMatch(
      /^260429-[a-z]+-[a-z]+$/,
    );
  });

  it('parses both old random and new prompt-derived IDs', () => {
    expect(parseSessionId('260429-frosty-heron')?.slug).toBe('frosty-heron');
    expect(parseSessionId('260429-fix-qwen-acp-session-names-2')).toEqual(
      expect.objectContaining({
        datePrefix: '260429',
        slug: 'fix-qwen-acp-session-names',
        suffix: 2,
      }),
    );
    expect(parseSessionId('260429-你好-帮我看看会话')?.slug).toBe(
      '你好-帮我看看会话',
    );
  });
});
