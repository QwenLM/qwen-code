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
const RESULT_PREFIX = 'BUN_UNDICI_INTEGRATION_RESULT:';
const BUN_AVAILABLE =
  spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const OPENSSL_AVAILABLE =
  spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

interface HttpsTestCert {
  certPath: string;
  keyPath: string;
}

interface BunUndiciIntegrationResult {
  bunVersion: string;
  resolvedIp: {
    status: number;
    text: string;
    host: string | undefined;
    marker: string | undefined;
    contentType: string | undefined;
    requestBody: string;
    url: string;
  };
  resolvedIpCancelRace: {
    attempts: number;
    requests: number;
    injectedLateDataEvents: number;
  };
  formData: {
    status: number;
    text: string;
    contentType: string | undefined;
    requestBody: string;
  };
  socks: {
    status: number;
    text: string;
    proxyHits: number;
    targetHits: number;
    httpsStatus?: number;
    httpsText?: string;
    httpsTargetHits?: number;
  };
  socksTlsCertificate?: {
    name: string;
    code: string | undefined;
    message: string;
  };
  httpsResolvedIp?: {
    status: number;
    text: string;
    httpVersion: string | undefined;
    contentType: string | undefined;
    contentLength: string | undefined;
    transferEncoding: string | undefined;
    requestBody: string;
  };
}

/**
 * SOCKS5 connect-timeout and abort scenarios (silent proxy, silent TLS target,
 * caller abort, concurrent abort) used to live here. They encoded guarantees
 * the hand-rolled transport made and undici's native SOCKS5 does not:
 *
 * - `socksTimeout` / `socksAbort` asserted a sub-second bound from a caller's
 *   `connectTimeoutMs`. undici ignores it and applies its own fixed 10s
 *   connect / 5s handshake bounds, so a silent proxy now fails at ~5s.
 * - `socksTlsTimeout` asserted a bound on the target TLS handshake, which
 *   undici does not time out at all.
 * - `socksConcurrentAbort` asserted pool eviction on abort; the per-origin
 *   pools and their lease accounting are gone.
 *
 * All four also leave their `closeServer()` cleanup pending, because a
 * timed-out request no longer destroys its proxy socket. Accepted for a
 * feature with very few users; see docs/designs/2026-08-24-bun-1.4-upgrade.md.
 * Restore them together with a bounded SOCKS connect and socket teardown.
 */
describe.skipIf(!BUN_AVAILABLE)('Bun npm undici transport integration', () => {
  it('supports resolved-IP and SOCKS in run and compiled modes', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(currentDir, '../../../..');
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'test-bun-undici-'));
    const scriptPath = path.join(tmpRoot, 'integration.ts');
    const binaryPath = path.join(tmpRoot, 'integration-bin');
    const cert = await createHttpsTestCert(tmpRoot);
    const trustedCertEnv = getTrustedCertEnv(cert);

    try {
      await writeFile(
        scriptPath,
        buildIntegrationScript(
          path.join(repoRoot, 'packages/core/src/utils/fetch.ts'),
          cert,
        ),
        'utf8',
      );

      const interpretedRun = await runCommand(
        'bun',
        ['run', scriptPath],
        repoRoot,
        45_000,
        trustedCertEnv,
      );
      const interpreted = parseResult(interpretedRun.stdout);

      await runCommand(
        'bun',
        [
          'build',
          '--compile',
          '--external=web-tree-sitter/*',
          '--external=tree-sitter-bash/*',
          scriptPath,
          '--outfile',
          binaryPath,
        ],
        repoRoot,
        90_000,
      );
      const compiledRun = await runCommand(
        binaryPath,
        [],
        repoRoot,
        45_000,
        trustedCertEnv,
      );
      const compiled = parseResult(compiledRun.stdout);

      assertTransportResult(interpreted, cert !== undefined);
      assertTransportResult(compiled, cert !== undefined);
      expect(interpretedRun.stderr).not.toContain(
        'SOCKS5 proxy support is experimental',
      );
      expect(compiledRun.stderr).not.toContain(
        'SOCKS5 proxy support is experimental',
      );
      expect(compiled.bunVersion).toBe(interpreted.bunVersion);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

function assertTransportResult(
  result: BunUndiciIntegrationResult,
  expectHttps: boolean,
): void {
  expect(result.bunVersion).toMatch(/\d+\.\d+\.\d+/);
  expect(result.resolvedIp).toMatchObject({
    status: 200,
    text: 'resolved-ip-ok',
    marker: '127.0.0.1',
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    requestBody: 'query=hello+world',
  });
  expect(result.resolvedIp.host).toMatch(/^resolved\.invalid:\d+$/);
  expect(result.resolvedIp.url).toMatch(
    /^http:\/\/resolved\.invalid:\d+\/resolved$/,
  );
  expect(result.resolvedIpCancelRace).toEqual({
    attempts: 50,
    requests: 50,
    injectedLateDataEvents: 50,
  });
  expect(result.formData).toMatchObject({
    status: 200,
    text: 'form-data-ok',
  });
  expect(result.formData.contentType).toMatch(
    /^multipart\/form-data; boundary=/,
  );
  expect(result.formData.requestBody).toContain('name="prompt"');
  expect(result.formData.requestBody).toContain('hello from form data');
  if (expectHttps) {
    // The tunnel must not skip target identity verification. undici's
    // native SOCKS5 surfaces Node's own checkServerIdentity failure
    // rather than a wrapped one, so match on the code and its text.
    expect(result.socksTlsCertificate).toMatchObject({
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    expect(result.socksTlsCertificate?.message).toContain(
      "does not match certificate's altnames",
    );
    expect(result.socks).toEqual({
      status: 200,
      text: 'socks-payload',
      proxyHits: 2,
      targetHits: 1,
      httpsStatus: 200,
      httpsText: 'secure-socks-payload',
      httpsTargetHits: 1,
    });
    expect(result.httpsResolvedIp).toEqual({
      status: 200,
      text: 'https-resolved-ip-ok',
      httpVersion: '1.1',
      contentType: 'application/octet-stream',
      contentLength: '18',
      transferEncoding: undefined,
      requestBody: 'https-blob-payload',
    });
  } else {
    expect(result.socksTlsCertificate).toBeUndefined();
    expect(result.socks).toEqual({
      status: 200,
      text: 'socks-payload',
      proxyHits: 1,
      targetHits: 1,
    });
    expect(result.httpsResolvedIp).toBeUndefined();
  }
}

async function runCommand(
  executable: string,
  args: string[],
  repoRoot: string,
  timeout = 45_000,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(executable, args, {
      cwd: repoRoot,
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        NO_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        no_proxy: '',
        ...extraEnv,
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

async function createHttpsTestCert(
  tmpRoot: string,
): Promise<HttpsTestCert | undefined> {
  if (!OPENSSL_AVAILABLE) return undefined;

  const keyPath = path.join(tmpRoot, 'resolved-ip-key.pem');
  const certPath = path.join(tmpRoot, 'resolved-ip-cert.pem');
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
        '/CN=resolved.invalid',
        '-addext',
        'subjectAltName=DNS:resolved.invalid',
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

function getTrustedCertEnv(
  cert: HttpsTestCert | undefined,
): Record<string, string> | undefined {
  if (!cert) return undefined;
  return {
    NODE_EXTRA_CA_CERTS: cert.certPath,
    SSL_CERT_FILE: cert.certPath,
  };
}

function parseResult(stdout: string): BunUndiciIntegrationResult {
  const resultLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`Bun undici integration did not emit a result:\n${stdout}`);
  }
  return JSON.parse(
    resultLine.slice(RESULT_PREFIX.length),
  ) as BunUndiciIntegrationResult;
}

function buildIntegrationScript(
  fetchModuleUrl: string,
  cert: HttpsTestCert | undefined,
): string {
  return `import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import {
  fetchWithResolvedIp,
  proxiedFetch,
  setGlobalProxy,
  withFetchTimeouts,
  _resetBunRuntimeCacheForTesting,
  _resetProxyForTesting,
} from ${JSON.stringify(fetchModuleUrl)};

const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const certPath = ${JSON.stringify(cert?.certPath ?? '')};
const keyPath = ${JSON.stringify(cert?.keyPath ?? '')};

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

async function runResolvedIpScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let requestHeaders;
  let requestBody = '';
  const target = http.createServer((req, res) => {
    requestHeaders = req.headers;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('connection', 'close');
      res.end('resolved-ip-ok');
    });
  });
  const targetPort = await listen(target);
  const url = 'http://resolved.invalid:' + targetPort + '/resolved';

  try {
    const response = await fetchWithResolvedIp(
      url,
      withFetchTimeouts(
        {
          method: 'POST',
          body: new URLSearchParams({ query: 'hello world' }),
        },
        {
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
      {
        ip: '127.0.0.1',
        originalHostname: 'resolved.invalid',
        markerHeader: 'X-Qwen-HTTPDNS-IP',
      },
    );
    return {
      status: response.status,
      text: await response.text(),
      host: requestHeaders?.host,
      marker: requestHeaders?.['x-qwen-httpdns-ip'],
      contentType: requestHeaders?.['content-type'],
      requestBody,
      url: response.url,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(target);
  }
}

async function runResolvedIpCancelRaceScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  const attempts = 50;
  let requests = 0;
  let injectLateData = false;
  let injectedLateDataEvents = 0;
  const originalReadableDestroy = Readable.prototype.destroy;
  Readable.prototype.destroy = function (...args) {
    const result = originalReadableDestroy.apply(this, args);
    if (injectLateData) {
      injectedLateDataEvents++;
      this.emit('data', Buffer.from('late-response-body'));
    }
    return result;
  };

  const target = http.createServer((_req, res) => {
    requests++;
    res.on('error', () => {});
    res.writeHead(200, {
      connection: 'close',
      'content-type': 'text/plain',
    });
    res.flushHeaders();
  });
  const targetPort = await listen(target);
  const url = 'http://resolved.invalid:' + targetPort + '/cancel-race';

  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await fetchWithResolvedIp(
        url,
        { method: 'GET' },
        {
          ip: '127.0.0.1',
          originalHostname: 'resolved.invalid',
        },
      );

      // Force the underlying Node stream to emit one late data event while
      // cancellation is closing the consumer.
      // Bun 1.3.14's Readable.toWeb() adapter can deliver that data to an
      // already-closed controller as a process-level exception.
      let cancellation;
      injectLateData = true;
      try {
        cancellation = response.body?.cancel(
          'health probe only needed response headers',
        );
      } finally {
        injectLateData = false;
      }
      await cancellation;
    }

    return {
      attempts,
      requests,
      injectedLateDataEvents,
    };
  } finally {
    injectLateData = false;
    Readable.prototype.destroy = originalReadableDestroy;
    _resetProxyForTesting();
    await closeServer(target);
  }
}

async function runFormDataScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let requestHeaders;
  let requestBody = '';
  const target = http.createServer((req, res) => {
    requestHeaders = req.headers;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('connection', 'close');
      res.end('form-data-ok');
    });
  });
  const targetPort = await listen(target);
  const url = 'http://resolved.invalid:' + targetPort + '/form-data';

  try {
    const form = new FormData();
    form.append('prompt', 'hello from form data');
    const response = await fetchWithResolvedIp(
      url,
      withFetchTimeouts(
        { method: 'POST', body: form },
        {
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
      {
        ip: '127.0.0.1',
        originalHostname: 'resolved.invalid',
      },
    );
    return {
      status: response.status,
      text: await response.text(),
      contentType: requestHeaders?.['content-type'],
      requestBody,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(target);
  }
}

async function runHttpsResolvedIpScenario() {
  if (!certPath || !keyPath) return undefined;
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let httpVersion;
  let requestHeaders;
  let requestBody = '';
  const target = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    (req, res) => {
      httpVersion = req.httpVersion;
      requestHeaders = req.headers;
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requestBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('connection', 'close');
        res.end('https-resolved-ip-ok');
      });
    },
  );
  const targetPort = await listen(target);
  const url = 'https://resolved.invalid:' + targetPort + '/resolved';

  try {
    const response = await fetchWithResolvedIp(
      url,
      withFetchTimeouts(
        {
          method: 'POST',
          body: new Blob(['https-blob-payload'], {
            type: 'application/octet-stream',
          }),
        },
        {
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
      {
        ip: '127.0.0.1',
        originalHostname: 'resolved.invalid',
        markerHeader: 'X-Qwen-HTTPDNS-IP',
      },
    );
    return {
      status: response.status,
      text: await response.text(),
      httpVersion,
      contentType: requestHeaders?.['content-type'],
      contentLength: requestHeaders?.['content-length'],
      transferEncoding: requestHeaders?.['transfer-encoding'],
      requestBody,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(target);
  }
}

function createSocksServer(onProxyConnect, credentials) {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let state = 'greeting';
    let upstream;
    client.on('error', () => {});
    client.on('close', () => upstream?.destroy());

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (state === 'greeting') {
        if (buffer.length < 2) return;
        const methodCount = buffer[1];
        const greetingLength = 2 + methodCount;
        if (buffer.length < greetingLength) return;
        const methods = buffer.subarray(2, greetingLength);
        buffer = buffer.subarray(greetingLength);
        const selectedMethod = credentials ? 0x02 : 0x00;
        if (!methods.includes(selectedMethod)) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        client.write(Buffer.from([0x05, selectedMethod]));
        state = credentials ? 'auth' : 'request';
      }

      if (state === 'auth') {
        if (buffer.length < 2) return;
        const authVersion = buffer[0];
        const usernameLength = buffer[1];
        const passwordLengthOffset = 2 + usernameLength;
        if (buffer.length <= passwordLengthOffset) return;
        const passwordLength = buffer[passwordLengthOffset];
        const authLength = passwordLengthOffset + 1 + passwordLength;
        if (buffer.length < authLength) return;
        const username = buffer
          .subarray(2, passwordLengthOffset)
          .toString('utf8');
        const password = buffer
          .subarray(passwordLengthOffset + 1, authLength)
          .toString('utf8');
        buffer = buffer.subarray(authLength);
        if (
          authVersion === 0x01 &&
          username === credentials.username &&
          password === credentials.password
        ) {
          client.write(Buffer.from([0x01, 0x00]));
          state = 'request';
        } else {
          client.end(Buffer.from([0x01, 0x01]));
          return;
        }
      }

      if (state !== 'request' || buffer.length < 4) return;
      const addressType = buffer[3];
      let address;
      let addressEnd;
      if (addressType === 0x01) {
        if (buffer.length < 10) return;
        address = Array.from(buffer.subarray(4, 8)).join('.');
        addressEnd = 8;
      } else if (addressType === 0x03) {
        const addressLength = buffer[4];
        if (buffer.length < 7 + addressLength) return;
        address = buffer.subarray(5, 5 + addressLength).toString('utf8');
        addressEnd = 5 + addressLength;
      } else {
        client.destroy(new Error('Unsupported SOCKS address type'));
        return;
      }

      const requestLength = addressEnd + 2;
      if (buffer.length < requestLength) return;
      const port = buffer.readUInt16BE(addressEnd);
      const pending = buffer.subarray(requestLength);
      buffer = Buffer.alloc(0);
      state = 'connecting';

      upstream = net.connect(
        port,
        address.endsWith('.invalid') ? '127.0.0.1' : address,
        () => {
          onProxyConnect();
          client.write(
            Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]),
          );
          client.off('data', onData);
          if (pending.length > 0) upstream.write(pending);
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      upstream.on('error', (error) => client.destroy(error));
    };

    client.on('data', onData);
  });
}

async function runSocksScenario() {
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  let proxyHits = 0;
  let targetHits = 0;
  let httpsTargetHits = 0;
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      targetHits++;
      res.setHeader('connection', 'close');
      res.setHeader('content-encoding', 'gzip');
      res.end(
        zlib.gzipSync('socks-' + Buffer.concat(chunks).toString('utf8')),
      );
    });
  });
  const httpsTarget =
    certPath && keyPath
      ? https.createServer(
          {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
          },
          (_req, res) => {
            httpsTargetHits++;
            res.setHeader('connection', 'close');
            res.end('secure-socks-payload');
          },
        )
      : undefined;
  const socksCredentials = { username: 'integration-user', password: 's3cret' };
  const socks = createSocksServer(() => {
    proxyHits++;
  }, socksCredentials);
  const targetPort = await listen(target);
  const httpsTargetPort = httpsTarget ? await listen(httpsTarget) : undefined;
  const socksPort = await listen(socks);

  try {
    setGlobalProxy(
      'socks5://' +
        encodeURIComponent(socksCredentials.username) +
        ':' +
        encodeURIComponent(socksCredentials.password) +
        '@127.0.0.1:' +
        socksPort,
    );
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('payload'));
        controller.close();
      },
    });
    const response = await proxiedFetch(
      'http://127.0.0.1:' + targetPort + '/socks',
      withFetchTimeouts(
        { method: 'POST', body, duplex: 'half' },
        {
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
    );
    const result = {
      status: response.status,
      text: await response.text(),
      proxyHits,
      targetHits,
    };
    if (httpsTargetPort === undefined) return result;

    // Reuse one configured proxy for a different origin and protocol. Each
    // origin requires its own pool-bound SOCKS dispatcher.
    const httpsResponse = await proxiedFetch(
      'https://resolved.invalid:' + httpsTargetPort + '/socks-secure',
      withFetchTimeouts(
        { method: 'GET' },
        {
          connectTimeoutMs: 5000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
    );
    return {
      ...result,
      httpsStatus: httpsResponse.status,
      httpsText: await httpsResponse.text(),
      httpsTargetHits,
      proxyHits,
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(socks);
    if (httpsTarget) await closeServer(httpsTarget);
    await closeServer(target);
  }
}

async function runSocksTlsCertificateScenario() {
  if (!certPath || !keyPath) return undefined;
  _resetBunRuntimeCacheForTesting();
  _resetProxyForTesting();
  const target = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  });
  const targetPort = await listen(target);
  const socks = createSocksServer(() => {}, undefined);
  const socksPort = await listen(socks);

  try {
    setGlobalProxy('socks5://127.0.0.1:' + socksPort);
    await proxiedFetch(
      'https://wrong.invalid:' + targetPort + '/certificate-mismatch',
      withFetchTimeouts(
        { method: 'GET' },
        {
          connectTimeoutMs: 2000,
          requestTimeoutMs: 5000,
          bodyIdleTimeoutMs: 5000,
        },
      ),
    );
    throw new Error('Expected the target certificate identity check to fail');
  } catch (error) {
    return {
      name: error?.name ?? 'Error',
      code: error?.code,
      message: error?.message ?? String(error),
    };
  } finally {
    _resetProxyForTesting();
    await closeServer(socks);
    await closeServer(target);
  }
}


try {
  const result = {
    bunVersion: globalThis.Bun?.version ?? process.versions.bun ?? 'unknown',
    resolvedIp: await runResolvedIpScenario(),
    resolvedIpCancelRace: await runResolvedIpCancelRaceScenario(),
    formData: await runFormDataScenario(),
    httpsResolvedIp: await runHttpsResolvedIpScenario(),
    socks: await runSocksScenario(),
    socksTlsCertificate: await runSocksTlsCertificateScenario(),
  };
  console.log(RESULT_PREFIX + JSON.stringify(result));
} catch (error) {
  console.error(error?.stack ?? error);
  if (error?.cause) console.error('cause:', error.cause);
  process.exit(1);
}
`;
}
