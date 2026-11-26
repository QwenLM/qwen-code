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
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
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

  it('pins real-size guest uploads (F1), clean ERR busy delivery (F2), inode-reuse-proof bundle pinning (F3), and startup hard-link refusal (M4)', async () => {
    const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();

    // F1: default collector (maxChunkBytes=2048, maxFrameBytes=4096) receives
    // 2048B, 2049B, 4092B, 12 KiB report.md, and 120 KiB PNG via Python guest
    const largeReport = `${`merge-ready · 1 passed · 0 failed · 1 total · ${headRefOid}\n\n`.padEnd(12 * 1024, 'x')}\n`;
    const largePng = Buffer.concat([
      PNG_BYTES,
      Buffer.alloc(120 * 1024 - PNG_BYTES.length, 0x5a),
    ]);
    const log2048 = 'a'.repeat(2048);
    const log2049 = 'b'.repeat(2049);
    const log4092 = 'c'.repeat(4092);

    const artDir = join(root, 'real-size-art');
    mkdirSync(join(artDir, 'evidence'), { recursive: true });
    mkdirSync(join(artDir, 'logs'), { recursive: true });
    writeFileSync(join(artDir, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(artDir, 'assertions.json'),
      '{"pass":1,"fail":0,"total":1}\n',
    );
    writeFileSync(join(artDir, 'report.md'), largeReport);
    writeFileSync(join(artDir, 'evidence', '01-ab.png'), largePng);
    writeFileSync(join(artDir, 'logs', 'b2048.log'), log2048);
    writeFileSync(join(artDir, 'logs', 'b2049.log'), log2049);
    writeFileSync(join(artDir, 'logs', 'b4092.log'), log4092);

    const vaultDir = join(root, 'real-size-vault');
    const colSock = join(root, 'col-f1.sock');
    const collector = startCollectorServer({ socketPath: colSock, vaultDir });
    cleanups.push(() => collector.close());
    await collector.ready;

    const upRes = await runAsync('python3', [
      GUEST_VSOCK_PY,
      'upload-artifacts',
      '--unix',
      colSock,
      '--dir',
      artDir,
    ]);
    expect(upRes.status, upRes.stderr).toBe(0);
    const summary = await collector.done;
    expect(summary.outputStatus).toBe('complete');
    expect(readFileSync(join(vaultDir, 'report.md'), 'utf8')).toBe(largeReport);
    expect(readFileSync(join(vaultDir, 'evidence', '01-ab.png'))).toEqual(
      largePng,
    );
    expect(readFileSync(join(vaultDir, 'logs', 'b2048.log'), 'utf8')).toBe(
      log2048,
    );
    expect(readFileSync(join(vaultDir, 'logs', 'b2049.log'), 'utf8')).toBe(
      log2049,
    );
    expect(readFileSync(join(vaultDir, 'logs', 'b4092.log'), 'utf8')).toBe(
      log4092,
    );

    // M4: constructor refuses a hard-linked bundlePath before creating socket
    const bundleInfo = createRoundInputBundle({
      repoDir,
      baseRefOid,
      headRefOid,
      outPath: join(root, 'm4.bundle'),
    });
    const built = buildInputManifest({
      runId: 'm4f2',
      baseRefOid,
      headRefOid,
      bundleSha256: bundleInfo.bundleSha256,
      bundleBytes: bundleInfo.bundleBytes,
    });
    const hardAlias = join(root, 'm4-alias.bundle');
    linkSync(bundleInfo.bundlePath, hardAlias);
    const neverBoundSock = join(root, 'never-bound.sock');
    expect(() =>
      startInputServer({
        socketPath: neverBoundSock,
        manifest: built.manifest,
        bundlePath: bundleInfo.bundlePath,
      }),
    ).toThrow(/single-link regular file/);
    expect(existsSync(neverBoundSock)).toBe(false);
    unlinkSync(hardAlias);

    // F2: 12 consecutive over-cap Node clients receive ERR busy\n (zero EPIPE)
    const busySock = join(root, 'busy.sock');
    const busyServer = startInputServer({
      socketPath: busySock,
      manifest: built.manifest,
      manifestBytes: built.manifestBytes,
      bundlePath: bundleInfo.bundlePath,
      maxConcurrent: 1,
      commandTimeoutMs: 5_000,
    });
    cleanups.push(() => busyServer.close());
    await busyServer.ready;

    const holder = net.createConnection(busySock);
    cleanups.push(() => holder.destroy());
    await once(holder, 'connect');
    // Give the server loop one tick to register holder in activeSockets.
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 12; i++) {
      const reply = await rawCommand(busySock, 'GET manifest\n');
      expect(reply).toBe('ERR busy\n');
    }
    expect(busyServer.getStats().rejectedBusy).toBe(12);
    holder.destroy();
    await new Promise((r) => setTimeout(r, 20));

    // F3: 20 tight unlink + same-size recreate trials must fail 20/20 because
    // the server holds the original inode pinned via an open read-only fd.
    const origLen = bundleInfo.bundleBytes;
    for (let i = 0; i < 20; i++) {
      unlinkSync(bundleInfo.bundlePath);
      writeFileSync(
        bundleInfo.bundlePath,
        Buffer.alloc(origLen, 0x41 + (i % 26)),
      );
      const reply = await rawCommand(busySock, 'GET bundle\n');
      expect(reply).toBe('ERR bundle-invalid\n');
    }
  });

  it('bridges loopback HTTP to IPv4 and allowlisted IPv6 ::1 listeners', async () => {
    const runtimeIpv6Loopback = await runAsync('python3', [
      '-c',
      [
        'import socket',
        'try:',
        '    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)',
        '    s.bind(("::1", 0)); s.listen(1)',
        '    c = socket.create_connection(s.getsockname()[:2], timeout=1)',
        '    c.close(); s.close(); print(1)',
        'except OSError:',
        '    print(0)',
      ].join('\n'),
    ]);
    expect(runtimeIpv6Loopback.status, runtimeIpv6Loopback.stderr).toBe(0);
    expect(['0', '1']).toContain(runtimeIpv6Loopback.stdout.trim());
    const ipv6Loopback = runtimeIpv6Loopback.stdout.trim() === '1';

    const root = mkdtempSync('/tmp/qc-bridge-v6-');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const proxySock = join(root, 'm.sock');
    const responseBody = 'synthetic-v6-nonce';
    let holdHealthResponse = false;
    const upstream = net.createServer({ allowHalfOpen: true }, (sock) => {
      sock.once('data', () => {
        if (holdHealthResponse) return;
        sock.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${responseBody.length}\r\nConnection: close\r\n\r\n${responseBody}`,
        );
      });
    });
    await new Promise((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(proxySock, resolve);
    });
    cleanups.push(() => {
      upstream.closeAllConnections();
      upstream.close();
    });

    const httpHealth = async (host, port) =>
      new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port }, () => {
          client.end('GET /__health HTTP/1.1\r\nConnection: close\r\n\r\n');
        });
        client.setTimeout(5_000, () => {
          client.destroy(
            new Error(`HTTP health timed out for ${host}:${port}`),
          );
        });
        const chunks = [];
        client.on('data', (chunk) => chunks.push(chunk));
        client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        client.on('error', reject);
      });

    for (const { listen, holdResponse = false } of [
      { listen: '127.0.0.1' },
      ...(ipv6Loopback ? [{ listen: '::1' }] : []),
      { listen: 'localhost' },
      { listen: '0.0.0.0' },
      { listen: '127.0.0.1', holdResponse: true },
    ]) {
      holdHealthResponse = holdResponse;
      const bridge = spawn(
        'python3',
        [
          GUEST_VSOCK_PY,
          'model-bridge',
          '--unix',
          proxySock,
          '--listen',
          listen,
          '--local-port',
          '0',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      cleanups.push(() => {
        if (bridge.exitCode === null) bridge.kill('SIGTERM');
      });
      let stderr = '';
      bridge.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      try {
        if (listen === '0.0.0.0') {
          const [code] = await once(bridge, 'close');
          expect(code).toBe(1);
          expect(stderr).toContain(
            'model-bridge refuses non-loopback listen address',
          );
          continue;
        }

        const [ready] = await Promise.race([
          once(bridge.stdout, 'data'),
          once(bridge, 'exit').then(([code]) => {
            throw new Error(`bridge exited ${code}: ${stderr}`);
          }),
        ]);
        const readyInfo = JSON.parse(ready.toString('utf8').trim());
        const healthPromise = httpHealth(readyInfo.host, readyInfo.port);
        if (holdResponse) {
          await expect(healthPromise).rejects.toThrow('HTTP health timed out');
        } else {
          const health = await healthPromise;
          expect(health).toContain('200 OK');
          expect(health.endsWith(responseBody)).toBe(true);
        }
      } finally {
        if (bridge.exitCode === null && bridge.signalCode === null) {
          const exited = once(bridge, 'exit');
          bridge.kill('SIGTERM');
          await exited;
        }
      }
    }
  });

  // Node uses Windows named pipes, not the AF_UNIX peer required here.
  it.skipIf(process.platform === 'win32')(
    'rejects hostile bundle frames without promoting temporary guest inputs',
    async () => {
      const root = mkdtempSync('/tmp/qc-bad-input-frames-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const payload = Buffer.from('boom');
      const cases = [
        {
          name: 'truncated',
          declaredBytes: 1024,
          header: 'OK 1024\n',
          response: Buffer.from('abc'),
          error: 'truncated payload (3/1024 bytes)',
        },
        {
          name: 'oversize',
          declaredBytes: 4,
          header: `OK ${128 * 1024 * 1024 + 1}\n`,
          response: Buffer.alloc(0),
          error: 'declared size 134217729 exceeds max 134217728',
        },
        {
          name: 'malformed',
          declaredBytes: 4,
          header: 'OK four\n',
          response: payload,
          error: "malformed host header: 'OK four'",
        },
        {
          name: 'trailing',
          declaredBytes: 4,
          header: 'OK 4\n',
          response: Buffer.from('boomTRAILING'),
          error: 'unexpected trailing bytes after declared payload',
        },
        {
          name: 'digest',
          declaredBytes: 4,
          header: 'OK 4\n',
          response: payload,
          error: 'bundle integrity mismatch: got 4B/',
        },
      ];

      for (const testCase of cases) {
        const manifestBytes = buildInputManifest({
          runId: `bad-${testCase.name}`,
          baseRefOid: 'a'.repeat(40),
          headRefOid: 'b'.repeat(40),
          bundleSha256: 'c'.repeat(64),
          bundleBytes: testCase.declaredBytes,
          entropyHex: '01'.repeat(32),
        }).manifestBytes;
        const socketPath = join(root, `${testCase.name}.sock`);
        let requests = 0;
        const server = net.createServer((socket) => {
          socket.once('data', (data) => {
            if (requests === 0) {
              expect(data.toString('utf8')).toBe('GET manifest\n');
              socket.end(
                Buffer.concat([
                  Buffer.from(`OK ${manifestBytes.length}\n`),
                  manifestBytes,
                ]),
              );
            } else {
              expect(data.toString('utf8')).toBe('GET bundle\n');
              socket.end(
                Buffer.concat([
                  Buffer.from(testCase.header),
                  testCase.response,
                ]),
              );
            }
            requests += 1;
          });
        });
        await new Promise((resolve) => server.listen(socketPath, resolve));
        const outDir = join(root, testCase.name);
        try {
          const result = await runAsync('python3', [
            GUEST_VSOCK_PY,
            'fetch-inputs',
            '--unix',
            socketPath,
            '--out',
            outDir,
          ]);
          expect(result.status, result.stderr).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain(testCase.error);
          expect(requests).toBe(2);
          expect(readdirSync(outDir)).toEqual([]);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'cleans scratch storage when bundle output-parent creation is not writable',
    () => {
      const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
      const scratchParent = mkdtempSync(
        join(tmpdir(), 'qc-bundle-scratch-parent-'),
      );
      cleanups.push(() =>
        rmSync(scratchParent, { recursive: true, force: true }),
      );
      const protectedParent = join(root, 'write-protected-parent');
      const outPath = join(protectedParent, 'child', 'round.bundle');
      const previousTmp = process.env.TMPDIR;
      mkdirSync(protectedParent);
      chmodSync(protectedParent, 0o500);
      process.env.TMPDIR = scratchParent;
      try {
        expect(tmpdir()).toBe(scratchParent);
        expect(() =>
          createRoundInputBundle({
            repoDir,
            baseRefOid,
            headRefOid,
            outPath,
          }),
        ).toThrow(/EACCES|EPERM/);
        expect(readdirSync(scratchParent)).toEqual([]);
        expect(readdirSync(protectedParent)).toEqual([]);
        expect(existsSync(outPath)).toBe(false);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
        chmodSync(protectedParent, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects an ordinary-file output parent before creating scratch storage',
    () => {
      const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
      const scratchParent = mkdtempSync(
        join(tmpdir(), 'qc-bundle-scratch-parent-'),
      );
      cleanups.push(() =>
        rmSync(scratchParent, { recursive: true, force: true }),
      );
      const notDirectory = join(root, 'plain-file');
      writeFileSync(notDirectory, 'intentional parent obstruction\n');
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = scratchParent;
      try {
        expect(() =>
          createRoundInputBundle({
            repoDir,
            baseRefOid,
            headRefOid,
            outPath: join(notDirectory, 'child', 'round.bundle'),
          }),
        ).toThrow(/ENOTDIR/);
        expect(readdirSync(scratchParent)).toEqual([]);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves the original error when scratch storage cannot be created',
    () => {
      const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
      const scratchParent = mkdtempSync(
        join(tmpdir(), 'qc-bundle-scratch-parent-'),
      );
      cleanups.push(() =>
        rmSync(scratchParent, { recursive: true, force: true }),
      );
      const missingScratchRoot = join(scratchParent, 'missing');
      const outPath = join(root, 'round.bundle');
      const previousTmp = process.env.TMPDIR;
      process.env.TMPDIR = missingScratchRoot;
      try {
        expect(() =>
          createRoundInputBundle({
            repoDir,
            baseRefOid,
            headRefOid,
            outPath,
          }),
        ).toThrow(/ENOENT/);
        expect(existsSync(outPath)).toBe(false);
        expect(readdirSync(scratchParent)).toEqual([]);
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
      }
    },
  );
});
