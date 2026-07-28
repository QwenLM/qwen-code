/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSessionPathname } from './sessionPath';

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
