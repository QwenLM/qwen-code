/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isWildcardBind } from './loopback-binds.js';

describe('isWildcardBind', () => {
  it.each([
    '0.0.0.0',
    '::',
    '[::]',
    // Node binds these spellings to a wildcard too: inet_aton short forms,
    // IPv6 zero variants, and the IPv4-mapped wildcard.
    '0',
    '0.0',
    '0.0.0',
    '::0',
    '[::0]',
    '0::',
    '::ffff:0.0.0.0',
    '[::ffff:0.0.0.0]',
    ' 0.0.0.0 ',
  ])('treats %j as a wildcard bind', (hostname) => {
    expect(isWildcardBind(hostname)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
    '192.168.1.5',
    'example.com',
    '',
  ])('treats %j as a specific bind', (hostname) => {
    expect(isWildcardBind(hostname)).toBe(false);
  });
});
