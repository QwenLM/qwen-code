/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK,
  GREETING,
  startCollectorServer,
  validateCollectorFilename,
  validateSocketPathLength,
} from '../../scripts/verify-pr-vm-collector.mjs';

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeTmpDir(prefix = 'qc-col-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeFrame(kind, body = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const hdr = Buffer.allocUnsafe(5);
  hdr[0] = kind.charCodeAt(0);
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

function makeFileBegin(name, size) {
  const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name, 'utf8');
  const sz = Buffer.allocUnsafe(8);
  sz.writeBigUInt64BE(BigInt(size), 0);
  return makeFrame('B', Buffer.concat([sz, nameBuf]));
}

function makeWholeFile(name, text) {
  const body = Buffer.from(text, 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  return Buffer.concat([
    makeFileBegin(name, body.length),
    makeFrame('C', body),
    makeFrame('E', sha),
  ]);
}

function sendTransaction(
  socketPath,
  payloadBuilder,
  { closeEarly = false } = {},
) {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let acked = false;
    conn.on('error', (err) => {
      if (closeEarly) resolve(null);
      else reject(err);
    });
    conn.on('connect', () => {
      conn.write(GREETING);
    });
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!acked) {
        if (buf.length < ACK.length) return;
        expect(buf.subarray(0, ACK.length).equals(ACK)).toBe(true);
        buf = buf.subarray(ACK.length);
        acked = true;
        const toSend = payloadBuilder();
        if (toSend) conn.write(toSend);
        if (closeEarly) {
          conn.end();
        }
        return;
      }
      if (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length >= 5 + len) {
          const kind = String.fromCharCode(buf[0]);
          const reason = buf.subarray(5, 5 + len).toString('ascii');
          conn.end();
          resolve({ kind, reason });
        }
      }
    });
    conn.on('end', () => {
      if (closeEarly) resolve(null);
    });
  });
}

describe('verify-pr-vm-collector', () => {
  it('validates flat filenames and UDS sun_path byte budgets', () => {
    expect(validateCollectorFilename(Buffer.from('report.md'))).toEqual({
      ok: true,
      name: 'report.md',
    });
    for (const bad of [
      Buffer.from('../../escape.txt'),
      Buffer.from('/etc/passwd'),
      Buffer.from('..\\escape.txt'),
      Buffer.from('report\0.md'),
      Buffer.from([0xff, 0xfe]),
    ]) {
      expect(validateCollectorFilename(bad)).toEqual({
        ok: false,
        reason: 'invalid-name',
      });
    }
    for (const auth of [
      'boundary.json',
      'boundary-gate.json',
      'execution-record.json',
    ]) {
      expect(validateCollectorFilename(Buffer.from(auth))).toEqual({
        ok: false,
        reason: 'authority-file',
      });
    }
    expect(validateSocketPathLength('/a'.repeat(54), 'linux').ok).toBe(false);
    expect(validateSocketPathLength('/tmp/v.sock', 'linux').ok).toBe(true);
  });

  it('commits valid regular files on round-end and closes cleanly without polling lag', async () => {
    const dir = makeTmpDir();
    const sock = join(dir, 'v.sock');
    const vault = join(dir, 'vault');
    const srv = startCollectorServer({ socketPath: sock, vaultDir: vault });
    await srv.ready;

    const t0 = Date.now();
    const reply = await sendTransaction(sock, () =>
      Buffer.concat([
        makeFrame('H', 'report-v1'),
        makeWholeFile('verdict.txt', 'merge-ready\n'),
        makeWholeFile('assertions.json', '{"pass":2,"fail":0,"total":2}\n'),
        makeWholeFile('report.md', 'merge-ready report\n'),
        makeFrame('R'),
      ]),
    );
    const summary = await srv.done;
    const elapsed = Date.now() - t0;

    expect(reply).toEqual({ kind: 'O', reason: 'complete' });
    expect(summary.outputStatus).toBe('complete');
    expect(summary.files).toHaveLength(3);
    expect(existsSync(sock)).toBe(false);
    expect(elapsed).toBeLessThan(500);
    const st = lstatSync(join(vault, 'report.md'));
    expect(st.isFile() && !st.isSymbolicLink() && st.nlink === 1).toBe(true);
    expect(readFileSync(join(vault, 'verdict.txt'), 'utf8')).toBe(
      'merge-ready\n',
    );
  });

  it('rejects authority filenames, traversal, digest mismatch, control chars, oversize frames, and leaves zero pending files', async () => {
    const cases = [
      [
        'authority-file',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeWholeFile('verdict.txt', 'merge-ready\n'),
            makeFileBegin('boundary.json', 20),
          ]),
        'authority-file',
      ],
      [
        'path-traversal',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeFileBegin('../../escape.txt', 1),
          ]),
        'invalid-name',
      ],
      [
        'digest-mismatch',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeFileBegin('verdict.txt', 1),
            makeFrame('C', 'x'),
            makeFrame('E', '0'.repeat(64)),
          ]),
        'digest-mismatch',
      ],
      [
        'control-character',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeFileBegin('report.md', 4),
            makeFrame('C', Buffer.from([0x61, 0x1b, 0x5b, 0x6d])),
          ]),
        'control-character',
      ],
      [
        'oversized-frame',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeFrame('B', Buffer.alloc(1025, 0x41)),
          ]),
        'frame-too-large',
      ],
      [
        'total-too-large',
        () =>
          Buffer.concat([
            makeFrame('H', 'report-v1'),
            makeWholeFile('verdict.txt', 'x'.repeat(200)),
            makeFileBegin('report.md', 200),
          ]),
        'total-too-large',
      ],
    ];

    for (const [label, builder, expectedReason] of cases) {
      const dir = makeTmpDir(`qc-neg-${label}-`);
      const sock = join(dir, 'v.sock');
      const vault = join(dir, 'vault');
      const srv = startCollectorServer({
        socketPath: sock,
        vaultDir: vault,
        maxFrameBytes: 1024,
        maxFileBytes: 300,
        maxTotalBytes: 300,
      });
      await srv.ready;
      const reply = await sendTransaction(sock, builder);
      const summary = await srv.done;
      expect(reply).toEqual({ kind: 'E', reason: expectedReason });
      expect(summary.outputStatus).toBe('rejected');
      expect(summary.reason).toBe(expectedReason);
      expect(summary.vaultEntries).toEqual([]);
    }
  });

  it('marks full-close mid-stream as truncated and hung guest as timeout with empty vault', async () => {
    // 1. Truncated stream
    const d1 = makeTmpDir('qc-trunc-');
    const s1 = join(d1, 'v.sock');
    const v1 = join(d1, 'vault');
    const srv1 = startCollectorServer({ socketPath: s1, vaultDir: v1 });
    await srv1.ready;
    await sendTransaction(
      s1,
      () =>
        Buffer.concat([
          makeFrame('H', 'report-v1'),
          makeWholeFile('verdict.txt', 'merge-ready\n'),
          makeFileBegin('report.md', 100),
          makeFrame('C', 'partial'),
        ]),
      { closeEarly: true },
    );
    const sum1 = await srv1.done;
    expect(sum1.outputStatus).toBe('truncated');
    expect(sum1.vaultEntries).toEqual([]);

    // 2. Read timeout on hung guest
    const d2 = makeTmpDir('qc-timeout-');
    const s2 = join(d2, 'v.sock');
    const v2 = join(d2, 'vault');
    const srv2 = startCollectorServer({
      socketPath: s2,
      vaultDir: v2,
      readDeadlineMs: 150,
    });
    await srv2.ready;
    const reply2 = await sendTransaction(s2, () => makeFrame('H', 'report-v1'));
    const sum2 = await srv2.done;
    expect(reply2).toEqual({ kind: 'E', reason: 'read-timeout' });
    expect(sum2.outputStatus).toBe('timeout');
    expect(sum2.vaultEntries).toEqual([]);
  });
});
