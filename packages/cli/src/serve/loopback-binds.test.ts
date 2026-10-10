/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isIpv4MappedLoopback, isWildcardBind } from './loopback-binds.js';

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
  ])('treats %j as a wildcard bind', (hostname) => {
    expect(isWildcardBind(hostname)).toBe(true);
  });

  // Node cannot bind the padded spelling, so it is not in the socket-match
  // table above; `canonicalHost` trims the operator's text before the WHATWG
  // parse, and the trimmed classification still applies.
  it('trims operator whitespace before classifying', () => {
    expect(isWildcardBind(' 0.0.0.0 ')).toBe(true);
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

describe('isIpv4MappedLoopback', () => {
  // `canonicalHost('::ffff:127.0.0.1')` is `[::ffff:7f00:1]`: the embedded
  // IPv4 packs into two hex groups, and the whole 127/8 range is loopback.
  it.each(['[::ffff:7f00:1]', '::ffff:7f00:1', '[::ffff:7fff:ffff]'])(
    'treats the canonical serialization %j as mapped loopback',
    (canonical) => {
      expect(isIpv4MappedLoopback(canonical)).toBe(true);
    },
  );

  it.each([
    // The IPv4-mapped wildcard is a wildcard, not a loopback.
    '[::ffff:0:0]',
    // 8.0.0.1 mapped: outside 127/8.
    '[::ffff:800:1]',
    '0.0.0.0',
    '127.0.0.1',
    '[::1]',
    // The dotted operator spelling is not the canonical form this takes.
    '::ffff:127.0.0.1',
  ])('does not treat %j as mapped loopback', (canonical) => {
    expect(isIpv4MappedLoopback(canonical)).toBe(false);
  });
});
