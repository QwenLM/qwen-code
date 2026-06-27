/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServeApp } from '../server.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { BridgeEvent } from '../event-bus.js';
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
    boundWorkspace: workspace,
    trusted: opts?.trusted ?? true,
    emit: (e) => events.push(e),
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
