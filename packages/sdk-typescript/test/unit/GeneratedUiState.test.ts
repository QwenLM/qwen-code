/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

const CARD = 'gc_aaaaaaaaaaaaaaaaaaaaaa';

function client(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const restFetch = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  const transport: DaemonTransport = {
    type: 'acp-http',
    supportsReplay: false,
    connected: true,
    restFetch,
    fetch: vi.fn(),
    subscribeEvents: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    calls,
    client: new DaemonClient({ baseUrl: 'http://daemon', transport }),
  };
}

describe('Generated UI view state', () => {
  it('reads state through owner-routed REST with the bound client', async () => {
    const state = { cardId: CARD, revision: 0, value: null };
    const { client: daemon, calls } = client(200, state);
    await expect(
      daemon.getGeneratedUiState('session/1', CARD, 'client-1'),
    ).resolves.toEqual(state);
    expect(calls[0]?.url).toBe(
      `http://daemon/session/session%2F1/generated-ui/state/${CARD}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('x-qwen-client-id')).toBe(
      'client-1',
    );
  });

  it.each([
    [200, { outcome: 'saved', cardId: CARD, revision: 2 }],
    [409, { outcome: 'stale', cardId: CARD, revision: 3, value: 'theirs' }],
    [413, { outcome: 'too_large', cardId: CARD, limitBytes: 16384 }],
  ])('resolves a %i write with its outcome', async (status, body) => {
    const { client: daemon, calls } = client(status, body);
    await expect(
      daemon.setGeneratedUiState(
        'session-1',
        CARD,
        { baseRevision: 1, value: 'mine' },
        'client-1',
      ),
    ).resolves.toEqual(body);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ baseRevision: 1, value: 'mine' }),
    );
  });

  it.each([
    [409, { error: 'card limit', code: 'state_card_limit' }],
    [503, { error: 'unavailable', code: 'state_unavailable' }],
  ])('throws for a %i write without an outcome', async (status, body) => {
    const { client: daemon } = client(status, body);
    const write = daemon.setGeneratedUiState(
      'session-1',
      CARD,
      { baseRevision: 0, value: 1 },
      'client-1',
    );
    await expect(write).rejects.toBeInstanceOf(DaemonHttpError);
    await expect(write).rejects.toMatchObject({ status, body });
  });
});
