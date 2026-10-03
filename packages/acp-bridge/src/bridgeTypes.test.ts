/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseBridgeManagedSessionStore } from './bridgeTypes.js';

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
    'http://[::1]:8080',
    'http://127.0.0.2:8080',
  ])('accepts cleartext loopback baseUrl %s', (baseUrl) => {
    expect(parseBridgeManagedSessionStore({ ...valid, baseUrl }).baseUrl).toBe(
      baseUrl,
    );
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
});
