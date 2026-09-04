import { describe, it, expect } from 'vitest';
import { testBotMention, stripBotMention, escapeRegex } from './mention.js';

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('user[name]')).toBe('user\\[name\\]');
  });
});

describe('testBotMention', () => {
  const bot = 'test-bot';

  it('matches @bot at start of text', () => {
    expect(testBotMention('@test-bot hello', bot)).toBe(true);
  });

  it('matches @bot mid-sentence', () => {
    expect(testBotMention('hey @test-bot please fix', bot)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(testBotMention('@TEST-BOT hello', bot)).toBe(true);
    expect(testBotMention('@Test-Bot hello', bot)).toBe(true);
  });

  it('matches @bot after bracket', () => {
    expect(testBotMention('(@test-bot) hello', bot)).toBe(true);
  });

  it('does not match partial username', () => {
    expect(testBotMention('@test-bot-extra hello', bot)).toBe(false);
  });

  it('does not match email-like patterns', () => {
    expect(testBotMention('user@test-bot.com', bot)).toBe(false);
  });

  it('does not match without @', () => {
    expect(testBotMention('test-bot hello', bot)).toBe(false);
  });

  it('matches @bot at end of text', () => {
    expect(testBotMention('hello @test-bot', bot)).toBe(true);
  });

  it('handles username with dots', () => {
    expect(testBotMention('@my.bot hello', 'my.bot')).toBe(true);
    expect(testBotMention('@myXbot hello', 'my.bot')).toBe(false);
  });
});

describe('stripBotMention', () => {
  const bot = 'test-bot';

  it('removes @bot from text', () => {
    expect(stripBotMention('@test-bot please fix', bot)).toBe(' please fix');
  });

  it('removes multiple @bot occurrences', () => {
    expect(stripBotMention('@test-bot hello @test-bot', bot)).toBe(' hello ');
  });

  it('preserves text without @bot', () => {
    expect(stripBotMention('no mention here', bot)).toBe('no mention here');
  });

  it('does not strip partial matches', () => {
    expect(stripBotMention('@test-bot-extra hello', bot)).toBe(
      '@test-bot-extra hello',
    );
  });
});
