/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns, type LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NetworkPolicyError,
  parseNetworkTargetUrl,
  resolveNetworkTarget,
} from './network-policy.js';

function mockDns(addresses: LookupAddress[]) {
  return vi.spyOn(dns, 'lookup').mockResolvedValue(addresses as never);
}

function addressUrl(address: string, protocol = 'https:'): string {
  const host = address.includes(':') ? `[${address}]` : address;
  return `${protocol}//${host}/deliver`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseNetworkTargetUrl', () => {
  it('does not turn a missing runtime policy into private access', () => {
    expect(() =>
      parseNetworkTargetUrl('http://127.0.0.1/', undefined as never),
    ).toThrow(NetworkPolicyError);
  });

  it('validates configuration without resolving the hostname', () => {
    const lookup = vi.spyOn(dns, 'lookup');
    const target = parseNetworkTargetUrl(
      'http://receiver.internal:8080/deliver',
      'allow-private',
    );

    expect(target.href).toBe('http://receiver.internal:8080/deliver');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['public', 'allow-private'] as const)(
    'rejects embedded credentials under %s policy',
    (policy) => {
      expect(() =>
        parseNetworkTargetUrl('https://user:secret@example.com/', policy),
      ).toThrow(NetworkPolicyError);
    },
  );

  it.each([
    ['http://example.com/', 'public'],
    ['ftp://example.com/', 'allow-private'],
    ['/relative', 'allow-private'],
  ] as const)('rejects %s with policy %s', (url, policy) => {
    expect(() => parseNetworkTargetUrl(url, policy)).toThrow(
      NetworkPolicyError,
    );
  });

  it('preserves URL normalization and fragments for existing public callers', () => {
    const target = parseNetworkTargetUrl(
      ' \nhttps://EXAMPLE.com:443/archive#part\t',
      'public',
    );
    expect(target.href).toBe('https://example.com/archive#part');
    expect(parseNetworkTargetUrl(target, 'public')).toBe(target);
  });
});

describe('resolveNetworkTarget address policies', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.254',
    '127.0.0.1',
    '127.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
    '::1',
    'fc00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:fffe',
    '::ffff:127.0.0.1',
    '::ffff:c0a8:1',
  ])('requires private opt-in for %s', async (address) => {
    const lookup = vi.spyOn(dns, 'lookup');
    await expect(
      resolveNetworkTarget(addressUrl(address), 'public'),
    ).rejects.toThrow(NetworkPolicyError);

    for (const protocol of ['http:', 'https:']) {
      const target = await resolveNetworkTarget(
        addressUrl(address, protocol),
        'allow-private',
      );
      expect(target.url.protocol).toBe(protocol);
      expect(target.address).toBeTruthy();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.100.100.200',
    '100.127.255.254',
    '169.254.169.254',
    '169.254.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.254',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '64:ff9b::a00:1',
    '2001::1',
    '2001:1::1',
    '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db8::1',
    '2002::1',
    '2002:a00:1::',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff::1',
    'fd00:ec2::254',
    'fd00:0ec2:0000:0000:0000:0000:0000:0254',
    '::ffff:169.254.169.254',
    '::ffff:6464:64c8',
    '::ffff:0:7f00:1',
    '::ffff:0:a9fe:a9fe',
    '::ffff:0:808:808',
    '::ffff:1:808:808',
  ])('never permits the special address %s', async (address) => {
    for (const policy of ['public', 'allow-private'] as const) {
      await expect(
        resolveNetworkTarget(addressUrl(address), policy),
      ).rejects.toThrow(NetworkPolicyError);
    }
  });

  it.each([
    '8.8.8.8',
    '100.63.255.254',
    '100.128.0.1',
    '172.15.255.254',
    '172.32.0.1',
    '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:200::',
    '2001:4860:4860::8888',
    '2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2003::',
    '2606:4700:4700::1111',
    '::ffff:808:808',
  ])('allows public HTTPS but rejects public HTTP at %s', async (address) => {
    const url = `${addressUrl(address)}?topic=build%20result&tag=a&tag=b#details`;
    for (const policy of ['public', 'allow-private'] as const) {
      const target = await resolveNetworkTarget(url, policy);
      expect(target.url.href).toBe(url);
      await expect(
        resolveNetworkTarget(addressUrl(address, 'http:'), policy),
      ).rejects.toThrow(NetworkPolicyError);
    }
  });

  it('requires every HTTP answer to be private, even when the first is private', async () => {
    mockDns([
      { address: '10.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]);

    await expect(
      resolveNetworkTarget('http://receiver.test/', 'allow-private'),
    ).rejects.toThrow('require private addresses');
    await expect(
      resolveNetworkTarget('https://receiver.test/', 'allow-private'),
    ).resolves.toMatchObject({ address: '10.0.0.1', family: 4 });
    await expect(
      resolveNetworkTarget('https://receiver.test/', 'public'),
    ).rejects.toThrow(NetworkPolicyError);
  });

  it.each(['public', 'allow-private'] as const)(
    'checks later DNS answers for metadata under %s policy',
    async (policy) => {
      mockDns([
        { address: '8.8.8.8', family: 4 },
        { address: 'fd00:ec2::254', family: 6 },
      ]);

      await expect(
        resolveNetworkTarget('https://receiver.test/', policy),
      ).rejects.toThrow(NetworkPolicyError);
    },
  );

  it('classifies expanded mapped IPv6 and metadata DNS answers', async () => {
    const lookup = mockDns([{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 }]);
    await expect(
      resolveNetworkTarget('http://receiver.test/', 'allow-private'),
    ).resolves.toMatchObject({ address: '0:0:0:0:0:ffff:7f00:1', family: 6 });

    lookup.mockResolvedValueOnce([
      { address: 'FD00:0EC2:0:0:0:0:0:0254', family: 6 },
    ] as never);
    await expect(
      resolveNetworkTarget('https://receiver.test/', 'allow-private'),
    ).rejects.toThrow(NetworkPolicyError);
  });

  it.each([
    '::ffff:0:7f00:1',
    '::ffff:0:a9fe:a9fe',
    '0:0:0:0:ffff:0:808:808',
    '::ffff:1:808:808',
  ])(
    'rejects a non-mapped IPv6 DNS answer after a public answer: %s',
    async (address) => {
      mockDns([
        { address: '8.8.8.8', family: 4 },
        { address, family: 6 },
      ]);
      for (const policy of ['public', 'allow-private'] as const) {
        await expect(
          resolveNetworkTarget('https://receiver.test/', policy),
        ).rejects.toThrow(NetworkPolicyError);
      }
    },
  );

  it.each([
    ['::ffff:8.8.8.8', true, true],
    ['0:0:0:0:0:ffff:808:808', true, true],
    ['0::ffff:0808:0808', true, true],
    ['0000:0000:0000:0000:0000:FFFF:8.8.8.8', true, true],
    ['::ffff:127.0.0.1', false, true],
    ['0:0:0:0:0:ffff:7f00:1', false, true],
    ['0::FFFF:127.0.0.1', false, true],
    ['::ffff:169.254.169.254', false, false],
    ['0:0:0:0:0:ffff:a9fe:a9fe', false, false],
    ['0::FFFF:169.254.169.254', false, false],
  ] as const)(
    'classifies the raw mapped DNS answer %s without changing the pinned address',
    async (address, publicAllowed, privateAllowed) => {
      mockDns([{ address, family: 6 }]);
      for (const [policy, allowed] of [
        ['public', publicAllowed],
        ['allow-private', privateAllowed],
      ] as const) {
        const pending = resolveNetworkTarget('https://receiver.test/', policy);
        if (!allowed) {
          await expect(pending).rejects.toThrow(NetworkPolicyError);
          continue;
        }
        const target = await pending;
        expect(target.address).toBe(address);
        expect(target.family).toBe(6);
        expect(target.curlResolve).toBe(`receiver.test:443:[${address}]`);
        const callback = vi.fn();
        target.lookup('receiver.test', { all: true }, callback);
        expect(callback).toHaveBeenCalledWith(null, [{ address, family: 6 }]);
      }
    },
  );
});

describe('resolved connection targets', () => {
  it('pins one checked answer for both direct lookup forms and proxy callers', async () => {
    const dnsLookup = mockDns([
      { address: '10.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
    const target = await resolveNetworkTarget(
      'http://receiver.test:8080/deliver',
      'allow-private',
    );
    dnsLookup.mockResolvedValue([
      { address: '169.254.169.254', family: 4 },
    ] as never);
    const callback = vi.fn();
    target.lookup('receiver.test', { family: 0 }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '10.0.0.1', 4);
    target.lookup('receiver.test', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [
      { address: '10.0.0.1', family: 4 },
    ]);
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(dnsLookup).toHaveBeenCalledWith('receiver.test', {
      all: true,
      verbatim: true,
    });
    expect(target).toMatchObject({
      address: '10.0.0.1',
      family: 4,
      curlResolve: 'receiver.test:8080:10.0.0.1',
    });
  });

  it('refuses to use a pinned lookup for another hostname', async () => {
    mockDns([{ address: '8.8.8.8', family: 4 }]);
    const target = await resolveNetworkTarget(
      'https://receiver.test/',
      'public',
    );
    const callback = vi.fn();
    target.lookup('other.test', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ENOTFOUND' }),
      '',
      0,
    );
  });

  it('preserves IPv6 address syntax and the protocol default port', async () => {
    const target = await resolveNetworkTarget('http://[::1]/', 'allow-private');
    expect(target.curlResolve).toBe('[::1]:80:[::1]');
    expect(target).toMatchObject({ address: '::1', family: 6 });
    const callback = vi.fn();
    target.lookup('[::1]', { family: 6 }, callback);
    expect(callback).toHaveBeenCalledWith(null, '::1', 6);
  });

  it('fails closed on an empty DNS answer', async () => {
    mockDns([]);
    await expect(
      resolveNetworkTarget('https://receiver.test/', 'public'),
    ).rejects.toThrow(NetworkPolicyError);
  });

  it('preserves DNS failures for transport error classification', async () => {
    const error = Object.assign(new Error('DNS unavailable'), {
      code: 'EAI_AGAIN',
    });
    vi.spyOn(dns, 'lookup').mockRejectedValue(error);
    await expect(
      resolveNetworkTarget('https://receiver.test/', 'public'),
    ).rejects.toBe(error);
  });

  it('does not begin resolution when already cancelled', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    const reason = new Error('cancelled');
    await expect(
      resolveNetworkTarget('invalid URL', 'public', AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('stops waiting for DNS on cancellation', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(
      () => new Promise(() => undefined),
    );
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = resolveNetworkTarget(
      'https://receiver.test/',
      'allow-private',
      controller.signal,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
