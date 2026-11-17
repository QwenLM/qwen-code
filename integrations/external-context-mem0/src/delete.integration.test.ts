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
import fixture from '../test/fixtures/synthetic-delete-v1.json' with { type: 'json' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Mode =
  | 'normal'
  | 'drop'
  | 'slow-preflight-body'
  | 'slow-delete-body'
  | 'slow-verification-body'
  | 'cumulative-deadline';

async function start(mode: Mode = 'normal', outside = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'mem0-delete-stdio-')),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const memories = new Map([
    [
      'record-1',
      {
        id: 'record-1',
        memory: '  exact\n中文 😀 \u202e END  ',
        user_id: 'repository-memory',
      },
    ],
    ['empty', { id: 'empty', memory: '', user_id: 'repository-memory' }],
    [
      'control',
      { id: 'control', memory: 'keep me', user_id: 'repository-memory' },
    ],
    [
      'foreign',
      { id: 'foreign', memory: 'private foreign text', user_id: 'other' },
    ],
  ]);
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body: string;
  }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let deleted = false;
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    const match = req.url?.match(/^\/memories\/([^/]+)$/u);
    if (!match) {
      res.writeHead(500);
      res.end('collection trap');
      return;
    }
    const id = decodeURIComponent(match[1]!);
    const respond = () => {
      if (req.method === 'DELETE') {
        memories.delete(id);
        deleted = true;
        if (mode === 'drop') {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'slow-delete-body') {
          res.write('{"message":');
          return;
        }
        res.end(JSON.stringify({ message: 'Memory deleted successfully!' }));
        return;
      }
      if (
        (mode === 'slow-preflight-body' && !deleted) ||
        (mode === 'slow-verification-body' && deleted)
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        return;
      }
      const target = memories.get(id);
      res.writeHead(target ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(target ?? { detail: 'not found' }));
    };
    if (mode === 'cumulative-deadline') timers.push(setTimeout(respond, 100));
    else respond();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(async () => {
    timers.forEach(clearTimeout);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing provider port');
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
      timeoutMs: mode === 'cumulative-deadline' ? 250 : 200,
    }),
  );
  const client = new Client({ name: 'stdio-delete-test', version: '1' });
  cleanups.push(() => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/delete-main.js', import.meta.url))],
    cwd: outside ? tmpdir() : root,
    env: {
      QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG: configPath,
      SYNTHETIC_MEMORY_TOKEN: 'synthetic-token',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const expectedContent = memories.get('record-1')!.memory;
  return {
    client,
    transport,
    requests,
    memories,
    expectedContent,
    stderr: () => stderr,
    root,
  };
}

describe('packaged deletion MCP through real HTTP', () => {
  it('reads full text, refuses changed/foreign targets and deletes exactly one record', async () => {
    const test = await start();
    await test.client.connect(test.transport);
    expect(
      (await test.client.listTools()).tools.map((tool) => tool.name),
    ).toEqual(['context_get', 'context_forget']);
    const read = await test.client.callTool({
      name: 'context_get',
      arguments: { memoryId: 'record-1' },
    });
    expect(read.structuredContent).toMatchObject({
      status: 'found',
      untrusted_deletion_target: { content: test.expectedContent },
    });
    expect(
      (
        await test.client.callTool({
          name: 'context_forget',
          arguments: { memoryId: 'record-1', expectedContent: 'summary' },
        })
      ).structuredContent,
    ).toMatchObject({ status: 'not_deleted', reason: 'target_changed' });
    const foreign = await test.client.callTool({
      name: 'context_get',
      arguments: { memoryId: 'foreign' },
    });
    expect(foreign.structuredContent).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(foreign)).not.toContain('private foreign');
    const result = await test.client.callTool({
      name: 'context_forget',
      arguments: {
        memoryId: 'record-1',
        expectedContent: test.expectedContent,
      },
    });
    expect(result.structuredContent).toMatchObject({
      status: 'deleted',
      memoryId: 'record-1',
    });
    expect(test.requests.map((req) => req.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'GET',
      'DELETE',
      'GET',
    ]);
    expect(
      test.requests.every(
        (req) =>
          req.authorization === 'Token synthetic-token' && req.body === '',
      ),
    ).toBe(true);
    expect([...test.memories.keys()]).toEqual(['empty', 'control', 'foreign']);
    expect(test.stderr()).toBe('');
  });

  it('deletes an empty record without a preceding get and rejects dot IDs before HTTP', async () => {
    const test = await start();
    await test.client.connect(test.transport);
    for (const memoryId of ['.', '..', '%2e%2e', 'a/b']) {
      expect(
        (
          await test.client.callTool({
            name: 'context_forget',
            arguments: { memoryId, expectedContent: '' },
          })
        ).isError,
      ).toBe(true);
    }
    expect(test.requests).toHaveLength(0);
    expect(
      (
        await test.client.callTool({
          name: 'context_forget',
          arguments: { memoryId: 'empty', expectedContent: '' },
        })
      ).structuredContent,
    ).toMatchObject({ status: 'deleted' });
    expect(test.requests.map((req) => [req.method, req.url])).toEqual(
      ['GET', 'DELETE', 'GET'].map((method) => [method, '/memories/empty']),
    );
  });

  it.each([
    'drop',
    'slow-preflight-body',
    'slow-delete-body',
    'slow-verification-body',
    'cumulative-deadline',
  ] as const)(
    'bounds the entire operation without replay: %s',
    async (mode) => {
      const test = await start(mode);
      await test.client.connect(test.transport);
      const startTime = Date.now();
      const result = await test.client.callTool({
        name: 'context_forget',
        arguments: {
          memoryId: 'record-1',
          expectedContent: test.expectedContent,
        },
      });
      expect(Date.now() - startTime).toBeLessThan(1800);
      expect(result.structuredContent).toMatchObject({
        status: mode === 'slow-preflight-body' ? 'not_deleted' : 'unknown',
      });
      expect(
        test.requests.filter((req) => req.method === 'DELETE'),
      ).toHaveLength(mode === 'slow-preflight-body' ? 0 : 1);
      if (mode === 'cumulative-deadline')
        expect(test.requests.map((req) => req.method)).toEqual([
          'GET',
          'DELETE',
          'GET',
        ]);
      expect(test.stderr()).toBe('');
    },
  );

  it('fails startup outside its workspace without leaking local paths or credentials', async () => {
    const test = await start('normal', true);
    await expect(test.client.connect(test.transport)).rejects.toThrow();
    expect(test.stderr()).toContain(
      'deletion server is outside its repository',
    );
    expect(test.stderr()).not.toContain(test.root);
    expect(test.stderr()).not.toContain('synthetic-token');
    expect(test.requests).toHaveLength(0);
  });
});
