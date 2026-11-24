#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-to-guest read-only input channel and loopback model-proxy bridge for
 * NIC-less hardware-isolated `/verify-pr` microVMs (D2/D3/D4/D8):
 *
 *   1. `createRoundInputBundle()` — packages ONLY two explicit commit OIDs
 *      (`baseRefOid`, `headRefOid`) from a trusted host checkout into a
 *      standalone git bundle using a disposable read-only alternates repo,
 *      never mutating the host repo or exposing other branches/config/secrets.
 *   2. `buildInputManifest()` — builds the canonical `verify-pr-input-v1`
 *      manifest containing per-round entropy, bundle digest/size, and
 *      ephemeral model-proxy bearer coordinates (never the real upstream key),
 *      returning a deterministic `trustedInputDigest`.
 *   3. `startInputServer()` — serves `GET manifest\n` and `GET bundle\n` over
 *      a private per-round Unix domain socket (virtio-vsock port 53 by
 *      default), enforcing read budget, live `token.json` revocation, and
 *      dev/ino + libuv `uv_pipe_close()` replacement protection.
 *   4. `fetchRoundInputFromSocket()`, `materializeTwoOidWorktrees()`, and
 *      `startLoopbackToUdsBridge()` — pure Node client/bridge helpers for
 *      guest verification and unit/integration testing.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isTokenFileRevoked } from './verify-pr-model-proxy.mjs';
import { validateSocketPathLength } from './verify-pr-vm-collector.mjs';

export const INPUT_SCHEMA_VERSION = 'verify-pr-input-v1';
export const DEFAULT_INPUT_VSOCK_PORT = 53;
export const DEFAULT_MODEL_VSOCK_PORT = 54;
export const DEFAULT_MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_INPUT_READS = 4;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_COMMAND_BYTES = 128;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FORBIDDEN_MANIFEST_KEYS = new Set([
  'apiKey',
  'api_key',
  'upstreamBaseUrl',
  'upstreamUrl',
  'REVIEW_OPENAI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

const HARDENED_GIT_PREFIX = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'core.excludesFile=',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.clean=',
];

function assertHex40(label, value) {
  if (typeof value !== 'string' || !HEX40.test(value)) {
    throw new Error(`${label} must be a 40-char lowercase hex commit OID`);
  }
}

function assertPositiveSafeInt(label, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function sha256FileChunked(filePath) {
  const hash = createHash('sha256');
  const fd = openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(256 * 1024);
  let total = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
    }
  } finally {
    closeSync(fd);
  }
  return { digest: hash.digest('hex'), bytes: total };
}

function runHardenedGit(args, { cwd = undefined, env = process.env } = {}) {
  const res = spawnSync('git', [...HARDENED_GIT_PREFIX, ...args], {
    cwd,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} failed (exit ${res.status}): ${(res.stderr || res.stdout || '').trim()}`,
    );
  }
  return res.stdout;
}

/**
 * Packages ONLY `baseRefOid` and `headRefOid` from a trusted host checkout
 * into a standalone git bundle without mutating `repoDir` or leaking other
 * branches, stashes, tags, or `.git/config` credentials.
 */
export function createRoundInputBundle({
  repoDir,
  baseRefOid,
  headRefOid,
  outPath,
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
}) {
  if (typeof repoDir !== 'string' || repoDir.trim() === '') {
    throw new Error('repoDir must be a non-empty path');
  }
  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new Error('outPath must be a non-empty path');
  }
  assertHex40('baseRefOid', baseRefOid);
  assertHex40('headRefOid', headRefOid);
  assertPositiveSafeInt('maxBundleBytes', maxBundleBytes);

  try {
    const existing = lstatSync(outPath);
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      throw new Error(`refusing to overwrite non-regular outPath ${outPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const absRepo = resolve(repoDir);
  const commonDir = runHardenedGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: absRepo },
  ).trim();

  for (const [label, oid] of [
    ['baseRefOid', baseRefOid],
    ['headRefOid', headRefOid],
  ]) {
    const type = runHardenedGit(['cat-file', '-t', oid], {
      cwd: absRepo,
    }).trim();
    if (type !== 'commit') {
      throw new Error(`${label} (${oid}) is not a commit (got ${type})`);
    }
  }

  const scratchBare = mkdtempSync(join(tmpdir(), 'qc-round-bundle-'));
  const absOut = resolve(outPath);
  mkdirSync(dirname(absOut), { recursive: true, mode: 0o700 });
  const tmpOut = `${absOut}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

  try {
    runHardenedGit(['init', '--bare', '--quiet', scratchBare]);
    writeFileSync(
      join(scratchBare, 'objects', 'info', 'alternates'),
      `${join(commonDir, 'objects')}\n`,
    );
    mkdirSync(join(scratchBare, 'refs', 'verify'), { recursive: true });
    writeFileSync(
      join(scratchBare, 'refs', 'verify', 'base'),
      `${baseRefOid}\n`,
    );
    writeFileSync(
      join(scratchBare, 'refs', 'verify', 'head'),
      `${headRefOid}\n`,
    );
    runHardenedGit([
      '--git-dir',
      scratchBare,
      'bundle',
      'create',
      tmpOut,
      'refs/verify/base',
      'refs/verify/head',
    ]);
    chmodSync(tmpOut, 0o600);
    const { digest, bytes } = sha256FileChunked(tmpOut);
    if (bytes === 0 || bytes > maxBundleBytes) {
      throw new Error(
        `bundle size ${bytes} bytes exceeds allowed range (1..${maxBundleBytes})`,
      );
    }
    renameSync(tmpOut, absOut);
    return {
      bundlePath: absOut,
      bundleSha256: digest,
      bundleBytes: bytes,
    };
  } catch (error) {
    try {
      unlinkSync(tmpOut);
    } catch {
      // Ignore cleanup error.
    }
    throw error;
  } finally {
    rmSync(scratchBare, { recursive: true, force: true });
  }
}

/**
 * Builds the canonical read-only input manifest delivered to the guest over
 * vsock port 53. Rejects any accidental upstream secret fields.
 */
export function buildInputManifest({
  runId,
  repo = '',
  prNumber = null,
  baseRefOid,
  headRefOid,
  bundleSha256,
  bundleBytes,
  modelProxy = null,
  entropyHex = null,
}) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(runId)) {
    throw new Error('runId must match /^[A-Za-z0-9._-]{1,32}$/');
  }
  assertHex40('baseRefOid', baseRefOid);
  assertHex40('headRefOid', headRefOid);
  if (typeof bundleSha256 !== 'string' || !HEX64.test(bundleSha256)) {
    throw new Error('bundleSha256 must be a 64-char lowercase hex SHA-256');
  }
  assertPositiveSafeInt('bundleBytes', bundleBytes);

  const entropy = entropyHex ?? randomBytes(32).toString('hex');
  if (typeof entropy !== 'string' || !HEX64.test(entropy)) {
    throw new Error('entropyHex must be a 64-char lowercase hex string');
  }

  let safeModelProxy = null;
  if (modelProxy !== null) {
    if (typeof modelProxy !== 'object' || Array.isArray(modelProxy)) {
      throw new Error('modelProxy must be an object or null');
    }
    for (const key of Object.keys(modelProxy)) {
      if (FORBIDDEN_MANIFEST_KEYS.has(key)) {
        throw new Error(
          `refusing to embed forbidden secret field ${JSON.stringify(key)} in guest manifest`,
        );
      }
    }
    assertPositiveSafeInt('modelProxy.port', modelProxy.port);
    if (
      typeof modelProxy.token !== 'string' ||
      modelProxy.token.trim() === ''
    ) {
      throw new Error('modelProxy.token must be a non-empty string');
    }
    if (
      typeof modelProxy.nonce !== 'string' ||
      modelProxy.nonce.trim() === ''
    ) {
      throw new Error('modelProxy.nonce must be a non-empty string');
    }
    const basePath =
      typeof modelProxy.basePath === 'string' ? modelProxy.basePath : '';
    safeModelProxy = {
      port: modelProxy.port,
      basePath,
      token: modelProxy.token,
      nonce: modelProxy.nonce,
    };
  }

  const manifest = {
    schemaVersion: INPUT_SCHEMA_VERSION,
    runId,
    repo: typeof repo === 'string' ? repo : '',
    prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
    baseRefOid,
    headRefOid,
    bundleSha256,
    bundleBytes,
    entropyHex: entropy,
    modelProxy: safeModelProxy,
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  if (manifestBytes.length > DEFAULT_MAX_MANIFEST_BYTES) {
    throw new Error(
      `manifest exceeds max size ${DEFAULT_MAX_MANIFEST_BYTES} bytes`,
    );
  }
  const trustedInputDigest = createHash('sha256')
    .update(manifestBytes)
    .digest('hex');

  return { manifest, manifestBytes, trustedInputDigest };
}

function removeOwnedInputSocket(socketPath, identity) {
  let st;
  try {
    st = lstatSync(socketPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, identityChanged: false, error: null };
    }
    return {
      ok: false,
      identityChanged: false,
      error: `input-socket-stat-failed:${error.code}`,
    };
  }
  if (!st.isSocket() || st.dev !== identity.dev || st.ino !== identity.ino) {
    return {
      ok: false,
      identityChanged: true,
      error: 'input-socket-identity-changed',
    };
  }
  try {
    unlinkSync(socketPath);
    return { ok: true, identityChanged: false, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: true, identityChanged: false, error: null };
    }
    return {
      ok: false,
      identityChanged: false,
      error: `input-socket-remove-failed:${error.code}`,
    };
  }
}

/**
 * Starts the host-side read-only input server on a private Unix domain socket
 * (Firecracker `v.sock_53` or vfkit `in.sock`).
 *
 * Wire protocol (one request per connection, strictly read-only):
 *   Client -> `GET manifest\n`  |  `GET bundle\n`
 *   Host   -> `OK <byteLength>\n<rawBytes>`  |  `ERR <reason>\n`
 */
export function startInputServer({
  socketPath,
  manifest,
  manifestBytes = null,
  bundlePath,
  tokenFile = null,
  vmmUid = null,
  vmmGid = null,
  maxReads = DEFAULT_MAX_INPUT_READS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxCommandBytes = DEFAULT_MAX_COMMAND_BYTES,
  maxConcurrent = 4,
}) {
  assertPositiveSafeInt('maxReads', maxReads);
  assertPositiveSafeInt('commandTimeoutMs', commandTimeoutMs);
  assertPositiveSafeInt('maxCommandBytes', maxCommandBytes);
  assertPositiveSafeInt('maxConcurrent', maxConcurrent);
  if (
    tokenFile !== null &&
    (typeof tokenFile !== 'string' || tokenFile.trim() === '')
  ) {
    throw new Error('tokenFile must be a non-empty path when provided');
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== INPUT_SCHEMA_VERSION
  ) {
    throw new Error(
      `manifest must carry schemaVersion=${INPUT_SCHEMA_VERSION}`,
    );
  }
  if (typeof bundlePath !== 'string' || bundlePath.trim() === '') {
    throw new Error('bundlePath must be a non-empty path');
  }
  const bundleStat = lstatSync(bundlePath);
  if (
    bundleStat.isSymbolicLink() ||
    !bundleStat.isFile() ||
    bundleStat.nlink !== 1 ||
    bundleStat.size !== manifest.bundleBytes
  ) {
    throw new Error(
      'bundlePath must be a single-link regular file matching manifest.bundleBytes',
    );
  }
  const bundleIdentity = { dev: bundleStat.dev, ino: bundleStat.ino };
  const lenCheck = validateSocketPathLength(socketPath);
  if (!lenCheck.ok) {
    throw new Error(`input-server: ${lenCheck.reason}`);
  }
  try {
    lstatSync(socketPath);
    throw new Error(
      `input-server: refusing existing socket path ${socketPath}`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const encodedManifest =
    manifestBytes instanceof Buffer
      ? manifestBytes
      : Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const stats = {
    servedManifest: 0,
    servedBundle: 0,
    rejectedRevoked: 0,
    rejectedBudget: 0,
    rejectedInvalid: 0,
    rejectedBusy: 0,
  };
  const activeSockets = new Set();
  let socketIdentity = null;
  let closed = false;

  const server = net.createServer((socket) => {
    if (closed || activeSockets.size >= maxConcurrent) {
      stats.rejectedBusy += 1;
      socket.end('ERR busy\n');
      socket.destroy();
      return;
    }
    activeSockets.add(socket);
    let handled = false;
    let buf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      if (!handled) {
        handled = true;
        stats.rejectedInvalid += 1;
        socket.end('ERR timeout\n');
        socket.destroy();
      }
    }, commandTimeoutMs);
    timer.unref?.();

    const finish = () => {
      clearTimeout(timer);
      activeSockets.delete(socket);
    };
    socket.once('close', finish);
    socket.once('error', () => {
      finish();
      socket.destroy();
    });

    const reject = (code, statKey) => {
      handled = true;
      clearTimeout(timer);
      stats[statKey] += 1;
      socket.end(`ERR ${code}\n`);
    };

    socket.on('data', (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > maxCommandBytes) {
          reject('command-too-long', 'rejectedInvalid');
          socket.destroy();
        }
        return;
      }
      if (nl > maxCommandBytes) {
        reject('command-too-long', 'rejectedInvalid');
        socket.destroy();
        return;
      }
      handled = true;
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');

      if (tokenFile !== null && isTokenFileRevoked(tokenFile)) {
        stats.rejectedRevoked += 1;
        socket.end('ERR token-revoked\n');
        return;
      }
      const totalServed = stats.servedManifest + stats.servedBundle;
      if (totalServed >= maxReads) {
        stats.rejectedBudget += 1;
        socket.end('ERR read-budget-exceeded\n');
        return;
      }

      if (line === 'GET manifest') {
        stats.servedManifest += 1;
        socket.write(`OK ${encodedManifest.length}\n`);
        socket.end(encodedManifest);
        return;
      }

      if (line === 'GET bundle') {
        let cur;
        try {
          cur = lstatSync(bundlePath);
        } catch {
          stats.rejectedInvalid += 1;
          socket.end('ERR bundle-unavailable\n');
          return;
        }
        if (
          cur.isSymbolicLink() ||
          !cur.isFile() ||
          cur.nlink !== 1 ||
          cur.dev !== bundleIdentity.dev ||
          cur.ino !== bundleIdentity.ino ||
          cur.size !== manifest.bundleBytes
        ) {
          stats.rejectedInvalid += 1;
          socket.end('ERR bundle-invalid\n');
          return;
        }
        stats.servedBundle += 1;
        socket.write(`OK ${cur.size}\n`);
        const rs = createReadStream(bundlePath);
        rs.on('error', () => {
          socket.destroy();
        });
        socket.on('close', () => {
          rs.destroy();
        });
        rs.pipe(socket);
        return;
      }

      stats.rejectedInvalid += 1;
      socket.end('ERR unknown-command\n');
    });
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(socketPath, () => {
      try {
        const st = lstatSync(socketPath);
        socketIdentity = { dev: st.dev, ino: st.ino };
        chmodSync(socketPath, 0o600);
        if (Number.isInteger(vmmUid) && Number.isInteger(vmmGid)) {
          chownSync(socketPath, vmmUid, vmmGid);
        }
        resolveReady({ socketPath });
      } catch (error) {
        const cleanup = socketIdentity
          ? removeOwnedInputSocket(socketPath, socketIdentity)
          : { identityChanged: false };
        if (cleanup.identityChanged) {
          server.unref();
        } else {
          server.close();
        }
        rejectReady(error);
      }
    });
  });

  async function close() {
    if (closed) {
      return { ok: true, identityChanged: false, error: null };
    }
    closed = true;
    for (const s of activeSockets) {
      s.destroy();
    }
    activeSockets.clear();
    const cleanup = socketIdentity
      ? removeOwnedInputSocket(socketPath, socketIdentity)
      : { ok: true, identityChanged: false, error: null };
    if (server.listening) {
      if (cleanup.identityChanged) {
        // Avoid libuv uv_pipe_close() blind-unlinking the replacement entry.
        server.unref();
      } else {
        await new Promise((done) => {
          server.close(() => done());
        });
      }
    }
    return cleanup;
  }

  return {
    socketPath,
    ready,
    close,
    getStats: () => ({ ...stats }),
  };
}

function fetchOneFramedItem(
  socketPath,
  command,
  maxBytes,
  outFilePath = null,
  timeoutMs = 30_000,
) {
  return new Promise((resolveFetch, rejectFetch) => {
    const client = net.createConnection(socketPath);
    client.setTimeout(timeoutMs, () => {
      fail(new Error(`input-client: timed out after ${timeoutMs}ms`));
    });
    let headerBuf = Buffer.alloc(0);
    let expectedLength = null;
    let received = 0;
    const chunks = outFilePath ? null : [];
    const hash = createHash('sha256');
    let ws = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (ws) ws.destroy();
      client.destroy();
      rejectFetch(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      const digest = hash.digest('hex');
      if (ws) {
        ws.end(() => resolveFetch({ bytes: received, sha256: digest }));
      } else {
        resolveFetch({
          bytes: received,
          sha256: digest,
          buffer: Buffer.concat(chunks),
        });
      }
    };

    const appendPayload = (slice) => {
      if (slice.length === 0) return;
      received += slice.length;
      if (received > expectedLength) {
        fail(
          new Error(
            `input-client: response exceeded declared ${expectedLength} bytes`,
          ),
        );
        return;
      }
      hash.update(slice);
      if (ws) ws.write(slice);
      else chunks.push(slice);
    };

    client.once('error', fail);
    client.once('connect', () => {
      client.write(`${command}\n`);
    });
    client.on('data', (chunk) => {
      if (settled) return;
      if (expectedLength === null) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const nl = headerBuf.indexOf(0x0a);
        if (nl === -1) {
          if (headerBuf.length > 256) {
            fail(new Error('input-client: response header too long'));
          }
          return;
        }
        const line = headerBuf.subarray(0, nl).toString('utf8');
        const rest = headerBuf.subarray(nl + 1);
        headerBuf = null;
        if (line.startsWith('ERR ')) {
          fail(new Error(`input-server rejected ${command}: ${line.slice(4)}`));
          return;
        }
        const match = /^OK (\d+)$/.exec(line);
        if (!match) {
          fail(
            new Error(`input-client: malformed header ${JSON.stringify(line)}`),
          );
          return;
        }
        expectedLength = Number(match[1]);
        if (
          !Number.isSafeInteger(expectedLength) ||
          expectedLength < 0 ||
          expectedLength > maxBytes
        ) {
          fail(
            new Error(
              `input-client: payload length ${expectedLength} exceeds maxBytes ${maxBytes}`,
            ),
          );
          return;
        }
        if (outFilePath) {
          ws = createWriteStream(outFilePath, { mode: 0o600 });
          ws.once('error', fail);
        }
        appendPayload(rest);
      } else {
        appendPayload(chunk);
      }
    });
    client.once('end', () => {
      if (settled) return;
      if (expectedLength === null) {
        fail(new Error('input-client: unexpected EOF before header'));
        return;
      }
      if (received !== expectedLength) {
        fail(
          new Error(
            `input-client: truncated payload (${received}/${expectedLength} bytes)`,
          ),
        );
        return;
      }
      succeed();
    });
  });
}

/**
 * Fetches `manifest` and `bundle` from a host input server UDS, verifies
 * `bundleSha256` and `bundleBytes` fail-closed, and writes `manifest.json`,
 * `round.bundle`, and `entropy.hex` into `outDir`.
 */
export async function fetchRoundInputFromSocket({
  socketPath,
  outDir,
  maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifestRes = await fetchOneFramedItem(
    socketPath,
    'GET manifest',
    maxManifestBytes,
  );
  const manifest = JSON.parse(manifestRes.buffer.toString('utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== INPUT_SCHEMA_VERSION
  ) {
    throw new Error('input-client: unsupported manifest schema');
  }
  const tmpBundle = join(outDir, `.round.bundle.tmp.${process.pid}`);
  const bundlePath = join(outDir, 'round.bundle');
  try {
    const bundleRes = await fetchOneFramedItem(
      socketPath,
      'GET bundle',
      maxBundleBytes,
      tmpBundle,
    );
    if (
      bundleRes.bytes !== manifest.bundleBytes ||
      bundleRes.sha256 !== manifest.bundleSha256
    ) {
      throw new Error(
        `input-client: bundle integrity mismatch (got ${bundleRes.bytes}B/${bundleRes.sha256}, expected ${manifest.bundleBytes}B/${manifest.bundleSha256})`,
      );
    }
    renameSync(tmpBundle, bundlePath);
  } catch (error) {
    try {
      unlinkSync(tmpBundle);
    } catch {
      // Ignore cleanup error.
    }
    throw error;
  }
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, manifestRes.buffer, { mode: 0o600 });
  const entropyPath = join(outDir, 'entropy.hex');
  writeFileSync(entropyPath, `${manifest.entropyHex}\n`, { mode: 0o600 });
  return {
    manifest,
    manifestPath,
    bundlePath,
    entropyPath,
    manifestSha256: manifestRes.sha256,
  };
}

/**
 * Materializes `baseRefOid` and `headRefOid` into two isolated directories
 * strictly from a local `round.bundle` (no host `.git` sharing, hooks and
 * filters disabled) and verifies both checked-out HEAD OIDs.
 */
export function materializeTwoOidWorktrees({
  bundlePath,
  baseRefOid,
  headRefOid,
  baseDir,
  headDir,
}) {
  assertHex40('baseRefOid', baseRefOid);
  assertHex40('headRefOid', headRefOid);
  const absBundle = resolve(bundlePath);
  for (const [label, dir, oid] of [
    ['base', baseDir, baseRefOid],
    ['head', headDir, headRefOid],
  ]) {
    const absDir = resolve(dir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    runHardenedGit(['init', '--quiet'], { cwd: absDir });
    runHardenedGit(['bundle', 'unbundle', absBundle], { cwd: absDir });
    runHardenedGit(['checkout', '--quiet', '--detach', '--force', oid], {
      cwd: absDir,
    });
    const actual = runHardenedGit(['rev-parse', 'HEAD'], {
      cwd: absDir,
    }).trim();
    if (actual !== oid) {
      throw new Error(
        `materialized ${label} HEAD ${actual} does not match expected ${oid}`,
      );
    }
  }
  return { baseDir: resolve(baseDir), headDir: resolve(headDir) };
}

/**
 * Transparent loopback TCP -> UDS tunnel used inside a NIC-less environment
 * so standard HTTP/OpenAI clients can reach a Unix-socket model proxy via
 * `http://127.0.0.1:<port>`.
 */
export async function startLoopbackToUdsBridge({
  upstreamSocketPath,
  listenHost = '127.0.0.1',
  listenPort = 0,
}) {
  if (typeof upstreamSocketPath !== 'string' || upstreamSocketPath === '') {
    throw new Error('upstreamSocketPath is required');
  }
  const active = new Set();
  const server = net.createServer((client) => {
    const upstream = net.createConnection(upstreamSocketPath);
    active.add(client);
    active.add(upstream);
    const cleanup = () => {
      active.delete(client);
      active.delete(upstream);
    };
    client.once('close', cleanup);
    upstream.once('close', cleanup);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(listenPort, listenHost, resolveListen);
  });
  const addr = server.address();
  return {
    host: listenHost,
    port: addr.port,
    close: async () => {
      for (const s of active) s.destroy();
      active.clear();
      if (server.listening) {
        await new Promise((done) => server.close(() => done()));
      }
    },
  };
}
