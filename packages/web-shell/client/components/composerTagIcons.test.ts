import { describe, expect, it } from 'vitest';
import { getComposerTagIconUrl } from './composerTagIcons';

describe('composer tag icons', () => {
  it('uses registered icons for custom tag kinds', () => {
    expect(getComposerTagIconUrl('table', { table: '/icons/table.svg' })).toBe(
      '/icons/table.svg',
    );
  });

  it('falls back to built-in tag icons', () => {
    expect(getComposerTagIconUrl('file')).toBeTruthy();
  });

  it('ignores inherited object properties', () => {
    const icons = Object.create({ table: '/icons/table.svg' }) as Record<
      string,
      string
    >;

    expect(getComposerTagIconUrl('table', icons)).toBeUndefined();
    expect(getComposerTagIconUrl('toString')).toBeUndefined();
  });
});
