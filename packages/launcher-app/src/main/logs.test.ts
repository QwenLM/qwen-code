import { describe, it, expect } from 'vitest';
import { LineFramer } from './logs.js';

describe('LineFramer', () => {
  it('emits only complete lines and buffers the partial tail', () => {
    const f = new LineFramer();
    expect(f.push('hello\nwor')).toEqual(['hello']);
    expect(f.push('ld\nfoo\n')).toEqual(['world', 'foo']);
    expect(f.push('')).toEqual([]);
    expect(f.push('bar')).toEqual([]); // no newline yet
    expect(f.push('\n')).toEqual(['bar']);
  });
});
