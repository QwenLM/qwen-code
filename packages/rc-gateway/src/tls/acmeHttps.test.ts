/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { SecureContext } from 'node:tls';
import { createLiveTlsContext } from './acmeHttps.js';
import type { CertBundle } from './acme/certStore.js';

const bundle = (tag: string): CertBundle => ({
  cert: tag,
  chain: 'c',
  privateKey: 'k',
  meta: { domains: ['d'], notAfter: 'x', issuedAt: 'y' },
});

function resolve(live: ReturnType<typeof createLiveTlsContext>) {
  let res: SecureContext | undefined;
  let err: Error | null = null;
  live.sniCallback('any.host', (e, c) => {
    err = e;
    res = c;
  });
  return { err, res };
}

describe('createLiveTlsContext', () => {
  it('serves the current context and swaps it live on update (renewal)', () => {
    const build = vi.fn(
      (b: CertBundle) => ({ tag: b.cert }) as unknown as SecureContext,
    );
    const live = createLiveTlsContext(bundle('v1'), build);

    expect(resolve(live).res).toEqual({ tag: 'v1' });

    live.update(bundle('v2'));
    expect(resolve(live).res).toEqual({ tag: 'v2' }); // next handshake sees the renewed cert

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('passes no error to the SNI callback', () => {
    const build = (b: CertBundle) =>
      ({ tag: b.cert }) as unknown as SecureContext;
    const live = createLiveTlsContext(bundle('v1'), build);
    expect(resolve(live).err).toBeNull();
  });
});
