#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bounded content-only artifact collector over a per-round Unix domain socket
 * (host endpoint of virtio-vsock or provider gateway) per design D5.
 *
 * Protocol:
 *   1. Handshake: guest sends `guest-vsock-ready` (17 B), host replies
 *      `host-vsock-ack` (14 B).
 *   2. Frames: 1-byte ASCII kind + 4-byte big-endian uint32 length + payload:
 *      - `H`: hello (`collector-v1` or `report-v1`)
 *      - `B`: file-begin (8-byte big-endian uint64 size + flat UTF-8 filename)
 *      - `C`: file-chunk (raw bytes, <= maxChunkBytes)
 *      - `E`: file-end (64-byte lowercase hex SHA-256)
 *      - `R`: round-end (0-byte payload; commits pending files atomically)
 *   3. Reply: `O` + reason on success, `E` + reason on refusal.
 *
 * Never accepts tar archives, symlinks, file modes, device nodes, or
 * caller-supplied host paths. Any refusal, truncation, or timeout removes
 * every pending file and reports a non-complete `outputStatus`.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

export const GREETING = Buffer.from('guest-vsock-ready', 'ascii');
export const ACK = Buffer.from('host-vsock-ack', 'ascii');
export const LINUX_MAX_UDS_BYTES = 107;
export const AUTHORITY_FILENAMES = new Set([
  'boundary.json',
  'boundary-gate.json',
  'execution-record.json',
]);
export const DEFAULT_ALLOWED_FILES = new Set([
  'report.md',
  'verdict.txt',
  'assertions.json',
  'mutations.json',
  'comment.md',
]);

const FLAT_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VALID_HELLOS = new Set(['collector-v1', 'report-v1']);

class CollectorRejected extends Error {
  constructor(outputStatus, reason) {
    super(reason);
    this.outputStatus = outputStatus;
    this.reason = reason;
  }
}

/** Validates flat filename, rejecting traversal, NUL, invalid UTF-8, and authority names. */
export function validateCollectorFilename(
  nameBytes,
  allowedFiles = DEFAULT_ALLOWED_FILES,
) {
  if (!Buffer.isBuffer(nameBytes) || nameBytes.length === 0) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (nameBytes.includes(0)) {
    return { ok: false, reason: 'invalid-name' };
  }
  const decoded = nameBytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(nameBytes)) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (!FLAT_FILENAME_RE.test(decoded) || decoded.includes('..')) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (AUTHORITY_FILENAMES.has(decoded.toLowerCase())) {
    return { ok: false, reason: 'authority-file' };
  }
  if (allowedFiles && !allowedFiles.has(decoded)) {
    return { ok: false, reason: 'disallowed-filename' };
  }
  return { ok: true, name: decoded };
}

/** Checks that a Unix socket path fits within the OS sun_path byte budget. */
export function validateSocketPathLength(
  socketPath,
  platform = process.platform,
) {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  const limit = platform === 'darwin' ? 103 : LINUX_MAX_UDS_BYTES;
  if (bytes >= limit) {
    return {
      ok: false,
      bytes,
      limit,
      reason: `uds-path-too-long:${bytes}>=${limit}`,
    };
  }
  return { ok: true, bytes, limit };
}

function hasDisallowedControlByte(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) {
      return true;
    }
  }
  return false;
}

function encodeReply(kind, reason) {
  const body = Buffer.from(reason, 'ascii');
  const hdr = Buffer.allocUnsafe(5);
  hdr[0] = kind.charCodeAt(0);
  hdr.writeUInt32BE(body.length, 1);
  return Buffer.concat([hdr, body]);
}

/**
 * Starts a single-round bounded collector listener on `socketPath` and writes
 * committed files into `vaultDir`. Resolves once one guest transaction finishes
 * (or times out) and the listener closes cleanly without polling delays.
 */
export function startCollectorServer({
  socketPath,
  vaultDir,
  allowedFiles = DEFAULT_ALLOWED_FILES,
  maxFiles = 5,
  maxFileBytes = 64 * 1024,
  maxTotalBytes = 256 * 1024,
  maxFrameBytes = 4096,
  maxChunkBytes = 2048,
  maxOversizeDrainBytes = 2048,
  readDeadlineMs = 5000,
  acceptDeadlineMs = 45000,
  rejectControlChars = true,
  vmmUid = null,
  vmmGid = null,
}) {
  const lenCheck = validateSocketPathLength(socketPath);
  if (!lenCheck.ok) {
    throw new Error(lenCheck.reason);
  }
  try {
    lstatSync(socketPath);
    throw new Error(`refusing existing socket path: ${socketPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  let settled = false;
  let acceptTimer = null;
  let activeConnection = false;
  let currentConn = null;
  let cleanupActiveConnection = null;
  const server = createServer();

  const finish = (summary, { destroyActive = false } = {}) => {
    if (settled) return;
    settled = true;
    if (acceptTimer) clearTimeout(acceptTimer);
    if (destroyActive) {
      if (cleanupActiveConnection) cleanupActiveConnection();
      if (currentConn && !currentConn.destroyed) {
        currentConn.destroy();
      }
    }
    server.close(() => {
      try {
        unlinkSync(socketPath);
      } catch {
        // Already unlinked.
      }
      const vaultEntries = readdirSync(vaultDir).sort();
      resolveDone({ ...summary, vaultEntries });
    });
  };

  server.on('connection', (conn) => {
    if (settled || activeConnection) {
      conn.destroy();
      return;
    }
    activeConnection = true;
    currentConn = conn;
    if (acceptTimer) {
      clearTimeout(acceptTimer);
      acceptTimer = null;
    }
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    let openFile = null;
    let totalBytes = 0;
    const completed = [];
    let finished = false;
    let draining = 0;
    let drainTimer = null;
    let pendingReject = null;

    const cleanupPending = () => {
      if (openFile !== null) {
        try {
          closeSync(openFile.fd);
        } catch {
          // Ignore close error.
        }
        try {
          unlinkSync(openFile.partial);
        } catch {
          // Ignore unlink error.
        }
        openFile = null;
      }
      for (const item of completed) {
        try {
          unlinkSync(item.partial);
        } catch {
          // Ignore unlink error.
        }
      }
      completed.length = 0;
    };

    const readTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (drainTimer) clearTimeout(drainTimer);
      cleanupPending();
      try {
        conn.end(encodeReply('E', 'read-timeout'));
      } catch {
        conn.destroy();
      }
      finish({ outputStatus: 'timeout', reason: 'read-timeout', files: [] });
    }, readDeadlineMs);

    cleanupActiveConnection = () => {
      finished = true;
      clearTimeout(readTimer);
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      cleanupPending();
    };

    const failTransaction = (outputStatus, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(readTimer);
      if (drainTimer) clearTimeout(drainTimer);
      cleanupPending();
      try {
        conn.end(encodeReply('E', reason));
      } catch {
        conn.destroy();
      }
      finish({ outputStatus, reason, files: [] });
    };

    const processBuffer = () => {
      while (!finished) {
        if (draining > 0) {
          const take = Math.min(draining, buffer.length);
          buffer = buffer.subarray(take);
          draining -= take;
          if (draining === 0 && pendingReject) {
            if (drainTimer) {
              clearTimeout(drainTimer);
              drainTimer = null;
            }
            const rej = pendingReject;
            pendingReject = null;
            failTransaction(rej.outputStatus, rej.reason);
          }
          return;
        }

        if (stage === 'greeting') {
          if (buffer.length < GREETING.length) return;
          const got = buffer.subarray(0, GREETING.length);
          buffer = buffer.subarray(GREETING.length);
          if (!got.equals(GREETING)) {
            throw new CollectorRejected('rejected', 'bad-greeting');
          }
          conn.write(ACK);
          stage = 'hello';
          continue;
        }

        if (buffer.length < 5) return;
        const kind = String.fromCharCode(buffer[0]);
        const length = buffer.readUInt32BE(1);

        if (length > maxFrameBytes) {
          buffer = buffer.subarray(5);
          const bounded = Math.min(length, maxOversizeDrainBytes);
          const already = Math.min(bounded, buffer.length);
          buffer = buffer.subarray(already);
          draining = bounded - already;
          if (draining === 0) {
            throw new CollectorRejected('rejected', 'frame-too-large');
          }
          pendingReject = new CollectorRejected('rejected', 'frame-too-large');
          drainTimer = setTimeout(() => {
            if (pendingReject && !finished) {
              const rej = pendingReject;
              pendingReject = null;
              failTransaction(rej.outputStatus, rej.reason);
            }
          }, 200);
          return;
        }

        if (buffer.length < 5 + length) return;
        const payload = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);

        if (stage === 'hello') {
          if (kind !== 'H' || !VALID_HELLOS.has(payload.toString('utf8'))) {
            throw new CollectorRejected('rejected', 'bad-hello');
          }
          stage = 'frames';
          continue;
        }

        if (kind === 'B') {
          if (openFile !== null || length < 9) {
            throw new CollectorRejected('rejected', 'unexpected-frame');
          }
          const sizeBig = payload.readBigUInt64BE(0);
          if (sizeBig > BigInt(maxFileBytes)) {
            throw new CollectorRejected('rejected', 'file-too-large');
          }
          const size = Number(sizeBig);
          const nameCheck = validateCollectorFilename(
            payload.subarray(8),
            allowedFiles,
          );
          if (!nameCheck.ok) {
            throw new CollectorRejected('rejected', nameCheck.reason);
          }
          if (completed.length >= maxFiles) {
            throw new CollectorRejected('rejected', 'too-many-files');
          }
          if (totalBytes + size > maxTotalBytes) {
            throw new CollectorRejected('rejected', 'total-too-large');
          }
          if (completed.some((item) => item.name === nameCheck.name)) {
            throw new CollectorRejected('rejected', 'duplicate-name');
          }
          const partial = join(vaultDir, `${nameCheck.name}.pending`);
          const destination = join(vaultDir, nameCheck.name);
          const flags =
            fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            (fsConstants.O_NOFOLLOW ?? 0);
          const fd = openSync(partial, flags, 0o600);
          openFile = {
            name: nameCheck.name,
            partial,
            destination,
            fd,
            declaredSize: size,
            remaining: size,
            digest: createHash('sha256'),
          };
        } else if (kind === 'C') {
          if (openFile === null) {
            throw new CollectorRejected('rejected', 'unexpected-frame');
          }
          if (length > maxChunkBytes || length > openFile.remaining) {
            throw new CollectorRejected('rejected', 'file-size-mismatch');
          }
          if (rejectControlChars && hasDisallowedControlByte(payload)) {
            throw new CollectorRejected('rejected', 'control-character');
          }
          if (length > 0) {
            const written = writeSync(openFile.fd, payload, 0, length);
            if (written !== length) {
              throw new CollectorRejected('rejected', 'vault-write-failed');
            }
            openFile.digest.update(payload);
            openFile.remaining -= length;
          }
        } else if (kind === 'E') {
          if (openFile === null || length !== 64) {
            throw new CollectorRejected('rejected', 'unexpected-frame');
          }
          if (openFile.remaining !== 0) {
            throw new CollectorRejected('rejected', 'file-size-mismatch');
          }
          const expectedHex = payload.toString('ascii');
          const actualHex = openFile.digest.digest('hex');
          if (!SHA256_RE.test(expectedHex) || expectedHex !== actualHex) {
            throw new CollectorRejected('rejected', 'digest-mismatch');
          }
          closeSync(openFile.fd);
          completed.push({
            name: openFile.name,
            partial: openFile.partial,
            destination: openFile.destination,
            bytes: openFile.declaredSize,
            sha256: actualHex,
          });
          totalBytes += openFile.declaredSize;
          openFile = null;
        } else if (kind === 'R') {
          if (length !== 0 || openFile !== null || completed.length === 0) {
            throw new CollectorRejected('rejected', 'unexpected-frame');
          }
          const files = [];
          for (const item of completed) {
            renameSync(item.partial, item.destination);
            files.push({
              name: item.name,
              bytes: item.bytes,
              sha256: item.sha256,
            });
          }
          completed.length = 0;
          finished = true;
          clearTimeout(readTimer);
          conn.end(encodeReply('O', 'complete'));
          finish({ outputStatus: 'complete', reason: 'ok', files });
        } else {
          throw new CollectorRejected('rejected', 'unexpected-frame');
        }
      }
    };

    conn.on('data', (chunk) => {
      if (finished) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      try {
        processBuffer();
      } catch (error) {
        if (error instanceof CollectorRejected) {
          failTransaction(error.outputStatus, error.reason);
        } else {
          failTransaction('rejected', 'collector-internal-error');
        }
      }
    });

    conn.on('end', () => {
      if (finished) return;
      if (pendingReject) {
        const rej = pendingReject;
        pendingReject = null;
        failTransaction(rej.outputStatus, rej.reason);
        return;
      }
      failTransaction('truncated', 'truncated-frame');
    });

    conn.on('error', () => {
      if (finished) return;
      failTransaction('truncated', 'peer-disconnect');
    });
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
        if (Number.isInteger(vmmUid) && Number.isInteger(vmmGid)) {
          chownSync(socketPath, vmmUid, vmmGid);
        }
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      acceptTimer = setTimeout(() => {
        finish({
          outputStatus: 'timeout',
          reason: 'accept-timeout',
          files: [],
        });
      }, acceptDeadlineMs);
      resolve({ socketPath });
    });
  });

  return {
    ready,
    done,
    close: () =>
      finish(
        {
          outputStatus: 'incomplete',
          reason: 'closed-by-host',
          files: [],
        },
        { destroyActive: true },
      ),
  };
}

async function main(argv) {
  let socketPath = null;
  let vaultDir = null;
  let summaryOut = null;
  let vmmUidRaw = null;
  let vmmGidRaw = null;
  let readDeadlineMs = 5000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--socket') socketPath = argv[(i += 1)] ?? null;
    else if (arg === '--vault') vaultDir = argv[(i += 1)] ?? null;
    else if (arg === '--summary-out') summaryOut = argv[(i += 1)] ?? null;
    else if (arg === '--vmm-uid') vmmUidRaw = argv[(i += 1)] ?? null;
    else if (arg === '--vmm-gid') vmmGidRaw = argv[(i += 1)] ?? null;
    else if (arg === '--read-deadline-ms') {
      const val = Number(argv[(i += 1)]);
      if (!Number.isInteger(val) || val <= 0) {
        process.stderr.write(
          'verify-pr vm-collector: --read-deadline-ms requires a positive integer\n',
        );
        return 2;
      }
      readDeadlineMs = val;
    } else {
      process.stderr.write(`verify-pr vm-collector: unknown option ${arg}\n`);
      return 2;
    }
  }
  if (!socketPath || !vaultDir) {
    process.stderr.write(
      'Usage: node scripts/verify-pr-vm-collector.mjs --socket <uds> --vault <dir> [--summary-out <file>] [--vmm-uid <uid> --vmm-gid <gid>]\n',
    );
    return 2;
  }
  let vmmUid = null;
  let vmmGid = null;
  if (vmmUidRaw !== null || vmmGidRaw !== null) {
    if (vmmUidRaw === null || vmmGidRaw === null) {
      process.stderr.write(
        'verify-pr vm-collector: --vmm-uid and --vmm-gid must be provided together\n',
      );
      return 2;
    }
    vmmUid = Number(vmmUidRaw);
    vmmGid = Number(vmmGidRaw);
    if (
      !Number.isInteger(vmmUid) ||
      vmmUid <= 0 ||
      !Number.isInteger(vmmGid) ||
      vmmGid <= 0
    ) {
      process.stderr.write(
        'verify-pr vm-collector: --vmm-uid and --vmm-gid require positive integers\n',
      );
      return 2;
    }
  }
  const srv = startCollectorServer({
    socketPath,
    vaultDir,
    vmmUid,
    vmmGid,
    readDeadlineMs,
  });
  await srv.ready;
  process.stdout.write(`VERIFY_PR_COLLECTOR_READY socket=${socketPath}\n`);
  const summary = await srv.done;
  if (summaryOut) {
    writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.outputStatus === 'complete' ? 0 : 1;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
