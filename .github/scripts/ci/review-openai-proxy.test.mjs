import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const proxy = fileURLToPath(
  new URL('./review-openai-proxy.cjs', import.meta.url),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('moves the model key behind the bearer and path boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-openai-proxy-'));
  let child;
  let upstream;
  let listening = false;
  try {
    const requests = [];
    upstream = createServer((req, res) => {
      if (!req.headers['x-stall']) {
        requests.push({
          url: req.url,
          authorization: req.headers.authorization,
        });
      }
      if (req.headers['x-stall']) {
        res.writeHead(200);
        res.flushHeaders();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const portFile = join(dir, 'port');
    const keyFile = join(dir, 'key');
    writeFileSync(keyFile, 'file-upstream-key');
    child = spawn(process.execPath, [proxy], {
      env: {
        ...process.env,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
        https_proxy: '',
        http_proxy: '',
        PATH: process.env.PATH,
        PROXY_TOKEN: 'short-run-token',
        UPSTREAM_API_KEY_FILE: keyFile,
        UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
        OPENAI_PROXY_PORT: '0',
        OPENAI_PROXY_PORT_FILE: portFile,
        OPENAI_PROXY_TIMEOUT_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (data) => console.error(String(data)));
    child.on('exit', () => {
      listening = true;
    });
    for (
      let attempt = 0;
      attempt < 100 &&
      !listening &&
      !statSync(portFile, { throwIfNoEntry: false });
      attempt++
    ) {
      await sleep(20);
    }
    const port = Number(readFileSync(portFile, 'utf8'));
    assert.ok(port > 0);
    assert.equal(statSync(portFile).mode & 0o077, 0);
    const request = (path, token, body = false) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}` },
        body: body ? '{}' : undefined,
      });
    assert.equal(
      (await request('/v1/chat/completions', 'wrong', true)).status,
      401,
    );
    assert.equal(
      (await request('/v1/other', 'short-run-token', true)).status,
      403,
    );
    assert.equal((await request('/__health', '')).status, 200);
    assert.equal(
      (await request('/v1/chat/completions', 'short-run-token', true)).status,
      200,
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer short-run-token', 'x-stall': 'true' },
        body: '{}',
      }),
    );
    assert.deepEqual(requests, [
      {
        url: '/v1/chat/completions',
        authorization: 'Bearer file-upstream-key',
      },
    ]);
  } finally {
    child?.kill();
    upstream?.close();
    if (child && child.exitCode === null) await once(child, 'exit');
    rmSync(dir, { recursive: true, force: true });
  }
});
