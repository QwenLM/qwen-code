/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { arePermissionBitsEnforced } from '../../packages/cli/src/test-utils/permission-bits.js';
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

const BACKPRESSURE_DRIVER = fileURLToPath(
  new URL('./verify-pr-vm-backpressure-driver.cjs', import.meta.url),
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

function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    let bundleTooLarge;
    try {
      createRoundInputBundle({
        repoDir,
        baseRefOid,
        headRefOid,
        outPath: join(root, 'tiny.bundle'),
        maxBundleBytes: 10,
      });
    } catch (error) {
      bundleTooLarge = error;
    }
    expect(bundleTooLarge).toBeInstanceOf(Error);
    expect(bundleTooLarge.message).toContain('exceeds allowed range');
    expect(bundleTooLarge.code).toBe('ENOBUFS');
    expect(bundleTooLarge.cause?.code).toBe('ENOBUFS');
    expect(existsSync(join(root, 'tiny.bundle'))).toBe(false);
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

  it.skipIf(process.platform === 'win32')(
    'refuses aliased or nested materialize directories before git initialization',
    () => {
      const { root, repoDir, baseRefOid, headRefOid } = makeFixtureRepo();
      const bundlePath = join(root, 'round.bundle');
      createRoundInputBundle({
        repoDir,
        baseRefOid,
        headRefOid,
        outPath: bundlePath,
      });
      const sameDir = join(root, 'same');
      const nestedBase = join(root, 'nested-base');
      const nestedHead = join(nestedBase, 'child-head');
      const aliasTarget = join(root, 'alias-target');
      const aliasLink = join(root, 'alias-link');
      symlinkSync(aliasTarget, aliasLink, 'dir');
      const invalidPairs = [
        [sameDir, `${sameDir}/../same`],
        [nestedBase, nestedHead],
        [nestedHead, nestedBase],
        [aliasTarget, aliasLink],
      ];
      mkdirSync(join(root, 'CaseAlias'));
      const caseAlias = [join(root, 'CaseAlias'), join(root, 'casealias')];
      if (
        existsSync(caseAlias[1]) &&
        ['dev', 'ino'].every(
          (key) => statSync(caseAlias[0])[key] === statSync(caseAlias[1])[key],
        )
      ) {
        invalidPairs.push(
          caseAlias,
          [caseAlias[0], join(caseAlias[1], 'nested-head')],
          [join(caseAlias[0], 'nested-base'), caseAlias[1]],
        );
      }
      for (const [baseDir, headDir] of invalidPairs) {
        expect(() =>
          materializeTwoOidWorktrees({
            bundlePath,
            baseRefOid,
            headRefOid,
            baseDir,
            headDir,
          }),
        ).toThrow(/distinct, non-nested directories/);
        expect(existsSync(join(baseDir, '.git'))).toBe(false);
        expect(existsSync(join(headDir, '.git'))).toBe(false);
      }
      const valid = materializeTwoOidWorktrees({
        bundlePath,
        baseRefOid,
        headRefOid,
        baseDir: join(root, 'prefix'),
        headDir: join(root, 'prefix-other'),
      });
      expect(readFileSync(join(valid.baseDir, 'math.mjs'), 'utf8')).toContain(
        'a - b',
      );
      expect(readFileSync(join(valid.headDir, 'math.mjs'), 'utf8')).toContain(
        'a + b',
      );
    },
  );

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

    for (const [prNumber, expected] of [
      [Number.MAX_SAFE_INTEGER + 1, null],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ]) {
      expect(
        buildInputManifest({
          runId: 'pr-limits',
          baseRefOid: base,
          headRefOid: head,
          bundleSha256: sha,
          bundleBytes: 1234,
          prNumber,
        }).manifest.prNumber,
      ).toBe(expected);
    }

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
    for (const field of ['token', 'nonce']) {
      for (const value of ['\u0085', '\ufeff', '\u001c\u0085\ufeff']) {
        expect(() =>
          buildInputManifest({
            runId: 'blank-credential',
            baseRefOid: base,
            headRefOid: head,
            bundleSha256: sha,
            bundleBytes: 1234,
            modelProxy: {
              port: 54,
              token: 't',
              nonce: 'n',
              [field]: value,
            },
          }),
        ).toThrow(`modelProxy.${field}`);
      }
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
          nodeError: 'payload length 134217729 exceeds maxBytes 134217728',
        },
        {
          name: 'malformed',
          declaredBytes: 4,
          header: 'OK four\n',
          response: payload,
          error: "malformed host header: 'OK four'",
          nodeError: 'malformed header',
        },
        {
          name: 'unicode-length',
          declaredBytes: 1,
          header: 'OK １\n',
          response: Buffer.from('x'),
          error: 'malformed host header',
          nodeError: 'malformed header',
        },
        {
          name: 'long-header',
          declaredBytes: 1,
          header: `OK ${'0'.repeat(300)}1\n`,
          response: Buffer.from('x'),
          error: 'header line exceeded maximum length',
          nodeError: 'response header too long',
        },
        {
          name: 'trailing',
          declaredBytes: 4,
          header: 'OK 4\n',
          response: Buffer.from('boomTRAILING'),
          error: 'unexpected trailing bytes after declared payload',
          nodeError: 'response exceeded declared 4 bytes',
        },
        {
          name: 'digest',
          declaredBytes: 4,
          header: 'OK 4\n',
          response: payload,
          error: 'bundle integrity mismatch: got 4B/',
          nodeError: 'bundle integrity mismatch (got 4B/',
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
          // The guest aborts mid-response on the reject paths by design.
          socket.on('error', () => {});
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
          requests = 0;
          const nodeOutDir = join(root, `node-${testCase.name}`);
          await expect(
            fetchRoundInputFromSocket({
              socketPath,
              outDir: nodeOutDir,
            }),
          ).rejects.toThrow(testCase.nodeError ?? testCase.error);
          expect(requests).toBe(2);
          expect(readdirSync(nodeOutDir)).toEqual([]);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects malformed manifests before downloading or promoting bundle bytes',
    async () => {
      const bundle = Buffer.from('boom');
      const valid = buildInputManifest({
        runId: 'manifest-types',
        repo: 'QwenLM/qwen-code',
        prNumber: 18400,
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: bundle.length,
        modelProxy: null,
        entropyHex: '01'.repeat(32),
      }).manifest;
      const cases = [
        [
          'missing-entropy',
          (manifest) => {
            delete manifest.entropyHex;
            return 'entropyHex';
          },
        ],
        [
          'invalid-oid',
          (manifest) => {
            manifest.baseRefOid = 'a'.repeat(41);
            return 'baseRefOid';
          },
        ],
        [
          'model-proxy-array',
          (manifest) => {
            manifest.modelProxy = [];
            return 'modelProxy';
          },
        ],
        [
          'zero-bundle-bytes',
          (manifest) => {
            manifest.bundleBytes = 0;
            return 'bundleBytes';
          },
        ],
        [
          'missing-pr-number',
          (manifest) => {
            delete manifest.prNumber;
            return 'prNumber';
          },
        ],
        [
          'array-entropy',
          (manifest) => {
            manifest.entropyHex = ['01'.repeat(32)];
            return 'entropyHex';
          },
        ],
        [
          'array-bundle-sha',
          (manifest) => {
            manifest.bundleSha256 = [manifest.bundleSha256];
            return 'bundleSha256';
          },
        ],
        [
          'unknown-top-level-field',
          (manifest) => {
            manifest.unexpected = 'fixture';
            return 'unknown-field';
          },
        ],
        [
          'unknown-model-proxy-field',
          (manifest) => {
            manifest.modelProxy = {
              port: 19000,
              basePath: '/v1',
              token: 'fixture-token',
              nonce: 'fixture-nonce',
              apiKey: 'fixture-not-a-secret',
            };
            return 'modelProxy';
          },
        ],
        [
          'newline-terminated-entropy',
          (manifest) => {
            manifest.entropyHex = `${'01'.repeat(32)}\n`;
            return 'entropyHex';
          },
        ],
        [
          'invalid-utf8',
          (manifest) => {
            manifest.repo = '__INVALID_UTF8_BYTE__';
            return 'decode';
          },
          'invalid manifest JSON/UTF-8',
        ],
        [
          'bom-prefixed-manifest',
          () => 'decode',
          'invalid manifest JSON/UTF-8',
        ],
        [
          'unsafe-pr-number',
          (manifest) => {
            manifest.prNumber = Number.MAX_SAFE_INTEGER + 1;
            return 'prNumber';
          },
        ],
        [
          'missing-model-proxy',
          (manifest) => {
            delete manifest.modelProxy;
            return 'modelProxy';
          },
        ],
        [
          'nullable-pr-number',
          (manifest) => {
            manifest.prNumber = null;
            return null;
          },
        ],
        [
          'nullable-model-base-path',
          (manifest) => {
            manifest.modelProxy = {
              port: 54,
              basePath: null,
              token: 'fixture-token',
              nonce: 'fixture-nonce',
            };
            return null;
          },
        ],
        [
          'integral-json-number-forms',
          (manifest) => {
            manifest.prNumber = '__INTEGRAL_PR_NUMBER__';
            manifest.bundleBytes = '__INTEGRAL_BUNDLE_BYTES__';
            manifest.modelProxy = {
              port: '__INTEGRAL_MODEL_PORT__',
              basePath: '/v1',
              token: 'fixture-token',
              nonce: 'fixture-nonce',
            };
            return null;
          },
        ],
        [
          'fractional-bundle-bytes',
          (manifest) => {
            manifest.bundleBytes = 4.5;
            return 'bundleBytes';
          },
        ],
        [
          'fractional-pr-number',
          (manifest) => {
            manifest.prNumber = 18400.5;
            return 'prNumber';
          },
        ],
        [
          'fractional-model-port',
          (manifest) => {
            manifest.modelProxy = {
              port: 54.5,
              basePath: '/v1',
              token: 'fixture-token',
              nonce: 'fixture-nonce',
            };
            return 'modelProxy.port';
          },
        ],
      ];
      cases.push([
        'non-blank-unicode-credential',
        (manifest) => {
          manifest.modelProxy = {
            port: 54,
            basePath: '/v1',
            token: '\u0085credential\u180e\ufeff',
            nonce: 'fixture-nonce',
          };
          return null;
        },
      ]);
      for (const [fieldIndex, field] of ['token', 'nonce'].entries()) {
        for (const [valueIndex, value] of [
          '\u0085',
          '\ufeff',
          '\u001c\u0085\ufeff',
        ].entries()) {
          cases.push([
            `blank-${field}-${fieldIndex}-${valueIndex}`,
            (manifest) => {
              manifest.modelProxy = {
                port: 54,
                basePath: '/v1',
                token: 'fixture-token',
                nonce: 'fixture-nonce',
                [field]: value,
              };
              return `modelProxy.${field}`;
            },
          ]);
        }
      }
      const root = mkdtempSync('/tmp/qc-input-schema-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      for (const [name, mutate, nodeExpectedField] of cases) {
        const changed = structuredClone(valid);
        const expectedField = mutate(changed);
        let manifestText = `${JSON.stringify(changed, null, 2)}\n`;
        if (name === 'integral-json-number-forms') {
          manifestText = manifestText
            .replace('"__INTEGRAL_PR_NUMBER__"', '18400.0')
            .replace('"__INTEGRAL_BUNDLE_BYTES__"', '4.0')
            .replace('"__INTEGRAL_MODEL_PORT__"', '4e0');
          expect(manifestText).not.toContain('__INTEGRAL_');
        }
        const manifestBytes = Buffer.from(manifestText, 'utf8');
        if (name === 'invalid-utf8') {
          const marker = Buffer.from('__INVALID_UTF8_BYTE__');
          const offset = manifestBytes.indexOf(marker);
          expect(offset).toBeGreaterThanOrEqual(0);
          manifestBytes.writeUInt8(0xff, offset);
        }
        const manifestFrameBytes =
          name === 'bom-prefixed-manifest'
            ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifestBytes])
            : manifestBytes;
        const socketPath = join(root, `${name}.sock`);
        let requests = 0;
        const server = net.createServer((socket) => {
          socket.on('error', () => {});
          socket.once('data', (data) => {
            requests += 1;
            if (data.toString('utf8') === 'GET manifest\n') {
              socket.end(
                Buffer.concat([
                  Buffer.from(`OK ${manifestFrameBytes.length}\n`),
                  manifestFrameBytes,
                ]),
              );
            } else {
              expect(data.toString('utf8')).toBe('GET bundle\n');
              socket.end(Buffer.concat([Buffer.from('OK 4\n'), bundle]));
            }
          });
        });
        await new Promise((resolve) => server.listen(socketPath, resolve));
        const outDir = join(root, `out-${name}`);
        try {
          const result = await runAsync('python3', [
            GUEST_VSOCK_PY,
            'fetch-inputs',
            '--unix',
            socketPath,
            '--out',
            outDir,
          ]);
          const nodeResult = await fetchRoundInputFromSocket({
            socketPath,
            outDir,
          }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          if (expectedField === null) {
            expect(result.status, result.stderr).toBe(0);
            expect(nodeResult.error).toBeUndefined();
            expect(nodeResult.value.manifest).toEqual(JSON.parse(manifestText));
            expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe(
              manifestText,
            );
            expect(readFileSync(join(outDir, 'round.bundle'))).toEqual(bundle);
            expect(requests).toBe(4);
          } else {
            expect(result.status, result.stderr).toBe(1);
            expect(result.stderr).toContain('invalid manifest');
            expect(result.stderr).toContain(expectedField);
            expect(nodeResult.error).toBeInstanceOf(Error);
            expect(nodeResult.error.message).toContain(
              nodeExpectedField ?? expectedField,
            );
            expect(readdirSync(outDir)).toEqual([]);
            expect(requests).toBe(2);
          }
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects non-finite byte limits before sockets or file creation',
    async () => {
      const root = mkdtempSync('/tmp/qc-input-config-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const socketPath = join(root, 'input.sock');
      const connections = new Set();
      let requests = 0;
      const server = net.createServer((socket) => {
        connections.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => connections.delete(socket));
        socket.once('data', () => {
          requests += 1;
          socket.end(Buffer.from('OK 4\nnull'));
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      try {
        for (const [field, value] of [
          ['maxManifestBytes', Number.NaN],
          ['maxBundleBytes', Number.POSITIVE_INFINITY],
        ]) {
          const outDir = join(root, `out-${field}`);
          const error = await fetchRoundInputFromSocket({
            socketPath,
            outDir,
            [field]: value,
          }).catch((cause) => cause);
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toContain(field);
          expect(error.message).toContain('positive safe integer');
          expect(requests).toBe(0);
          expect(connections.size).toBe(0);
          expect(existsSync(outDir)).toBe(false);
        }
      } finally {
        for (const socket of connections) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rolls back every promoted input when a later promotion fails',
    async () => {
      const root = mkdtempSync('/tmp/qc-input-promotion-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const bundle = Buffer.from('boom');
      const { manifestBytes } = buildInputManifest({
        runId: 'promote-failure',
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: bundle.length,
        entropyHex: '01'.repeat(32),
      });
      const socketPath = join(root, 'input.sock');
      const requests = [];
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', (data) => {
          const request = data.toString('utf8');
          requests.push(request);
          if (request === 'GET manifest\n') {
            socket.end(
              Buffer.concat([
                Buffer.from(`OK ${manifestBytes.length}\n`),
                manifestBytes,
              ]),
            );
          } else if (request === 'GET bundle\n') {
            socket.end(
              Buffer.concat([Buffer.from(`OK ${bundle.length}\n`), bundle]),
            );
          } else {
            socket.destroy();
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      try {
        for (const client of ['python', 'node']) {
          const outDir = join(root, client);
          mkdirSync(outDir);
          writeFileSync(join(outDir, 'sentinel.txt'), 'keep');
          mkdirSync(join(outDir, 'entropy.hex'));
          if (client === 'python') {
            const result = await runAsync('python3', [
              GUEST_VSOCK_PY,
              'fetch-inputs',
              '--unix',
              socketPath,
              '--out',
              outDir,
            ]);
            expect(result.status, result.stderr).toBe(1);
            expect(result.stderr).toContain('entropy.hex');
          } else {
            await expect(
              fetchRoundInputFromSocket({ socketPath, outDir }),
            ).rejects.toThrow('entropy.hex');
          }
          expect(requests).toEqual(['GET manifest\n', 'GET bundle\n']);
          expect(readdirSync(outDir)).toEqual(['entropy.hex', 'sentinel.txt']);
          expect(readdirSync(join(outDir, 'entropy.hex'))).toEqual([]);
          expect(readFileSync(join(outDir, 'sentinel.txt'), 'utf8')).toBe(
            'keep',
          );
          requests.length = 0;
        }
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'bounds guest bridge concurrency and restores capacity after bursts',
    async () => {
      const root = mkdtempSync('/tmp/qc-bridge-budget-');
      const clients = [];
      const clientMeta = new Map();
      const nodeEvents = [];
      let nextClientId = 0;
      let currentBurst = 0;
      const traceNode = (event, fields = {}) => {
        nodeEvents.push({ event, ...fields });
      };
      cleanups.push(() => {
        for (const client of clients) client.destroy();
        rmSync(root, { recursive: true, force: true });
      });
      const upstreamPath = join(root, 'upstream.sock');
      let upstreamActive = 0;
      let upstreamPeak = 0;
      let upstreamConnections = 0;
      const upstreamSockets = new Set();
      const upstream = net.createServer((socket) => {
        upstreamSockets.add(socket);
        upstreamActive += 1;
        upstreamConnections += 1;
        upstreamPeak = Math.max(upstreamPeak, upstreamActive);
        socket.on('error', () => {});
        socket.on('close', () => {
          upstreamActive -= 1;
          upstreamSockets.delete(socket);
        });
        socket.on('data', (data) => socket.end(data));
      });
      writeFileSync(
        join(root, 'sitecustomize.py'),
        `import atexit
import json
import os
import socket
import sys
import threading
import time

sys.setswitchinterval(0.000001)
trace_fd = os.open(os.environ['QC_ATTRIB_PY_TRACE'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
trace_lock = threading.Lock()

def trace_event(event, **fields):
    with trace_lock:
        record = {'event': event, 'pid': os.getpid(), 'tid': threading.get_native_id(), 'time': time.monotonic(), **fields}
        os.write(trace_fd, (json.dumps(record, default=repr) + '\\n').encode())

peer_sockets_by_address = {}

def socket_identity(sock):
    identity = {}
    try:
        fd = sock.fileno()
        identity['fd'] = fd
        identity['inode'] = os.fstat(fd).st_ino if fd >= 0 else None
        identity['local'] = sock.getsockname()
        identity['peer'] = sock.getpeername()
    except OSError as error:
        identity['error'] = str(error)
    return identity

counts = {'accepted': 0, 'handled': 0, 'rejected': 0}
counts_lock = threading.Lock()
snapshot_path = os.path.join(os.environ['PYTHONPATH'], 'bridge-epochs.json')
temporary_path = snapshot_path + '.tmp'

def checkpoint():
    if not (
        (counts['accepted'] > 0 and counts['accepted'] % 16 == 0)
        or (counts['handled'] > 0 and counts['handled'] % 64 == 0)
        or (counts['rejected'] > 0 and counts['rejected'] % 32 == 0)
        or (
            counts['accepted'] > 0
            and counts['accepted'] == counts['handled'] + counts['rejected']
        )
    ):
        return
    with open(temporary_path, 'w', encoding='utf-8') as output:
        json.dump(counts, output)
        output.write('\\n')
    os.replace(temporary_path, snapshot_path)

def record(kind):
    with counts_lock:
        counts[kind] += 1
        trace_event('record', kind=kind, counts=dict(counts))
        checkpoint()

class ScannedSocket(socket.socket):
    def listen(self, *args):
        result = super().listen(*args)
        trace_event('listen', fd=self.fileno(), listener=self.getsockname())
        return result

    def accept(self):
        client, address = super().accept()
        client.is_scanned_client = True
        client.accept_seq = counts['accepted'] + 1
        identity = socket_identity(client)
        previous = peer_sockets_by_address.get(address)
        if previous is not None:
            trace_event('duplicate-peer', previous=previous, current=identity)
        peer_sockets_by_address[address] = identity
        record('accepted')
        trace_event('accepted', listener=self.getsockname(), peer=address, client_fd=client.fileno(), client_type=type(client).__name__, accepted=counts['accepted'], accept_seq=client.accept_seq, identity=identity)
        return client, address

    def close(self):
        is_rejected = (
            getattr(self, 'is_scanned_client', False)
            and threading.current_thread() is threading.main_thread()
        )
        if is_rejected:
            record('rejected')
        if getattr(self, 'is_scanned_client', False):
            trace_event('socket_close', accept_seq=getattr(self, 'accept_seq', None), identity=socket_identity(self), is_rejected=is_rejected)
        return super().close()

class ScannedThread(threading.Thread):
    def run(self):
        scanned_client = self._args[0] if self._args else None
        handles_scanned_client = (
            getattr(self._target, '__name__', None) == 'handle_bridge_client'
        )
        try:
            super().run()
        finally:
            if handles_scanned_client:
                record('handled')
                if scanned_client is not None:
                    trace_event('handler_finished', accept_seq=getattr(scanned_client, 'accept_seq', None), client_fd=scanned_client.fileno())

socket.socket = ScannedSocket
threading.Thread = ScannedThread

def write_final_counts():
    with counts_lock:
        checkpoint()

atexit.register(write_final_counts)
`,
      );
      const epochPath = join(root, 'bridge-epochs.json');
      const readEpoch = () => {
        if (!existsSync(epochPath)) {
          return { accepted: 0, handled: 0, rejected: 0 };
        }
        return JSON.parse(readFileSync(epochPath, 'utf8'));
      };
      const bridge = spawn(
        'python3',
        [
          GUEST_VSOCK_PY,
          'model-bridge',
          '--unix',
          upstreamPath,
          '--listen',
          '127.0.0.1',
          '--local-port',
          '0',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            PYTHONPATH: root,
            QC_ATTRIB_PY_TRACE: join(root, 'python-attribution.jsonl'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      cleanups.push(async () => {
        for (const client of clients) client.destroy();
        if (bridge.exitCode === null && bridge.signalCode === null) {
          const exited = once(bridge, 'exit');
          bridge.kill('SIGTERM');
          await exited;
        }
      });
      let stderr = '';
      bridge.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      const [ready] = await Promise.race([
        once(bridge.stdout, 'data'),
        once(bridge, 'exit').then(([code]) => {
          throw new Error(`bridge exited ${code}: ${stderr}`);
        }),
      ]);
      const address = JSON.parse(ready.toString('utf8').trim());
      traceNode('bridge_ready', { bridgePid: bridge.pid, address });
      const connectClient = async (purpose = 'burst') => {
        const meta = {
          id: ++nextClientId,
          burst: currentBurst,
          purpose,
          localPort: null,
        };
        clientMeta.set(meta.id, meta);
        const client = net.createConnection(address.port, '127.0.0.1');
        clientMeta.get(meta.id).client = client;
        client.on('connect', () => {
          meta.localPort = client.localPort;
        });
        client.on('error', (error) => {
          meta.errorCode = error.code ?? error.name;
        });
        client.on('close', () => {
          traceNode('client_close', { ...meta, client: undefined });
        });
        clients.push(client);
        client.on('error', () => {});
        await new Promise((resolve) => {
          client.once('connect', resolve);
          client.once('close', resolve);
        });
        return client;
      };
      const burst = async () => {
        currentBurst += 1;
        const before = upstreamConnections;
        const epochBefore = readEpoch();
        traceNode('burst_before', {
          burst: currentBurst,
          before,
          epochBefore,
        });
        const sockets = await Promise.all(
          Array.from({ length: 96 }, () => connectClient()),
        );
        await expect
          .poll(() => upstreamConnections - before, { timeout: 5_000 })
          .toBe(64);
        expect(upstreamPeak).toBeLessThanOrEqual(64);
        expect(upstreamConnections - before).toBe(64);
        for (const socket of sockets) socket.destroy();
        await expect.poll(() => upstreamActive, { timeout: 5_000 }).toBe(0);
        // Drain actual accept/handler/reject events before the next batch.
        await expect
          .poll(
            () => {
              const { accepted, handled, rejected } = readEpoch();
              return {
                accepted: accepted - epochBefore.accepted,
                completed:
                  handled +
                  rejected -
                  epochBefore.handled -
                  epochBefore.rejected,
              };
            },
            { timeout: 5_000 },
          )
          .toSatisfy(
            ({ accepted, completed }) =>
              accepted >= 96 && accepted === completed,
          );
        const epochAfter = readEpoch();
        traceNode('epoch_after', {
          burst: currentBurst,
          epochBefore,
          epochAfter,
        });
        expect(epochAfter.accepted).toBeGreaterThanOrEqual(
          epochBefore.accepted + 96,
        );
        expect(epochAfter.handled).toBeGreaterThanOrEqual(epochBefore.handled);
        expect(epochAfter.rejected).toBeGreaterThanOrEqual(
          epochBefore.rejected,
        );
        expect(epochAfter.handled + epochAfter.rejected).toBe(
          epochAfter.accepted,
        );
      };
      try {
        const faultEpochBefore = readEpoch();
        expect(upstream.listening).toBe(false);
        expect(existsSync(upstreamPath)).toBe(false);
        await Promise.all(
          Array.from({ length: 64 }, () => connectClient('upstream-missing')),
        );
        await expect
          .poll(
            () => {
              const { accepted, handled, rejected } = readEpoch();
              return {
                accepted: accepted - faultEpochBefore.accepted,
                completed:
                  handled +
                  rejected -
                  faultEpochBefore.handled -
                  faultEpochBefore.rejected,
              };
            },
            { timeout: 5_000 },
          )
          .toSatisfy(
            ({ accepted, completed }) =>
              accepted >= 64 && accepted === completed,
          );
        expect(upstreamConnections).toBe(0);
        await new Promise((resolve, reject) => {
          upstream.once('error', reject);
          upstream.listen(upstreamPath, resolve);
        });
        expect(upstream.listening).toBe(true);
        cleanups.push(async () => {
          for (const socket of upstreamSockets) socket.destroy();
          await new Promise((resolve) => upstream.close(resolve));
        });
        for (let index = 0; index < 3; index += 1) {
          await burst();
          await burst();
        }
        for (let index = 0; index < 8; index += 1) {
          const client = await connectClient('health');
          const closed = once(client, 'close');
          const echoed = once(client, 'data');
          client.end('healthy-after-budget-overflow');
          expect((await echoed)[0].toString('utf8')).toBe(
            'healthy-after-budget-overflow',
          );
          await closed;
        }
        await expect.poll(() => upstreamActive).toBe(0);
        expect(stderr).toBe(
          'model bridge: connection limit 64 reached; refusing extra client\n',
        );
      } catch (error) {
        const directory = mkdtempSync('/tmp/qc-bridge-attribution-');
        const peerTracePath = join(root, 'python-attribution.jsonl');
        let currentEpoch;
        try {
          currentEpoch = readEpoch();
        } catch (epochError) {
          currentEpoch = { readError: epochError.message };
        }
        const report = {
          phase: 'before-cleanup',
          error: error.stack,
          bridgePid: bridge.pid,
          address,
          root,
          epoch: currentEpoch,
          epochBytes: existsSync(epochPath)
            ? readFileSync(epochPath, 'utf8')
            : null,
          upstream: {
            active: upstreamActive,
            peak: upstreamPeak,
            connections: upstreamConnections,
          },
          nodeEvents,
          clientMeta: Array.from(clientMeta.values()).map(
            ({ client, ...meta }) => ({
              ...meta,
              destroyed: client.destroyed,
            }),
          ),
          peerEvents: existsSync(peerTracePath)
            ? readFileSync(peerTracePath, 'utf8')
            : null,
          stderr,
        };
        try {
          writeFileSync(
            join(directory, 'failure.json'),
            `${JSON.stringify(report, null, 2)}\n`,
            { mode: 0o600 },
          );
        } catch (dumpError) {
          throw new AggregateError(
            [error, dumpError],
            'bridge test and attribution dump both failed',
            { cause: error },
          );
        }
        console.error(`bridge failure attribution: ${directory}`);
        throw error;
      } finally {
        for (const client of clients) client.destroy();
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'honors writer backpressure without changing streamed input bytes',
    () => {
      const root = mkdtempSync('/tmp/qc-backpressure-test-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const modulePath = fileURLToPath(
        new URL('../../scripts/verify-pr-vm-channel.mjs', import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [BACKPRESSURE_DRIVER, modulePath],
        {
          encoding: 'utf8',
          cwd: root,
          env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
          timeout: 30_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const observation = JSON.parse(result.stdout);
      expect(observation.payloadBytes).toBe(4 * 1024 * 1024 + 123);
      expect(observation.accepted).toBe(observation.payloadBytes);
      expect(observation.maxWriterWritableLength).toBeLessThan(256 * 1024);
      expect(observation.finalBytes).toBe(observation.payloadBytes);
      expect(observation.finalShaMatches).toBe(true);
      expect(observation.completedWriteCallbacksAtReturn).toBeGreaterThan(0);
      expect(observation.pauseCalls).toBeGreaterThan(0);
      expect(observation.resumeCalls).toBeGreaterThan(0);
      expect(observation.requests).toEqual(['GET manifest\n', 'GET bundle\n']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects file-write failures instead of promoting a truncated Node bundle',
    async () => {
      const root = mkdtempSync('/tmp/qc-input-write-limit-');
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const bundle = Buffer.alloc(8192, 0x42);
      const manifestBytes = buildInputManifest({
        runId: 'node-write-failure',
        repo: 'QwenLM/qwen-code',
        prNumber: 18400,
        baseRefOid: 'a'.repeat(40),
        headRefOid: 'b'.repeat(40),
        bundleSha256: createHash('sha256').update(bundle).digest('hex'),
        bundleBytes: bundle.length,
        entropyHex: '01'.repeat(32),
      }).manifestBytes;
      const socketPath = join(root, 'limited-input.sock');
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', (data) => {
          if (data.toString('utf8') === 'GET manifest\n') {
            socket.end(
              Buffer.concat([
                Buffer.from(`OK ${manifestBytes.length}\n`),
                manifestBytes,
              ]),
            );
          } else {
            expect(data.toString('utf8')).toBe('GET bundle\n');
            socket.end(
              Buffer.concat([Buffer.from(`OK ${bundle.length}\n`), bundle]),
            );
          }
        });
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));
      const outDir = join(root, 'outputs');
      const driver = join(root, 'limited-fetch.mjs');
      const channelUrl = pathToFileURL(
        fileURLToPath(
          new URL('../../scripts/verify-pr-vm-channel.mjs', import.meta.url),
        ),
      ).href;
      writeFileSync(
        driver,
        `import { readdirSync } from 'node:fs';
import { fetchRoundInputFromSocket } from ${JSON.stringify(channelUrl)};
try {
  await fetchRoundInputFromSocket({ socketPath: process.argv[2], outDir: process.argv[3] });
  process.stdout.write(JSON.stringify({ error: 'promoted-truncated-input' }));
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code, files: readdirSync(process.argv[3]) }));
  process.exitCode = 1;
}
`,
      );
      try {
        const result = await runAsync(
          'bash',
          [
            '-c',
            'ulimit -f 1\nexec "$1" "$2" "$3" "$4"',
            'qc-input-write-limit',
            process.execPath,
            driver,
            socketPath,
            outDir,
          ],
          { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } },
        );
        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          error: 'EFBIG',
          files: [],
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

  it.skipIf(!arePermissionBitsEnforced())(
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
