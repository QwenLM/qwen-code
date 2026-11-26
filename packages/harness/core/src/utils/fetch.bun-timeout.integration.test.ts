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
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const fetchModule = path.join(packageRoot, 'src/utils/fetch.ts');

// Bun's native idle limit is not observable through a mocked fetch, so this
// runs the real module under Bun against a server that stays silent past it.
describe.skipIf(!BUN_AVAILABLE)('Bun native idle timeout', () => {
  it('honors declared deadlines beyond the native idle limit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qoder-bun-timeout-'));
    try {
      const script = path.join(dir, 'timeout.ts');
      await writeFile(
        script,
        `
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { proxiedFetch, withFetchTimeouts } from ${JSON.stringify(fetchModule)};

const REPLY = 'data: done\\n\\n';
const server = http.createServer((req, res) => {
  if (req.url === '/body') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }
  const timer = setTimeout(() => res.end(REPLY), 12000);
  res.on('close', () => clearTimeout(timer));
});
server.timeout = 0;
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port;
const controller = new AbortController();
const outerTimer = setTimeout(() => controller.abort(), 20000);
const managed = (route, timeouts) =>
  proxiedFetch(url + route, withFetchTimeouts({ signal: controller.signal }, timeouts))
    .then((response) => response.text());
try {
  const results = await Promise.allSettled([
    fetch(url + '/headers', { signal: controller.signal }).then((r) => r.text()),
    managed('/headers', { requestTimeoutMs: 20000, bodyIdleTimeoutMs: 20000 }),
    managed('/body', { requestTimeoutMs: 20000, bodyIdleTimeoutMs: 20000 }),
    // The shapes a streaming model request sends: body idle disabled, with the
    // response-header deadline either absent or following the first-payload budget.
    managed('/body', { connectTimeoutMs: 3000, bodyIdleTimeoutMs: 0 }),
    managed('/headers', { connectTimeoutMs: 3000, requestTimeoutMs: 20000, bodyIdleTimeoutMs: 0 }),
  ]);
  assert.equal(controller.signal.aborted, false);
  assert.equal(results[0].status, 'rejected', 'control must exercise native idle expiry');
  assert.equal(results[0].reason.name, 'TimeoutError');
  assert.deepEqual(
    results.slice(1),
    Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: REPLY })),
  );
  console.log('managed-timeouts-ok');
} finally {
  clearTimeout(outerTimer);
  server.closeAllConnections();
  server.close();
}
`,
      );
      const { stdout } = await execFileAsync('bun', ['run', script], {
        cwd: packageRoot,
        timeout: 25_000,
        env: {
          ...process.env,
          // Scales the five-minute native limit down; its coarse timer fires
          // within about eight seconds, which the control request proves.
          BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1',
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
      expect(stdout).toContain('managed-timeouts-ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
