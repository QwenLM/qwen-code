/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const BUN_AVAILABLE =
  spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

// Exercise the actual fetch module with Bun's native response streams. A mock
// body that ignores AbortSignal cannot reproduce the abort-before-cancel race.
describe.skipIf(!BUN_AVAILABLE)('Bun response body cancellation', () => {
  it.each([200, 202])(
    'cancels HTTP %i bodies and completes MCP tool discovery',
    async (status) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'test-bun-cancel-'));
      const script = path.join(dir, 'cancel.ts');
      try {
        await writeFile(script, buildScript(status));
        const { stdout, stderr } = await execFileAsync('bun', ['run', script], {
          cwd: repoRoot,
          timeout: 20_000,
          env: {
            ...process.env,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            NO_PROXY: '',
            http_proxy: '',
            https_proxy: '',
            all_proxy: '',
            no_proxy: '',
          },
        });
        expect(stdout).toContain(`cancel-and-discovery-ok:${status}`);
        expect(stderr).toBe('');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

function buildScript(status: number): string {
  return `
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { proxiedFetch, withFetchTimeouts } from ${JSON.stringify(path.join(repoRoot, 'packages/core/src/utils/fetch.ts'))};
import { Client } from ${JSON.stringify(path.join(repoRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(path.join(repoRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'))};

const errors = [];
process.on('unhandledRejection', (error) => errors.push(error));
const methods = [];
let cancelledBodies = 0;
const timers = new Set();
function delayedEmptyBody(res) {
  res.writeHead(${status}, { 'content-type': 'application/json', connection: 'close' });
  res.flushHeaders();
  // Keep the body open past cancellation; close it eventually if the client leaks.
  const timer = setTimeout(() => res.end(), 10_000);
  timers.add(timer);
  res.on('close', () => {
    if (!res.writableEnded) cancelledBodies++;
    clearTimeout(timer);
    timers.delete(timer);
  });
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/cancel') return delayedEmptyBody(res);
  if (req.url === '/complete') {
    res.writeHead(${status}, { 'content-length': '0' });
    return res.end();
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString());
  methods.push(message.method);
  if (message.method === 'notifications/initialized') return delayedEmptyBody(res);
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cancel-regression', version: '1.0' } }
    : { tools: [{ name: 'example', description: 'Regression tool', inputSchema: { type: 'object' } }] };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const timeouts = { requestTimeoutMs: 5000, bodyIdleTimeoutMs: 5000 };
const client = new Client({ name: 'cancel-regression', version: '1.0' });
async function waitForCancelledBodies(count) {
  for (let i = 0; i < 100 && cancelledBodies < count; i++) await delay(10);
  assert.equal(cancelledBodies, count, 'cancellation must close the underlying HTTP request');
}
try {
  const response = await proxiedFetch(baseUrl + '/cancel', withFetchTimeouts({}, timeouts));
  assert.equal(response.status, ${status});
  assert.ok(response.body);
  await response.body.cancel();
  await waitForCancelledBodies(1);

  const complete = await proxiedFetch(baseUrl + '/complete', withFetchTimeouts({}, timeouts));
  const reader = complete.body.getReader();
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  await complete.body.cancel();

  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), {
    fetch: (input, init) => proxiedFetch(input, withFetchTimeouts(init ?? {}, timeouts)),
  });
  await client.connect(transport);
  const result = await client.listTools();
  assert.deepEqual(result.tools.map(tool => tool.name), ['example']);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list']);
  await waitForCancelledBodies(2);
  await delay(20);
  assert.deepEqual(errors, [], 'no unhandled rejection from response cleanup');
  console.log('cancel-and-discovery-ok:${status}');
} finally {
  await client.close();
  for (const timer of timers) clearTimeout(timer);
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
`;
}
