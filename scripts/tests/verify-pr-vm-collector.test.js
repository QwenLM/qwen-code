/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK,
  GREETING,
  startCollectorServer,
  validateCollectorFilename,
  validateSocketPathLength,
} from '../../scripts/verify-pr-vm-collector.mjs';

const COLLECTOR_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-vm-collector.mjs', import.meta.url),
);

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
  it('validates flat filenames, bounded evidence/logs namespaces, and UDS sun_path byte budgets', () => {
    expect(validateCollectorFilename(Buffer.from('report.md'))).toMatchObject({
      ok: true,
      name: 'report.md',
      kind: 'text',
      subdir: null,
    });
    expect(
      validateCollectorFilename(Buffer.from('evidence/01-ab-cells.png')),
    ).toMatchObject({
      ok: true,
      name: 'evidence/01-ab-cells.png',
      kind: 'image',
      subdir: 'evidence',
      leaf: '01-ab-cells.png',
    });
    expect(
      validateCollectorFilename(Buffer.from('logs/harness.log')),
    ).toMatchObject({
      ok: true,
      name: 'logs/harness.log',
      kind: 'log',
      subdir: 'logs',
      leaf: 'harness.log',
    });
    for (const bad of [
      Buffer.from('../../escape.txt'),
      Buffer.from('/etc/passwd'),
      Buffer.from('..\\escape.txt'),
      Buffer.from('report\0.md'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('evidence/../boundary.json'),
      Buffer.from('evidence/not-numbered.png'),
      Buffer.from('other/01-cells.png'),
      Buffer.from('logs/nested/deep.log'),
    ]) {
      expect(validateCollectorFilename(bad)).toEqual({
        ok: false,
        reason: 'invalid-name',
      });
    }
    for (const auth of [
      'boundary.json',
      'Boundary.JSON',
      'boundary-gate.json',
      'execution-record.json',
      'EXECUTION-RECORD.JSON',
      'logs/boundary.json',
    ]) {
      expect(validateCollectorFilename(Buffer.from(auth), null)).toEqual({
        ok: false,
        reason: 'authority-file',
      });
    }
    expect(validateSocketPathLength('/a'.repeat(54), 'linux').ok).toBe(false);
    expect(validateSocketPathLength('/tmp/v.sock', 'linux').ok).toBe(true);
  });

  it('commits binary PNG evidence and log files byte-exactly while refusing spoofed PNG signatures and authority --allowed-files', async () => {
    const dir = makeTmpDir('qc-png-');
    const sock = join(dir, 'v.sock');
    const vault = join(dir, 'vault');
    const srv = startCollectorServer({ socketPath: sock, vaultDir: vault });
    await srv.ready;

    // Minimal PNG header + arbitrary binary bytes (including 0x00 and 0x1b control bytes)
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x1b, 0x7f, 0x01, 0x02,
    ]);
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');
    const reply = await sendTransaction(sock, () =>
      Buffer.concat([
        makeFrame('H', 'report-v1'),
        makeWholeFile('verdict.txt', 'merge-ready\n'),
        makeFileBegin('evidence/01-ab-cells.png', pngBytes.length),
        makeFrame('C', pngBytes),
        makeFrame('E', pngSha),
        makeWholeFile('logs/harness.log', 'step 1 ok\n'),
        makeFrame('R'),
      ]),
    );
    const summary = await srv.done;
    expect(reply).toEqual({ kind: 'O', reason: 'complete' });
    expect(summary.outputStatus).toBe('complete');
    expect(summary.vaultEntries).toEqual([
      'evidence/01-ab-cells.png',
      'logs/harness.log',
      'verdict.txt',
    ]);
    expect(
      readFileSync(join(vault, 'evidence', '01-ab-cells.png')).equals(pngBytes),
    ).toBe(true);
    expect(readFileSync(join(vault, 'logs', 'harness.log'), 'utf8')).toBe(
      'step 1 ok\n',
    );

    // Spoofed PNG signature must be refused and leave zero vault files
    const dBad = makeTmpDir('qc-badpng-');
    const sBad = join(dBad, 'v.sock');
    const vBad = join(dBad, 'vault');
    const srvBad = startCollectorServer({ socketPath: sBad, vaultDir: vBad });
    await srvBad.ready;
    const fakePng = Buffer.from('not-a-real-png-header');
    const rBad = await sendTransaction(sBad, () =>
      Buffer.concat([
        makeFrame('H', 'report-v1'),
        makeFileBegin('evidence/01-fake.png', fakePng.length),
        makeFrame('C', fakePng),
      ]),
    );
    const sumBad = await srvBad.done;
    expect(rBad).toEqual({ kind: 'E', reason: 'invalid-png-signature' });
    expect(sumBad.outputStatus).toBe('rejected');
    expect(sumBad.vaultEntries).toEqual([]);

    // CLI refuses authority filenames in --allowed-files
    const badAllow = spawnSync(
      process.execPath,
      [
        COLLECTOR_SCRIPT,
        '--socket',
        sBad,
        '--vault',
        vBad,
        '--allowed-files',
        'report.md,boundary.json',
      ],
      { encoding: 'utf8' },
    );
    expect(badAllow.status).toBe(2);
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

  it('rejects concurrent second connection, bounds partial oversize drain to frame-too-large, closes active connections cleanly, and validates CLI numeric flags', async () => {
    // 0. Concurrent second connection is immediately dropped while first connection succeeds
    const d0 = makeTmpDir('qc-conc-');
    const s0 = join(d0, 'v.sock');
    const v0 = join(d0, 'vault');
    const srv0 = startCollectorServer({ socketPath: s0, vaultDir: v0 });
    await srv0.ready;
    const conn1 = createConnection(s0);
    const firstDone = new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let acked = false;
      conn1.on('error', reject);
      conn1.on('connect', () => conn1.write(GREETING));
      conn1.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!acked && buf.length >= ACK.length) {
          acked = true;
          buf = buf.subarray(ACK.length);
          // Open a hostile concurrent second connection before conn1 finishes
          const conn2 = createConnection(s0);
          conn2.on('close', () => {
            conn1.write(
              Buffer.concat([
                makeFrame('H', 'report-v1'),
                makeWholeFile('verdict.txt', 'merge-ready\n'),
                makeFrame('R'),
              ]),
            );
          });
          conn2.on('error', () => {
            // Expected on immediate destroy.
          });
          return;
        }
        if (acked && buf.length >= 5) {
          const len = buf.readUInt32BE(1);
          if (buf.length >= 5 + len) {
            conn1.end();
            resolve(buf.subarray(5, 5 + len).toString('ascii'));
          }
        }
      });
    });
    expect(await firstDone).toBe('complete');
    const sum0 = await srv0.done;
    expect(sum0.outputStatus).toBe('complete');

    // 0b. srv.close() destroys a hung client mid-file, clears timers, and leaves zero pending files
    const dClose = makeTmpDir('qc-close-');
    const sClose = join(dClose, 'v.sock');
    const vClose = join(dClose, 'vault');
    const srvClose = startCollectorServer({
      socketPath: sClose,
      vaultDir: vClose,
      readDeadlineMs: 10000,
    });
    await srvClose.ready;
    const hung = createConnection(sClose);
    hung.on('error', () => {});
    await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      hung.once('connect', () => hung.write(GREETING));
      hung.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= ACK.length) {
          hung.write(
            Buffer.concat([
              makeFrame('H', 'report-v1'),
              makeFileBegin('report.md', 50),
              makeFrame('C', 'half-written'),
            ]),
          );
          setTimeout(resolve, 30);
        }
      });
    });
    srvClose.close();
    const sumClose = await srvClose.done;
    expect(sumClose.outputStatus).toBe('incomplete');
    expect(sumClose.vaultEntries).toEqual([]);

    // 1. Oversize frame with partial stalled body still returns frame-too-large via 200ms drain timer
    const d1 = makeTmpDir('qc-drain-');
    const s1 = join(d1, 'v.sock');
    const v1 = join(d1, 'vault');
    const srv1 = startCollectorServer({
      socketPath: s1,
      vaultDir: v1,
      maxFrameBytes: 1024,
      readDeadlineMs: 5000,
    });
    await srv1.ready;
    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = 'B'.charCodeAt(0);
    hdr.writeUInt32BE(2000, 1);
    const r1 = await sendTransaction(s1, () =>
      Buffer.concat([
        makeFrame('H', 'report-v1'),
        hdr,
        Buffer.alloc(100, 0x41),
      ]),
    );
    const sum1 = await srv1.done;
    expect(r1).toEqual({ kind: 'E', reason: 'frame-too-large' });
    expect(sum1.outputStatus).toBe('rejected');
    expect(sum1.reason).toBe('frame-too-large');

    // 2. CLI rejects unpaired --vmm-uid and non-integer --read-deadline-ms
    const badUid = spawnSync(
      process.execPath,
      [COLLECTOR_SCRIPT, '--socket', s1, '--vault', v1, '--vmm-uid', '65534'],
      { encoding: 'utf8' },
    );
    expect(badUid.status).toBe(2);
    const badDeadline = spawnSync(
      process.execPath,
      [
        COLLECTOR_SCRIPT,
        '--socket',
        s1,
        '--vault',
        v1,
        '--read-deadline-ms',
        'abc',
      ],
      { encoding: 'utf8' },
    );
    expect(badDeadline.status).toBe(2);
  });
});
