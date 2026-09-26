/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_RELAY_INSTALL_COMMAND,
  connectDesktopRelay,
  disconnectDesktopRelay,
  probeDesktopRelay,
  type FetchLike,
} from './desktop-relay-client';

// The version the copy button hands out must be one the release workflow
// actually publishes with the `desktop-relay` subcommand in it.
const nodeReplPackage = JSON.parse(
  readFileSync(
    new URL('../../../node-repl/package.json', import.meta.url),
    'utf8',
  ),
) as { version: string };

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

describe('DESKTOP_RELAY_INSTALL_COMMAND', () => {
  it('pins the published node-repl version instead of @latest', () => {
    const pin = DESKTOP_RELAY_INSTALL_COMMAND.match(
      /^npx -y @qwen-code\/node-repl-mcp@(\S+) desktop-relay install$/,
    )?.[1];
    expect(pin).toBe(nodeReplPackage.version);
    expect(DESKTOP_RELAY_INSTALL_COMMAND).not.toContain(
      '@qwen-code/node-repl-mcp@latest',
    );
  });
});

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
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      input.includes('/desktop-relay/credential')
        ? new Response(JSON.stringify({ credential: 'scoped' }), {
            status: 200,
          })
        : new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    await expect(connectDesktopRelay(request, fetchImpl)).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://devbox:4170/workspaces/%2Fw/runtime/ensure',
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: 'Bearer t',
      'content-type': 'application/json',
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://devbox:4170/desktop-relay/credential',
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: 'Bearer t',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      sessionId: 's1',
      workspace: { kind: 'cwd', value: '/w' },
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('http://127.0.0.1:47821/connect');
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      ...request,
      token: 'scoped',
    });
  });

  it('passes on the refusal code', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      input.includes('/runtime/ensure')
        ? new Response(JSON.stringify({ ok: true }))
        : input.includes('/desktop-relay/credential')
          ? new Response(JSON.stringify({ credential: 'scoped' }))
          : new Response(JSON.stringify({ ok: false, code: 'denied' }), {
              status: 403,
            }),
    );
    await expect(connectDesktopRelay(request, fetchImpl)).resolves.toEqual({
      ok: false,
      code: 'denied',
    });
  });

  it('does not send the daemon token when credential minting fails', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (input) =>
      input.includes('/runtime/ensure')
        ? new Response(JSON.stringify({ ok: true }))
        : new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          }),
    );
    await expect(connectDesktopRelay(request, fetchImpl)).resolves.toEqual({
      ok: false,
      code: 'credential_failed',
      message: 'Unauthorized',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not mint a scoped credential when bearer-authenticated prewarm fails', async () => {
    const fetchImpl = respond(401, { error: 'Unauthorized' });
    await expect(connectDesktopRelay(request, fetchImpl)).resolves.toEqual({
      ok: false,
      code: 'prewarm_failed',
      message: 'Unauthorized',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports an unreachable relay', async () => {
    const refused = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      connectDesktopRelay({ ...request, token: undefined }, refused),
    ).resolves.toEqual({
      ok: false,
      code: 'unreachable',
      message: 'Failed to fetch',
    });
  });
});

describe('disconnectDesktopRelay', () => {
  it('posts to /disconnect and reports an unreachable relay', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(disconnectDesktopRelay(fetchImpl)).resolves.toBe(false);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:47821/disconnect',
    );
  });

  it('reports a refusal, so the caller cannot claim a revocation', async () => {
    await expect(
      disconnectDesktopRelay(respond(403, { code: 'denied' })),
    ).resolves.toBe(false);
  });

  it('reports success only when the relay accepted the revocation', async () => {
    await expect(disconnectDesktopRelay(respond(200, {}))).resolves.toBe(true);
  });
});
