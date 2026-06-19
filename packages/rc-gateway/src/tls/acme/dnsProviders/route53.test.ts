/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Route53DnsProvider,
  type Route53Client,
  type Route53ChangeInput,
} from './route53.js';

function fakeClient(statuses: Array<'PENDING' | 'INSYNC'> = ['INSYNC']) {
  const changes: Route53ChangeInput[] = [];
  let i = 0;
  const client: Route53Client & { changes: Route53ChangeInput[] } = {
    changes,
    async changeTxtRecord(input) {
      changes.push(input);
      return { changeId: '/change/C123' };
    },
    async getChangeStatus() {
      return statuses[Math.min(i++, statuses.length - 1)];
    },
  };
  return client;
}

const record = {
  fqdn: '_acme-challenge.qwen.example.com',
  value: 'tok-value',
};

describe('Route53DnsProvider', () => {
  it('UPSERTs the TXT record, waits for INSYNC, returns a cleanup handle', async () => {
    const client = fakeClient(['PENDING', 'INSYNC']);
    const sleep = vi.fn(async () => {});
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep,
    });

    const handle = await provider.present(record);

    expect(client.changes[0]).toEqual({
      hostedZoneId: 'Z1',
      action: 'UPSERT',
      name: record.fqdn,
      value: record.value,
      ttl: 60,
    });
    expect(handle).toMatchObject({
      fqdn: record.fqdn,
      value: record.value,
      hostedZoneId: 'Z1',
      changeId: '/change/C123',
    });
    expect(sleep).toHaveBeenCalledTimes(1); // polled once on PENDING, then INSYNC
  });

  it('DELETEs the record on cleanup', async () => {
    const client = fakeClient();
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
    });
    const handle = await provider.present(record);
    await provider.cleanup(handle);
    expect(client.changes[1]).toEqual({
      hostedZoneId: 'Z1',
      action: 'DELETE',
      name: record.fqdn,
      value: record.value,
      ttl: 60,
    });
  });

  it('cleanup is best-effort: never throws even if the API errors', async () => {
    const client: Route53Client = {
      async changeTxtRecord() {
        throw new Error('boom');
      },
      async getChangeStatus() {
        return 'INSYNC';
      },
    };
    const provider = new Route53DnsProvider({ client, hostedZoneId: 'Z1' });
    await expect(
      provider.cleanup({
        fqdn: 'x',
        value: 'y',
        hostedZoneId: 'Z1',
        changeId: 'c',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws if the change never reaches INSYNC before the deadline', async () => {
    const client = fakeClient(['PENDING']);
    let t = 0;
    const provider = new Route53DnsProvider({
      client,
      hostedZoneId: 'Z1',
      sleep: async () => {},
      now: () => (t += 1000),
      maxWaitMs: 2500,
      pollIntervalMs: 1000,
    });
    await expect(provider.present(record)).rejects.toThrow(/INSYNC/);
  });
});
