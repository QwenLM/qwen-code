/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
} from '../../src/daemon/DaemonClient.js';

interface CapturedCall {
  url: string;
  method: string;
  body: string | undefined;
}

function fetchSequence(bodies: Array<{ status: number; body: unknown }>): {
  fetch: typeof globalThis.fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const body = bodies[calls.length];
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : undefined,
    });
    return new Response(
      body.status === 204 ? null : JSON.stringify(body.body),
      {
        status: body.status,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  return { fetch, calls };
}

describe('DaemonClient Google OAuth methods', () => {
  it('uses workspace routes and sends authorization codes only in JSON', async () => {
    const { fetch, calls } = fetchSequence([
      { status: 201, body: { id: 'flow-1', status: 'waiting' } },
      {
        status: 200,
        body: { id: 'flow-1', status: 'awaiting-code' },
      },
      { status: 202, body: { accepted: true } },
      { status: 204, body: {} },
    ]);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client.startGoogleOAuthLogin({ workspace: '/wk' }),
    ).resolves.toMatchObject({ id: 'flow-1' });
    await expect(
      client.getGoogleOAuthLogin('flow-1', { workspace: '/wk' }),
    ).resolves.toMatchObject({ status: 'awaiting-code' });
    await client.submitGoogleOAuthCode('flow-1', 'manual-code', {
      workspace: '/wk',
    });
    await client.cancelGoogleOAuthLogin('flow-1', { workspace: '/wk' });

    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/workspaces/%2Fwk/auth/google/flows',
      'http://daemon/workspaces/%2Fwk/auth/google/flows/flow-1',
      'http://daemon/workspaces/%2Fwk/auth/google/flows/flow-1/code',
      'http://daemon/workspaces/%2Fwk/auth/google/flows/flow-1',
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      'POST',
      'GET',
      'POST',
      'DELETE',
    ]);
    expect(calls[0]?.body).toBe('{}');
    expect(calls[1]?.body).toBeUndefined();
    expect(JSON.parse(calls[2]?.body ?? '')).toEqual({ code: 'manual-code' });
    expect(calls.every((call) => !call.url.includes('manual-code'))).toBe(true);
  });

  it('uses the process-global path and maps errors', async () => {
    const { fetch, calls } = fetchSequence([
      { status: 201, body: { id: 'flow-1', status: 'waiting' } },
      { status: 502, body: { error: 'upstream' } },
    ]);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await client.startGoogleOAuthLogin();
    expect(calls[0]?.url).toBe('http://daemon/auth/google/flows');

    await expect(client.getGoogleOAuthLogin('flow-1')).rejects.toBeInstanceOf(
      DaemonHttpError,
    );
    expect(calls[1]?.url).toBe('http://daemon/auth/google/flows/flow-1');
  });

  it('rejects an empty workspace selector without making HTTP requests', async () => {
    const { fetch, calls } = fetchSequence([]);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.startGoogleOAuthLogin({ workspace: '' }),
    ).rejects.toThrow('workspace must not be empty');
    await expect(
      client.getGoogleOAuthLogin('flow-1', { workspace: '' }),
    ).rejects.toThrow('workspace must not be empty');
    await expect(
      client.submitGoogleOAuthCode('flow-1', 'code', { workspace: '' }),
    ).rejects.toThrow('workspace must not be empty');
    await expect(
      client.cancelGoogleOAuthLogin('flow-1', { workspace: '' }),
    ).rejects.toThrow('workspace must not be empty');
    await expect(client.signOutGoogleOAuth({ workspace: '' })).rejects.toThrow(
      'workspace must not be empty',
    );
    expect(calls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs out Google at both workspace and process-global routes', async () => {
    const { fetch, calls } = fetchSequence([
      { status: 204, body: {} },
      { status: 204, body: {} },
    ]);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await client.signOutGoogleOAuth({ workspace: '/wk' });
    await client.signOutGoogleOAuth();
    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/workspaces/%2Fwk/auth/google',
      'http://daemon/auth/google',
    ]);
    expect(calls.every((call) => call.method === 'DELETE')).toBe(true);
  });
});
