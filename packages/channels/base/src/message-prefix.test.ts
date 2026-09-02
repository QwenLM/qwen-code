import { describe, expect, it } from 'vitest';
import { applyMessagePrefix, stripMessagePrefix } from './message-prefix.js';
import type { Envelope } from './types.js';

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    channelName: 'test',
    senderId: 'user',
    senderName: 'User',
    chatId: 'chat',
    text: 'hello',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    ...overrides,
  };
}

describe('stripMessagePrefix', () => {
  it.each([
    ['/review 123', '123'],
    ['  /review   123  ', '123'],
    ['@Qwen /review 123', '123'],
    ['@Qwen @Code\n/review 123', '123'],
  ])('accepts %j', (text, expected) => {
    expect(stripMessagePrefix(text, '/review')).toBe(expected);
  });

  it.each([
    'please review 123',
    '/review',
    '/review   ',
    '/reviewer 123',
    'please /review 123',
    '/Review 123',
    '@Qwen/review 123',
    '@Qwen@Code /review 123',
  ])('rejects %j', (text) => {
    expect(stripMessagePrefix(text, '/review')).toBeUndefined();
  });

  it('preserves text when no prefix is configured', () => {
    expect(stripMessagePrefix('  hello  ', undefined)).toBe('  hello  ');
  });
});

describe('applyMessagePrefix', () => {
  it('updates both the display text and a self-prefixed model prompt', () => {
    const input = envelope({
      text: '[atMention=true] [User]: review: inspect this',
      displayText: 'review: inspect this',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(true);
    expect(input.displayText).toBe('inspect this');
    expect(input.text).toBe('[atMention=true] [User]: inspect this');
  });

  it('lets system envelopes bypass the filter', () => {
    const input = envelope({ bypassMessagePrefix: true });

    expect(applyMessagePrefix(input, '/review')).toBe(true);
    expect(input.text).toBe('hello');
  });
});
