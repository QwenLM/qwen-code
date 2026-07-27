/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createPeersRoute, type BrowsePeers } from './peers.js';
import type { DaemonRecord } from '../mdns/advert.js';

const REC: DaemonRecord = {
  name: 'work',
  host: '192.168.1.9',
  port: 4123,
  version: '0.17.1',
  tlsRequired: false,
  workspace: 'myrepo',
};

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}
const call = async (browsePeers: BrowsePeers) => {
  const res = fakeRes();
  await createPeersRoute(browsePeers)(
    {} as never,
    res as never,
    (() => {}) as never,
  );
  return res;
};

describe('createPeersRoute', () => {
  it('200s with the peers array verbatim', async () => {
    const res = await call(async () => [REC]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ peers: [REC] });
  });

  it('200s with an empty list on an empty LAN', async () => {
    const res = await call(async () => []);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ peers: [] });
  });

  it('503 mdns_unavailable when browsePeers returns null', async () => {
    const res = await call(async () => null);
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('mdns_unavailable');
  });

  it('500 peers_unavailable when browsePeers throws', async () => {
    const res = await call(async () => {
      throw new Error('boom');
    });
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('peers_unavailable');
  });
});
