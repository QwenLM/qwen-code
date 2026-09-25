/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectDesktopRelay,
  disconnectDesktopRelay,
  probeDesktopRelay,
  type FetchLike,
} from './desktop-relay-client';

function respond(status: number, body: unknown) {
  return vi.fn<FetchLike>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('probeDesktopRelay', () => {
  it('reads the version and the connection this page started', async () => {
    const fetchImpl = respond(200, {
      ok: true,
      version: '0.1.5',
      active: {
        sessionId: 's1',
        daemonUrl: 'https://devbox:4170/',
        phase: 'connected',
      },
    });
    await expect(probeDesktopRelay(fetchImpl)).resolves.toEqual({
      kind: 'ready',
      version: '0.1.5',
      active: {
        sessionId: 's1',
        daemonUrl: 'https://devbox:4170/',
        phase: 'connected',
      },
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:47821/status');
  });

  it('ignores a malformed connection entry', async () => {
    await expect(
      probeDesktopRelay(
        respond(200, {
          ok: true,
          version: '0.1.5',
          active: { phase: 'weird' },
        }),
      ),
    ).resolves.toEqual({ kind: 'ready', version: '0.1.5' });
  });

  it('reports an undetected relay for failed requests or foreign answers', async () => {
    const refused = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeDesktopRelay(refused)).resolves.toEqual({
      kind: 'missing',
    });
    await expect(probeDesktopRelay(respond(404, {}))).resolves.toEqual({
      kind: 'missing',
    });
  });

  it.each(['prompt', 'granted', 'denied'])(
    'does not infer a permission denial from %s',
    async (state) => {
      vi.stubGlobal('navigator', {
        permissions: {
          query: vi.fn().mockResolvedValue({ state }),
        },
      });
      const refused = vi.fn<FetchLike>(async () => {
        throw new TypeError('Failed to fetch');
      });
      await expect(probeDesktopRelay(refused)).resolves.toEqual({
        kind: state === 'denied' ? 'permission-required' : 'missing',
      });
    },
  );
});

describe('connectDesktopRelay', () => {
  const request = {
    daemonUrl: 'https://devbox:4170/',
    sessionId: 's1',
    token: 't',
    workspace: { kind: 'cwd' as const, value: '/w' },
  };

  it('posts the request as JSON and reports acceptance', async () => {
    const fetchImpl = respond(202, { ok: true });
    await expect(connectDesktopRelay(request, fetchImpl)).resolves.toEqual({
      ok: true,
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:47821/connect');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('passes on the refusal code', async () => {
    await expect(
      connectDesktopRelay(request, respond(403, { ok: false, code: 'denied' })),
    ).resolves.toEqual({ ok: false, code: 'denied' });
  });

  it('reports an unreachable relay', async () => {
    const refused = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(connectDesktopRelay(request, refused)).resolves.toEqual({
      ok: false,
      code: 'unreachable',
      message: 'Failed to fetch',
    });
  });
});

describe('disconnectDesktopRelay', () => {
  it('posts to /disconnect and swallows failures', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(disconnectDesktopRelay(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:47821/disconnect',
    );
  });
});
