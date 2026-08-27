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
import {
  createMemoryWriter,
  GenericHttpSearchV1Adapter,
  Mem0CompatibleAdapter,
  Mem0PlatformV3Adapter,
} from './providers.js';
import type { Mem0CompatibleProviderConfig, Mem0PresetId } from './types.js';

const closeServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeServers.splice(0).map((close) => close()));
});

describe('GenericHttpSearchV1Adapter', () => {
  it('sends only query and limit without discarding content for bad metadata', async () => {
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
          {
            id: 'invalid-score',
            content: 'bad',
            title: 42,
            uri: false,
            updated_at: [],
            score: 'high',
          },
          { id: 'nullable-score', content: 'real', score: null },
          {
            id: 'large',
            content: 'x'.repeat(150_000),
            title: 't'.repeat(3000),
            uri: `https://example.com/${'u'.repeat(5000)}`,
          },
          { id: 'i'.repeat(2000), content: 'oversized id' },
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
    expect(items.slice(0, 3)).toEqual([
      {
        id: 'valid',
        content: 'repository policy',
        title: 'Policy',
        score: 0.82,
        updatedAt: '2026-07-23T00:00:00Z',
      },
      { id: 'invalid-score', content: 'bad' },
      { id: 'nullable-score', content: 'real' },
    ]);
    expect(items[3]).toMatchObject({ id: 'large' });
    expect(items[3]?.content).toHaveLength(150_000);
    expect(items[3]?.title).toHaveLength(3000);
    expect(items[3]?.uri).toHaveLength(5020);
    expect(items[4]?.id).toHaveLength(2000);
  });

  it('filters invalid entries before applying the result limit', async () => {
    const baseUrl = await startServer((_request, response) => {
      json(response, {
        items: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `invalid-${index}`,
          })),
          { id: 'valid', content: 'repository policy' },
        ],
      });
    });

    await expect(searchGeneric(baseUrl)).resolves.toEqual([
      { id: 'valid', content: 'repository policy' },
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

    await expect(searchGeneric(baseUrl)).rejects.toThrow(
      'External context provider returned an invalid response.',
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

    await expect(searchGeneric(baseUrl)).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
  });

  it('rejects a streamed response larger than 1 MiB', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.write('x'.repeat(512 * 1024));
      response.end('x'.repeat(512 * 1024 + 1));
    });

    await expect(searchGeneric(baseUrl)).rejects.toThrow(
      'External context provider returned an invalid response.',
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
    ).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
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
    ).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
  });

  it('reports an interrupted request without a public error taxonomy', async () => {
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
    ).rejects.toThrow('External context provider request did not complete.');
  });
});

describe('Mem0PlatformV3Adapter', () => {
  const eventId = '123e4567-e89b-12d3-a456-426614174000';

  it('creates a writer only for the Mem0 provider', () => {
    expect(
      createMemoryWriter({
        type: 'mem0-platform-v3',
        apiKeyEnv: 'MEM0_API_KEY',
        apiKey: 'project-key',
        appId: 'fixed-repository',
      }),
    ).toBeInstanceOf(Mem0PlatformV3Adapter);
    expect(
      createMemoryWriter({
        type: 'generic-http-search-v1',
        baseUrl: 'https://context.example.com',
        tokenEnv: 'TOKEN',
        token: 'credential',
      }),
    ).toBeUndefined();
  });

  it('validates an injected test origin before sending a project key', () => {
    const config = {
      type: 'mem0-platform-v3' as const,
      apiKeyEnv: 'MEM0_API_KEY',
      apiKey: 'project-key',
      appId: 'fixed-repository',
    };
    expect(
      () =>
        new Mem0PlatformV3Adapter(
          config,
          new URL('http://context.example.com'),
        ),
    ).toThrow('Provider URL must use HTTPS or loopback HTTP.');
    expect(
      () =>
        new Mem0PlatformV3Adapter(
          config,
          new URL('https://context.example.com/prefix'),
        ),
    ).toThrow('Provider URL must not contain credentials, path');
  });

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

  it('sends one exact direct-import write with fixed provider binding', async () => {
    const content = '  Keep 🙂 this\nexactly.  ';
    let requestCount = 0;
    let requestBody: unknown;
    let requestPath: string | undefined;
    let authorization: string | undefined;
    const baseUrl = await startServer(async (request, response) => {
      requestCount += 1;
      requestPath = request.url;
      authorization = request.headers.authorization;
      requestBody = JSON.parse(await readBody(request));
      json(response, { status: 'PENDING', event_id: eventId });
    });

    await expect(
      mem0Adapter(baseUrl).remember({
        content,
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({
      status: 'accepted',
      providerOperationId: eventId,
    });
    expect(requestCount).toBe(1);
    expect(requestPath).toBe('/v3/memories/add/');
    expect(authorization).toBe('Token project-key');
    expect(requestBody).toEqual({
      messages: [{ role: 'user', content }],
      app_id: 'fixed-repository',
      infer: false,
    });
  });

  it('does not deduplicate repeated approved content', async () => {
    let requestCount = 0;
    const baseUrl = await startServer((_request, response) => {
      requestCount += 1;
      json(response, { status: 'PENDING', event_id: eventId });
    });
    const adapter = mem0Adapter(baseUrl);
    const remember = () =>
      adapter.remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      });

    await expect(remember()).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(remember()).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(requestCount).toBe(2);
  });

  it.each([
    [{ status: 'SUCCEEDED' }, { status: 'stored' }],
    [
      { status: 'SUCCEEDED', event_id: eventId },
      { status: 'stored', providerOperationId: eventId },
    ],
    [{ status: 'PENDING' }, { status: 'unknown' }],
    [{ status: 'PENDING', event_id: ' ' }, { status: 'unknown' }],
    [{ status: 'SUCCEEDED', event_id: '\u0000' }, { status: 'unknown' }],
    [{ status: 'UNKNOWN', event_id: eventId }, { status: 'unknown' }],
    [{}, { status: 'unknown' }],
    [[], { status: 'unknown' }],
  ])('maps Mem0 write response %#', async (responseBody, expected) => {
    const baseUrl = await startServer((_request, response) => {
      json(response, responseBody);
    });

    await expect(
      mem0Adapter(baseUrl).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual(expected);
  });

  it('maps an explicit Mem0 failure to a stable failed result', async () => {
    const baseUrl = await startServer((_request, response) => {
      json(response, {
        status: 'FAILED',
        message: 'provider details must stay private',
      });
    });

    await expect(
      mem0Adapter(baseUrl).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({ status: 'failed' });
  });

  it.each([400, 401, 403, 404])(
    'returns failed for definitive HTTP %s rejections',
    async (status) => {
      let requestCount = 0;
      const baseUrl = await startServer((_request, response) => {
        requestCount += 1;
        response.writeHead(status);
        response.end('private upstream detail');
      });

      await expect(
        mem0Adapter(baseUrl).remember({
          content: 'repository policy',
          signal: AbortSignal.timeout(1000),
        }),
      ).resolves.toEqual({ status: 'failed' });
      expect(requestCount).toBe(1);
    },
  );

  it.each([302, 408, 429, 500])(
    'returns unknown for HTTP %s without retrying',
    async (status) => {
      let requestCount = 0;
      const baseUrl = await startServer((_request, response) => {
        requestCount += 1;
        response.writeHead(status, {
          location: 'https://other.example.com',
        });
        response.end('private upstream detail');
      });

      await expect(
        mem0Adapter(baseUrl).remember({
          content: 'repository policy',
          signal: AbortSignal.timeout(1000),
        }),
      ).resolves.toEqual({ status: 'unknown' });
      expect(requestCount).toBe(1);
    },
  );

  it('returns unknown for malformed, oversized, interrupted, and timed-out responses', async () => {
    const handlers: Array<Parameters<typeof startServer>[0]> = [
      (_request, response) => response.end('{'),
      (_request, response) => {
        response.setHeader('content-length', String(1024 * 1024 + 1));
        response.end('{}');
      },
      (_request, response) => response.destroy(),
      async (_request, response) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        json(response, { status: 'SUCCEEDED' });
      },
    ];

    for (const [index, handler] of handlers.entries()) {
      const baseUrl = await startServer(handler);
      await expect(
        mem0Adapter(baseUrl).remember({
          content: 'repository policy',
          signal: AbortSignal.timeout(
            index === handlers.length - 1 ? 10 : 1000,
          ),
        }),
      ).resolves.toEqual({ status: 'unknown' });
    }
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

describe('Mem0CompatibleAdapter', () => {
  it('creates a writer for a versioned Mem0 preset', () => {
    expect(
      createMemoryWriter(
        mem0CompatibleConfig(
          'https://mem0.example.com',
          'polardb-mysql-2026-08',
          { userId: 'fixed-user' },
        ),
      ),
    ).toBeInstanceOf(Mem0CompatibleAdapter);
  });

  it('validates endpoint authority, basePath, and preset scope', () => {
    const config = mem0CompatibleConfig(
      'http://192.0.2.1:8080',
      'polardb-mysql-2026-08',
      { userId: 'fixed-user' },
    );
    expect(() => new Mem0CompatibleAdapter(config)).toThrow(
      'Provider URL must use HTTPS or loopback HTTP; set "allowInsecureHttp": true',
    );
    expect(
      () =>
        new Mem0CompatibleAdapter({
          ...config,
          endpoint: { ...config.endpoint, allowInsecureHttp: true },
        }),
    ).not.toThrow();
    expect(
      () =>
        new Mem0CompatibleAdapter({
          ...config,
          endpoint: {
            origin: 'https://mem0.example.com',
            basePath: '/../other',
          },
        }),
    ).toThrow(
      'External context Mem0 endpoint basePath is invalid: it must not contain a "." or ".." segment.',
    );
    expect(
      () =>
        new Mem0CompatibleAdapter({
          ...config,
          endpoint: {
            origin: 'https://mem0.example.com',
            basePath: '/memory service',
          },
        }),
    ).toThrow(
      'External context Mem0 endpoint basePath is invalid: it must not contain whitespace.',
    );
    expect(
      () =>
        new Mem0CompatibleAdapter({
          ...config,
          endpoint: {
            origin: 'https://key@mem0.example.com',
            basePath: '',
          },
        }),
    ).toThrow('Provider URL must not contain credentials');
    expect(
      () =>
        new Mem0CompatibleAdapter({
          ...config,
          scope: { appId: 'unused' },
        }),
    ).toThrow('preset "polardb-mysql-2026-08" requires "userId"');
  });

  // Every rejection rule, one violation each. The suite previously exercised
  // two of the nine, so deleting any of the other seven - including the "%"
  // rule, without which "/%2e%2e/secret" survives the "." segment check and is
  // forwarded percent-encoded for a decoding reverse proxy to traverse - left
  // the whole suite green.
  it.each([
    { basePath: 'proxy', reason: 'it must start with "/"' },
    {
      basePath: '/proxy//inner',
      reason: 'it must not contain an empty segment ("//")',
    },
    { basePath: '/proxy?a=1', reason: 'it must not contain a query ("?")' },
    { basePath: '/proxy#a', reason: 'it must not contain a fragment ("#")' },
    { basePath: '/proxy\\inner', reason: 'it must not contain a backslash' },
    {
      basePath: '/%2e%2e/secret',
      reason: 'it must not contain percent-encoded material ("%")',
    },
    { basePath: '/proxy inner', reason: 'it must not contain whitespace' },
    {
      basePath: '/proxy\u0007inner',
      reason: 'it must not contain control characters',
    },
    {
      basePath: '/proxy/../secret',
      reason: 'it must not contain a "." or ".." segment',
    },
  ])('rejects the basePath $basePath', ({ basePath, reason }) => {
    expect(
      () =>
        new Mem0CompatibleAdapter(
          mem0CompatibleConfig(
            'https://mem0.example.com',
            'polardb-mysql-2026-08',
            { userId: 'fixed-user' },
            basePath,
          ),
        ),
    ).toThrow(`External context Mem0 endpoint basePath is invalid: ${reason}.`);
  });

  it('joins a trailing-slash basePath without doubling the separator', async () => {
    let requestPath: string | undefined;
    const origin = await startServer((request, response) => {
      requestPath = request.url;
      json(response, { results: [] });
    });

    await new Mem0CompatibleAdapter(
      mem0CompatibleConfig(
        origin,
        'polardb-mysql-2026-08',
        { userId: 'fixed-user' },
        '/proxy/',
      ),
    ).search({
      query: 'deployment',
      limit: 5,
      signal: AbortSignal.timeout(1000),
    });

    expect(requestPath).toBe('/proxy/v2/memories/search');
  });

  // The search contract tests pin basePath joining; the write contract tests
  // did not, so a direct-import URL built without the reverse-proxy prefix
  // stayed green while `context_remember` posted outside the prefix that
  // search was correctly using.
  it('applies basePath to the direct-import request too', async () => {
    let requestPath: string | undefined;
    const origin = await startServer(async (request, response) => {
      requestPath = request.url;
      await readBody(request);
      json(response, { results: [{ id: 'memory-1', event: 'ADD' }] });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(
          origin,
          'polardb-mysql-2026-08',
          { userId: 'fixed-user' },
          '/proxy',
        ),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toMatchObject({ status: 'stored' });
    expect(requestPath).toBe('/proxy/v1/memories');
  });

  it.each([
    {
      preset: 'mem0-platform-v3' as const,
      scope: { appId: 'fixed-app' },
      path: '/proxy/v3/memories/search/',
      authorization: 'Token project-key',
      apiKey: undefined,
      responseItem: { id: 'memory-1', memory: 'platform memory' },
      expectedBody: {
        query: 'deployment',
        top_k: 5,
        threshold: 0.1,
        rerank: false,
        filters: { app_id: 'fixed-app' },
      },
      expectedContent: 'platform memory',
    },
    {
      preset: 'mem0-server-rest-2026-08' as const,
      scope: { userId: 'fixed-user', agentId: 'fixed-agent' },
      path: '/proxy/search',
      authorization: undefined,
      apiKey: 'project-key',
      responseItem: { id: 'memory-1', content: 'server memory' },
      expectedBody: {
        query: 'deployment',
        top_k: 5,
        // Sent in both positions on purpose: builds that read session identity
        // from the request root and builds that read it from `filters` resolve
        // this one request to the same scope, so neither silently searches an
        // unscoped corpus. See Mem0ScopePlacement.
        user_id: 'fixed-user',
        agent_id: 'fixed-agent',
        filters: { user_id: 'fixed-user', agent_id: 'fixed-agent' },
      },
      expectedContent: 'server memory',
    },
    {
      preset: 'polardb-mysql-2026-08' as const,
      scope: { userId: 'fixed-user', agentId: 'fixed-agent' },
      path: '/proxy/v2/memories/search',
      authorization: 'Token project-key',
      apiKey: undefined,
      responseItem: { id: 'memory-1', memory: 'polardb memory' },
      expectedBody: {
        query: 'deployment',
        top_k: 5,
        agent_id: 'fixed-agent',
        filters: { user_id: 'fixed-user' },
      },
      expectedContent: 'polardb memory',
    },
  ])(
    'maps the $preset search contract',
    async ({
      preset,
      scope,
      path,
      authorization,
      apiKey,
      responseItem,
      expectedBody,
      expectedContent,
    }) => {
      let requestBody: unknown;
      let requestPath: string | undefined;
      let requestAuthorization: string | undefined;
      let requestApiKey: string | string[] | undefined;
      const origin = await startServer(async (request, response) => {
        requestPath = request.url;
        requestBody = JSON.parse(await readBody(request));
        requestAuthorization = request.headers.authorization;
        requestApiKey = request.headers['x-api-key'];
        json(response, { results: [responseItem, {}, responseItem] });
      });

      const items = await new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, preset, scope, '/proxy'),
      ).search({
        query: 'deployment',
        limit: 99,
        signal: AbortSignal.timeout(1000),
      });

      expect(requestPath).toBe(path);
      expect(requestAuthorization).toBe(authorization);
      expect(requestApiKey).toBe(apiKey);
      expect(requestBody).toEqual(expectedBody);
      expect(items).toEqual([
        { id: 'memory-1', content: expectedContent },
        { id: 'memory-1', content: expectedContent },
      ]);
    },
  );

  it.each([
    {
      preset: 'mem0-server-rest-2026-08' as const,
      path: '/memories',
      scope: { userId: 'fixed-user', agentId: 'fixed-agent' },
      authorization: undefined,
      apiKey: 'project-key',
    },
    {
      preset: 'polardb-mysql-2026-08' as const,
      path: '/v1/memories',
      scope: { userId: 'fixed-user', agentId: 'fixed-agent' },
      authorization: 'Token project-key',
      apiKey: undefined,
    },
  ])(
    'maps the $preset direct-import contract conservatively',
    async ({ preset, path, scope, authorization, apiKey }) => {
      const content = '  Keep 🙂 this\nexactly.  ';
      let requestCount = 0;
      let requestBody: unknown;
      let requestPath: string | undefined;
      let requestAuthorization: string | undefined;
      let requestApiKey: string | string[] | undefined;
      const origin = await startServer(async (request, response) => {
        requestCount += 1;
        requestPath = request.url;
        requestBody = JSON.parse(await readBody(request));
        requestAuthorization = request.headers.authorization;
        requestApiKey = request.headers['x-api-key'];
        json(response, { results: [{ id: 'memory-1', event: 'ADD' }] });
      });

      await expect(
        new Mem0CompatibleAdapter(
          mem0CompatibleConfig(origin, preset, scope),
        ).remember({ content, signal: AbortSignal.timeout(1000) }),
      ).resolves.toEqual({
        status: 'stored',
        providerOperationId: 'memory-1',
      });
      expect(requestCount).toBe(1);
      expect(requestPath).toBe(path);
      expect(requestAuthorization).toBe(authorization);
      expect(requestApiKey).toBe(apiKey);
      expect(requestBody).toEqual({
        messages: [{ role: 'user', content }],
        user_id: 'fixed-user',
        agent_id: 'fixed-agent',
        infer: false,
      });
    },
  );

  it('keeps Platform V3 event responses asynchronous', async () => {
    const origin = await startServer((_request, response) => {
      json(response, { status: 'PENDING', event_id: 'event-1' });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'mem0-platform-v3', {
          appId: 'fixed-app',
        }),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({
      status: 'accepted',
      providerOperationId: 'event-1',
    });
  });

  it('does not treat a direct-import event_id as proof of storage', async () => {
    const origin = await startServer((_request, response) => {
      json(response, { results: [{ event_id: 'event-1' }] });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'polardb-mysql-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('does not retry an ambiguous direct-import failure', async () => {
    let requestCount = 0;
    const origin = await startServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500);
      response.end('private upstream detail');
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'mem0-server-rest-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({ status: 'unknown' });
    expect(requestCount).toBe(1);
  });

  // `infer: false` is what makes the stored text the exact text the user
  // approved in the confirmation Hook, but a deployment whose request model
  // predates the field drops it silently, extracts facts with an LLM, and
  // still returns a valid identifier. The endpoint and its version are
  // operator-supplied, so the echoed memory is the only evidence available.
  it('does not claim storage when the provider rewrote the content', async () => {
    const content = 'Deploy with --no-verify only after a green CI run.';
    const origin = await startServer(async (request, response) => {
      await readBody(request);
      json(response, {
        results: [
          { id: 'memory-1', memory: 'Use --no-verify after CI.', event: 'ADD' },
        ],
      });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'mem0-server-rest-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({ content, signal: AbortSignal.timeout(1000) }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('claims storage when the provider echoes the content unchanged', async () => {
    const content = 'Deploy with --no-verify only after a green CI run.';
    const origin = await startServer(async (request, response) => {
      await readBody(request);
      json(response, {
        results: [{ id: 'memory-1', memory: content, event: 'ADD' }],
      });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'mem0-server-rest-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({ content, signal: AbortSignal.timeout(1000) }),
    ).resolves.toEqual({ status: 'stored', providerOperationId: 'memory-1' });
  });

  // Fact extraction retires contradicting memories. A DELETE carries a valid
  // identifier, so without this the tool reports a deletion as storage.
  it('does not report a delete event as storage', async () => {
    const content = 'repository policy';
    const origin = await startServer(async (request, response) => {
      await readBody(request);
      json(response, {
        results: [{ id: 'memory-1', memory: content, event: 'DELETE' }],
      });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'polardb-mysql-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({ content, signal: AbortSignal.timeout(1000) }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it.each([
    { label: 'an alternate root object', body: { data: [{ id: 'memory-1' }] } },
    { label: 'a root array', body: [{ id: 'memory-1' }] },
    { label: 'a non-array results field', body: { results: { id: 'm' } } },
  ])('treats $label as unknown rather than throwing', async ({ body }) => {
    const origin = await startServer(async (request, response) => {
      await readBody(request);
      json(response, body);
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'polardb-mysql-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  // The bound is what keeps a provider-controlled string out of the operation
  // id that mcp.ts serializes verbatim into the tool result.
  it.each([
    { label: 'at the 256 code point bound', length: 256, stored: true },
    { label: 'past the 256 code point bound', length: 257, stored: false },
  ])('handles an identifier $label', async ({ length, stored }) => {
    const id = 'a'.repeat(length);
    const origin = await startServer(async (request, response) => {
      await readBody(request);
      json(response, { results: [{ id, event: 'ADD' }] });
    });

    await expect(
      new Mem0CompatibleAdapter(
        mem0CompatibleConfig(origin, 'polardb-mysql-2026-08', {
          userId: 'fixed-user',
        }),
      ).remember({
        content: 'repository policy',
        signal: AbortSignal.timeout(1000),
      }),
    ).resolves.toEqual(
      stored
        ? { status: 'stored', providerOperationId: id }
        : { status: 'unknown' },
    );
  });

  // The async preset's write request was only pinned through its PENDING
  // response, so dropping the preset's `app_id` write rule stayed green while
  // the write silently landed outside the administrator-bound app scope.
  it('sends the Platform V3 preset direct-import contract', async () => {
    const content = 'repository policy';
    let requestPath: string | undefined;
    let requestBody: unknown;
    let requestAuthorization: string | undefined;
    const origin = await startServer(async (request, response) => {
      requestPath = request.url;
      requestBody = JSON.parse(await readBody(request));
      requestAuthorization = request.headers.authorization;
      json(response, { status: 'PENDING', event_id: 'event-1' });
    });

    await new Mem0CompatibleAdapter(
      mem0CompatibleConfig(origin, 'mem0-platform-v3', { appId: 'fixed-app' }),
    ).remember({ content, signal: AbortSignal.timeout(1000) });

    expect(requestPath).toBe('/v3/memories/add/');
    expect(requestAuthorization).toBe('Token project-key');
    expect(requestBody).toEqual({
      messages: [{ role: 'user', content }],
      app_id: 'fixed-app',
      infer: false,
    });
  });
});

function mem0CompatibleConfig(
  origin: string,
  preset: Mem0PresetId,
  scope: Mem0CompatibleProviderConfig['scope'],
  basePath = '',
): Mem0CompatibleProviderConfig {
  return {
    type: 'mem0',
    preset,
    endpoint: { origin, basePath },
    credentialEnv: 'MEM0_API_KEY',
    credential: 'project-key',
    scope,
  };
}

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
