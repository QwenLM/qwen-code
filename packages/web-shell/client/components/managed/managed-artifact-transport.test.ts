import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import { JavaManagedAgentClient } from './java-managed-agent-client';
import { artifact } from './managed-tool-result.test-fixtures';
it('recovers a bounded range after real HTTP 429 Retry-After', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '1',
      });
      response.end(
        JSON.stringify({
          error: { code: 'artifact_read_limit', message: 'busy' },
        }),
      );
      return;
    }
    response.writeHead(206, {
      etag: '"' + artifact.sha256 + '"',
      'content-range': 'bytes 0-4/5',
      'content-length': '5',
    });
    response.end('hello');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  const client = new JavaManagedAgentClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  try {
    let value: Uint8Array | undefined;
    let failure: unknown;
    try {
      value = await client.readArtifactRange(artifact, 0, 5);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeUndefined();
    expect(new TextDecoder().decode(value)).toBe('hello');
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}, 5000);

it('aborts an already open real HTTP artifact download stream', async () => {
  let disconnected = false;
  const server = createServer((request, response) => {
    response.on('close', () => {
      disconnected = true;
    });
    response.writeHead(200, {
      etag: '"' + artifact.sha256 + '"',
      'content-length': '5',
    });
    response.write('he');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  try {
    const controller = new AbortController();
    const client = new JavaManagedAgentClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const stream = await client.openArtifactStream(artifact, controller.signal);
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('he');
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(disconnected).toBe(true);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

it.each([429, 503])(
  'retries %s only once with the identical fixed-revision range',
  async (status) => {
    const seen: Array<{ url: string; headers: Array<[string, string]> }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        seen.push({
          url: String(url),
          headers: [...new Headers(init?.headers)],
        });
        return new Response(
          JSON.stringify({ error: { code: 'busy', message: 'busy' } }),
          { status, headers: { 'retry-after': '0' } },
        );
      });
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    await expect(
      client.readArtifactRange(artifact, 0, 5),
    ).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(Object.fromEntries(seen[0].headers)).toMatchObject({
      range: 'bytes=0-4',
      'if-match': expect.any(String),
    });
  },
);
it('aborts the Retry-After wait without issuing a second request', async () => {
  const abort = new AbortController();
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'retry-after': '5' } }),
    );
  const client = new JavaManagedAgentClient({
    baseUrl: 'https://product.example',
    fetch: fetchImpl,
  });
  const pending = client.readArtifactRange(artifact, 0, 5, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('stops a provider download after the sink aborts its first chunk', async () => {
  let closed = false;
  const server = createServer((_request, response) => {
    response.on('close', () => {
      closed = true;
    });
    response.writeHead(200, {
      etag: `"${artifact.sha256}"`,
      'content-length': '5',
    });
    response.write('he');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  const abort = new AbortController();
  let consumed = 0;
  try {
    const provider = createJavaManagedAgentProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      saveArtifact: async (_artifact, options) => {
        const stream = await options.openStream();
        const reader = stream.getReader();
        consumed += (await reader.read()).value!.byteLength;
        abort.abort();
        await expect(reader.read()).rejects.toMatchObject({
          name: 'AbortError',
        });
      },
    });
    await provider.toolResults!.downloadArtifact(artifact, {
      clientId: 'client',
      signal: abort.signal,
    });
    expect(consumed).toBeLessThan(artifact.byte_length);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(true);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}, 5000);

it('does not retry earlier than a Retry-After beyond its wait budget', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
    );
  const client = new JavaManagedAgentClient({
    baseUrl: 'https://product.example',
    fetch: fetchImpl,
  });
  await expect(client.readArtifactRange(artifact, 0, 5)).rejects.toMatchObject({
    status: 429,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
