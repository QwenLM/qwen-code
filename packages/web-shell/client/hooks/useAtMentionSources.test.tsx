import { describe, expect, it } from 'vitest';
import {
  escapeGlobQuery,
  fileReferenceInsertText,
  fileSearchGlobPattern,
} from './useAtMentionSources';

describe('useAtMentionSources helpers', () => {
  it('escapes glob metacharacters and folds letters into case-insensitive classes', () => {
    expect(escapeGlobQuery('a*b?')).toBe('[aA]\\*[bB]\\?');
    expect(escapeGlobQuery('')).toBe('');
  });

  it('builds a **/*<escaped>* pattern and strips a leading ./', () => {
    expect(fileSearchGlobPattern('')).toBe('**/*');
    expect(fileSearchGlobPattern('./src/foo')).toBe(
      '**/*[sS][rR][cC]/[fF][oO][oO]*',
    );
  });

  it('produces an @-prefixed, trailing-space file reference insert', () => {
    expect(fileReferenceInsertText('a/b c.txt')).toBe('@a/b\\ c.txt ');
  });
});
