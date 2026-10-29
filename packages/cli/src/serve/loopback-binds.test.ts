/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  hostHeaderMatchesLoopbackBind,
  isIpv4MappedLoopback,
  isWildcardBind,
  parseAuthority,
} from './loopback-binds.js';

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

describe('parseAuthority', () => {
  it.each([
    ['localhost:4170', { hostname: 'localhost', port: '4170' }],
    ['127.0.0.1:4170', { hostname: '127.0.0.1', port: '4170' }],
    ['[::1]:4170', { hostname: '[::1]', port: '4170' }],
    ['localhost', { hostname: 'localhost' }],
    ['[::1]', { hostname: '[::1]' }],
    // Host is case-insensitive (RFC 7230 §5.4) and Express lowercases header
    // names but not values.
    ['LOCALHOST:4170', { hostname: 'localhost', port: '4170' }],
    [' localhost:4170 ', { hostname: 'localhost', port: '4170' }],
  ])('parses %j', (authority, expected) => {
    expect(parseAuthority(authority)).toEqual(expected);
  });

  it.each([
    '',
    ' ',
    // An unbracketed IPv6 literal is not a valid authority, and splitting it
    // on the first colon would otherwise yield an empty hostname.
    '::1',
    // No bracket to close, so where the hostname ends is undefined.
    '[::1:4170',
    // A non-numeric port is malformed; the gate must not match on the
    // leading label and ignore the rest.
    'localhost:abc',
    'localhost:4170:9',
    'localhost:',
  ])('rejects the malformed authority %j', (authority) => {
    expect(parseAuthority(authority)).toBeUndefined();
  });
});

describe('hostHeaderMatchesLoopbackBind', () => {
  it.each([
    'localhost:4170',
    '127.0.0.1:4170',
    '[::1]:4170',
    'host.docker.internal:4170',
  ])('accepts the loopback Host %j', (host) => {
    expect(hostHeaderMatchesLoopbackBind(host, '127.0.0.1')).toBe(true);
  });

  // The point of #12059: VS Code / Cursor port forwarding hands the webview a
  // client-side port that need not equal the one the daemon bound, and the
  // browser then puts that forwarded port in the Host header. Matching the
  // port rejected those requests before the bearer check could run.
  it.each(['localhost:64205', '127.0.0.1:64205', '[::1]:64205'])(
    'accepts %j when the daemon bound some other port',
    (host) => {
      expect(hostHeaderMatchesLoopbackBind(host, '127.0.0.1')).toBe(true);
    },
  );

  // RFC 7230 §5.4: the port is omitted when it matches the scheme default.
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'accepts the port-less form %j',
    (host) => {
      expect(hostHeaderMatchesLoopbackBind(host, '127.0.0.1')).toBe(true);
    },
  );

  // The DNS-rebinding defense: a page served from `evil.example` whose name
  // resolves to 127.0.0.1 still sends its own hostname, whatever the port.
  it.each([
    'evil.example:4170',
    'evil.example',
    'localhost.evil.example:4170',
    '192.168.1.5:4170',
    '',
  ])('rejects the non-loopback Host %j', (host) => {
    expect(hostHeaderMatchesLoopbackBind(host, '127.0.0.1')).toBe(false);
  });

  it('accepts the address the daemon was pinned to inside 127.0.0.0/8', () => {
    expect(hostHeaderMatchesLoopbackBind('127.0.0.5:4170', '127.0.0.5')).toBe(
      true,
    );
    expect(hostHeaderMatchesLoopbackBind('127.0.0.5:4170', '127.0.0.1')).toBe(
      false,
    );
  });

  it('ignores a non-loopback bind, which has no Host gate of its own', () => {
    expect(
      hostHeaderMatchesLoopbackBind('example.com:4170', 'example.com'),
    ).toBe(false);
  });
});
