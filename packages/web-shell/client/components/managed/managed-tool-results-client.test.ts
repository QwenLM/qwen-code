import { describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentClient } from './java-managed-agent-client';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import { artifact, result } from './managed-tool-result.test-fixtures';
import type { ManagedArtifactSave } from './managed-tool-result-types';

function rangeResponse(text: string, headers: HeadersInit = {}) {
  return new Response(text, {
    status: 206,
    headers: {
      etag: `"${artifact.sha256}"`,
      'content-range': 'bytes 1-3/5',
      ...headers,
    },
  });
}

describe('Managed result transport', () => {
  it('reads metadata and fixed bytes through the product transport with fresh headers', async () => {
    let token = 'first';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result, access: { can_read_content: true } }),
        ),
      )
      .mockResolvedValueOnce(rangeResponse('ell'));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway/',
      fetch: fetchImpl,
      credentials: 'same-origin',
      getHeaders: async () => ({
        authorization: `Bearer ${token}`,
        'x-tenant': 'tenant-a',
      }),
    });
    const signal = new AbortController().signal;
    expect(
      await client.getToolResult('session-1', 'item-1', signal),
    ).toMatchObject({ result });
    token = 'second';
    expect(
      new TextDecoder().decode(
        await client.readArtifactRange(artifact, 1, 3, signal),
      ),
    ).toBe('ell');
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe(
      `https://product.example/gateway/v1/agents/sessions/session-1/artifacts/artifact-1/content?revision=${artifact.revision}`,
    );
    expect(request).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      signal,
    });
    const headers = new Headers(request?.headers);
    expect(headers.get('authorization')).toBe('Bearer second');
    expect(headers.get('x-tenant')).toBe('tenant-a');
    expect(headers.get('if-match')).toBe(`"${artifact.sha256}"`);
    expect(headers.get('range')).toBe('bytes=1-3');
  });

  it.each([
    [() => new Response('hello'), 'validator'],
    [() => rangeResponse('ell', { 'content-range': 'bytes 0-2/5' }), 'range'],
    [() => rangeResponse('el'), 'ended'],
    [() => rangeResponse('ello'), 'exceeds'],
  ] as const)(
    'rejects responses that cannot be the selected byte range',
    async (response, message) => {
      const client = new JavaManagedAgentClient({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
      });
      await expect(client.readArtifactRange(artifact, 1, 3)).rejects.toThrow(
        message,
      );
    },
  );

  it('preserves authenticated metadata error semantics for expired output', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'artifact_revision_expired', message: 'expired' },
          }),
          { status: 410 },
        ),
      ),
    });
    await expect(
      client.readArtifactRange(artifact, 0, 5),
    ).rejects.toMatchObject({ status: 410, code: 'artifact_revision_expired' });
  });

  it('streams through the host sink without materializing a Blob and refreshes auth at open', async () => {
    const byteCount = 16 * 1024 * 1024;
    let produced = 0;
    let consumed = 0;
    let token = 'old';
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= byteCount) controller.close();
        else {
          const chunk = new Uint8Array(64 * 1024);
          produced += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const response = new Response(body, {
      headers: {
        etag: `"${artifact.sha256}"`,
        'content-length': String(byteCount),
      },
    });
    const blob = vi.spyOn(response, 'blob');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const saveArtifact = vi.fn<ManagedArtifactSave>(
      async (_artifact, options) => {
        token = 'new';
        const stream = await options.openStream();
        await stream.pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              consumed += chunk.byteLength;
              expect(produced - consumed).toBeLessThanOrEqual(3 * 64 * 1024);
            },
          }),
          { signal: options.signal },
        );
      },
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: `Bearer ${token}` }),
      saveArtifact,
    });
    expect(provider.toolResults?.canDownload).toBe(true);
    await provider.toolResults!.downloadArtifact(
      { ...artifact, byte_length: byteCount },
      { clientId: 'client' },
    );
    expect(consumed).toBe(byteCount);
    expect(blob).not.toHaveBeenCalled();
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer new');
  });

  it('fails an incomplete download instead of closing the saved stream successfully', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('hell', {
          headers: { etag: `"${artifact.sha256}"`, 'content-length': '5' },
        }),
      ),
    });
    const close = vi.fn();
    const abort = vi.fn();
    const stream = await client.openArtifactStream(artifact);
    await expect(
      stream.pipeTo(new WritableStream({ close, abort })),
    ).rejects.toThrow('incomplete');
    expect(close).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
  });
});
