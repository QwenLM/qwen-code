/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CloudflareDnsProvider,
  createCloudflareApi,
  type CloudflareApi,
} from './cloudflare.js';

const record = { fqdn: '_acme-challenge.qwen.example.com', value: 'tok' };

describe('CloudflareDnsProvider', () => {
  it('creates the TXT record, waits for propagation, returns a handle', async () => {
    const calls: Array<[string, unknown]> = [];
    const api: CloudflareApi = {
      async createTxt(i) {
        calls.push(['create', i]);
        return { recordId: 'rec1' };
      },
      async deleteTxt(i) {
        calls.push(['delete', i]);
      },
    };
    const sleep = vi.fn(async () => {});
    const provider = new CloudflareDnsProvider({
      api,
      zoneId: 'Z',
      sleep,
      propagationWaitMs: 5,
    });

    const handle = await provider.present(record);

    expect(calls[0]).toEqual([
      'create',
      { zoneId: 'Z', name: record.fqdn, value: record.value, ttl: 60 },
    ]);
    expect(handle).toMatchObject({
      fqdn: record.fqdn,
      zoneId: 'Z',
      recordId: 'rec1',
    });
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('deletes on cleanup, best-effort (never throws)', async () => {
    const api: CloudflareApi = {
      async createTxt() {
        return { recordId: 'rec1' };
      },
      async deleteTxt() {
        throw new Error('gone');
      },
    };
    const provider = new CloudflareDnsProvider({ api, zoneId: 'Z' });
    await expect(
      provider.cleanup({
        fqdn: 'x',
        value: 'y',
        zoneId: 'Z',
        recordId: 'rec1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('createCloudflareApi', () => {
  it('POSTs a TXT create with the bearer token and parses the record id', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, result: { id: 'rec9' } }),
          { status: 200 },
        ),
    );
    const api = createCloudflareApi({ token: 'tkn', fetchImpl });

    const { recordId } = await api.createTxt({
      zoneId: 'Z',
      name: '_acme-challenge.x',
      value: 'v',
      ttl: 60,
    });

    expect(recordId).toBe('rec9');
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toContain('/zones/Z/dns_records');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer tkn');
    expect(JSON.parse(init.body)).toMatchObject({
      type: 'TXT',
      name: '_acme-challenge.x',
      content: 'v',
      ttl: 60,
    });
  });

  it('throws on a Cloudflare error response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: 'bad token' }],
          }),
          { status: 403 },
        ),
    );
    const api = createCloudflareApi({ token: 'tkn', fetchImpl });
    await expect(
      api.createTxt({ zoneId: 'Z', name: 'n', value: 'v', ttl: 60 }),
    ).rejects.toThrow(/bad token/);
  });
});
