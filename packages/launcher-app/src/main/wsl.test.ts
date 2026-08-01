import { describe, it, expect } from 'vitest';
import { parseDistroList } from './wsl.js';

describe('parseDistroList', () => {
  it('returns distro names, stripping CR / blanks / the default marker', () => {
    // wsl.exe -l -q output, already decoded from UTF-16 to a string
    const raw = 'Ubuntu\r\nUbuntu-22.04\r\ndocker-desktop\r\n\r\n';
    expect(parseDistroList(raw)).toEqual([
      'Ubuntu',
      'Ubuntu-22.04',
      'docker-desktop',
    ]);
  });
  it('handles an empty listing', () => {
    expect(parseDistroList('\r\n')).toEqual([]);
  });
});
