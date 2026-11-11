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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const RESULT_PREFIX = 'BUN_PROXY_INTEGRATION_RESULT:';
const BASIC_PROXY_AUTH = 'Basic dXNlcjpwYXNz';
const BUN_AVAILABLE =
  spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const OPENSSL_AVAILABLE =
  spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

interface HttpsProxyCert {
  certPath: string;
  keyPath: string;
}

interface BunProxyIntegrationResult {
  bunVersion: string;
  httpProxy: {
    status: number;
    text: string;
    proxyUrl: string | undefined;
    proxyAuthorization: string | undefined;
    targetHits: number;
  };
  sseProxy: {
    status: number;
    text: string;
    contentType: string | undefined;
    proxyHits: number;
    targetHits: number;
  };
  noProxy: {
    status: number;
    text: string;
    proxyHits: number;
    targetHits: number;
  };
  requestScopedUpload: {
    proxied: {
      status: number;
      proxyHits: number;
      targetHits: number;
      targetBodyHex: string;
    };
    bypassed: {
      status: number;
      proxyHits: number;
      targetHits: number;
      targetBodyHex: string;
    };
  };
  proxyReenable: {
    firstText: string;
    directText: string;
    secondText: string;
    firstProxyHits: number;
    secondProxyHits: number;
    targetHits: number;
  };
  httpsProxy?: {
    status: number;
    text: string;
    proxyUrl: string | undefined;
    targetHits: number;
  };
}

describe.skipIf(!BUN_AVAILABLE)('proxiedFetch Bun native proxy integration', () => {
  it('routes Bun HTTP proxy traffic through native fetch proxy support', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(currentDir, '../../../..');
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'test-bun-proxy-'));
    const cert = await createHttpsProxyCert(tmpRoot);
    const scriptPath = path.join(tmpRoot, 'bun-proxy-integration.ts');

    try {
      await writeFile(
        scriptPath,
        buildBunProxyIntegrationScript({
          fetchModuleUrl: pathToFileURL(
            path.join(repoRoot, 'packages/core/src/utils/fetch.ts'),
          ).href,
          cert,
        }),
        'utf8',
      );

      const { stdout } = await runBunScript(scriptPath, repoRoot);
      const result = parseBunProxyResult(stdout);

      expect(result.bunVersion).toMatch(/\d+\.\d+\.\d+/);
      expect(result.httpProxy).toMatchObject({
        status: 200,
        text: 'via-http-proxy',
        proxyAuthorization: BASIC_PROXY_AUTH,
        targetHits: 0,
      });
      expect(result.httpProxy.proxyUrl).toContain('/path?q=1');

      expect(result.sseProxy).toMatchObject({
        status: 200,
        text: 'data: one\n\ndata: two\n\n',
        proxyHits: 1,
        targetHits: 0,
      });
      expect(result.sseProxy.contentType).toContain('text/event-stream');

      expect(result.noProxy).toEqual({
        status: 200,
        text: 'target-bypass',
        proxyHits: 0,
        targetHits: 1,
      });

      expect(result.requestScopedUpload).toEqual({
        proxied: {
          status: 200,
          proxyHits: 1,
          targetHits: 1,
          targetBodyHex: '0001027f80feff',
        },
        bypassed: {
          status: 200,
          proxyHits: 1,
          targetHits: 2,
          targetBodyHex: '0304058182fd',
        },
      });

      expect(result.proxyReenable).toEqual({
        firstText: 'via-first-proxy',
        directText: 'target-direct',
        secondText: 'via-second-proxy',
        firstProxyHits: 1,
        secondProxyHits: 1,
        targetHits: 1,
      });

      if (cert) {
        expect(result.httpsProxy).toMatchObject({
          status: 200,
          text: 'via-https-proxy',
          targetHits: 0,
        });
        expect(result.httpsProxy?.proxyUrl).toContain('/secure-proxy');
      } else {
        expect(result.httpsProxy).toBeUndefined();
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runBunScript(
  scriptPath: string,
  repoRoot: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('bun', ['run', scriptPath], {
      cwd: repoRoot,
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        NO_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        no_proxy: '',
      },
    });
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      [
        failed.message,
        failed.stdout ? `stdout:\n${failed.stdout}` : undefined,
        failed.stderr ? `stderr:\n${failed.stderr}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
      { cause: error },
    );
  }
}

async function createHttpsProxyCert(
  tmpRoot: string,
): Promise<HttpsProxyCert | undefined> {
  if (!OPENSSL_AVAILABLE) return undefined;

  const keyPath = path.join(tmpRoot, 'proxy-key.pem');
  const certPath = path.join(tmpRoot, 'proxy-cert.pem');
  try {
    await execFileAsync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-days',
        '1',
      ],
      { timeout: 10_000 },
    );
    return { keyPath, certPath };
  } catch {
    return undefined;
  }
}

function parseBunProxyResult(stdout: string): BunProxyIntegrationResult {
  const resultLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Bun proxy integration did not emit a result:\n${stdout}`);
  }
  return JSON.parse(
    resultLine.slice(RESULT_PREFIX.length),
  ) as BunProxyIntegrationResult;
}

function buildBunProxyIntegrationScript(params: {
  fetchModuleUrl: string;
  cert: HttpsProxyCert | undefined;
}): string {
  return `import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici/index.js';
import {
  clearGlobalProxy,
  createRequestScopedDispatcher,
  proxiedFetch,
  setGlobalProxy,
  withFetchTimeouts,
  _resetBunRuntimeCacheForTesting,
  _resetProxyForTesting,
} from ${JSON.stringify(params.fetchModuleUrl)};

const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const certPath = ${JSON.stringify(params.cert?.certPath ?? '')};
const keyPath = ${JSON.stringify(params.cert?.keyPath ?? '')};

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

async function runHttpProxyScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let proxyRequest;
  const target = http.createServer((_req, res) => {
    targetHits++;
    res.end('target-direct');
  });
  const proxy = http.createServer((req, res) => {
    proxyRequest = {
      url: req.url,
      authorization: req.headers['proxy-authorization'],
    };
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('via-http-proxy');
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  try {
    setGlobalProxy('http://user:pass@127.0.0.1:' + proxyPort);
    const response = await proxiedFetch(
      'http://127.0.0.1:' + targetPort + '/path?q=1',
      withFetchTimeouts(
        { method: 'GET' },
        { requestTimeoutMs: 5000 },
      ),
    );
    return {
      status: response.status,
      text: await response.text(),
      proxyUrl: proxyRequest?.url,
      proxyAuthorization: proxyRequest?.authorization,
      targetHits,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(proxy);
    await closeServer(target);
  }
}

async function runSseProxyScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let proxyHits = 0;
  const target = http.createServer((_req, res) => {
    targetHits++;
    res.end('target-direct');
  });
  const proxy = http.createServer((_req, res) => {
    proxyHits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\\n\\n');
    setTimeout(() => res.end('data: two\\n\\n'), 10);
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  try {
    setGlobalProxy('http://127.0.0.1:' + proxyPort);
    const response = await proxiedFetch(
      'http://127.0.0.1:' + targetPort + '/sse',
      withFetchTimeouts(
        { method: 'GET', headers: { Accept: 'text/event-stream' } },
        { requestTimeoutMs: 5000 },
      ),
    );
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? undefined,
      proxyHits,
      targetHits,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(proxy);
    await closeServer(target);
  }
}

async function runNoProxyScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let proxyHits = 0;
  const target = http.createServer((_req, res) => {
    targetHits++;
    res.end('target-bypass');
  });
  const proxy = http.createServer((_req, res) => {
    proxyHits++;
    res.end('unexpected-proxy');
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const previousNoProxy = process.env.NO_PROXY;
  try {
    process.env.NO_PROXY = '127.0.0.1';
    setGlobalProxy('http://127.0.0.1:' + proxyPort);
    const response = await proxiedFetch(
      'http://127.0.0.1:' + targetPort + '/bypass',
      withFetchTimeouts(
        { method: 'GET' },
        { requestTimeoutMs: 5000 },
      ),
    );
    return {
      status: response.status,
      text: await response.text(),
      proxyHits,
      targetHits,
    };
  } finally {
    if (previousNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = previousNoProxy;
    }
    _resetProxyForTesting();
    await closeServer(proxy);
    await closeServer(target);
  }
}

async function runRequestScopedUploadScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let proxyHits = 0;
  const targetBodies = [];
  const target = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    targetHits++;
    targetBodies.push(Buffer.concat(chunks).toString('hex'));
    res.setHeader('connection', 'close');
    res.end('target-upload');
  });
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  proxy.on('connect', (req, client, head) => {
    const separator = req.url.lastIndexOf(':');
    const host = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstream = net.connect(
      port,
      host.endsWith('.invalid') ? '127.0.0.1' : host,
      () => {
        proxyHits++;
        client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      },
    );
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const previousNoProxy = process.env.NO_PROXY;
  try {
    const proxiedUrl = 'http://artifact-upload.invalid:' + targetPort + '/artifact';
    const directUrl = 'http://127.0.0.1:' + targetPort + '/artifact';
    const timeouts = {
      connectTimeoutMs: 5000,
      headersTimeoutMs: 5000,
      bodyTimeoutMs: 5000,
    };
    setGlobalProxy('http://127.0.0.1:' + proxyPort);
    const proxiedDispatcher = createRequestScopedDispatcher(
      new URL(proxiedUrl),
      timeouts,
    );
    let proxiedStatus;
    try {
      const response = await undiciRequest(proxiedUrl, {
        method: 'PUT',
        body: Readable.from([Buffer.from([0, 1, 2]), Buffer.from([127, 128, 254, 255])]),
        dispatcher: proxiedDispatcher,
      });
      proxiedStatus = response.statusCode;
      await response.body.dump();
    } finally {
      await proxiedDispatcher.close();
    }
    const proxied = {
      status: proxiedStatus,
      proxyHits,
      targetHits,
      targetBodyHex: targetBodies[0],
    };

    process.env.NO_PROXY = '127.0.0.1';
    const bypassedDispatcher = createRequestScopedDispatcher(
      new URL(directUrl),
      timeouts,
    );
    let bypassedStatus;
    try {
      const response = await undiciRequest(directUrl, {
        method: 'PUT',
        body: Readable.from([Buffer.from([3, 4, 5]), Buffer.from([129, 130, 253])]),
        dispatcher: bypassedDispatcher,
      });
      bypassedStatus = response.statusCode;
      await response.body.dump();
    } finally {
      await bypassedDispatcher.close();
    }

    return {
      proxied,
      bypassed: {
        status: bypassedStatus,
        proxyHits,
        targetHits,
        targetBodyHex: targetBodies[1],
      },
    };
  } finally {
    if (previousNoProxy === undefined) {
      delete process.env.NO_PROXY;
    } else {
      process.env.NO_PROXY = previousNoProxy;
    }
    _resetProxyForTesting();
    await closeServer(proxy);
    await closeServer(target);
  }
}

async function runProxyReenableScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let firstProxyHits = 0;
  let secondProxyHits = 0;
  const target = http.createServer((_req, res) => {
    targetHits++;
    res.end('target-direct');
  });
  const firstProxy = http.createServer((_req, res) => {
    firstProxyHits++;
    res.end('via-first-proxy');
  });
  const secondProxy = http.createServer((_req, res) => {
    secondProxyHits++;
    res.end('via-second-proxy');
  });
  const targetPort = await listen(target);
  const firstProxyPort = await listen(firstProxy);
  const secondProxyPort = await listen(secondProxy);
  try {
    const targetUrl = 'http://127.0.0.1:' + targetPort + '/dynamic-proxy';

    setGlobalProxy('http://127.0.0.1:' + firstProxyPort);
    const firstResponse = await fetch(targetUrl);

    clearGlobalProxy();
    const directResponse = await fetch(targetUrl);

    setGlobalProxy('http://127.0.0.1:' + secondProxyPort);
    const secondResponse = await fetch(targetUrl);

    return {
      firstText: await firstResponse.text(),
      directText: await directResponse.text(),
      secondText: await secondResponse.text(),
      firstProxyHits,
      secondProxyHits,
      targetHits,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(secondProxy);
    await closeServer(firstProxy);
    await closeServer(target);
  }
}

async function runHttpsProxyScenario() {
  if (!certPath || !keyPath) return undefined;
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let targetHits = 0;
  let proxyRequest;
  const target = http.createServer((_req, res) => {
    targetHits++;
    res.end('target-direct');
  });
  const proxy = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    (req, res) => {
      proxyRequest = { url: req.url };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('via-https-proxy');
    },
  );
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  try {
    setGlobalProxy('https://127.0.0.1:' + proxyPort);
    const response = await proxiedFetch(
      'http://127.0.0.1:' + targetPort + '/secure-proxy',
      withFetchTimeouts(
        {
          method: 'GET',
          tls: { rejectUnauthorized: false },
        },
        { requestTimeoutMs: 5000 },
      ),
    );
    return {
      status: response.status,
      text: await response.text(),
      proxyUrl: proxyRequest?.url,
      targetHits,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(proxy);
    await closeServer(target);
  }
}

try {
  const result = {
    bunVersion: globalThis.Bun?.version ?? process.versions.bun ?? 'unknown',
    httpProxy: await runHttpProxyScenario(),
    sseProxy: await runSseProxyScenario(),
    noProxy: await runNoProxyScenario(),
    requestScopedUpload: await runRequestScopedUploadScenario(),
    proxyReenable: await runProxyReenableScenario(),
    httpsProxy: await runHttpsProxyScenario(),
  };
  console.log(RESULT_PREFIX + JSON.stringify(result));
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
`;
}
