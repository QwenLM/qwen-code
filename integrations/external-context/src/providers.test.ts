/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { renderExternalContext } from './context.js';
import { ProviderResponseError, ProviderTimeoutError } from './http-client.js';
import {
  GenericHttpSearchV1Adapter,
  Mem0PlatformV3Adapter,
} from './providers.js';

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

describe('GenericHttpSearchV1Adapter', () => {
  it('sends only query and limit and drops invalid entries', async () => {
    let requestBody: unknown;
    let authorization: string | undefined;
    let accept: string | undefined;
    const baseUrl = await startServer(async (request, response) => {
      requestBody = JSON.parse(await readBody(request));
      authorization = request.headers.authorization;
      accept = request.headers.accept;
      json(response, {
        items: [
          {
            id: 'valid',
            content: 'repository policy',
            title: 'Policy',
            score: 0.82,
            updated_at: '2026-07-23T00:00:00Z',
          },
          { id: 'invalid-without-content' },
          { id: 'invalid-score', content: 'bad', score: 'high' },
        ],
      });
    });
    const adapter = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });

    const items = await adapter.search({
      query: 'deployment',
      limit: 5,
      signal: AbortSignal.timeout(1000),
    });

    expect(requestBody).toEqual({ query: 'deployment', limit: 5 });
    expect(authorization).toBe('Bearer credential');
    expect(accept).toBe('application/json');
    expect(JSON.stringify(requestBody)).not.toMatch(
      /tenant|repository|namespace|filter/i,
    );
    expect(items).toEqual([
      {
        id: 'valid',
        content: 'repository policy',
        title: 'Policy',
        score: 0.82,
        updatedAt: '2026-07-23T00:00:00Z',
      },
    ]);
  });

  it('requires HTTPS except for explicit loopback HTTP', () => {
    const config = {
      type: 'generic-http-search-v1' as const,
      tokenEnv: 'TOKEN',
      token: 'credential',
    };
    expect(
      () =>
        new GenericHttpSearchV1Adapter({
          ...config,
          baseUrl: 'http://context.example.com',
        }),
    ).toThrow('Provider URL must use HTTPS or loopback HTTP.');
    expect(
      () =>
        new GenericHttpSearchV1Adapter({
          ...config,
          baseUrl: 'https://user:password@context.example.com',
        }),
    ).toThrow('Provider URL must not contain credentials');
    expect(
      () =>
        new GenericHttpSearchV1Adapter({
          ...config,
          baseUrl: 'https://context.example.com/safe-prefix',
        }),
    ).toThrow('Provider URL must not contain credentials, path');
  });

  it('rejects redirects', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(302, { location: 'https://other.example.com' });
      response.end();
    });

    await expect(searchGeneric(baseUrl)).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('rejects a declared response larger than 1 MiB', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-length': String(1024 * 1024 + 1),
        'content-type': 'application/json',
      });
      response.end('{}');
    });

    await expect(searchGeneric(baseUrl)).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it('rejects a streamed response larger than 1 MiB', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.write('x'.repeat(512 * 1024));
      response.end('x'.repeat(512 * 1024 + 1));
    });

    await expect(searchGeneric(baseUrl)).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  it.each([429, 500])('rejects HTTP %s without retrying', async (status) => {
    let requestCount = 0;
    const baseUrl = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(status);
      response.end('upstream detail');
    });
    const adapter = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });

    await expect(
      adapter.search({
        query: 'query',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow('External context provider rejected the request.');
    expect(requestCount).toBe(1);
  });

  it('rejects invalid JSON', async () => {
    const invalidUrl = await startServer((_request, response) => {
      response.end('{');
    });
    const adapter = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl: invalidUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });

    await expect(
      adapter.search({
        query: 'query',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('rejects a valid JSON response with an invalid envelope', async () => {
    const baseUrl = await startServer((_request, response) => {
      json(response, {});
    });

    await expect(searchGeneric(baseUrl)).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
  });

  it('rejects invalid UTF-8 as a provider response error', async () => {
    const invalidUrl = await startServer((_request, response) => {
      response.end(Buffer.from([0xc3, 0x28]));
    });
    const adapter = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl: invalidUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });

    await expect(
      adapter.search({
        query: 'query',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('preserves the caller timeout classification', async () => {
    const delayedUrl = await startServer(
      async (_request, response) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            json(response, { items: [] });
            resolve();
          }, 200);
        }),
    );
    const adapter = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl: delayedUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });

    await expect(
      adapter.search({
        query: 'query',
        limit: 5,
        signal: AbortSignal.timeout(10),
      }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

describe('Mem0PlatformV3Adapter', () => {
  it('binds app_id and fixed V3 search options in the adapter', async () => {
    let requestBody: unknown;
    let requestPath: string | undefined;
    let authorization: string | undefined;
    let accept: string | undefined;
    const baseUrl = await startServer(async (request, response) => {
      requestPath = request.url;
      requestBody = JSON.parse(await readBody(request));
      authorization = request.headers.authorization;
      accept = request.headers.accept;
      json(response, {
        results: [
          {
            id: 'memory-1',
            memory: 'repository policy',
            score: 0.9,
          },
        ],
      });
    });
    const adapter = mem0Adapter(baseUrl);

    const items = await adapter.search({
      query: 'deployment',
      limit: 99,
      signal: AbortSignal.timeout(1000),
    });

    expect(requestPath).toBe('/v3/memories/search/');
    expect(authorization).toBe('Token project-key');
    expect(accept).toBe('application/json');
    expect(requestBody).toEqual({
      query: 'deployment',
      filters: { app_id: 'fixed-repository' },
      top_k: 5,
      threshold: 0.1,
      rerank: false,
    });
    expect(items).toEqual([
      { id: 'memory-1', content: 'repository policy', score: 0.9 },
    ]);
  });

  it('rejects an undocumented top-level array response', async () => {
    const baseUrl = await startServer((_request, response) => {
      json(response, [{ id: 'memory-1', memory: 'repository policy' }]);
    });

    await expect(
      mem0Adapter(baseUrl).search({
        query: 'deployment',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
  });

  it('normalizes Mem0 and Generic HTTP results to the same context', async () => {
    const genericUrl = await startServer((_request, response) => {
      json(response, {
        items: [{ id: 'one', content: 'same content', score: 0.75 }],
      });
    });
    const mem0Url = await startServer((_request, response) => {
      json(response, {
        results: [{ id: 'one', memory: 'same content', score: 0.75 }],
      });
    });
    const generic = new GenericHttpSearchV1Adapter({
      type: 'generic-http-search-v1',
      baseUrl: genericUrl,
      tokenEnv: 'TOKEN',
      token: 'credential',
    });
    const mem0 = mem0Adapter(mem0Url);

    const [genericItems, mem0Items] = await Promise.all([
      generic.search({
        query: 'same',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
      mem0.search({
        query: 'same',
        limit: 5,
        signal: AbortSignal.timeout(1000),
      }),
    ]);
    expect(renderExternalContext(genericItems)).toBe(
      renderExternalContext(mem0Items),
    );
  });
});

function mem0Adapter(baseUrl: string) {
  return new Mem0PlatformV3Adapter(
    {
      type: 'mem0-platform-v3',
      apiKeyEnv: 'MEM0_API_KEY',
      apiKey: 'project-key',
      appId: 'fixed-repository',
    },
    new URL(baseUrl),
  );
}

async function searchGeneric(baseUrl: string) {
  const adapter = new GenericHttpSearchV1Adapter({
    type: 'generic-http-search-v1',
    baseUrl,
    tokenEnv: 'TOKEN',
    token: 'credential',
  });
  return adapter.search({
    query: 'query',
    limit: 5,
    signal: AbortSignal.timeout(1000),
  });
}

async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  closeServers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, body: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
