import { describe, it, expect } from 'vitest';
import { matchTrigger, normalizeTriggerPrefixes } from './trigger.js';

describe('matchTrigger', () => {
  it('matches a leading prefix and strips it from the prompt text', () => {
    const match = matchTrigger('qwen: fix the bug', ['qwen:']);
    expect(match).toEqual({ prefix: 'qwen:', text: 'fix the bug' });
  });

  it('matches case-insensitively but strips the original spelling length', () => {
    const match = matchTrigger('QWEN: do it', ['qwen:']);
    expect(match?.text).toBe('do it');
  });

  it('trims the body before matching', () => {
    expect(matchTrigger('  \n qwen: go', ['qwen:'])?.text).toBe('go');
  });

  it('does not match a prefix appearing mid-body', () => {
    expect(matchTrigger('please qwen: go', ['qwen:'])).toBeUndefined();
  });

  it('returns the first matching prefix', () => {
    const match = matchTrigger('precheck_all now', ['qwen:', 'precheck_all']);
    expect(match?.prefix).toBe('precheck_all');
    expect(match?.text).toBe('now');
  });

  it('matches a bare prefix with empty remaining text', () => {
    expect(matchTrigger('qwen:', ['qwen:'])).toEqual({
      prefix: 'qwen:',
      text: '',
    });
  });

  it('returns undefined for an empty prefix list', () => {
    expect(matchTrigger('qwen: go', [])).toBeUndefined();
  });

  it('ignores empty-string prefixes', () => {
    expect(matchTrigger('anything', [''])).toBeUndefined();
  });
});

describe('normalizeTriggerPrefixes', () => {
  it('trims entries and keeps order', () => {
    expect(normalizeTriggerPrefixes([' qwen: ', 'go'], 'ch')).toEqual([
      'qwen:',
      'go',
    ]);
  });

  it('rejects a missing or empty list', () => {
    expect(() => normalizeTriggerPrefixes(undefined, 'ch')).toThrow(
      /non-empty array/,
    );
    expect(() => normalizeTriggerPrefixes([], 'ch')).toThrow(/non-empty array/);
  });

  it('rejects non-string and blank entries', () => {
    expect(() => normalizeTriggerPrefixes([42], 'ch')).toThrow(
      /non-empty strings/,
    );
    expect(() => normalizeTriggerPrefixes(['  '], 'ch')).toThrow(
      /non-empty strings/,
    );
  });
});
