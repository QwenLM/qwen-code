/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDirectoryUrl,
  buildDnsProvider,
  LE_DIRECTORY,
} from './buildAcmeStack.js';

describe('resolveDirectoryUrl', () => {
  it('defaults to LE production', () => {
    expect(
      resolveDirectoryUrl({
        domains: ['d'],
        email: 'e',
        dnsProvider: 'route53',
      }),
    ).toBe(LE_DIRECTORY.production);
  });
  it('uses LE staging when staging:true', () => {
    expect(
      resolveDirectoryUrl({
        domains: ['d'],
        email: 'e',
        dnsProvider: 'route53',
        staging: true,
      }),
    ).toBe(LE_DIRECTORY.staging);
  });
  it('an explicit directoryUrl overrides staging/production', () => {
    expect(
      resolveDirectoryUrl({
        domains: ['d'],
        email: 'e',
        dnsProvider: 'route53',
        staging: true,
        directoryUrl: 'https://pebble.local/dir',
      }),
    ).toBe('https://pebble.local/dir');
  });
});

describe('buildDnsProvider', () => {
  it('builds a Cloudflare provider from env creds', async () => {
    const provider = await buildDnsProvider('cloudflare', {
      CLOUDFLARE_API_TOKEN: 'tkn',
      CLOUDFLARE_ZONE_ID: 'Z',
    });
    expect(provider.name).toBe('cloudflare');
  });

  it('rejects Cloudflare without token/zone', async () => {
    await expect(
      buildDnsProvider('cloudflare', { CLOUDFLARE_API_TOKEN: 'tkn' }),
    ).rejects.toThrow(/CLOUDFLARE_ZONE_ID/);
  });

  it('rejects Route53 without a hosted zone id', async () => {
    await expect(buildDnsProvider('route53', {})).rejects.toThrow(
      /AWS_ROUTE53_HOSTED_ZONE_ID/,
    );
  });

  it('rejects an unknown provider name', async () => {
    await expect(buildDnsProvider('namecheap', {})).rejects.toThrow(
      /unknown .*provider/i,
    );
  });
});
