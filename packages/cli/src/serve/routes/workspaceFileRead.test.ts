/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Ignore } from '@qwen-code/qwen-code-core';
import { createServeApp } from '../server.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from '../fs/index.js';
import type { BridgeEvent } from '../eventBus.js';
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
  ignore?: Ignore;
}): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), `qwen-routes-${randomBytes(4).toString('hex')}-`),
  );
  const wsDir = path.join(scratch, 'ws');
  await fsp.mkdir(wsDir);
  const workspace = canonicalizeWorkspace(wsDir);
  const events: BridgeEvent[] = [];
  const fsFactory = createWorkspaceFileSystemFactory({
    boundWorkspace: workspace,
    trusted: opts?.trusted ?? true,
    emit: (e) => events.push(e),
    ignore: opts?.ignore,
  });
  const app = createServeApp({ ...baseOpts, workspace }, undefined, {
    fsFactory,
  });
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

describe('GET /file', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('returns content + meta for a UTF-8 text file', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'hello\nworld\n');
    const res = await request(h.app)
      .get('/file?path=a.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'file',
      path: 'a.txt',
      content: 'hello\nworld\n',
      lineEnding: 'lf',
      truncated: false,
      matchedIgnore: null,
    });
    expect(res.body.sizeBytes).toBe(12);
    expect(res.body.returnedBytes).toBe(12);
    expect(res.body.hash).toBe(rawHash('hello\nworld\n'));
  });

  it('returns the requested line window', async () => {
    await fsp.writeFile(
      path.join(h.workspace, 'multiline.txt'),
      'one\ntwo\nthree\n',
    );
    const res = await request(h.app)
      .get('/file?path=multiline.txt&line=2&limit=1')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'file',
      path: 'multiline.txt',
      content: 'two',
      originalLineCount: 4,
      truncated: true,
    });
  });

  it('attaches Cache-Control: no-store and X-Content-Type-Options: nosniff', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'x');
    const res = await request(h.app)
      .get('/file?path=a.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns 400 path_outside_workspace for ".." escapes', async () => {
    const res = await request(h.app)
      .get('/file?path=../escape')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errorKind: 'path_outside_workspace',
      status: 400,
    });
  });

  it('returns 404 path_not_found for missing files', async () => {
    const res = await request(h.app)
      .get('/file?path=missing.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(404);
    expect(res.body.errorKind).toBe('path_not_found');
  });

  it('returns 422 binary_file when target contains NULs', async () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x00, 0x61, 0x01]);
    await fsp.writeFile(path.join(h.workspace, 'bin.dat'), buf);
    const res = await request(h.app)
      .get('/file?path=bin.dat')
      .set('Host', loopbackHost());
    expect(res.status).toBe(422);
    expect(res.body.errorKind).toBe('binary_file');
  });

  it('truncates content above maxBytes and reports truncated=true', async () => {
    await fsp.writeFile(path.join(h.workspace, 'big.txt'), 'a'.repeat(2048));
    const res = await request(h.app)
      .get('/file?path=big.txt&maxBytes=512')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.sizeBytes).toBe(2048);
    expect(res.body.returnedBytes).toBeLessThanOrEqual(512);
    expect(res.body.content.length).toBeLessThanOrEqual(512);
  });

  it('rejects malformed maxBytes with parse_error 400', async () => {
    const res = await request(h.app)
      .get('/file?path=a.txt&maxBytes=-1')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('rejects malformed line with parse_error 400', async () => {
    const res = await request(h.app)
      .get('/file?path=a.txt&line=abc')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('requires the path query param', async () => {
    const res = await request(h.app).get('/file').set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('emits one fs.access audit event per successful read', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'x');
    await request(h.app).get('/file?path=a.txt').set('Host', loopbackHost());
    const accesses = h.events.filter((e) => e.type === 'fs.access');
    expect(accesses).toHaveLength(1);
    expect(accesses[0].data).toMatchObject({
      intent: 'read',
      route: 'GET /file',
    });
  });
});

describe('GET /file/bytes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('returns base64 raw bytes and hash for a full-file window', async () => {
    const data = Buffer.from([0, 1, 2, 3, 255]);
    await fsp.writeFile(path.join(h.workspace, 'bin.dat'), data);
    const res = await request(h.app)
      .get('/file/bytes?path=bin.dat')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'file_bytes',
      path: 'bin.dat',
      offset: 0,
      sizeBytes: data.length,
      returnedBytes: data.length,
      truncated: false,
      contentBase64: data.toString('base64'),
      hash: rawHash(data),
    });
  });

  it('returns a partial byte window without hash', async () => {
    await fsp.writeFile(
      path.join(h.workspace, 'window.bin'),
      Buffer.from([1, 2, 3, 4, 5]),
    );
    const res = await request(h.app)
      .get('/file/bytes?path=window.bin&offset=1&maxBytes=2')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      offset: 1,
      returnedBytes: 2,
      truncated: true,
      contentBase64: Buffer.from([2, 3]).toString('base64'),
    });
    expect(res.body.hash).toBeUndefined();
  });

  it('rejects malformed offset and maxBytes with parse_error', async () => {
    const badOffset = await request(h.app)
      .get('/file/bytes?path=x&offset=-1')
      .set('Host', loopbackHost());
    expect(badOffset.status).toBe(400);
    expect(badOffset.body.errorKind).toBe('parse_error');

    const badMax = await request(h.app)
      .get('/file/bytes?path=x&maxBytes=999999999')
      .set('Host', loopbackHost());
    expect(badMax.status).toBe(400);
    expect(badMax.body.errorKind).toBe('parse_error');
  });
});

describe('GET /stat', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('returns metadata for a regular file', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'hi');
    const res = await request(h.app)
      .get('/stat?path=a.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'stat',
      path: 'a.txt',
      type: 'file',
      sizeBytes: 2,
    });
    expect(typeof res.body.modifiedMs).toBe('number');
  });

  it('returns metadata for a directory', async () => {
    await fsp.mkdir(path.join(h.workspace, 'sub'));
    const res = await request(h.app)
      .get('/stat?path=sub')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('directory');
  });

  it('returns 404 path_not_found for missing entries', async () => {
    const res = await request(h.app)
      .get('/stat?path=nosuch.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(404);
    expect(res.body.errorKind).toBe('path_not_found');
  });

  it('returns 500 rather than leaking paths when boundWorkspace is missing', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), 'hi');
    delete (h.app.locals as { boundWorkspace?: string }).boundWorkspace;
    const res = await request(h.app)
      .get('/stat?path=a.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(500);
    expect(res.body.errorKind).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain(h.workspace);
  });

  it('returns 400 symlink_escape when target points outside the workspace', async () => {
    const outside = path.join(h.scratch, 'evil.txt');
    await fsp.writeFile(outside, 'x');
    await fsp.symlink(outside, path.join(h.workspace, 'leak.txt'), 'file');
    const res = await request(h.app)
      .get('/stat?path=leak.txt')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('symlink_escape');
  });
});

describe('GET /list', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('lists entries with name + kind + ignored, no path field', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), '');
    await fsp.mkdir(path.join(h.workspace, 'sub'));
    const res = await request(h.app)
      .get('/list?path=.')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('list');
    expect(res.body.path).toBe('.');
    expect(res.body.truncated).toBe(false);
    const names = (res.body.entries as Array<{ name: string }>)
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['a.txt', 'sub']);
    for (const e of res.body.entries) {
      expect(e).toHaveProperty('name');
      expect(e).toHaveProperty('kind');
      expect(e).toHaveProperty('ignored');
      expect(e).not.toHaveProperty('path');
    }
  });

  it('drops ignored entries by default and includes them with includeIgnored=1', async () => {
    // Build the Ignore instance manually because `loadIgnoreRules`
    // is invoked at factory construction time — writing a .gitignore
    // file post-construction would be ignored. The test harness
    // resets between specs, so we get a fresh factory here.
    await teardown(h);
    h = await makeHarness({ ignore: new Ignore().add(['secret.txt']) });
    await fsp.writeFile(path.join(h.workspace, 'public.txt'), 'p');
    await fsp.writeFile(path.join(h.workspace, 'secret.txt'), 's');

    const filtered = await request(h.app)
      .get('/list?path=.')
      .set('Host', loopbackHost());
    const filteredNames = (
      filtered.body.entries as Array<{ name: string }>
    ).map((e) => e.name);
    expect(filteredNames).not.toContain('secret.txt');
    expect(filteredNames).toContain('public.txt');

    const all = await request(h.app)
      .get('/list?path=.&includeIgnored=1')
      .set('Host', loopbackHost());
    const allNames = (all.body.entries as Array<{ name: string }>)
      .map((e) => e.name)
      .sort();
    expect(allNames).toContain('secret.txt');
    expect(allNames).toContain('public.txt');
  });

  it('returns 400 parse_error when listing a regular file', async () => {
    await fsp.writeFile(path.join(h.workspace, 'a.txt'), '');
    const res = await request(h.app)
      .get('/list?path=a.txt')
      .set('Host', loopbackHost());
    // ENOTDIR maps to parse_error per fs/errors.ts
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });
});

describe('GET /glob', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('returns workspace-relative match paths', async () => {
    await fsp.writeFile(path.join(h.workspace, 'one.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'two.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'README.md'), '');
    const res = await request(h.app)
      .get('/glob?pattern=*.ts')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('glob');
    expect(res.body.pattern).toBe('*.ts');
    expect(res.body.matches.sort()).toEqual(['one.ts', 'two.ts']);
    expect(res.body.count).toBe(2);
    for (const m of res.body.matches) {
      expect(path.isAbsolute(m)).toBe(false);
      expect(m.startsWith('..')).toBe(false);
    }
  });

  it('returns 400 parse_error for ".." escape patterns', async () => {
    const res = await request(h.app)
      .get('/glob?pattern=../**')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });

  it('reports truncated=false when match count equals maxResults exactly', async () => {
    // Probe-then-trim: pre-fixup the route inferred `truncated` from
    // `length === maxResults`, false-positive when the workspace
    // happens to hold exactly N matches. After the fixup the
    // boundary probes `cap + 1` so `truncated` is only true when
    // there really were more matches.
    await fsp.writeFile(path.join(h.workspace, 'a.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'b.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'c.ts'), '');
    const res = await request(h.app)
      .get('/glob?pattern=*.ts&maxResults=3')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.truncated).toBe(false);
  });

  it('reports truncated=true when boundary saw more matches than maxResults', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      await fsp.writeFile(path.join(h.workspace, name), '');
    }
    const res = await request(h.app)
      .get('/glob?pattern=*.ts&maxResults=2')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.truncated).toBe(true);
  });

  it('normalizes a root match to "." instead of empty string', async () => {
    // `pattern=.` resolves to the workspace itself; `path.relative`
    // returns "" but the response shape expects "." (matches
    // /file/list/stat). The route uses the shared
    // `workspaceRelative` helper to normalize.
    const res = await request(h.app)
      .get('/glob?pattern=.')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.matches).toContain('.');
    for (const m of res.body.matches) {
      expect(m).not.toBe('');
      expect(typeof m).toBe('string');
    }
  });

  it('drops ignored glob matches by default and includes them with includeIgnored=1', async () => {
    await teardown(h);
    h = await makeHarness({ ignore: new Ignore().add(['secret.ts']) });
    await fsp.writeFile(path.join(h.workspace, 'public.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'secret.ts'), '');

    const filtered = await request(h.app)
      .get('/glob?pattern=*.ts')
      .set('Host', loopbackHost());
    expect(filtered.status).toBe(200);
    expect(filtered.body.matches).toContain('public.ts');
    expect(filtered.body.matches).not.toContain('secret.ts');

    const all = await request(h.app)
      .get('/glob?pattern=*.ts&includeIgnored=1')
      .set('Host', loopbackHost());
    expect(all.status).toBe(200);
    expect(all.body.matches.sort()).toEqual(['public.ts', 'secret.ts']);
  });

  it('scopes glob matches to cwd', async () => {
    await fsp.mkdir(path.join(h.workspace, 'sub'));
    await fsp.writeFile(path.join(h.workspace, 'root.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'sub', 'inside.ts'), '');
    const res = await request(h.app)
      .get('/glob?pattern=*.ts&cwd=sub')
      .set('Host', loopbackHost());
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe('sub');
    expect(res.body.matches).toEqual(['sub/inside.ts']);
  });

  it('returns 400 parse_error when maxResults is malformed', async () => {
    const res = await request(h.app)
      .get('/glob?pattern=*&maxResults=zero')
      .set('Host', loopbackHost());
    expect(res.status).toBe(400);
    expect(res.body.errorKind).toBe('parse_error');
  });
});

describe('capability advertisement', () => {
  it('advertises workspace file capabilities on /capabilities', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get('/capabilities')
        .set('Host', loopbackHost());
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('workspace_file_read');
      expect(res.body.features).toContain('workspace_file_bytes');
      expect(res.body.features).toContain('workspace_file_write');
    } finally {
      await teardown(h);
    }
  });
});
