/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveNetworkTarget } from './network-policy.js';

describe('resolveNetworkTarget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves unrestricted targets unchanged', async () => {
    const target = await resolveNetworkTarget('http://127.0.0.1/archive');

    expect(target.url.toString()).toBe('http://127.0.0.1/archive');
    expect(target.lookup).toBeUndefined();
  });

  it('requires credential-free HTTPS for public targets', async () => {
    await expect(
      resolveNetworkTarget('http://example.com/archive', 'public'),
    ).rejects.toThrow('must use HTTPS');
    await expect(
      resolveNetworkTarget('https://user:secret@example.com/archive', 'public'),
    ).rejects.toThrow('must not use credentials');
  });

  it.each([
    'https://127.0.0.1/archive',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/archive',
    'https://[::ffff:7f00:1]/archive',
    'https://[fec0::1]/archive',
    'https://[2001::1]/archive',
    'https://[fc00::1]/archive',
  ])('rejects blocked literal address %s', async (url) => {
    await expect(resolveNetworkTarget(url, 'public')).rejects.toThrow(
      'resolved to a blocked address',
    );
  });

  it('rejects a DNS answer set containing a private address', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ] as never);

    await expect(
      resolveNetworkTarget('https://packages.example/archive', 'public'),
    ).rejects.toThrow('resolved to a blocked address');
  });

  it('pins the validated address for the connection', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
    ] as never);

    const target = await resolveNetworkTarget(
      'https://packages.example:8443/archive',
      'public',
    );
    const callback = vi.fn();
    target.lookup?.('packages.example', { family: 0 }, callback);

    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(target.curlResolve).toBe('packages.example:8443:8.8.8.8');
  });

  it('allows public IPv6 targets', async () => {
    const target = await resolveNetworkTarget(
      'https://[2606:4700:4700::1111]/archive',
      'public',
    );

    expect(target.curlResolve).toBe(
      '[2606:4700:4700::1111]:443:[2606:4700:4700::1111]',
    );
  });
});
