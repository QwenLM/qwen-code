/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createModelProxy } from '../../scripts/verify-pr-model-proxy.mjs';
import {
  INPUT_SCHEMA_VERSION,
  buildInputManifest,
  createRoundInputBundle,
  fetchRoundInputFromSocket,
  materializeTwoOidWorktrees,
  startInputServer,
  startLoopbackToUdsBridge,
} from '../../scripts/verify-pr-vm-channel.mjs';
import { startCollectorServer } from '../../scripts/verify-pr-vm-collector.mjs';

const GUEST_VSOCK_PY = fileURLToPath(
  new URL('../../scripts/verify-pr-vm-guest-vsock.py', import.meta.url),
);

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      await fn();
    } catch {
      // Best-effort cleanup.
    }
  }
});

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout.trim();
}

function makeFixtureRepo() {
  const root = mkdtempSync('/tmp/qc-chan-repo-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  // Plant a synthetic secret in .git/config and a private branch that must
  // never appear inside the exported two-OID bundle.
  git(
    ['config', 'http.extraheader', 'AUTHORIZATION: basic host-only-secret'],
    repoDir,
  );

  writeFileSync(
    join(repoDir, 'math.mjs'),
    'export const add = (a, b) => a - b;\n',
  );
  writeFileSync(
    join(repoDir, 'math.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { add } from './math.mjs';\nassert.equal(add(2, 3), 5);\n",
  );
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'base buggy'], repoDir);
  const baseRefOid = git(['rev-parse', 'HEAD'], repoDir);

  git(['checkout', '-q', '-b', 'private-secret'], repoDir);
  writeFileSync(join(repoDir, 'host-secret.txt'), 'SUPER_SECRET_NEVER_SHIP\n');
  git(['add', 'host-secret.txt'], repoDir);
  git(['commit', '-q', '-m', 'private secret branch'], repoDir);

  git(['checkout', '-q', 'main'], repoDir);
  git(['checkout', '-q', '-b', 'pr-head'], repoDir);
  writeFileSync(
    join(repoDir, 'math.mjs'),
    'export const add = (a, b) => a + b;\n',
  );
  git(['add', 'math.mjs'], repoDir);
  git(['commit', '-q', '-m', 'fix add'], repoDir);
  const headRefOid = git(['rev-parse', 'HEAD'], repoDir);

  return { root, repoDir, baseRefOid, headRefOid };
}

function runAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

function rawCommand(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const chunks = [];
    client.on('connect', () => {
      if (payload !== null) client.write(payload);
    });
    client.on('data', (c) => chunks.push(c));
    client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    client.on('error', reject);
  });
}

describe('verify-pr-vm-channel input packaging and manifest', () => {
  it('bundles only base/head OIDs without mutating repo or leaking private branches/config, and works from a linked worktree', () => {
    const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
    const beforeRefs = git(['show-ref'], repoDir);

    // Also create a linked worktree (where .git is a file, not a directory).
    const wtDir = join(root, 'linked-wt');
    git(['worktree', 'add', '-q', '--detach', wtDir, headRefOid], repoDir);

    const bundleOut = join(root, 'round.bundle');
    const info = createRoundInputBundle({
      repoDir: wtDir,
      baseRefOid,
      headRefOid,
      outPath: bundleOut,
    });
    expect(info.bundleBytes).toBeGreaterThan(0);
    expect(info.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(git(['show-ref'], repoDir)).toBe(beforeRefs);

    const heads = git(['bundle', 'list-heads', bundleOut], root);
    expect(heads).toContain(`${baseRefOid} refs/verify/base`);
    expect(heads).toContain(`${headRefOid} refs/verify/head`);
    expect(heads).not.toContain('private-secret');
    expect(
      readFileSync(bundleOut).includes(Buffer.from('SUPER_SECRET_NEVER_SHIP')),
    ).toBe(false);
    expect(
      readFileSync(bundleOut).includes(Buffer.from('host-only-secret')),
    ).toBe(false);

    // Materialize both OIDs in an isolated directory with no host .git access
    const baseDir = join(root, 'mat-base');
    const headDir = join(root, 'mat-head');
    materializeTwoOidWorktrees({
      bundlePath: bundleOut,
      baseRefOid,
      headRefOid,
      baseDir,
      headDir,
    });
    expect(
      spawnSync(process.execPath, ['math.test.mjs'], { cwd: baseDir }).status,
    ).not.toBe(0);
    expect(
      spawnSync(process.execPath, ['math.test.mjs'], { cwd: headDir }).status,
    ).toBe(0);
    expect(existsSync(join(headDir, 'host-secret.txt'))).toBe(false);

    // Negative controls: bad OID, oversize cap, symlink outPath
    expect(() =>
      createRoundInputBundle({
        repoDir,
        baseRefOid: 'not-a-sha',
        headRefOid,
        outPath: join(root, 'bad.bundle'),
      }),
    ).toThrow(/40-char/);
    expect(() =>
      createRoundInputBundle({
        repoDir,
        baseRefOid,
        headRefOid,
        outPath: join(root, 'tiny.bundle'),
        maxBundleBytes: 10,
      }),
    ).toThrow(/exceeds allowed range/);
    const symOut = join(root, 'sym.bundle');
    symlinkSync(bundleOut, symOut);
    expect(() =>
      createRoundInputBundle({
        repoDir,
        baseRefOid,
        headRefOid,
        outPath: symOut,
      }),
    ).toThrow(/non-regular outPath/);
  });

  it('builds a canonical manifest with fresh entropy and refuses embedded upstream secrets', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const sha = 'c'.repeat(64);
    const m1 = buildInputManifest({
      runId: 'ch01',
      repo: 'QwenLM/qwen-code',
      prNumber: 18221,
      baseRefOid: base,
      headRefOid: head,
      bundleSha256: sha,
      bundleBytes: 1234,
      modelProxy: {
        port: 54,
        basePath: '/v1',
        token: 'ephemeral-token',
        nonce: 'ephemeral-nonce',
      },
    });
    const m2 = buildInputManifest({
      runId: 'ch01',
      repo: 'QwenLM/qwen-code',
      prNumber: 18221,
      baseRefOid: base,
      headRefOid: head,
      bundleSha256: sha,
      bundleBytes: 1234,
    });
    expect(m1.manifest.schemaVersion).toBe(INPUT_SCHEMA_VERSION);
    expect(m1.manifest.entropyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(m1.manifest.entropyHex).not.toBe(m2.manifest.entropyHex);
    expect(m1.trustedInputDigest).toMatch(/^[0-9a-f]{64}$/);

    for (const secretKey of ['apiKey', 'upstreamBaseUrl', 'GH_TOKEN']) {
      expect(() =>
        buildInputManifest({
          runId: 'ch02',
          baseRefOid: base,
          headRefOid: head,
          bundleSha256: sha,
          bundleBytes: 1234,
          modelProxy: {
            port: 54,
            token: 't',
            nonce: 'n',
            [secretKey]: 'sk-real-secret',
          },
        }),
      ).toThrow(/forbidden secret field/);
    }
  });
});

describe('verify-pr-vm-channel input server, revocation, replacement protection, and loopback bridge', () => {
  it('serves manifest and bundle, enforces read budget, fails closed on token revocation and invalid commands, and protects replaced UDS sockets', async () => {
    const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
    const bundleInfo = createRoundInputBundle({
      repoDir,
      baseRefOid,
      headRefOid,
      outPath: join(root, 'in.bundle'),
    });
    const built = buildInputManifest({
      runId: 'srv01',
      baseRefOid,
      headRefOid,
      bundleSha256: bundleInfo.bundleSha256,
      bundleBytes: bundleInfo.bundleBytes,
    });

    const tokenFile = join(root, 'token.json');
    writeFileSync(
      tokenFile,
      JSON.stringify({ runId: 'srv01', revoked: false }),
    );

    const sockPath = join(root, 'in.sock');
    const server = startInputServer({
      socketPath: sockPath,
      manifest: built.manifest,
      manifestBytes: built.manifestBytes,
      bundlePath: bundleInfo.bundlePath,
      tokenFile,
      maxReads: 3,
      commandTimeoutMs: 200,
    });
    cleanups.push(() => server.close());
    await server.ready;

    // Refuses binding on an already-existing path
    expect(() =>
      startInputServer({
        socketPath: sockPath,
        manifest: built.manifest,
        bundlePath: bundleInfo.bundlePath,
      }),
    ).toThrow(/refusing existing socket path/);

    // Invalid command, oversize command, and idle timeout
    expect(await rawCommand(sockPath, 'GET /etc/passwd\n')).toBe(
      'ERR unknown-command\n',
    );
    expect(await rawCommand(sockPath, `${'A'.repeat(200)}\n`)).toBe(
      'ERR command-too-long\n',
    );
    expect(await rawCommand(sockPath, null)).toBe('ERR timeout\n');

    // Valid client fetch consumes 2 reads (manifest + bundle)
    const guestDir = join(root, 'guest-in');
    const fetched = await fetchRoundInputFromSocket({
      socketPath: sockPath,
      outDir: guestDir,
    });
    expect(fetched.manifest.runId).toBe('srv01');
    expect(existsSync(fetched.bundlePath)).toBe(true);
    expect(existsSync(fetched.entropyPath)).toBe(true);

    // 3rd read rejected when bundlePath is replaced with a same-size different-inode file
    const origBytes = readFileSync(bundleInfo.bundlePath);
    unlinkSync(bundleInfo.bundlePath);
    writeFileSync(bundleInfo.bundlePath, Buffer.alloc(origBytes.length, 0x41));
    expect(await rawCommand(sockPath, 'GET bundle\n')).toBe(
      'ERR bundle-invalid\n',
    );

    // 3rd served read succeeds on manifest, 4th exceeds maxReads=3
    expect(
      (await rawCommand(sockPath, 'GET manifest\n')).startsWith('OK '),
    ).toBe(true);
    expect(await rawCommand(sockPath, 'GET manifest\n')).toBe(
      'ERR read-budget-exceeded\n',
    );

    // Revoking token.json immediately blocks reads with ERR token-revoked
    writeFileSync(tokenFile, JSON.stringify({ runId: 'srv01', revoked: true }));
    expect(await rawCommand(sockPath, 'GET manifest\n')).toBe(
      'ERR token-revoked\n',
    );
    expect(server.getStats()).toEqual({
      servedManifest: 2,
      servedBundle: 1,
      rejectedRevoked: 1,
      rejectedBudget: 1,
      rejectedInvalid: 4,
      rejectedBusy: 0,
    });

    // Replace the input UDS path with another live UDS socket: close() must
    // report identityChanged and MUST NOT unlink the replacement socket.
    unlinkSync(sockPath);
    const victim = net.createServer((s) => s.end('victim-input-alive'));
    await new Promise((resolve, reject) => {
      victim.once('error', reject);
      victim.listen(sockPath, resolve);
    });
    cleanups.push(() => victim.close());

    const closeRes = await server.close();
    expect(closeRes.ok).toBe(false);
    expect(closeRes.identityChanged).toBe(true);
    expect(closeRes.error).toBe('input-socket-identity-changed');
    expect(existsSync(sockPath)).toBe(true);
    expect(await rawCommand(sockPath, '')).toBe('victim-input-alive');
  });

  it('bridges loopback HTTP to a UDS model proxy and drives the real Python guest-vsock CLI end to end', async () => {
    const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
    const realUpstreamKey = 'sk-upstream-never-in-guest';
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
      upstreamHits += 1;
      if (req.headers.authorization !== `Bearer ${realUpstreamKey}`) {
        res.writeHead(401).end('bad-upstream-key');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `resp-${upstreamHits}`, ok: true }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    cleanups.push(() => upstream.close());

    const tokenFile = join(root, 'token.json');
    writeFileSync(tokenFile, JSON.stringify({ runId: 'py01', revoked: false }));

    const modelSock = join(root, 'mp.sock');
    const proxyToken = 'ephemeral-round-token-py01';
    const proxyNonce = 'ephemeral-round-nonce-py01';
    const proxy = createModelProxy({
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: realUpstreamKey,
      token: proxyToken,
      nonce: proxyNonce,
      tokenFile,
      maxRequests: 2,
    });
    await new Promise((r, rej) => {
      proxy.once('error', rej);
      proxy.listen(modelSock, r);
    });
    chmodSync(modelSock, 0o600);
    cleanups.push(
      () =>
        new Promise((done) => {
          proxy.closeAllConnections?.();
          proxy.close(() => done());
        }),
    );

    // 1. Node loopback-to-UDS bridge test
    const nodeBridge = await startLoopbackToUdsBridge({
      upstreamSocketPath: modelSock,
    });
    cleanups.push(() => nodeBridge.close());
    const unauth = await fetch(
      `http://127.0.0.1:${nodeBridge.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: '{}',
      },
    );
    expect(unauth.status).toBe(401);
    const ok1 = await fetch(
      `http://127.0.0.1:${nodeBridge.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${proxyToken}` },
        body: '{"messages":[]}',
      },
    );
    expect(ok1.status).toBe(200);
    expect(await ok1.text()).not.toContain(realUpstreamKey);

    // 2. Host input server + collector server
    const bundleInfo = createRoundInputBundle({
      repoDir,
      baseRefOid,
      headRefOid,
      outPath: join(root, 'py.bundle'),
    });
    const built = buildInputManifest({
      runId: 'py01',
      baseRefOid,
      headRefOid,
      bundleSha256: bundleInfo.bundleSha256,
      bundleBytes: bundleInfo.bundleBytes,
      modelProxy: {
        port: 54,
        basePath: '/v1',
        token: proxyToken,
        nonce: proxyNonce,
      },
    });
    const inputSock = join(root, 'in.sock');
    const inputServer = startInputServer({
      socketPath: inputSock,
      manifest: built.manifest,
      manifestBytes: built.manifestBytes,
      bundlePath: bundleInfo.bundlePath,
      tokenFile,
    });
    cleanups.push(() => inputServer.close());
    await inputServer.ready;

    const vaultDir = join(root, 'vault');
    const colSock = join(root, 'col.sock');
    const collector = startCollectorServer({
      socketPath: colSock,
      vaultDir,
    });
    cleanups.push(() => collector.close());
    await collector.ready;

    // 3. Drive real Python guest-vsock.py: fetch-inputs -> model-bridge -> upload-artifacts
    const pyOut = join(root, 'py-guest-in');
    const fetchRun = await runAsync('python3', [
      GUEST_VSOCK_PY,
      'fetch-inputs',
      '--unix',
      inputSock,
      '--out',
      pyOut,
    ]);
    expect(fetchRun.status, fetchRun.stderr).toBe(0);
    const fetchJson = JSON.parse(fetchRun.stdout);
    expect(fetchJson.bundleSha256).toBe(bundleInfo.bundleSha256);
    expect(fetchJson.hasModelProxy).toBe(true);
    const guestManifest = JSON.parse(
      readFileSync(join(pyOut, 'manifest.json'), 'utf8'),
    );
    expect(JSON.stringify(guestManifest)).not.toContain(realUpstreamKey);

    // Start Python model-bridge against modelSock
    const pyBridge = spawn(
      'python3',
      [
        GUEST_VSOCK_PY,
        'model-bridge',
        '--unix',
        modelSock,
        '--local-port',
        '0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    cleanups.push(() => {
      if (pyBridge.exitCode === null) pyBridge.kill('SIGTERM');
    });
    const [readyLine] = await once(pyBridge.stdout, 'data');
    const { port: pyPort } = JSON.parse(readyLine.toString('utf8').trim());

    const pyHealth = await fetch(`http://127.0.0.1:${pyPort}/__health`);
    expect(await pyHealth.text()).toBe(proxyNonce);
    const ok2 = await fetch(`http://127.0.0.1:${pyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guestManifest.modelProxy.token}` },
      body: '{"messages":[]}',
    });
    expect(ok2.status).toBe(200);
    // 3rd accepted request hits maxRequests=2 budget -> 429
    const overBudget = await fetch(
      `http://127.0.0.1:${pyPort}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${guestManifest.modelProxy.token}` },
        body: '{"messages":[]}',
      },
    );
    expect(overBudget.status).toBe(429);
    // Revoke token -> 403
    writeFileSync(tokenFile, JSON.stringify({ runId: 'py01', revoked: true }));
    const revoked = await fetch(
      `http://127.0.0.1:${pyPort}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${guestManifest.modelProxy.token}` },
        body: '{"messages":[]}',
      },
    );
    expect(revoked.status).toBe(403);
    pyBridge.kill('SIGTERM');
    await once(pyBridge, 'exit');

    // Upload artifacts via Python guest-vsock.py -> real host collector
    const artDir = join(root, 'guest-art');
    mkdirSync(join(artDir, 'evidence'), { recursive: true });
    writeFileSync(join(artDir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(artDir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}\n',
    );
    writeFileSync(
      join(artDir, 'report.md'),
      `merge-ready · 1 passed · 0 failed · 1 total · ${headRefOid}\n`,
    );
    writeFileSync(join(artDir, 'evidence', '01-ab.png'), PNG_BYTES);
    const upRun = await runAsync('python3', [
      GUEST_VSOCK_PY,
      'upload-artifacts',
      '--unix',
      colSock,
      '--dir',
      artDir,
    ]);
    expect(upRun.status, upRun.stderr).toBe(0);
    const summary = await collector.done;
    expect(summary.outputStatus).toBe('complete');
    expect(readFileSync(join(vaultDir, 'evidence', '01-ab.png'))).toEqual(
      PNG_BYTES,
    );
    expect(upstreamHits).toBe(2);

    // Non-loopback listen address is refused by guest model-bridge
    const badListen = await runAsync('python3', [
      GUEST_VSOCK_PY,
      'model-bridge',
      '--unix',
      modelSock,
      '--listen',
      '0.0.0.0',
    ]);
    expect(badListen.status).toBe(1);
    expect(badListen.stderr).toMatch(/non-loopback/);
  });
});
