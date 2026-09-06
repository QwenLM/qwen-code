/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeQuery,
  outputSchema,
  renderResult,
} from '../examples/provider-extension-local/src/profile.js';
import { searchProvider } from '../examples/provider-extension-local/src/provider.js';
import { installEnvironmentProxy } from '../examples/provider-extension-local/src/proxy.js';

const execFileAsync = promisify(execFile);
const packageRoot = new URL('..', import.meta.url);
const exampleRoot = new URL(
  '../examples/provider-extension-local/',
  import.meta.url,
);
const npmCli = process.env['npm_execpath'] ?? '';
let exampleBuild: Promise<void> | undefined;

function buildExample(): Promise<void> {
  exampleBuild ??= execFileAsync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: exampleRoot,
  }).then(() => undefined);
  return exampleBuild;
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local provider extension example', () => {
  it('normalizes and bounds provider-independent queries', () => {
    expect(normalizeQuery('  deployment\npolicy  ')).toBe('deployment policy');
    expect(() => normalizeQuery('   ')).toThrow(
      'Search query must not be empty.',
    );
    expect(() => normalizeQuery('x'.repeat(2001))).toThrow(
      'Search query is too long.',
    );
    expect(normalizeQuery('x'.repeat(2000)).length).toBe(2000);
    expect(Array.from(normalizeQuery('🙂'.repeat(2000)))).toHaveLength(2000);
  });

  it('renders bounded contract-valid output with matching representations', () => {
    const result = renderResult([
      { id: '', content: 'missing id' },
      { id: 'missing-content', content: '' },
      {
        id: '<valid>',
        content: '<untrusted>'.repeat(500),
        score: Number.POSITIVE_INFINITY,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `item-${index}`,
        content: 'x'.repeat(1500),
      })),
    ]);

    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(result.text).not.toContain('<');
    expect(result.text).not.toContain('>');
    expect(JSON.parse(result.text)).toEqual(result.structuredContent);
    expect(outputSchema.safeParse(result.structuredContent).success).toBe(true);
    const envelope = result.structuredContent['untrusted_external_context'] as {
      items: Array<{ id: string; score?: number }>;
    };
    expect(envelope.items[0]).toEqual(
      expect.objectContaining({ id: '<valid>' }),
    );
    expect(envelope.items[0]).not.toHaveProperty('score');

    const capped = renderResult(
      Array.from({ length: 8 }, (_, index) => ({
        id: `item-${index}`,
        content: 'content',
      })),
    );
    const cappedEnvelope = capped.structuredContent[
      'untrusted_external_context'
    ] as { items: unknown[] };
    expect(cappedEnvelope.items).toHaveLength(5);

    const budgeted = renderResult(
      Array.from({ length: 5 }, (_, index) => ({
        id: `budget-${index}`,
        content: 'x'.repeat(1000),
      })),
    );
    const budgetedEnvelope = budgeted.structuredContent[
      'untrusted_external_context'
    ] as { items: Array<{ content: string }> };
    expect(budgetedEnvelope.items.length).toBeLessThan(5);
    expect(
      budgetedEnvelope.items.every((item) => item.content.length > 0),
    ).toBe(true);

    const metadataBudgeted = renderResult(
      Array.from({ length: 5 }, (_, index) => ({
        id: `metadata-${index}`,
        content: 'x'.repeat(500),
        title: 't'.repeat(150),
        uri: `https://example.com/${'u'.repeat(40)}`,
        score: 0.9,
        updatedAt: '2026-08-13T00:00:00Z',
      })),
    );
    const metadataItems = metadataBudgeted.structuredContent[
      'untrusted_external_context'
    ] as {
      items: Array<{
        content: string;
        title?: string;
        uri?: string;
        score?: number;
        updatedAt?: string;
      }>;
    };
    const lastMetadataItem = metadataItems.items.at(-1);
    expect(lastMetadataItem?.content).toHaveLength(500);
    expect(lastMetadataItem).not.toHaveProperty('score');
    expect(lastMetadataItem).not.toHaveProperty('updatedAt');
    expect(lastMetadataItem).not.toHaveProperty('title');
    expect(lastMetadataItem).toHaveProperty('uri');
  });

  it.each([
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://[::1]:3000',
  ])('uses one guarded request through loopback origin %s', async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'one',
              content: 'context',
              title: 'Policy',
              uri: 'https://context.example.com/policies/1',
              score: 0.9,
              updated_at: '2026-08-13T00:00:00Z',
            },
            {
              id: 'camel',
              content: 'context',
              updatedAt: '2026-08-14T00:00:00Z',
            },
            {
              id: 'wrong-metadata',
              content: 'context',
              title: 42,
              uri: false,
            },
            { id: 'blank', content: '' },
            { id: 'non-finite', content: 'context', score: 'Infinity' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', baseUrl);
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    const signal = AbortSignal.timeout(1000);
    await expect(searchProvider({ query: 'policy', signal })).resolves.toEqual([
      {
        id: 'one',
        content: 'context',
        title: 'Policy',
        uri: 'https://context.example.com/policies/1',
        score: 0.9,
        updatedAt: '2026-08-13T00:00:00Z',
      },
      {
        id: 'camel',
        content: 'context',
        updatedAt: '2026-08-14T00:00:00Z',
      },
      { id: 'wrong-metadata', content: 'context' },
      { id: 'non-finite', content: 'context' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/v1/context/search', baseUrl),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'policy', limit: 5 }),
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
        }),
        redirect: 'manual',
        signal,
      }),
    );
  });

  it('uses forward-proxy semantics for HTTP providers', async () => {
    const forwardedRequests: string[] = [];
    const tunnelRequests: string[] = [];
    const proxyServer = createServer((request, response) => {
      forwardedRequests.push(`${request.method} ${request.url}`);
      request.resume();
      request.once('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ items: [] }));
      });
    });
    proxyServer.on('connect', (request, socket) => {
      tunnelRequests.push(request.url ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });
    const address = proxyServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Proxy test server did not bind a TCP port.');
    }
    const providerUrl = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', providerUrl);
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');
    vi.stubEnv('http_proxy', providerUrl);
    vi.stubEnv('HTTP_PROXY', providerUrl);
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');

    const previousDispatcher = getGlobalDispatcher();
    let dispatcher: ReturnType<typeof installEnvironmentProxy> | undefined;
    try {
      dispatcher = installEnvironmentProxy();
      await expect(
        searchProvider({
          query: 'policy',
          signal: AbortSignal.timeout(1000),
        }),
      ).resolves.toEqual([]);
      expect(forwardedRequests).toEqual([
        `POST ${providerUrl}/v1/context/search`,
      ]);
      expect(tunnelRequests).toEqual([]);
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await dispatcher?.destroy();
      proxyServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        proxyServer.close(() => resolve());
      });
    }
  });

  it.each([
    ['http://attacker.example', 'secret'],
    ['https://user:password@provider.example', 'secret'],
    ['https://provider.example/subpath', 'secret'],
    ['https://provider.example', '${PROVIDER_CONTEXT_TOKEN}'],
  ])(
    'rejects unsafe or unresolved provider configuration: %s',
    async (baseUrl, token) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', baseUrl);
      vi.stubEnv('PROVIDER_CONTEXT_TOKEN', token);

      await expect(
        searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects streamed provider responses over 1 MiB', async () => {
    const chunk = new Uint8Array(512 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', 'https://provider.example');
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    await expect(
      searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow('Provider response is invalid.');
  });

  it('accepts streamed provider responses at exactly 1 MiB', async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ items: [] }).padEnd(1024 * 1024, ' '),
    );
    const midpoint = body.byteLength / 2;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.slice(0, midpoint));
              controller.enqueue(body.slice(midpoint));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', 'https://provider.example');
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    await expect(
      searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
    ).resolves.toEqual([]);
  });

  it('rejects redirects without exposing provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/collect' },
        }),
      ),
    );
    vi.stubEnv('PROVIDER_CONTEXT_BASE_URL', 'https://provider.example');
    vi.stubEnv('PROVIDER_CONTEXT_TOKEN', 'secret');

    await expect(
      searchProvider({ query: 'policy', signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow('Provider request failed.');
  });

  it.skipIf(!npmCli)(
    'serves the exact profile tool with stable failure and cancellation semantics',
    async () => {
      await buildExample();
      let cancellationRequestSeen!: () => void;
      const cancellationRequest = new Promise<void>((resolve) => {
        cancellationRequestSeen = resolve;
      });
      let cancellationDisconnected = false;
      const providerServer = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const parsed = JSON.parse(body) as { query?: unknown };
          if (parsed.query === 'provider failure') {
            response.writeHead(500, { 'content-type': 'text/plain' });
            response.end('secret upstream response body');
            return;
          }
          if (parsed.query === 'cancel provider request') {
            response.once('close', () => {
              cancellationDisconnected = true;
            });
            cancellationRequestSeen();
            return;
          }
          if (parsed.query === 'provider timeout') return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ items: [] }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        providerServer.once('error', reject);
        providerServer.listen(0, '127.0.0.1', resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Provider test server did not bind a TCP port.');
      }

      const client = new Client({
        name: 'provider-context-local-example-test',
        version: '1.0.0',
      });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  '../examples/provider-extension-local/dist/main.js',
                  import.meta.url,
                ),
              ),
            ],
            cwd: fileURLToPath(exampleRoot),
            env: stringEnvironment({
              ...process.env,
              HTTP_PROXY: '',
              HTTPS_PROXY: '',
              ALL_PROXY: '',
              NO_PROXY: '127.0.0.1,localhost',
              http_proxy: '',
              https_proxy: '',
              all_proxy: '',
              no_proxy: '127.0.0.1,localhost',
              PROVIDER_CONTEXT_BASE_URL: `http://127.0.0.1:${address.port}`,
              PROVIDER_CONTEXT_TOKEN: 'secret',
            }),
            stderr: 'pipe',
          }),
        );

        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual([
          'context_search',
        ]);

        const failed = await client.callTool({
          name: 'context_search',
          arguments: { query: 'provider failure' },
        });
        expect(failed).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'External context search failed.' }],
        });
        expect(JSON.stringify(failed)).not.toMatch(
          /provider failure|secret upstream|127\.0\.0\.1/,
        );

        const controller = new AbortController();
        const cancelled = client.callTool(
          {
            name: 'context_search',
            arguments: { query: 'cancel provider request' },
          },
          undefined,
          { signal: controller.signal },
        );
        await cancellationRequest;
        controller.abort();
        await expect(cancelled).rejects.toThrow();
        await vi.waitFor(() => expect(cancellationDisconnected).toBe(true), {
          timeout: 2000,
        });

        const timeoutStarted = Date.now();
        const timedOut = await client.callTool(
          {
            name: 'context_search',
            arguments: { query: 'provider timeout' },
          },
          undefined,
          { timeout: 10_000 },
        );
        const timeoutElapsed = Date.now() - timeoutStarted;
        expect(timedOut).toMatchObject({
          isError: true,
          content: [{ type: 'text', text: 'External context search failed.' }],
        });
        expect(timeoutElapsed).toBeGreaterThanOrEqual(4500);
        expect(timeoutElapsed).toBeLessThan(8000);
      } finally {
        await client.close().catch(() => undefined);
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
    },
    20_000,
  );

  it.skipIf(!npmCli)(
    'packs an executable that fails fast without provider configuration',
    async () => {
      await buildExample();
      const executable = fileURLToPath(
        new URL(
          '../examples/provider-extension-local/dist/main.js',
          import.meta.url,
        ),
      );
      for (const [baseUrl, token, httpProxy, stderr] of [
        ['', '', '', 'Provider configuration is unavailable.\n'],
        ['not-a-url', 'secret', '', 'Provider configuration is invalid.\n'],
        [
          'https://provider.example',
          'secret',
          'not a URL',
          'Provider proxy configuration is invalid.\n',
        ],
      ] as const) {
        await expect(
          execFileAsync(process.execPath, [executable], {
            cwd: exampleRoot,
            env: {
              ...process.env,
              PROVIDER_CONTEXT_BASE_URL: baseUrl,
              PROVIDER_CONTEXT_TOKEN: token,
              HTTP_PROXY: httpProxy,
              HTTPS_PROXY: '',
              ALL_PROXY: '',
              NO_PROXY: '',
            },
            timeout: 5000,
          }),
        ).rejects.toMatchObject({ stderr, code: 1, killed: false });
      }
      const { stdout } = await execFileAsync(
        process.execPath,
        [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
        { cwd: packageRoot },
      );
      const packs = JSON.parse(stdout) as Array<{
        files: Array<{ path: string }>;
      }>;

      expect(packs).toHaveLength(1);
      expect(packs[0]?.files.map((file) => file.path)).toContain(
        'examples/provider-extension-local/dist/main.js',
      );

      const manifest = JSON.parse(
        await readFile(new URL('qwen-extension.json', exampleRoot), 'utf8'),
      ) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(
        manifest.mcpServers['provider-context-local-example']?.args,
      ).toEqual(['${extensionPath}${/}dist${/}main.js']);
    },
    30_000,
  );
});
