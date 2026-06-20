/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isLoopbackHost,
  resolveBindSecurity,
  BindSecurityError,
} from './bindSecurity.js';

describe('isLoopbackHost', () => {
  it('treats 127.0.0.0/8, ::1, localhost as loopback', () => {
    for (const h of [
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      'localhost',
      'LOCALHOST',
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('treats wildcards and LAN addresses as NON-loopback', () => {
    for (const h of [
      '0.0.0.0',
      '::',
      '192.168.1.10',
      '10.0.0.5',
      'example.local',
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('resolveBindSecurity', () => {
  it('defaults to loopback-http (no TLS needed, tlsRequired false)', () => {
    expect(resolveBindSecurity({})).toEqual({
      host: '127.0.0.1',
      mode: 'loopback-http',
      tlsRequired: false,
    });
  });

  it('REFUSES a non-loopback bind with no TLS story', () => {
    expect(() => resolveBindSecurity({ host: '0.0.0.0' })).toThrow(
      BindSecurityError,
    );
    expect(() => resolveBindSecurity({ host: '0.0.0.0' })).toThrow(
      /refusing to bind non-loopback/,
    );
  });

  it('allows a non-loopback bind with native TLS', () => {
    const r = resolveBindSecurity({
      host: '0.0.0.0',
      tlsCert: '/c.pem',
      tlsKey: '/k.pem',
    });
    expect(r).toEqual({
      host: '0.0.0.0',
      mode: 'tls',
      tls: { certPath: '/c.pem', keyPath: '/k.pem' },
      tlsRequired: true,
    });
  });

  it('allows a non-loopback bind behind an asserted proxy (cleartext locally, TLS upstream)', () => {
    const r = resolveBindSecurity({
      host: '192.168.1.10',
      insecureBehindProxy: true,
    });
    expect(r.mode).toBe('insecure-proxy');
    expect(r.tlsRequired).toBe(true); // clients still reach it over TLS via the proxy
  });

  it('requires --tls and --tls-key together', () => {
    expect(() => resolveBindSecurity({ tlsCert: '/c.pem' })).toThrow(
      /must be provided together/,
    );
    expect(() => resolveBindSecurity({ tlsKey: '/k.pem' })).toThrow(
      /must be provided together/,
    );
  });

  it('rejects both --tls and --insecure-behind-proxy', () => {
    expect(() =>
      resolveBindSecurity({
        host: '0.0.0.0',
        tlsCert: '/c.pem',
        tlsKey: '/k.pem',
        insecureBehindProxy: true,
      }),
    ).toThrow(/not both/);
  });

  it('allows native TLS even on loopback (operator choice)', () => {
    const r = resolveBindSecurity({
      tlsCert: '/c.pem',
      tlsKey: '/k.pem',
    });
    expect(r.mode).toBe('tls');
    expect(r.tlsRequired).toBe(true);
  });

  it("accepts a non-loopback bind in acme mode (auto Let's Encrypt)", () => {
    const r = resolveBindSecurity({
      host: '0.0.0.0',
      acmeDomains: ['qwen.example.com'],
    });
    expect(r.mode).toBe('acme');
    expect(r.tlsRequired).toBe(true);
  });

  it('rejects --acme-domain combined with --tls', () => {
    expect(() =>
      resolveBindSecurity({
        host: '0.0.0.0',
        acmeDomains: ['qwen.example.com'],
        tlsCert: '/c.pem',
        tlsKey: '/k.pem',
      }),
    ).toThrow(/not both/);
  });

  it('rejects --acme-domain combined with --insecure-behind-proxy', () => {
    expect(() =>
      resolveBindSecurity({
        host: '0.0.0.0',
        acmeDomains: ['qwen.example.com'],
        insecureBehindProxy: true,
      }),
    ).toThrow(/not both/);
  });
});
