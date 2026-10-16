import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

describe('workspace-qualified file deletion', () => {
  it('sends an authenticated REST mutation to the exact workspace', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ kind: 'file_delete', path: 'notes draft.md' }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      token: 'secret',
      fetch,
    });
    await client
      .workspaceByCwd('/work with space')
      .deleteWorkspaceFile('notes draft.md', 'viewer');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://daemon/workspaces/%2Fwork%20with%20space/file/delete',
    );
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({
      path: 'notes draft.md',
    });
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer secret',
    );
    expect(new Headers(options.headers).get('x-qwen-client-id')).toBe('viewer');
  });

  it('propagates refusal rather than treating it as deletion', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Deletion denied' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.workspaceByCwd('/work').deleteWorkspaceFile('keep.txt'),
    ).rejects.toThrow('Deletion denied');
  });
});
