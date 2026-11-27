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
  constants as fsConstants,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  read,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
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
const PYTHON_ONLY_BLANKS = new Set([
  '\u001c',
  '\u001d',
  '\u001e',
  '\u001f',
  '\u0085',
]);

// Match Python's blank credentials as well as JavaScript trim() semantics.
function isBlankCredential(value) {
  for (const character of value) {
    if (character.trim() !== '' && !PYTHON_ONLY_BLANKS.has(character)) {
      return false;
    }
  }
  return true;
}

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

function matchesExactPattern(regex, value) {
  return typeof value === 'string' && regex.exec(value)?.[0] === value;
}

function assertHex40(label, value) {
  if (!matchesExactPattern(HEX40, value)) {
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

function runHardenedGit(
  args,
  {
    cwd = undefined,
    env = process.env,
    maxBuffer = 16 * 1024 * 1024,
    encoding = 'utf8',
  } = {},
) {
  const res = spawnSync('git', [...HARDENED_GIT_PREFIX, ...args], {
    cwd,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding,
    maxBuffer,
  });
  if (res.error) {
    if (res.error.code === 'ENOBUFS') {
      // Preserve the public bundle-budget error while keeping the cause.
      const error = new Error(
        `ENOBUFS: bundle size exceeds allowed range (1..${maxBuffer})`,
      );
      error.cause = res.error;
      error.code = res.error.code;
      throw error;
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(
      `git ${args[0] ?? ''} failed (exit ${res.status}): ${String(res.stderr || res.stdout || '').trim()}`,
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

  const absOut = resolve(outPath);
  let scratchBare = null;
  let tmpOut = null;

  try {
    scratchBare = mkdtempSync(join(tmpdir(), 'qc-round-bundle-'));
    mkdirSync(dirname(absOut), { recursive: true, mode: 0o700 });
    tmpOut = `${absOut}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
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
    const bundleBytes = runHardenedGit(
      [
        '--git-dir',
        scratchBare,
        'bundle',
        'create',
        '-',
        'refs/verify/base',
        'refs/verify/head',
      ],
      // Cap stdout before the temporary file consumes any disk space.
      { maxBuffer: maxBundleBytes, encoding: null },
    );
    writeFileSync(tmpOut, bundleBytes, { mode: 0o600 });
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
    if (tmpOut !== null) {
      try {
        unlinkSync(tmpOut);
      } catch {
        // Ignore cleanup error.
      }
    }
    throw error;
  } finally {
    if (scratchBare !== null) {
      rmSync(scratchBare, { recursive: true, force: true });
    }
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
  if (!matchesExactPattern(/^[A-Za-z0-9._-]{1,32}$/, runId)) {
    throw new Error('runId must match /^[A-Za-z0-9._-]{1,32}$/');
  }
  assertHex40('baseRefOid', baseRefOid);
  assertHex40('headRefOid', headRefOid);
  if (!matchesExactPattern(HEX64, bundleSha256)) {
    throw new Error('bundleSha256 must be a 64-char lowercase hex SHA-256');
  }
  assertPositiveSafeInt('bundleBytes', bundleBytes);

  const entropy = entropyHex ?? randomBytes(32).toString('hex');
  if (!matchesExactPattern(HEX64, entropy)) {
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
      isBlankCredential(modelProxy.token)
    ) {
      throw new Error('modelProxy.token must be a non-empty string');
    }
    if (
      typeof modelProxy.nonce !== 'string' ||
      isBlankCredential(modelProxy.nonce)
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
    prNumber: Number.isSafeInteger(prNumber) && prNumber > 0 ? prNumber : null,
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

  // Open the validated bundle once with O_NOFOLLOW | O_NONBLOCK and hold the
  // read-only fd for the lifetime of the server. Keeping the inode pinned in
  // the kernel prevents the filesystem from reusing its inode number after an
  // unlink+recreate replacement (fstatSync(bundleFd).nlink drops to 0).
  const preStat = lstatSync(bundlePath);
  if (
    preStat.isSymbolicLink() ||
    !preStat.isFile() ||
    preStat.nlink !== 1 ||
    preStat.size !== manifest.bundleBytes
  ) {
    throw new Error(
      'bundlePath must be a single-link regular file matching manifest.bundleBytes',
    );
  }
  const openFlags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let bundleFd = openSync(bundlePath, openFlags);
  let activeReads = 0;
  let closeFdPending = false;
  const closeBundleFd = () => {
    if (bundleFd === null) return;
    if (activeReads > 0) {
      closeFdPending = true;
      return;
    }
    const fd = bundleFd;
    bundleFd = null;
    closeFdPending = false;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  };
  let bundleIdentity;
  try {
    const fStat = fstatSync(bundleFd);
    if (
      !fStat.isFile() ||
      fStat.nlink !== 1 ||
      fStat.size !== manifest.bundleBytes
    ) {
      throw new Error(
        'bundlePath must be a single-link regular file matching manifest.bundleBytes',
      );
    }
    bundleIdentity = { dev: fStat.dev, ino: fStat.ino };
  } catch (error) {
    closeBundleFd();
    throw error;
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
  const openSockets = new Set();
  const inFlightSockets = new Set();
  let socketIdentity = null;
  let closed = false;

  // Flush the rejection message cleanly before closing so the kernel does not
  // turn unread client bytes into an immediate RST/EPIPE. Release the
  // concurrency slot immediately so a half-closed socket cannot falsely reject
  // the next sequential request under maxConcurrent=1.
  const endAndClose = (socket, message) => {
    inFlightSockets.delete(socket);
    socket.resume();
    socket.end(message);
    const guard = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 150);
    guard.unref?.();
    socket.once('close', () => clearTimeout(guard));
  };

  const createPinnedBundleStream = (fd, totalBytes) => {
    let offset = 0;
    const chunkBytes = 64 * 1024;
    return new Readable({
      read() {
        if (offset >= totalBytes) {
          this.push(null);
          return;
        }
        if (closeFdPending || bundleFd === null) {
          this.destroy(new Error('input server closed while streaming bundle'));
          return;
        }
        const toRead = Math.min(chunkBytes, totalBytes - offset);
        const buf = Buffer.allocUnsafe(toRead);
        activeReads += 1;
        read(fd, buf, 0, toRead, offset, (err, bytesRead) => {
          activeReads -= 1;
          if (closeFdPending && activeReads === 0) {
            closeBundleFd();
          }
          if (err) {
            this.destroy(err);
            return;
          }
          if (bytesRead <= 0) {
            this.destroy(new Error('bundle shrank while streaming'));
            return;
          }
          offset += bytesRead;
          this.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
        });
      },
    });
  };

  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.once('error', () => {
      inFlightSockets.delete(socket);
      openSockets.delete(socket);
      socket.destroy();
    });
    if (closed || inFlightSockets.size >= maxConcurrent) {
      stats.rejectedBusy += 1;
      socket.once('close', () => openSockets.delete(socket));
      endAndClose(socket, 'ERR busy\n');
      return;
    }
    inFlightSockets.add(socket);
    let handled = false;
    let buf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      if (!handled) {
        handled = true;
        stats.rejectedInvalid += 1;
        endAndClose(socket, 'ERR timeout\n');
      }
    }, commandTimeoutMs);
    timer.unref?.();

    const finish = () => {
      clearTimeout(timer);
      inFlightSockets.delete(socket);
      openSockets.delete(socket);
    };
    socket.once('close', finish);

    const reject = (code, statKey) => {
      handled = true;
      clearTimeout(timer);
      stats[statKey] += 1;
      endAndClose(socket, `ERR ${code}\n`);
    };

    socket.on('data', (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > maxCommandBytes) {
          reject('command-too-long', 'rejectedInvalid');
        }
        return;
      }
      if (nl > maxCommandBytes) {
        reject('command-too-long', 'rejectedInvalid');
        return;
      }
      handled = true;
      clearTimeout(timer);
      const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');

      if (tokenFile !== null && isTokenFileRevoked(tokenFile)) {
        stats.rejectedRevoked += 1;
        endAndClose(socket, 'ERR token-revoked\n');
        return;
      }
      const totalServed = stats.servedManifest + stats.servedBundle;
      if (totalServed >= maxReads) {
        stats.rejectedBudget += 1;
        endAndClose(socket, 'ERR read-budget-exceeded\n');
        return;
      }

      if (line === 'GET manifest') {
        stats.servedManifest += 1;
        socket.write(`OK ${encodedManifest.length}\n`);
        socket.end(encodedManifest, () => {
          inFlightSockets.delete(socket);
        });
        return;
      }

      if (line === 'GET bundle') {
        if (bundleFd === null) {
          stats.rejectedInvalid += 1;
          endAndClose(socket, 'ERR bundle-unavailable\n');
          return;
        }
        let fdStat;
        let pathStat;
        try {
          fdStat = fstatSync(bundleFd);
          pathStat = lstatSync(bundlePath);
        } catch {
          stats.rejectedInvalid += 1;
          endAndClose(socket, 'ERR bundle-invalid\n');
          return;
        }
        if (
          !fdStat.isFile() ||
          fdStat.nlink !== 1 ||
          fdStat.size !== manifest.bundleBytes ||
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          pathStat.nlink !== 1 ||
          pathStat.dev !== bundleIdentity.dev ||
          pathStat.ino !== bundleIdentity.ino ||
          pathStat.size !== manifest.bundleBytes
        ) {
          stats.rejectedInvalid += 1;
          endAndClose(socket, 'ERR bundle-invalid\n');
          return;
        }
        stats.servedBundle += 1;
        socket.write(`OK ${fdStat.size}\n`);
        const rs = createPinnedBundleStream(bundleFd, fdStat.size);
        rs.on('end', () => {
          inFlightSockets.delete(socket);
        });
        rs.on('error', () => {
          inFlightSockets.delete(socket);
          socket.destroy();
        });
        socket.on('close', () => {
          rs.destroy();
        });
        rs.pipe(socket);
        return;
      }

      stats.rejectedInvalid += 1;
      endAndClose(socket, 'ERR unknown-command\n');
    });
  });

  const ready = new Promise((resolveReady, rejectReady) => {
    server.once('error', (err) => {
      closeBundleFd();
      rejectReady(err);
    });
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
        closeBundleFd();
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
    for (const s of openSockets) {
      s.destroy();
    }
    openSockets.clear();
    inFlightSockets.clear();
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
    closeBundleFd();
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
      client.setTimeout(0);
      if (ws) {
        // Cleanup must not run before a pending asynchronous open completes.
        ws.once('close', () => rejectFetch(err));
        ws.destroy();
      } else {
        rejectFetch(err);
      }
      client.destroy();
    };
    const succeed = () => {
      if (settled) return;
      client.setTimeout(0);
      if (ws) {
        // A write error may arrive after the end() completion callback.
        ws.once('close', () => {
          if (settled) return;
          settled = true;
          resolveFetch({ bytes: received, sha256: hash.digest('hex') });
        });
        ws.end();
      } else {
        settled = true;
        resolveFetch({
          bytes: received,
          sha256: hash.digest('hex'),
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
      if (ws) {
        if (!ws.write(slice)) {
          client.pause();
          ws.once('drain', () => {
            if (!settled) client.resume();
          });
        }
      } else {
        chunks.push(slice);
      }
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
        if (nl > 256) {
          fail(new Error('input-client: response header too long'));
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
          ws.on('error', fail);
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

function assertInputManifestShape(manifest) {
  function invalid(field) {
    throw new Error(`input-client: invalid manifest field: ${field}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    invalid('object');
  }
  const allowed = new Set([
    'schemaVersion',
    'runId',
    'repo',
    'prNumber',
    'baseRefOid',
    'headRefOid',
    'bundleSha256',
    'bundleBytes',
    'entropyHex',
    'modelProxy',
  ]);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) {
    invalid('unknown-field');
  }
  if (manifest.schemaVersion !== INPUT_SCHEMA_VERSION) {
    throw new Error('input-client: unsupported manifest schema');
  }
  if (!matchesExactPattern(/^[A-Za-z0-9._-]{1,32}$/, manifest.runId)) {
    invalid('runId');
  }
  if (typeof manifest.repo !== 'string') invalid('repo');
  if (manifest.prNumber !== null && !Number.isSafeInteger(manifest.prNumber)) {
    invalid('prNumber');
  }
  if (manifest.prNumber !== null && manifest.prNumber <= 0) {
    invalid('prNumber');
  }
  assertHex40('baseRefOid', manifest.baseRefOid);
  assertHex40('headRefOid', manifest.headRefOid);
  if (!matchesExactPattern(HEX64, manifest.bundleSha256)) {
    invalid('bundleSha256');
  }
  if (!matchesExactPattern(HEX64, manifest.entropyHex)) {
    invalid('entropyHex');
  }
  assertPositiveSafeInt('bundleBytes', manifest.bundleBytes);

  const proxy = manifest.modelProxy;
  if (proxy !== null) {
    if (typeof proxy !== 'object' || Array.isArray(proxy)) {
      invalid('modelProxy');
    }
    if (
      Object.keys(proxy).some(
        (key) => !['port', 'basePath', 'token', 'nonce'].includes(key),
      )
    ) {
      invalid('modelProxy');
    }
    for (const key of ['token', 'nonce']) {
      if (typeof proxy[key] !== 'string' || isBlankCredential(proxy[key])) {
        invalid(`modelProxy.${key}`);
      }
    }
    assertPositiveSafeInt('modelProxy.port', proxy.port);
    const basePath = proxy.basePath ?? '';
    if (typeof basePath !== 'string') invalid('modelProxy.basePath');
  }
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
  assertPositiveSafeInt('maxBundleBytes', maxBundleBytes);
  assertPositiveSafeInt('maxManifestBytes', maxManifestBytes);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifestRes = await fetchOneFramedItem(
    socketPath,
    'GET manifest',
    maxManifestBytes,
  );
  let manifest;
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        manifestRes.buffer,
      ),
    );
  } catch (error) {
    throw new Error(
      `input-client: invalid manifest JSON/UTF-8: ${error.message}`,
      { cause: error },
    );
  }
  assertInputManifestShape(manifest);
  if (manifest.bundleBytes > maxBundleBytes) {
    throw new Error(
      'input-client: manifest bundleBytes exceeds maxBundleBytes',
    );
  }
  const manifestPath = join(outDir, 'manifest.json');
  const bundlePath = join(outDir, 'round.bundle');
  const entropyPath = join(outDir, 'entropy.hex');
  const staged = [
    [join(outDir, `.round.bundle.tmp.${process.pid}`), bundlePath],
    [join(outDir, `.manifest.json.tmp.${process.pid}`), manifestPath],
    [join(outDir, `.entropy.hex.tmp.${process.pid}`), entropyPath],
  ];
  const tmpBundle = staged[0][0];
  const tmpManifest = staged[1][0];
  const tmpEntropy = staged[2][0];
  const promoted = [];
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
    writeFileSync(tmpManifest, manifestRes.buffer, { mode: 0o600 });
    writeFileSync(tmpEntropy, `${manifest.entropyHex}\n`, { mode: 0o600 });
    for (const [tmpPath, outputPath] of staged) {
      renameSync(tmpPath, outputPath);
      promoted.push(outputPath);
    }
  } catch (error) {
    for (const [tmpPath] of staged) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup error.
      }
    }
    for (const outputPath of promoted) {
      try {
        unlinkSync(outputPath);
      } catch {
        // Ignore cleanup error.
      }
    }
    throw error;
  }
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
  const dirs = [
    ['base', baseDir, baseRefOid],
    ['head', headDir, headRefOid],
  ].map(([label, dir, oid]) => {
    const absDir = resolve(dir);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    const canonicalDir = realpathSync(absDir);
    return {
      label,
      oid,
      absDir,
      canonicalDir,
      identity: statSync(canonicalDir),
    };
  });
  const relations = [
    relative(dirs[0].canonicalDir, dirs[1].canonicalDir),
    relative(dirs[1].canonicalDir, dirs[0].canonicalDir),
  ];
  if (
    relations.some(
      (rel) =>
        rel === '' ||
        (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)),
    )
  ) {
    throw new Error(
      'baseDir and headDir must be distinct, non-nested directories',
    );
  }
  for (const [current, other] of [
    [dirs[0], dirs[1]],
    [dirs[1], dirs[0]],
  ]) {
    for (let ancestor = current.canonicalDir; ; ancestor = dirname(ancestor)) {
      const st = statSync(ancestor);
      if (st.dev === other.identity.dev && st.ino === other.identity.ino) {
        throw new Error(
          'baseDir and headDir must be distinct, non-nested directories',
        );
      }
      if (dirname(ancestor) === ancestor) break;
    }
  }
  for (const { label, absDir, oid } of dirs) {
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
  return { baseDir: dirs[0].absDir, headDir: dirs[1].absDir };
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
