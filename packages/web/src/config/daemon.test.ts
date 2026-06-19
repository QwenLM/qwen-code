import { describe, expect, it } from 'vitest';
import {
  getWebDaemonConfigFromLocation,
  readSessionIdFromPathname,
} from './daemon';

const origin = 'http://127.0.0.1:5174';

function config(search = '', pathname = '/') {
  return getWebDaemonConfigFromLocation({ origin, pathname, search });
}

describe('getWebDaemonConfigFromLocation', () => {
  it('uses the current origin by default', () => {
    expect(config()).toEqual({ baseUrl: origin });
  });

  it('allows loopback daemon origins with the current protocol', () => {
    expect(config('?daemon=http://127.0.0.1:4171')).toEqual({
      baseUrl: 'http://127.0.0.1:4171',
    });
    expect(config('?daemon=http://localhost:4171')).toEqual({
      baseUrl: 'http://localhost:4171',
    });
  });

  it('allows same-origin relative daemon URLs', () => {
    expect(config('?daemon=/daemon')).toEqual({ baseUrl: origin });
  });

  it('rejects external daemon origins', () => {
    expect(config('?daemon=https://example.com')).toEqual({ baseUrl: origin });
  });

  it('reads token, client id, and session query values', () => {
    expect(
      config('?token=abc&clientId=browser-1&session=query-session'),
    ).toEqual({
      baseUrl: origin,
      token: 'abc',
      clientId: 'browser-1',
      initialSessionId: 'query-session',
    });
  });

  it('reads the initial session id from /session/:sessionId', () => {
    expect(config('', '/session/abc-123')).toEqual({
      baseUrl: origin,
      initialSessionId: 'abc-123',
    });
  });

  it('lets the session query override the route session', () => {
    expect(config('?session=query-session', '/session/route-session')).toEqual({
      baseUrl: origin,
      initialSessionId: 'query-session',
    });
  });
});

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
