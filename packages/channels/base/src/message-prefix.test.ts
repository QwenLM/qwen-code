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
    ['<@ABC123DEF456> /review 123', '123'],
  ])('accepts %j', (text, expected) => {
    expect(stripMessagePrefix(text, '/review')).toBe(expected);
  });

  it.each([
    ['@Qwen @bot hello', '@bot', 'hello'],
    ['<@U1> <@BOT> hi', '<@BOT>', 'hi'],
    ['@bot hello', '@bot', 'hello'],
  ])('accepts %j under the @-leading prefix %j', (text, prefix, expected) => {
    // Nothing rejects a prefix that itself starts with `@`, so the
    // mention loop must stop at the prefix rather than eat it as one
    // more mention token.
    expect(stripMessagePrefix(text, prefix)).toBe(expected);
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
    '@Alice please inspect /review 123',
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

  it('preserves adapter context around the display text', () => {
    const input = envelope({
      text: '[atMention=false] [Alice(abc)]: review: inspect this\n机器人 OPENID: BOT',
      displayText: 'review: inspect this',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(true);
    expect(input.displayText).toBe('inspect this');
    expect(input.text).toBe(
      '[atMention=false] [Alice(abc)]: inspect this\n机器人 OPENID: BOT',
    );
  });

  it('strips the user segment, not a sender tag that repeats it', () => {
    // Both the nick and the body are attacker-controlled on QQ, so a nick
    // equal to the message body puts the first occurrence of displayText
    // inside the sender tag. Splicing there would leave the prefix on the
    // dispatched message and corrupt the tag.
    const input = envelope({
      text: '[atMention=false] [review: inspect this(abc)]: review: inspect this\n机器人 OPENID: BOT',
      displayText: 'review: inspect this',
      displayTextOffset: '[atMention=false] [review: inspect this(abc)]: '
        .length,
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(true);
    expect(input.text).toBe(
      '[atMention=false] [review: inspect this(abc)]: inspect this\n机器人 OPENID: BOT',
    );
  });

  it('refuses to guess when the display text appears twice and no offset is given', () => {
    // Same shape without the adapter-supplied position: two candidate
    // locations and no way to tell them apart, so the message is refused
    // rather than rewritten at the wrong one.
    const input = envelope({
      text: '[atMention=false] [review: inspect this(abc)]: review: inspect this\n机器人 OPENID: BOT',
      displayText: 'review: inspect this',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(false);
  });

  it('uses the adapter-normalized prefix text without guessing mention boundaries', () => {
    const input = envelope({
      text: '@Alice Smith /review inspect this',
      displayText: '@Alice Smith /review inspect this',
      messagePrefixText: '/review inspect this',
    });

    expect(applyMessagePrefix(input, '/review')).toBe(true);
    expect(input.text).toBe('inspect this');
    expect(input.displayText).toBe('inspect this');
    expect(input.messagePrefixText).toBe('inspect this');
  });

  it('lets system envelopes bypass the filter', () => {
    const input = envelope({ bypassMessagePrefix: true });

    expect(applyMessagePrefix(input, '/review')).toBe(true);
    expect(input.text).toBe('hello');
  });
});
