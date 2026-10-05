/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBridgeManagedSessionStore } from './bridgeTypes.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../core/src/managed-runtime/contracts/managed-session-store-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  limits: {
    minimumWriterTokenLength: number;
    maximumWriterTokenLength: number;
  };
};

const valid = {
  baseUrl: 'https://store.example.com/',
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  writerId: 'writer-1',
  leaseDurationMs: 60_000,
};

describe('parseBridgeManagedSessionStore', () => {
  it('accepts a valid store and normalizes the trailing slash once', () => {
    expect(parseBridgeManagedSessionStore(valid)).toEqual({
      baseUrl: 'https://store.example.com',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      writerId: 'writer-1',
      leaseDurationMs: 60_000,
    });
  });

  it.each([
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://broker.localhost:8080',
    'http://[::1]:8080',
    'http://127.0.0.2:8080',
  ])('accepts cleartext loopback baseUrl %s', (baseUrl) => {
    expect(parseBridgeManagedSessionStore({ ...valid, baseUrl }).baseUrl).toBe(
      baseUrl,
    );
  });

  it.each([
    ['http://127.1', 'http://127.0.0.1'],
    ['http://0x7f.1', 'http://127.0.0.1'],
    ['http://LOCALHOST:8080', 'http://localhost:8080'],
  ])(
    'accepts canonicalized loopback spelling %s as %s',
    (spelling, canonical) => {
      expect(
        parseBridgeManagedSessionStore({ ...valid, baseUrl: spelling }).baseUrl,
      ).toBe(canonical);
    },
  );

  it('accepts a brokered plaintext opt-in on a trusted network', () => {
    expect(
      parseBridgeManagedSessionStore({
        ...valid,
        baseUrl: 'http://10.0.0.1:8080',
        allowInsecureHttp: true,
      }).baseUrl,
    ).toBe('http://10.0.0.1:8080');
  });

  it.each([
    null,
    'store',
    [],
    { ...valid, extra: true },
    { ...valid, baseUrl: 'ftp://store.example.com' },
    { ...valid, baseUrl: 'https://user:pw@store.example.com' },
    { ...valid, baseUrl: 'https://store.example.com/?q=1' },
    { ...valid, baseUrl: 'https://store.example.com/#frag' },
    { ...valid, baseUrl: 'http://10.0.0.1:8080' },
    { ...valid, baseUrl: 'http://store.example.com' },
    { ...valid, baseUrl: 'http://169.254.0.1' },
    { ...valid, baseUrl: 'http://127.0.0.1.evil.test' },
    { ...valid, baseUrl: 'http://localhost.evil.test' },
    { ...valid, baseUrl: 'http://notlocalhost' },
    { ...valid, tenantId: 'bad tenant!' },
    { ...valid, tenantId: '' },
    { ...valid, tenantId: 'x'.repeat(129) },
    { ...valid, workspaceId: 'bad\0id' },
    { ...valid, writerId: 'bad\x07id' },
    { ...valid, leaseDurationMs: 999 },
    { ...valid, leaseDurationMs: 300_001 },
    { ...valid, leaseDurationMs: 60_000.5 },
    { ...valid, leaseDurationMs: '60000' },
  ])('rejects %j', (input) => {
    expect(() => parseBridgeManagedSessionStore(input)).toThrow();
  });

  // A dotted-quad check that only read the first label would accept these:
  // the WHATWG parser leaves a four-label *name* starting with 127 verbatim,
  // so only the per-octet numeric test refuses them. Assert the message so
  // the row pins which rule fired.
  it.each(['http://127.foo.example.test', 'http://127.0.0.a'])(
    'refuses a four-label 127-prefixed DNS name %s without HTTPS',
    (baseUrl) => {
      expect(() =>
        parseBridgeManagedSessionStore({ ...valid, baseUrl }),
      ).toThrow('must use HTTPS outside the loopback interface');
    },
  );

  it('refuses IPv4-mapped loopback without HTTPS', () => {
    // Deliberately outside the loopback allowlist (see the predicate's
    // comment): the mapped spelling canonicalizes to `[::ffff:7f00:1]` and
    // must use HTTPS, matching the CLI's isLoopbackBind.
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        baseUrl: 'http://[::ffff:127.0.0.1]:8080',
      }),
    ).toThrow('must use HTTPS outside the loopback interface');
  });

  it('rejects control characters and over-byte-limit string fields', () => {
    expect(() =>
      parseBridgeManagedSessionStore({ ...valid, tenantId: 'bad\x07tenant' }),
    ).toThrow('tenantId');
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        baseUrl: `https://${'x'.repeat(2100)}`,
      }),
    ).toThrow('baseUrl');
  });

  it('round-trips the provisioned writer credential and insecure opt-in', () => {
    const parsed = parseBridgeManagedSessionStore(valid);
    expect(parsed.writerToken).toBeUndefined();
    expect(parsed.allowInsecureHttp).toBeUndefined();

    const provisioned = parseBridgeManagedSessionStore({
      ...valid,
      writerToken: `qwt1_${'a'.repeat(43)}`,
      allowInsecureHttp: true,
    });
    expect(provisioned.writerToken).toBe(`qwt1_${'a'.repeat(43)}`);
    expect(provisioned.allowInsecureHttp).toBe(true);
  });

  it('rejects malformed optional credentials', () => {
    for (const writerToken of [
      'short',
      'has spaces and symbols!! padding',
      42,
      null,
    ]) {
      expect(() =>
        parseBridgeManagedSessionStore({ ...valid, writerToken }),
      ).toThrow(/writerToken is invalid/);
    }
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        allowInsecureHttp: 'yes',
      }),
    ).toThrow(/allowInsecureHttp is invalid/);
    expect(() =>
      parseBridgeManagedSessionStore({ ...valid, extraField: 1 }),
    ).toThrow(/unsupported field/);
  });

  it('bounds writerToken length at the shared fixture limits', () => {
    const { minimumWriterTokenLength, maximumWriterTokenLength } =
      fixture.limits;
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(minimumWriterTokenLength - 1),
      }),
    ).toThrow(/writerToken is invalid/);
    expect(
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(minimumWriterTokenLength),
      }).writerToken,
    ).toHaveLength(minimumWriterTokenLength);
    expect(
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(maximumWriterTokenLength),
      }).writerToken,
    ).toHaveLength(maximumWriterTokenLength);
    expect(() =>
      parseBridgeManagedSessionStore({
        ...valid,
        writerToken: 'a'.repeat(maximumWriterTokenLength + 1),
      }),
    ).toThrow(/writerToken is invalid/);
  });
});
