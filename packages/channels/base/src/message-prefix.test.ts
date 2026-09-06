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
    ['@botswana @bot do X', '@bot', 'do X'],
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

  it('uses the trailing display segment without an adapter offset', () => {
    const input = envelope({
      text: '[atMention=true] [review: inspect]: review: inspect',
      displayText: 'review: inspect',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(true);
    expect(input.text).toBe('[atMention=true] [review: inspect]: inspect');
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

  it('matches an unsanitized prefix source while splicing sanitized display text', () => {
    const input = envelope({
      text: '[atMention=true] [Alice]: review hello',
      displayText: 'review hello',
      displayTextOffset: '[atMention=true] [Alice]: '.length,
      messagePrefixText: '[review] hello',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, '[review]')).toBe(true);
    expect(input.text).toBe('[atMention=true] [Alice]: hello');
    expect(input.displayText).toBe('hello');
  });

  it('rejects a prefix manufactured only by display sanitization', () => {
    const input = envelope({
      text: '[atMention=true] [Alice]: review hello',
      displayText: 'review hello',
      displayTextOffset: '[atMention=true] [Alice]: '.length,
      messagePrefixText: '[r]eview hello',
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review')).toBe(false);
    expect(input.text).toBe('[atMention=true] [Alice]: review hello');
  });

  it('strips a reconciled slash envelope without restoring removed mentions', () => {
    const input = envelope({
      text: '!ai /compact',
      displayText: '!ai /compact',
      messagePrefixText: '!ai /compact',
    });

    expect(applyMessagePrefix(input, '!ai')).toBe(true);
    expect(input.text).toBe('/compact');
    expect(input.displayText).toBe('/compact');
  });

  it('falls back to the search when the adapter offset does not fit', () => {
    // A stale or forged offset must not splice the payload at the wrong
    // range: the guard demotes it to the search path, which locates the
    // one real occurrence.
    const input = envelope({
      text: '[atMention=false] [Alice]: review: inspect this\n机器人 OPENID: BOT',
      displayText: 'review: inspect this',
      displayTextOffset: 3,
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'review:')).toBe(true);
    expect(input.text).toBe(
      '[atMention=false] [Alice]: inspect this\n机器人 OPENID: BOT',
    );
  });

  it('refuses an absent display segment without mutating the envelope', () => {
    const input = envelope({
      text: '!ai /compact',
      displayText: '!ai /compact <@other>',
      messagePrefixText: '!ai /compact <@other>',
    });

    expect(applyMessagePrefix(input, '!ai')).toBe(false);
    expect(input.text).toBe('!ai /compact');
    expect(input.displayText).toBe('!ai /compact <@other>');
    expect(input.messagePrefixText).toBe('!ai /compact <@other>');
  });

  it('uses an authoritative offset before a matching trailing segment', () => {
    const input = envelope({
      text: '[atMention=false] [Alice]: OPENID: BOT1D\n机器人 OPENID: BOT1D',
      displayText: 'OPENID: BOT1D',
      displayTextOffset: '[atMention=false] [Alice]: '.length,
      alreadyPrefixed: true,
    });

    expect(applyMessagePrefix(input, 'OPENID:')).toBe(true);
    expect(input.text).toBe(
      '[atMention=false] [Alice]: BOT1D\n机器人 OPENID: BOT1D',
    );
  });

  it('lets adapter-synthesized media placeholders bypass the filter', () => {
    const input = envelope({ text: '(image)', syntheticText: true });

    expect(applyMessagePrefix(input, '/review')).toBe(true);
    expect(input.text).toBe('(image)');
  });

  it('lets system envelopes bypass the filter', () => {
    const input = envelope({ bypassMessagePrefix: true });

    expect(applyMessagePrefix(input, '/review')).toBe(true);
    expect(input.text).toBe('hello');
  });
});
