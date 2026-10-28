import { describe, expect, it } from 'vitest';
import { titleFromPrompt } from './sessionTitleFromPrompt';

describe('titleFromPrompt', () => {
  it('uses a short single-line prompt as-is', () => {
    expect(titleFromPrompt('修复登录按钮在移动端错位')).toBe(
      '修复登录按钮在移动端错位',
    );
    expect(titleFromPrompt('  fix login button on mobile  ')).toBe(
      'fix login button on mobile',
    );
  });

  it('keeps a slash command that carries arguments', () => {
    expect(titleFromPrompt('/verify-pr 15361')).toBe('/verify-pr 15361');
  });

  it('rejects a bare slash command', () => {
    expect(titleFromPrompt('/review')).toBeUndefined();
  });

  it('rejects multi-line prompts', () => {
    expect(titleFromPrompt('Fix login\non mobile')).toBeUndefined();
    expect(titleFromPrompt('Fix login\r\non mobile')).toBeUndefined();
  });

  it('rejects prompts outside the 4-40 character window', () => {
    expect(titleFromPrompt('abc')).toBeUndefined();
    expect(titleFromPrompt('修复')).toBeUndefined();
    expect(titleFromPrompt('abcd')).toBe('abcd');
    expect(titleFromPrompt('a'.repeat(40))).toBe('a'.repeat(40));
    expect(titleFromPrompt('a'.repeat(41))).toBeUndefined();
  });

  it('strips markdown markers and trailing punctuation', () => {
    expect(titleFromPrompt('## Fix login button')).toBe('Fix login button');
    expect(titleFromPrompt('- 修复登录按钮')).toBe('修复登录按钮');
    expect(titleFromPrompt('Fix login button.')).toBe('Fix login button');
    expect(titleFromPrompt('修复登录按钮。')).toBe('修复登录按钮');
  });

  it('collapses internal whitespace', () => {
    expect(titleFromPrompt('fix   login')).toBe('fix login');
    expect(titleFromPrompt('fix\tlogin')).toBe('fix login');
  });

  it('rejects control characters', () => {
    expect(titleFromPrompt('fix \u001b[31mred')).toBeUndefined();
    expect(titleFromPrompt('fix\u0000login')).toBeUndefined();
  });

  it('rejects blank prompts', () => {
    expect(titleFromPrompt('')).toBeUndefined();
    expect(titleFromPrompt('   ')).toBeUndefined();
    expect(titleFromPrompt('\n')).toBeUndefined();
  });
});
