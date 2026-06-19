import { describe, expect, it } from 'vitest';
import { readSessionIdFromPathname } from './daemon';

describe('readSessionIdFromPathname', () => {
  it('reads a session id from /session/:sessionId', () => {
    expect(readSessionIdFromPathname('/session/abc123')).toBe('abc123');
  });

  it('decodes encoded session ids', () => {
    expect(readSessionIdFromPathname('/session/a%2Fb')).toBe('a/b');
  });

  it('ignores non-session paths', () => {
    expect(readSessionIdFromPathname('/')).toBeUndefined();
    expect(readSessionIdFromPathname('/sessions')).toBeUndefined();
  });

  it('ignores malformed encoded ids', () => {
    expect(readSessionIdFromPathname('/session/%E0%A4%A')).toBeUndefined();
  });
});
