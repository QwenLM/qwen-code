/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSessionPathname, parseSessionId } from './sessionPath';

describe('buildSessionPathname', () => {
  it('replaces an existing session segment at the root', () => {
    expect(buildSessionPathname('/session/old', 'new')).toBe('/session/new');
  });

  it('preserves a sub-path deployment base', () => {
    expect(buildSessionPathname('/app/session/old', 'new')).toBe(
      '/app/session/new',
    );
  });

  it('appends a session under a base path with no existing session', () => {
    expect(buildSessionPathname('/app', 'new')).toBe('/app/session/new');
  });

  it('appends a session at the root when there is no existing session', () => {
    expect(buildSessionPathname('/', 'new')).toBe('/session/new');
  });

  it('strips a trailing slash from the base path', () => {
    expect(buildSessionPathname('/app/', 'new')).toBe('/app/session/new');
  });

  it('strips a trailing slash after an existing session id', () => {
    expect(buildSessionPathname('/session/old/', 'new')).toBe('/session/new');
    expect(buildSessionPathname('/app/session/old/', 'new')).toBe(
      '/app/session/new',
    );
  });

  it('encodes the session id', () => {
    expect(buildSessionPathname('/', 'a b/c')).toBe('/session/a%20b%2Fc');
  });

  it('returns the base path when no session is given', () => {
    expect(buildSessionPathname('/app/session/old', undefined)).toBe('/app');
  });

  it('returns "/" when no session is given at the root', () => {
    expect(buildSessionPathname('/', undefined)).toBe('/');
    expect(buildSessionPathname('/session/old', undefined)).toBe('/');
  });
});

describe('parseSessionId', () => {
  it('reads the session id at the root', () => {
    expect(parseSessionId('/session/abc')).toBe('abc');
  });

  it('reads the last session segment under a base path', () => {
    expect(parseSessionId('/app/session/abc')).toBe('abc');
  });

  it('ignores a trailing slash', () => {
    expect(parseSessionId('/session/abc/')).toBe('abc');
  });

  it('decodes the session id', () => {
    expect(parseSessionId('/session/a%20b%2Fc')).toBe('a b/c');
  });

  it('returns undefined for malformed percent-encoding', () => {
    expect(parseSessionId('/session/%E0%A4%A')).toBeUndefined();
  });

  it('returns undefined when there is no session segment', () => {
    expect(parseSessionId('/')).toBeUndefined();
    expect(parseSessionId('/app')).toBeUndefined();
  });

  it('returns undefined for an empty session id', () => {
    expect(parseSessionId('/app/session/')).toBeUndefined();
  });
});

describe('build/parse round-trip', () => {
  it('reads back the written session id', () => {
    for (const base of ['/', '/app', '/app/', '/app/session/old']) {
      expect(parseSessionId(buildSessionPathname(base, 'real-id'))).toBe(
        'real-id',
      );
    }
  });

  it('reads back the written id when the base path ends in a session segment', () => {
    const pathname = buildSessionPathname('/app/session/', 'real-id');
    expect(parseSessionId(pathname)).toBe('real-id');
  });
});
