import { describe, expect, it } from 'vitest';
import { cssUrlValue, cssUrlVar } from './cssUrlVar';

describe('cssUrlVar', () => {
  it('escapes CSS string delimiters in URLs', () => {
    expect(cssUrlValue('https://x.test/a"\\\nb.svg')).toBe(
      'url("https://x.test/a\\"\\\\\\A b.svg")',
    );
  });

  it('returns a CSS custom property style object', () => {
    expect(cssUrlVar('--icon-url', '/icons/table.svg')).toEqual({
      '--icon-url': 'url("/icons/table.svg")',
    });
  });
});
