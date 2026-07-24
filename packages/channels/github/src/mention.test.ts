import { describe, it, expect } from 'vitest';
import { escapeRegex, testBotMention, stripBotMention } from './mention.js';

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('a.b+c')).toBe('a\\.b\\+c');
    expect(escapeRegex('bot[0]')).toBe('bot\\[0\\]');
  });
});

describe('testBotMention', () => {
  const bot = 'qwen-bot';

  it('detects a simple mention', () => {
    expect(testBotMention('hello @qwen-bot fix this', bot)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(testBotMention('@Qwen-Bot please help', bot)).toBe(true);
    expect(testBotMention('@QWEN-BOT', bot)).toBe(true);
  });

  it('does not false-positive on trailing newline', () => {
    expect(testBotMention('Please fix.\n', bot)).toBe(false);
  });

  it('does not false-positive on double space', () => {
    expect(testBotMention('Please  fix.', bot)).toBe(false);
  });

  it('does not false-positive on CRLF body', () => {
    expect(testBotMention('line one\r\nline two\r\n', bot)).toBe(false);
  });

  it('detects mention at start of text', () => {
    expect(testBotMention('@qwen-bot fix this', bot)).toBe(true);
  });

  it('does not match partial username', () => {
    expect(testBotMention('@qwen-bot-extra hello', bot)).toBe(false);
  });

  it('does not match mention embedded in word', () => {
    expect(testBotMention('foo@qwen-bot', bot)).toBe(false);
  });

  it('matches after colon (cc:@bot)', () => {
    expect(testBotMention('cc:@qwen-bot please help', bot)).toBe(true);
  });

  it('matches after quote ("@bot")', () => {
    expect(testBotMention('"@qwen-bot" mentioned you', bot)).toBe(true);
  });

  it('does not match email addresses', () => {
    expect(testBotMention('user@qwen-bot.com', bot)).toBe(false);
  });
});

describe('stripBotMention', () => {
  const bot = 'qwen-bot';

  it('removes the bot mention', () => {
    expect(stripBotMention('@qwen-bot fix this', bot)).toBe(' fix this');
  });

  it('preserves other mentions', () => {
    expect(stripBotMention('@qwen-bot ask @alice', bot)).toBe(' ask @alice');
  });

  it('preserves markdown indentation', () => {
    const input = '@qwen-bot Repro:\n\n    const x = 1;\n    foo(x);';
    expect(stripBotMention(input, bot)).toBe(
      ' Repro:\n\n    const x = 1;\n    foo(x);',
    );
  });

  it('preserves nested list formatting', () => {
    const input = '@qwen-bot\n- a\n  - b\n    - c';
    expect(stripBotMention(input, bot)).toBe('\n- a\n  - b\n    - c');
  });

  it('is case-insensitive', () => {
    expect(stripBotMention('@Qwen-Bot fix', bot)).toBe(' fix');
  });
});
