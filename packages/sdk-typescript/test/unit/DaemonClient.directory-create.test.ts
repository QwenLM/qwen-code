/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

describe('workspace file and directory mutations', () => {
  it.each(['file', 'directory', 'directory deletion'])(
    'uses authenticated qualified REST for %s',
    async (kind) => {
      const restFetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              kind:
                kind === 'file'
                  ? 'file_write'
                  : kind === 'directory'
                    ? 'directory_create'
                    : 'directory_delete',
              path: '新 item',
            }),
            {
              status: kind === 'directory deletion' ? 200 : 201,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
      const transportFetch = vi.fn(
        async () => new Response(null, { status: 404 }),
      );
      const transport: DaemonTransport = {
        type: 'acp-http',
        supportsReplay: true,
        connected: true,
        restFetch,
        fetch: transportFetch,
        async *subscribeEvents() {},
        dispose() {},
      };
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        token: 'secret',
        transport,
      });
      const workspace = client.workspaceByCwd('/work with space');
      if (kind === 'file') {
        await workspace.writeWorkspaceFile(
          { path: '新 item', content: '', mode: 'create' },
          'client-1',
        );
      } else if (kind === 'directory') {
        await expect(
          workspace.createWorkspaceDirectory('新 item', 'client-1'),
        ).resolves.toBeUndefined();
      } else {
        await expect(
          workspace.deleteWorkspaceDirectory('新 item', 'client-1'),
        ).resolves.toBeUndefined();
      }
      expect(transportFetch).not.toHaveBeenCalled();
      const [url, init] = restFetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        `http://daemon/workspaces/%2Fwork%20with%20space/${kind === 'file' ? 'file/write' : kind === 'directory' ? 'directory/create' : 'directory/delete'}`,
      );
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer secret');
      expect(headers.get('x-qwen-client-id')).toBe('client-1');
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init.body))).toEqual(
        kind === 'file'
          ? { path: '新 item', content: '', mode: 'create' }
          : { path: '新 item' },
      );
    },
  );

  it('surfaces directory collisions without a legacy-primary retry', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'already exists',
            errorKind: 'file_already_exists',
          }),
          { status: 409 },
        ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.workspaceById('owner').createWorkspaceDirectory('taken'),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces directory deletion failures without a legacy-primary retry', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.workspaceById('owner').deleteWorkspaceDirectory('missing'),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
