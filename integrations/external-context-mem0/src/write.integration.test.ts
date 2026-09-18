/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-internal-modules -- package-owned synthetic protocol fixture
import fixture from '../test/fixtures/synthetic-write-v1.json' with { type: 'json' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(mode: 'stored' | 'drop' | 'slow-body', outside = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mem0-write-stdio-')),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }> = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
    });
    if (mode === 'drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'slow-body') {
      res.write('{"results":');
      return;
    }
    res.end(JSON.stringify({ results: [{ id: 'record-1', event: 'ADD' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP port');
  const dialectPath = join(root, 'dialect.json');
  const configPath = join(root, 'instance.json');
  await writeFile(dialectPath, JSON.stringify(fixture.dialect));
  await writeFile(
    configPath,
    JSON.stringify({
      ...fixture.instance,
      repositoryRoot: root,
      dialectPath,
      endpoint: {
        origin: `http://127.0.0.1:${address.port}`,
        basePath: '',
        allowInsecureHttp: true,
      },
      timeoutMs: 100,
    }),
  );
  const client = new Client({ name: 'stdio-writer-test', version: '1' });
  cleanups.push(() => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/write-main.js', import.meta.url))],
    cwd: outside ? tmpdir() : root,
    env: {
      QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG: configPath,
      SYNTHETIC_MEMORY_TOKEN: 'synthetic-token',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  return { client, transport, requests, root, stderr: () => stderr };
}

describe('packaged Mem0 writer stdio to HTTP', () => {
  it('loads the workspace binding and sends exact content once', async () => {
    const fixture = await start('stored');
    await fixture.client.connect(fixture.transport);
    expect(
      (await fixture.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(['context_remember']);
    const content = '  literal\n中文 😀 "quote"\t END  ';
    const result = await fixture.client.callTool({
      name: 'context_remember',
      arguments: { content },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'stored',
      memoryId: 'record-1',
    });
    expect(fixture.requests).toEqual([
      {
        method: 'POST',
        url: '/memories',
        authorization: 'Token synthetic-token',
        body: {
          messages: [{ role: 'user', content }],
          infer: false,
          user_id: 'repository-memory',
        },
      },
    ]);
    const rejected = await fixture.client.callTool({
      name: 'context_remember',
      arguments: { content: ' ', userId: 'override' },
    });
    expect(rejected.isError).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.stderr()).toBe('');
  });

  it.each(['drop', 'slow-body'] as const)(
    'does not retry when the provider has received the write: %s',
    async (mode) => {
      const fixture = await start(mode);
      await fixture.client.connect(fixture.transport);
      const result = await fixture.client.callTool({
        name: 'context_remember',
        arguments: { content: 'may already be stored' },
      });
      expect(result.structuredContent).toMatchObject({ status: 'unknown' });
      expect(result.isError).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it('fails startup outside the configured workspace without disclosing paths', async () => {
    const fixture = await start('stored', true);
    await expect(fixture.client.connect(fixture.transport)).rejects.toThrow();
    expect(fixture.stderr()).toContain('writer is outside its repository');
    expect(fixture.stderr()).not.toContain(fixture.root);
    expect(fixture.stderr()).not.toContain('synthetic-token');
    expect(fixture.requests).toHaveLength(0);
  });
});
