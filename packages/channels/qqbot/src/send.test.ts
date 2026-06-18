import { describe, it, expect } from 'vitest';
import { isValidChatId, hasMarkdownSyntax, splitText } from './QQChannel.js';

describe('isValidChatId', () => {
  it('accepts alphanumeric IDs', () => {
    expect(isValidChatId('abc123')).toBe(true);
  });

  it('accepts IDs with underscores and hyphens', () => {
    expect(isValidChatId('user_openid_123')).toBe(true);
    expect(isValidChatId('group-id-456')).toBe(true);
  });

  it('accepts mixed-case IDs', () => {
    expect(isValidChatId('AbC123_DeF')).toBe(true);
  });

  it('rejects empty string', () => {
    // Empty string fails the `+` quantifier in the regex.
    // resolveRoute guards with `!this.accessToken || !isValidChatId(chatId)`,
    // so empty chatId is also caught by the falsy-string check.
    expect(isValidChatId('')).toBe(false);
  });

  it('accepts max-length ID (128 chars)', () => {
    const id = 'A'.repeat(128);
    expect(isValidChatId(id)).toBe(true);
  });

  it('rejects IDs longer than 128 chars', () => {
    const id = 'A'.repeat(129);
    expect(isValidChatId(id)).toBe(false);
  });

  it('rejects IDs with slashes (path traversal)', () => {
    expect(isValidChatId('abc/def')).toBe(false);
    expect(isValidChatId('../etc')).toBe(false);
    expect(isValidChatId('a\\b')).toBe(false);
  });

  it('rejects IDs with special characters', () => {
    expect(isValidChatId('abc?def')).toBe(false);
    expect(isValidChatId('abc#def')).toBe(false);
    expect(isValidChatId('abc def')).toBe(false);
    expect(isValidChatId('abc@def')).toBe(false);
  });

  it('rejects IDs with dots', () => {
    expect(isValidChatId('abc.def')).toBe(false);
  });
});

describe('hasMarkdownSyntax', () => {
  it('detects headings', () => {
    expect(hasMarkdownSyntax('# Title')).toBe(true);
    expect(hasMarkdownSyntax('## Subtitle')).toBe(true);
    expect(hasMarkdownSyntax('###### Deep heading')).toBe(true);
  });

  it('detects code blocks', () => {
    expect(hasMarkdownSyntax('```js\ncode\n```')).toBe(true);
  });

  it('detects bold (double asterisk)', () => {
    expect(hasMarkdownSyntax('**bold**')).toBe(true);
  });

  it('detects bold (double underscore)', () => {
    expect(hasMarkdownSyntax('__bold__')).toBe(true);
  });

  it('detects strikethrough', () => {
    expect(hasMarkdownSyntax('~~strikethrough~~')).toBe(true);
  });

  it('detects inline code', () => {
    expect(hasMarkdownSyntax('use `code` here')).toBe(true);
  });

  it('detects links', () => {
    expect(hasMarkdownSyntax('[text](url)')).toBe(true);
  });

  it('detects unordered list markers', () => {
    expect(hasMarkdownSyntax('- item')).toBe(true);
    expect(hasMarkdownSyntax('* item')).toBe(true);
    expect(hasMarkdownSyntax('+ item')).toBe(true);
  });

  it('detects ordered list markers', () => {
    expect(hasMarkdownSyntax('1. first')).toBe(true);
    expect(hasMarkdownSyntax('123. item')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasMarkdownSyntax('hello world')).toBe(false);
    expect(hasMarkdownSyntax('no special chars here')).toBe(false);
  });

  it('returns false for text with single asterisks (not list marker at line start)', () => {
    // Single * or _ without paired counterpart is not markdown
    expect(hasMarkdownSyntax('this is *not* italic in this regex')).toBe(false);
  });

  it('false positive: "- temperature" triggers list pattern', () => {
    // As documented: bias toward markdown to avoid false negatives
    expect(hasMarkdownSyntax('- temperature: 5°C')).toBe(true);
  });

  it('false positive: "1. first thing" at line start triggers ordered-list pattern', () => {
    expect(hasMarkdownSyntax('1. first thing in sentence')).toBe(true);
  });
});

describe('splitText', () => {
  it('returns single-element array for short text', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });

  it('returns single-element array for exactly 2000 chars', () => {
    const text = 'a'.repeat(2000);
    const result = splitText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2000);
  });

  it('splits text longer than 2000 chars into chunks', () => {
    const text = 'a'.repeat(4500);
    const result = splitText(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(2000);
    expect(result[1]).toHaveLength(2000);
    expect(result[2]).toHaveLength(500);
  });

  it('preserves content across chunk boundaries', () => {
    const text = 'x'.repeat(2000) + 'y'.repeat(500);
    const result = splitText(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('x'.repeat(2000));
    expect(result[1]).toBe('y'.repeat(500));
  });

  it('handles empty string', () => {
    expect(splitText('')).toEqual(['']);
  });
});
