/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServeApp } from '../server.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import type { ServeOptions } from '../types.js';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4180,
  mode: 'http-bridge',
};

interface Harness {
  workspace: string;
  scratch: string;
  events: BridgeEvent[];
  app: ReturnType<typeof createServeApp>;
}

async function makeHarness(opts?: {
  trusted?: boolean;
  token?: string;
  generationGuard?: { assertOpen(): void };
}): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(
      os.tmpdir(),
      `qwen-write-routes-${randomBytes(4).toString('hex')}-`,
    ),
  );
  const wsDir = path.join(scratch, 'ws');
  await fsp.mkdir(wsDir);
  const workspace = canonicalizeWorkspace(wsDir);
  const events: BridgeEvent[] = [];
  const fsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [workspace],
    trusted: opts?.trusted ?? true,
    emit: (e) => events.push(e),
    ...(opts?.generationGuard ? { generationGuard: opts.generationGuard } : {}),
  });
  const app = createServeApp(
    { ...baseOpts, workspace, token: opts?.token },
    undefined,
    { fsFactory },
  );
  return { workspace, scratch, events, app };
}

async function teardown(h: Harness): Promise<void> {
  await fsp.rm(h.scratch, { recursive: true, force: true });
}

function loopbackHost(): string {
  return `127.0.0.1:${baseOpts.port}`;
}

function rawHash(data: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * Upload `totalBytes` with chunked transfer encoding, i.e. without a
 * Content-Length header. The admission pre-check cannot see the size, so the
 * request reaches the concurrency gate and the raw parser — pinning their
 * order and the pre-handler slot release on parser rejection.
 */
async function sendChunkedUpload(
  app: ReturnType<typeof createServeApp>,
  targetPath: string,
  totalBytes: number,
): Promise<{ status: number; body: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<{ status: number; body: string }>(
      (resolvePromise) => {
        let settled = false;
        const settle = (status: number, body: string) => {
          if (!settled) {
            settled = true;
            resolvePromise({ status, body });
          }
        };
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/file/upload?path=${encodeURIComponent(targetPath)}`,
            headers: {
              Host: loopbackHost(),
              Authorization: 'Bearer secret',
              'Content-Type': 'application/octet-stream',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += String(chunk)));
            res.on('end', () => settle(res.statusCode ?? 0, body));
            // The server rejects before draining the body; the socket can
            // be cut before the response stream reports `end`.
            res.on('close', () => settle(res.statusCode ?? 0, body));
          },
        );
        // The server may destroy the connection mid-body once it rejects.
        req.on('error', () => {});
        const chunk = Buffer.alloc(4 * 1024 * 1024, 1);
        let remaining = totalBytes;
        const writeNext = (): void => {
          while (remaining > 0) {
            const size = Math.min(chunk.length, remaining);
            remaining -= size;
            const ok = req.write(
              size === chunk.length ? chunk : chunk.subarray(0, size),
            );
            if (!ok) {
              req.once('drain', writeNext);
              return;
            }
          }
          req.end();
        };
        writeNext();
      },
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /file/write', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ token: 'secret' });
  });
  afterEach(async () => teardown(h));

  it('requires a token even on loopback no-token defaults', async () => {
    await teardown(h);
    h = await makeHarness();
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .send({ path: 'a.txt', content: 'x', mode: 'create' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
  });

  it('creates a text file with no-store headers', async () => {
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ path: 'a.txt', content: 'hello\n', mode: 'create' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toMatchObject({
      kind: 'file_write',
      path: 'a.txt',
      mode: 'create',
      created: true,
      sizeBytes: 6,
      hash: rawHash('hello\n'),
      matchedIgnore: null,
    });
    expect(await fsp.readFile(path.join(h.workspace, 'a.txt'), 'utf-8')).toBe(
      'hello\n',
    );
  });

  it('maps a generation closed at the write boundary to retryable unavailable', async () => {
    await teardown(h);
    h = await makeHarness({
      token: 'secret',
      generationGuard: {
        assertOpen() {
          throw Object.assign(new Error('closed'), {
            code: 'workspace_generation_closed',
          });
        },
      },
    });

    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ path: 'a.txt', content: 'hello', mode: 'create' });

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('workspace_runtime_unavailable');
  });

  it('does not overwrite existing files in create mode', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'old');
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ path: 'a.txt', content: 'new', mode: 'create' });
    expect(res.status).toBe(409);
    expect(res.body.errorKind).toBe('file_already_exists');
    expect(await fsp.readFile(path.join(h.workspace, 'a.txt'), 'utf-8')).toBe(
      'old',
    );
  });

  it('replaces only when expectedHash matches', async () => {
    const target = path.join(h.workspace, 'r.txt');
    await fsp.writeFile(target, 'old');
    const stale = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'r.txt',
        content: 'new',
        mode: 'replace',
        expectedHash: rawHash('stale'),
      });
    expect(stale.status).toBe(409);
    expect(stale.body.errorKind).toBe('hash_mismatch');

    const ok = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'r.txt',
        content: 'new',
        mode: 'replace',
        expectedHash: rawHash('old'),
      });
    expect(ok.status).toBe(200);
    expect(ok.body.hash).toBe(rawHash('new'));
    expect(await fsp.readFile(target, 'utf-8')).toBe('new');
  });

  it('returns parse_error for malformed bodies', async () => {
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ path: 'a.txt', content: 'x', mode: 'replace' });
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('rejects unknown supplied client ids', async () => {
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'unknown-client')
      .send({ path: 'a.txt', content: 'x', mode: 'create' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
  });

  it('rejects untrusted workspace writes', async () => {
    await teardown(h);
    h = await makeHarness({ trusted: false, token: 'secret' });
    const res = await request(h.app)
      .post('/file/write')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({ path: 'a.txt', content: 'x', mode: 'create' });
    expect(res.status).toBe(403);
    expect(res.body.errorKind).toBe('untrusted_workspace');
  });
});

describe('POST /file/edit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ token: 'secret' });
  });
  afterEach(async () => teardown(h));

  it('applies one edit and returns a new hash', async () => {
    const target = path.join(h.workspace, 'config.txt');
    await fsp.writeFile(target, 'foo=1\nbar=2\n');
    const res = await request(h.app)
      .post('/file/edit')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'config.txt',
        oldText: 'foo=1',
        newText: 'foo=42',
        expectedHash: rawHash('foo=1\nbar=2\n'),
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'file_edit',
      path: 'config.txt',
      replacements: 1,
      hash: rawHash('foo=42\nbar=2\n'),
    });
    expect(await fsp.readFile(target, 'utf-8')).toBe('foo=42\nbar=2\n');
  });

  it('returns typed errors for absent and ambiguous oldText', async () => {
    await fsp.writeFile(path.join(h.workspace, 'x.txt'), 'x\nx\n');
    const missing = await request(h.app)
      .post('/file/edit')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'x.txt',
        oldText: 'y',
        newText: 'z',
        expectedHash: rawHash('x\nx\n'),
      });
    expect(missing.status).toBe(422);
    expect(missing.body.errorKind).toBe('text_not_found');

    const ambiguous = await request(h.app)
      .post('/file/edit')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'x.txt',
        oldText: 'x',
        newText: 'z',
        expectedHash: rawHash('x\nx\n'),
      });
    expect(ambiguous.status).toBe(422);
    expect(ambiguous.body.errorKind).toBe('ambiguous_text_match');
  });

  it('rejects symlink targets after resolve', async () => {
    const outside = path.join(h.scratch, 'outside.txt');
    await fsp.writeFile(outside, 'foo=1\n');
    await fsp.symlink(outside, path.join(h.workspace, 'link.txt'), 'file');
    const res = await request(h.app)
      .post('/file/edit')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .send({
        path: 'link.txt',
        oldText: 'foo=1',
        newText: 'foo=2',
        expectedHash: rawHash('foo=1\n'),
      });
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('symlink_escape');
    expect(await fsp.readFile(outside, 'utf-8')).toBe('foo=1\n');
  });
});

describe('POST /file/upload', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ token: 'secret' });
  });
  afterEach(async () => teardown(h));

  const upload = (pathParam: string) =>
    request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/octet-stream')
      .query({ path: pathParam });

  it('writes bytes atomically and returns the confirmed path, size, hash', async () => {
    const data = randomBytes(256);
    const res = await upload('blob.bin').send(data);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toMatchObject({
      kind: 'file_upload',
      path: 'blob.bin',
      sizeBytes: data.length,
      hash: rawHash(data),
    });
    expect(res.body).not.toHaveProperty('renamed');
    expect(await fsp.readFile(path.join(h.workspace, 'blob.bin'))).toEqual(
      data,
    );
  });

  it('accepts a zero-byte octet-stream upload', async () => {
    const res = await upload('empty.bin').send(Buffer.alloc(0));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'file_upload',
      path: 'empty.bin',
      sizeBytes: 0,
      hash: rawHash(Buffer.alloc(0)),
    });
    // The empty file must actually materialize on disk.
    await expect(
      fsp.readFile(path.join(h.workspace, 'empty.bin')),
    ).resolves.toEqual(Buffer.alloc(0));
  });

  it('rejects a wrong Content-Type with 415 before buffering', async () => {
    const res = await request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'text/plain')
      .query({ path: 'a.txt' })
      .send('not binary');
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({
      errorKind: 'unsupported_media_type',
      status: 415,
    });
  });

  it('rejects a missing path with parse_error', async () => {
    const res = await request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('rejects an oversized declared Content-Length with the upload 413 envelope', async () => {
    // Declare a Content-Length above the cap while sending a tiny body. The
    // admission gate rejects on the header alone, before buffering, so no
    // 50 MiB transfer (and no client EPIPE) is needed to exercise the path.
    const res = await request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Length', String(50 * 1024 * 1024 + 1))
      .query({ path: 'big.bin' })
      .send(Buffer.from('x'));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errorKind: 'file_too_large',
      status: 413,
      maxBytes: 50 * 1024 * 1024,
    });
    expect(res.body.error).not.toContain('10 MB');
    await expect(
      fsp.stat(path.join(h.workspace, 'big.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('numbers dotfiles as whole names (.env -> .env (1))', async () => {
    await fsp.writeFile(path.join(h.workspace, '.env'), 'orig');
    const res = await upload('.env').send(Buffer.from('new'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('.env (1)');
    expect(await fsp.readFile(path.join(h.workspace, '.env'), 'utf-8')).toBe(
      'orig',
    );
  });

  it('auto-numbers when the requested name is occupied by a file', async () => {
    await fsp.writeFile(path.join(h.workspace, 'report.pdf'), 'orig');
    const res = await upload('report.pdf').send(Buffer.from('new'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('report (1).pdf');
    expect(
      await fsp.readFile(path.join(h.workspace, 'report.pdf'), 'utf-8'),
    ).toBe('orig');
    expect(
      await fsp.readFile(path.join(h.workspace, 'report (1).pdf'), 'utf-8'),
    ).toBe('new');
  });

  it('auto-numbers past several taken candidates', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), '0');
    await fsp.writeFile(path.join(h.workspace, 'a (1).txt'), '1');
    const res = await upload('a.txt').send(Buffer.from('2'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('a (2).txt');
  });

  it('lands concurrent same-name uploads on distinct candidates', async () => {
    const [first, second] = await Promise.all([
      upload('race.bin').send(Buffer.from('one')),
      upload('race.bin').send(Buffer.from('two')),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // The no-clobber create guarantees the two uploads never share a path.
    expect(first.body.path).not.toBe(second.body.path);
    expect(new Set([first.body.path, second.body.path])).toEqual(
      new Set(['race.bin', 'race (1).bin']),
    );
    // Each response path holds exactly one of the two bodies — a
    // misrouted write (same bytes twice, or an empty file) fails here.
    const contents = new Set(
      await Promise.all(
        [first.body.path, second.body.path].map((p) =>
          fsp.readFile(path.join(h.workspace, p), 'utf-8'),
        ),
      ),
    );
    expect(contents).toEqual(new Set(['one', 'two']));
  });

  it('numbers a name occupied by a directory', async () => {
    await fsp.mkdir(path.join(h.workspace, 'data'));
    const res = await upload('data').send(Buffer.from('x'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('data (1)');
  });

  it('numbers instead of writing through an in-workspace symlink', async () => {
    await fsp.writeFile(path.join(h.workspace, 'real.bin'), 'orig');
    await fsp.symlink(
      path.join(h.workspace, 'real.bin'),
      path.join(h.workspace, 'link.bin'),
    );
    const res = await upload('link.bin').send(Buffer.from('new'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('link (1).bin');
    // The symlink target is untouched and no file was written through it.
    expect(
      await fsp.readFile(path.join(h.workspace, 'real.bin'), 'utf-8'),
    ).toBe('orig');
  });

  it('rejects an escaping symlink at the boundary', async () => {
    const outside = path.join(h.scratch, 'outside.bin');
    await fsp.writeFile(outside, 'external');
    await fsp.symlink(outside, path.join(h.workspace, 'evil.bin'));
    const res = await upload('evil.bin').send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('symlink_escape');
    expect(await fsp.readFile(outside, 'utf-8')).toBe('external');
  });

  it('rejects a missing parent directory before buffering', async () => {
    const res = await upload('no/such/dir/a.txt').send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('preserves a generation-closed error from the parent stat', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness({
      token: 'secret',
      generationGuard: {
        assertOpen() {
          checks += 1;
          if (checks === 3) {
            throw Object.assign(new Error('closed'), {
              code: 'workspace_generation_closed',
            });
          }
        },
      },
    });

    const res = await upload('a.txt').send(Buffer.from('x'));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('workspace_runtime_unavailable');
  });

  it('uploads into an existing subdirectory', async () => {
    await fsp.mkdir(path.join(h.workspace, 'sub'));
    const res = await upload(path.join('sub', 'file.txt')).send(
      Buffer.from('hi'),
    );
    expect(res.status).toBe(201);
    expect(res.body.path).toBe('sub/file.txt');
    expect(
      await fsp.readFile(path.join(h.workspace, 'sub', 'file.txt'), 'utf-8'),
    ).toBe('hi');
  });

  it('handles filenames with spaces, non-ASCII, and a literal %', async () => {
    const name = 'my 数据 %b.txt';
    const res = await upload(name).send(Buffer.from('v'));
    expect(res.status).toBe(201);
    expect(res.body.path).toBe(name);
    expect(await fsp.readFile(path.join(h.workspace, name), 'utf-8')).toBe('v');
  });

  it('rejects a requested basename over 255 UTF-8 bytes', async () => {
    const longName = 'あ'.repeat(100) + '.txt'; // 100*3 + 4 = 304 bytes
    const res = await upload(longName).send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('accepts a 255-byte basename and rejects a 256-byte one', async () => {
    const atCap = 'a'.repeat(251) + '.txt'; // exactly 255 bytes
    expect(Buffer.byteLength(atCap, 'utf-8')).toBe(255);
    const ok = await upload(atCap).send(Buffer.from('x'));
    expect(ok.status).toBe(201);
    expect(ok.body.path).toBe(atCap);

    const overCap = 'a'.repeat(252) + '.txt'; // 256 bytes
    const bad = await upload(overCap).send(Buffer.from('x'));
    expect(bad.status).toBe(400);
    expect(bad.body.errorKind).toBe('parse_error');
  });

  it('rejects an unknown client id before buffering', async () => {
    const res = await request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/octet-stream')
      .set('X-Qwen-Client-Id', 'not-a-real-client')
      .query({ path: 'a.bin' })
      .send(Buffer.from('x'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
  });

  it('returns 403 untrusted_workspace on an untrusted workspace', async () => {
    await teardown(h);
    h = await makeHarness({ trusted: false, token: 'secret' });
    const res = await upload('a.bin').send(Buffer.from('x'));
    expect(res.status).toBe(403);
    expect(res.body.errorKind).toBe('untrusted_workspace');
  });

  it('requires a token', async () => {
    await teardown(h);
    h = await makeHarness();
    const res = await request(h.app)
      .post('/file/upload')
      .set('Host', loopbackHost())
      .set('Content-Type', 'application/octet-stream')
      .query({ path: 'a.bin' })
      .send(Buffer.from('x'));
    expect(res.status).toBe(401);
  });

  it('rejects "." and ".." basenames with parse_error', async () => {
    const dot = await upload('.').send(Buffer.from('x'));
    expect(dot.status).toBe(400);
    expect(dot.body.errorKind).toBe('parse_error');
    const dotdot = await upload('sub/..').send(Buffer.from('x'));
    expect(dotdot.status).toBe(400);
    expect(dotdot.body.errorKind).toBe('parse_error');
  });

  it('accepts an upload above the 5 MiB text cap (binary policy at HTTP)', async () => {
    // 6 MiB > MAX_WRITE_BYTES (5 MiB) but <= MAX_UPLOAD_BYTES: proves the
    // route applies the binary-ingress cap, not the text-write default.
    const data = Buffer.alloc(6 * 1024 * 1024, 7);
    const res = await upload('big.bin').send(data);
    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(data.length);
    expect((await fsp.stat(path.join(h.workspace, 'big.bin'))).size).toBe(
      data.length,
    );
  });

  it('accepts an upload of exactly MAX_UPLOAD_BYTES', async () => {
    // The inclusive acceptance boundary across all three size checks:
    // admission Content-Length pre-check, express.raw limit, and the fs
    // layer's enforceWriteSize all use strict `>`.
    const data = Buffer.alloc(50 * 1024 * 1024, 3);
    const res = await upload('exact.bin').send(data);
    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(data.length);
    expect((await fsp.stat(path.join(h.workspace, 'exact.bin'))).size).toBe(
      data.length,
    );
  }, 30_000);

  it('trims a long stem on numbering to stay within the 255-byte cap', async () => {
    // 249-byte stem + '.txt' = 253-byte basename (passes the admission cap).
    const stem = 'a'.repeat(249);
    const name = `${stem}.txt`;
    await fsp.writeFile(path.join(h.workspace, name), 'orig');
    const res = await upload(name).send(Buffer.from('new'));
    expect(res.status).toBe(201);
    const base = path.posix.basename(res.body.path);
    // Numbering adds ' (1)' (4 bytes) -> 257, so the stem is trimmed by
    // exactly two bytes (the minimal trim for 1-byte code points).
    expect(Buffer.byteLength(base, 'utf-8')).toBe(255);
    expect(base.endsWith(' (1).txt')).toBe(true);
    expect(base).toBe(`${'a'.repeat(247)} (1).txt`);
    // The trimmed name is the real on-disk name with the new content.
    expect(await fsp.readFile(path.join(h.workspace, base), 'utf-8')).toBe(
      'new',
    );
    // The original is untouched.
    expect(await fsp.readFile(path.join(h.workspace, name), 'utf-8')).toBe(
      'orig',
    );
  });

  it('trims a multi-byte stem on a code-point boundary when numbering', async () => {
    // 83 * 3 = 249-byte stem + '.txt' = 253 bytes (passes admission).
    const stem = '数'.repeat(83);
    const name = `${stem}.txt`;
    await fsp.writeFile(path.join(h.workspace, name), 'orig');
    const res = await upload(name).send(Buffer.from('new'));
    expect(res.status).toBe(201);
    const base = path.posix.basename(res.body.path);
    // 249 + 4 (' (1)') + 4 ('.txt') = 257 > 255, so one 3-byte code point
    // is dropped: exactly 82 chars + suffix = 254 bytes, whole code points.
    expect(base).toBe(`${'数'.repeat(82)} (1).txt`);
    expect(Buffer.byteLength(base, 'utf-8')).toBe(254);
    // The API response path is the exact on-disk name.
    expect(await fsp.readFile(path.join(h.workspace, base), 'utf-8')).toBe(
      'new',
    );
  });

  it('lands on the 1000th candidate, then 409s when all are occupied', async () => {
    // Occupy a.txt, a (1).txt ... a (998).txt: candidate 999 (the 1000th
    // attempt) must still land — pinning the cap against shrinkage.
    await Promise.all(
      Array.from({ length: 999 }, (_, i) =>
        fsp.writeFile(
          path.join(h.workspace, i === 0 ? 'a.txt' : `a (${i}).txt`),
          'x',
        ),
      ),
    );
    const lands = await upload('a.txt').send(Buffer.from('y'));
    expect(lands.status).toBe(201);
    expect(lands.body.path).toBe('a (999).txt');

    // With all 1000 candidates now occupied the route gives up with 409.
    const res = await upload('a.txt').send(Buffer.from('z'));
    expect(res.status).toBe(409);
    expect(res.body.errorKind).toBe('file_already_exists');
  }, 30_000);

  it('frees gate slots when oversized chunked bodies are rejected after admission', async () => {
    // A chunked body carries no Content-Length, so it passes the admission
    // pre-check, acquires a gate slot, and is rejected by the raw parser.
    // Five sequential rejections would exhaust the four-slot gate if the
    // pre-handler finish/close release leaked on the parser-413 path.
    for (let i = 0; i < 5; i++) {
      const res = await sendChunkedUpload(
        h.app,
        `big-${i}.bin`,
        50 * 1024 * 1024 + 1,
      );
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({
        errorKind: 'file_too_large',
        status: 413,
      });
    }
    const ok = await upload('small.bin').send(Buffer.from('x'));
    expect(ok.status).toBe(201);
  }, 60_000);
});

describe('upload concurrency gate', () => {
  it('admits up to the cap and rejects the next until a slot frees', async () => {
    const { createUploadConcurrencyGate } = await import(
      './workspace-file-write.js'
    );
    const gate = createUploadConcurrencyGate(2);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    // Release is idempotent and never goes negative: after over-releasing
    // from empty, probing to the cap admits exactly `max` more acquires
    // (an underflowed counter would admit more).
    gate.release();
    gate.release();
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
  });
});

describe('POST /file/upload HTTP concurrency gate (end-to-end)', () => {
  it('holds a slot through a disconnected write, then frees it on completion', async () => {
    const scratch = await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        `qwen-upload-gate-${randomBytes(4).toString('hex')}-`,
      ),
    );
    const wsDir = path.join(scratch, 'ws');
    await fsp.mkdir(wsDir);
    const workspace = canonicalizeWorkspace(wsDir);
    const realFactory = createWorkspaceFileSystemFactory({
      boundWorkspaces: [workspace],
      trusted: true,
      emit: () => {},
    });
    // Hold every writeBytesAtomic until released, counting how many uploads
    // have reached the write step (= have already acquired a gate slot).
    let started = 0;
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hangingFactory = {
      assertCanWrite: () => {},
      forRequest: (ctx: { originatorClientId?: string; route: string }) => {
        const realFs = realFactory.forRequest(ctx);
        // A Proxy (not a spread) so prototype methods like resolve/stat are
        // preserved; only writeBytesAtomic is intercepted to hold the slot.
        return new Proxy(realFs, {
          get(target, prop, receiver) {
            if (prop === 'writeBytesAtomic') {
              return (
                p: Parameters<typeof realFs.writeBytesAtomic>[0],
                data: Buffer,
              ) => {
                started += 1;
                return hold.then(() => target.writeBytesAtomic(p, data));
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    const app = createServeApp(
      { ...baseOpts, workspace, token: 'secret' },
      undefined,
      { fsFactory: hangingFactory as never },
    );
    const upload = (name: string) =>
      request(app)
        .post('/file/upload')
        .set('Host', loopbackHost())
        .set('Authorization', 'Bearer secret')
        .set('Content-Type', 'application/octet-stream')
        .query({ path: name })
        .send(Buffer.from('x'));

    try {
      const inFlight = [
        upload('a.bin'),
        upload('b.bin'),
        upload('c.bin'),
        upload('d.bin'),
      ];
      // Supertest Tests are lazy thenables — attach a catch to actually send
      // each request without awaiting it (they hang until `release()`).
      inFlight.forEach((p) => void p.catch(() => {}));
      // Wait until all four have acquired a gate slot (reached the write step).
      await vi.waitFor(() => {
        expect(started).toBe(4);
      });

      // Disconnect one client after its full body has reached the held write.
      // The server still owns that Buffer and write task, so the slot must not
      // be released until writeBytesAtomic settles.
      const firstSettled = inFlight[0].then(
        () => undefined,
        () => undefined,
      );
      inFlight[0].abort();
      await firstSettled;

      const fifth = await upload('e.bin').timeout({
        response: 500,
        deadline: 1_000,
      });
      expect(fifth.status).toBe(429);
      expect(fifth.body).toMatchObject({
        errorKind: 'upload_busy',
        status: 429,
        retryAfterSeconds: 1,
      });
      expect(fifth.headers['retry-after']).toBe('1');

      // Order probe: a chunked over-limit body carries no Content-Length,
      // so admission cannot pre-check it. The saturated gate must reject it
      // (429) before the parser buffers it; a parser-first middleware order
      // would answer the upload-specific 413 instead.
      const chunked = await sendChunkedUpload(
        app,
        'chunked.bin',
        50 * 1024 * 1024 + 1,
      );
      expect(chunked.status).toBe(429);
      expect(JSON.parse(chunked.body)).toMatchObject({
        errorKind: 'upload_busy',
        status: 429,
      });

      release();
      const results = await Promise.all(inFlight.slice(1));
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      // The disconnected a.bin write still completed server-side.
      expect((await fsp.stat(path.join(wsDir, 'a.bin'))).size).toBe(1);

      // All four slots must be free again: four concurrent uploads all
      // succeed — exactly one leaked slot would surface as one 429 here.
      const after = await Promise.all([
        upload('f.bin'),
        upload('g.bin'),
        upload('h.bin'),
        upload('i.bin'),
      ]);
      for (const res of after) {
        expect(res.status).toBe(201);
      }
    } finally {
      release();
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('fileUploadBodyParser 413 (oversized buffered body)', () => {
  it('maps a body-parser 413 to the upload-specific envelope', async () => {
    // Exercises the raw-parser branch (not the admission Content-Length
    // pre-check): a body that is actually larger than MAX_UPLOAD_BYTES is
    // buffered and rejected by express.raw, and the wrapper converts that 413
    // into the upload-specific `file_too_large` envelope with `maxBytes`.
    const { fileUploadBodyParser } = await import('./workspace-file-write.js');
    const app = express();
    app.post('/upload', fileUploadBodyParser(), (req, res) => {
      res.status(200).json({ ok: true, size: (req.body as Buffer).length });
    });
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1);
    const res = await request(app)
      .post('/upload')
      .set('Content-Type', 'application/octet-stream')
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errorKind: 'file_too_large',
      status: 413,
      maxBytes: 50 * 1024 * 1024,
    });
  });

  it('passes non-413 body-parser errors through next(err)', async () => {
    // An unsupported Content-Encoding makes body-parser throw a 415
    // `encoding.unsupported` — the wrapper must forward it via `next(err)`
    // instead of misreporting an oversized body.
    const { fileUploadBodyParser } = await import('./workspace-file-write.js');
    const app = express();
    app.post('/upload', fileUploadBodyParser(), (req, res) => {
      res.status(200).json({ ok: true });
    });
    const res = await request(app)
      .post('/upload')
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Encoding', 'zstd')
      .send(Buffer.from('x'));
    expect(res.status).toBe(415);
    expect(res.text).not.toContain('file_too_large');
  });
});
