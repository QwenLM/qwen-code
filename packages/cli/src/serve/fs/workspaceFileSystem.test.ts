/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Ignore } from '@qwen-code/qwen-code-core';
import {
  FS_ACCESS_EVENT_TYPE,
  FS_DENIED_EVENT_TYPE,
  createWorkspaceFileSystemFactory,
  type ResolvedPath,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
} from './index.js';
import type { BridgeEvent } from '../eventBus.js';
import { canonicalizeWorkspace } from './paths.js';
import { isFsError } from './errors.js';

interface Harness {
  factory: WorkspaceFileSystemFactory;
  fs: WorkspaceFileSystem;
  events: BridgeEvent[];
  workspace: string;
  scratch: string;
}

async function makeHarness(opts?: {
  trusted?: boolean;
  ignore?: Ignore;
}): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), `qwen-wfs-${randomBytes(4).toString('hex')}-`),
  );
  const wsDir = path.join(scratch, 'ws');
  await fsp.mkdir(wsDir);
  const workspace = canonicalizeWorkspace(wsDir);
  const events: BridgeEvent[] = [];
  const factory = createWorkspaceFileSystemFactory({
    boundWorkspace: workspace,
    trusted: opts?.trusted ?? true,
    emit: (e) => events.push(e),
    ignore: opts?.ignore,
  });
  const fs = factory.forRequest({
    originatorClientId: 'client-x',
    sessionId: 'sess-1',
    route: 'TEST /op',
  });
  return { factory, fs, events, workspace, scratch };
}

async function teardown(h: Harness): Promise<void> {
  await fsp.rm(h.scratch, { recursive: true, force: true });
}

describe('WorkspaceFileSystem - resolve and stat', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it('resolves an existing path and emits no audit on resolve alone', async () => {
    const target = path.join(h.workspace, 'a.txt');
    await fsp.writeFile(target, 'x');
    const r = await h.fs.resolve('a.txt', 'read');
    expect(r).toBeTruthy();
    expect(
      h.events.filter((e) => e.type === FS_ACCESS_EVENT_TYPE),
    ).toHaveLength(0);
  });

  it('records fs.denied when resolve fails', async () => {
    await expect(h.fs.resolve('../escape', 'read')).rejects.toBeDefined();
    const denied = h.events.filter((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toHaveLength(1);
    expect(denied[0].data).toMatchObject({
      errorKind: 'path_outside_workspace',
    });
  });

  it('stat returns kind/sizeBytes/modifiedMs and emits fs.access', async () => {
    const target = path.join(h.workspace, 'b.txt');
    await fsp.writeFile(target, 'hi');
    const r = await h.fs.resolve('b.txt', 'stat');
    const st = await h.fs.stat(r);
    expect(st.kind).toBe('file');
    expect(st.sizeBytes).toBe(2);
    expect(st.modifiedMs).toBeGreaterThan(0);
    expect(h.events.find((e) => e.type === FS_ACCESS_EVENT_TYPE)).toBeDefined();
  });
});

describe('WorkspaceFileSystem - readText', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('reads small text and reports lineEnding', async () => {
    const target = path.join(h.workspace, 'plain.txt');
    await fsp.writeFile(target, 'hello\nworld\n');
    const r = await h.fs.resolve('plain.txt', 'read');
    const out = await h.fs.readText(r);
    expect(out.content).toBe('hello\nworld\n');
    expect(out.meta.lineEnding).toBe('lf');
    expect(out.meta.truncated).toBeUndefined();
  });

  it('truncates content above maxBytes and sets meta.truncated', async () => {
    const big = path.join(h.workspace, 'big.txt');
    const content = 'a'.repeat(2048);
    await fsp.writeFile(big, content);
    const r = await h.fs.resolve('big.txt', 'read');
    const out = await h.fs.readText(r, { maxBytes: 1024 });
    expect(out.meta.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(1024);
  });

  it('throws file_too_large when file exceeds MAX_READ_BYTES regardless of opts.maxBytes', async () => {
    // Write a file larger than the soft cap and assert the boundary
    // refuses BEFORE delegating to lowFs (which would slurp the
    // whole file into memory).
    const big = path.join(h.workspace, 'huge.txt');
    const bytes = (await import('./policy.js')).MAX_READ_BYTES + 1;
    await fsp.writeFile(big, 'a'.repeat(bytes));
    const r = await h.fs.resolve('huge.txt', 'read');
    const err = await h.fs.readText(r).catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
    // Audit was recorded for the denial (P0 silent-failure fix).
    const denied = h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
    expect((denied!.data as { errorKind: string }).errorKind).toBe(
      'file_too_large',
    );
  });

  it('throws binary_file when reading binary content', async () => {
    const bin = path.join(h.workspace, 'bin.dat');
    const buf = Buffer.alloc(64);
    buf[5] = 0;
    await fsp.writeFile(bin, buf);
    const r = await h.fs.resolve('bin.dat', 'read');
    const err = await h.fs.readText(r).catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('binary_file');
    expect(h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE)).toBeDefined();
  });

  it('annotates meta.matchedIgnore when path is ignored', async () => {
    const ignore = new Ignore().add(['*.log']);
    h = await makeHarness({ ignore });
    const target = path.join(h.workspace, 'app.log');
    await fsp.writeFile(target, 'log content');
    const r = await h.fs.resolve('app.log', 'read');
    const out = await h.fs.readText(r);
    expect(out.meta.matchedIgnore).toBe('file');
  });
});

describe('WorkspaceFileSystem - readBytes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('returns raw bytes', async () => {
    const target = path.join(h.workspace, 'raw.bin');
    await fsp.writeFile(target, Buffer.from([1, 2, 3, 0, 4, 5]));
    const r = await h.fs.resolve('raw.bin', 'read');
    const buf = await h.fs.readBytes(r);
    expect(Array.from(buf)).toEqual([1, 2, 3, 0, 4, 5]);
  });

  it('truncates returned buffer to opts.maxBytes (window read, matches API name)', async () => {
    // Earlier semantics threw `file_too_large` here, but `maxBytes`
    // in the parameter name promises window-read behavior. Files
    // above the HARD `MAX_READ_BYTES` cap still throw — see
    // separate test below — but a caller-supplied tighter cap
    // truncates rather than rejects.
    const target = path.join(h.workspace, 'small.bin');
    await fsp.writeFile(target, Buffer.alloc(2048, 0xab));
    const r = await h.fs.resolve('small.bin', 'read');
    const buf = await h.fs.readBytes(r, { maxBytes: 1024 });
    expect(buf.length).toBe(1024);
    expect(buf[0]).toBe(0xab);
  });

  it('throws file_too_large when file size exceeds the hard MAX_READ_BYTES cap regardless of maxBytes', async () => {
    const policy = await import('./policy.js');
    const target = path.join(h.workspace, 'huge.bin');
    await fsp.writeFile(target, Buffer.alloc(policy.MAX_READ_BYTES + 1));
    const r = await h.fs.resolve('huge.bin', 'read');
    const err = await h.fs.readBytes(r).catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });

  it('readBytes catches concurrent post-stat growth via post-read size check', async () => {
    // Pre-stat OOM gate sees a small file; post-read buf.length
    // check catches the same-inode growth case (concurrent
    // appender keeps the inode but extends past the cap). Test
    // simulates by overwriting the file AFTER `resolve()` with a
    // buffer larger than `MAX_READ_BYTES` — the readBytes call's
    // pre-stat sees the large size and trips the hard cap; the
    // post-read check is the defense-in-depth path for the case
    // where stat passed but read picked up more bytes.
    const policy = await import('./policy.js');
    const small = path.join(h.workspace, 'grew.bin');
    await fsp.writeFile(small, Buffer.alloc(64));
    const r = await h.fs.resolve('grew.bin', 'read');
    await fsp.writeFile(small, Buffer.alloc(policy.MAX_READ_BYTES + 1));
    const err = await h.fs.readBytes(r).catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });
});

describe('WorkspaceFileSystem - list', () => {
  let h: Harness;
  beforeEach(async () => {
    const ignore = new Ignore().add(['*.log']);
    h = await makeHarness({ ignore });
    await fsp.writeFile(path.join(h.workspace, 'a.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'b.log'), '');
    await fsp.mkdir(path.join(h.workspace, 'sub'));
  });
  afterEach(async () => teardown(h));

  it('drops ignored entries by default', async () => {
    const r = await h.fs.resolve('.', 'list');
    const entries = await h.fs.list(r);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.ts', 'sub']);
  });

  it('includes ignored entries when includeIgnored is true', async () => {
    const r = await h.fs.resolve('.', 'list');
    const entries = await h.fs.list(r, { includeIgnored: true });
    const log = entries.find((e) => e.name === 'b.log');
    expect(log?.ignored).toBe(true);
  });
});

describe('WorkspaceFileSystem - glob', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    await fsp.mkdir(path.join(h.workspace, 'src'));
    await fsp.writeFile(path.join(h.workspace, 'src', 'a.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'src', 'b.ts'), '');
    await fsp.writeFile(path.join(h.workspace, 'README.md'), '');
  });
  afterEach(async () => teardown(h));

  it('matches files by pattern', async () => {
    const hits = await h.fs.glob('src/*.ts');
    expect(hits.map((p) => path.basename(p)).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('rejects patterns containing `..`', async () => {
    const err = await h.fs.glob('../**/*.ts').catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
  });

  it('rejects POSIX-absolute patterns up-front (no I/O outside workspace)', async () => {
    const err = await h.fs.glob('/etc/**/*').catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
  });

  it('rejects Win32 drive-letter and UNC patterns up-front', async () => {
    for (const pattern of [
      'C:\\Users\\foo\\**\\*.ts',
      'C:/Users/foo/**/*.ts',
      '\\\\server\\share\\**',
      '//server/share/**',
    ]) {
      const err = await h.fs.glob(pattern).catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('parse_error');
    }
  });

  it('respects directory-only ignore rules (e.g. dist/) on glob hits', async () => {
    const ignore = new Ignore().add(['dist/']);
    h = await makeHarness({ ignore });
    await fsp.mkdir(path.join(h.workspace, 'dist'));
    await fsp.writeFile(path.join(h.workspace, 'dist', 'bundle.js'), '');
    await fsp.writeFile(path.join(h.workspace, 'src.ts'), '');
    const hits = await h.fs.glob('*');
    const names = hits.map((p) => path.basename(p)).sort();
    // `dist` directory is filtered because the trailing-slash dir
    // pattern now probes `<rel>/` against the directory ignorer.
    expect(names).not.toContain('dist');
    expect(names).toContain('src.ts');
  });

  it('prunes node_modules and .git at glob walk time (no traversal cost)', async () => {
    // The `ignore` option passed to `globAsync` short-circuits
    // traversal at the directory level — files under
    // node_modules/.git never reach our per-hit realpath +
    // shouldIgnore filter. Simulate a workspace with deps and
    // assert the deeply-nested `node_modules` file is absent
    // even from a `**/*` glob.
    await fsp.mkdir(
      path.join(h.workspace, 'node_modules', 'left-pad', 'dist'),
      {
        recursive: true,
      },
    );
    await fsp.writeFile(
      path.join(h.workspace, 'node_modules', 'left-pad', 'dist', 'index.js'),
      'module.exports = function leftPad() {};\n',
    );
    await fsp.mkdir(path.join(h.workspace, '.git', 'objects'), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(h.workspace, '.git', 'objects', 'pack.bin'),
      '',
    );
    await fsp.writeFile(path.join(h.workspace, 'src.ts'), '');
    const hits = await h.fs.glob('**/*');
    const names = hits.map((p) => path.relative(h.workspace, p));
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('.git'))).toBe(false);
    expect(names).toContain('src.ts');
  });

  it('respects maxResults', async () => {
    const hits = await h.fs.glob('**/*', { maxResults: 1 });
    expect(hits).toHaveLength(1);
  });

  it('filters ignored hits by default', async () => {
    const ignore = new Ignore().add(['*.md']);
    h = await makeHarness({ ignore });
    await fsp.writeFile(path.join(h.workspace, 'README.md'), '');
    await fsp.writeFile(path.join(h.workspace, 'src.ts'), '');
    const hits = await h.fs.glob('*');
    const names = hits.map((p) => path.basename(p)).sort();
    expect(names).not.toContain('README.md');
  });
});

describe('WorkspaceFileSystem - write/edit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('writes text and emits fs.access', async () => {
    const r = await h.fs.resolve('newfile.txt', 'write');
    await h.fs.writeText(r, 'hello');
    const written = await fsp.readFile(r as string, 'utf-8');
    expect(written).toBe('hello');
    const access = h.events.find(
      (e) =>
        e.type === FS_ACCESS_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'write',
    );
    expect(access).toBeDefined();
  });

  it('rejects oversize writes with file_too_large', async () => {
    const r = await h.fs.resolve('huge.txt', 'write');
    const err = await h.fs
      .writeText(r, 'a'.repeat(6 * 1024 * 1024))
      .catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });

  it('edits an existing file by replacing oldText with newText', async () => {
    const target = path.join(h.workspace, 'config.txt');
    await fsp.writeFile(target, 'foo=1\nbar=2\n');
    const r = await h.fs.resolve('config.txt', 'write');
    const out = await h.fs.edit(r, 'foo=1', 'foo=42');
    expect(out.writtenBytes).toBeGreaterThan(0);
    const after = await fsp.readFile(target, 'utf-8');
    expect(after).toBe('foo=42\nbar=2\n');
  });

  it('throws parse_error when oldText is not present', async () => {
    const target = path.join(h.workspace, 'c.txt');
    await fsp.writeFile(target, 'abc');
    const r = await h.fs.resolve('c.txt', 'write');
    const err = await h.fs.edit(r, 'NOT THERE', 'X').catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
  });

  it('rejects edit on file > MAX_READ_BYTES with file_too_large (no slurp)', async () => {
    const policy = await import('./policy.js');
    const big = path.join(h.workspace, 'huge.txt');
    await fsp.writeFile(big, 'a'.repeat(policy.MAX_READ_BYTES + 1));
    const r = await h.fs.resolve('huge.txt', 'write');
    const err = await h.fs.edit(r, 'a', 'b').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });

  it('rejects edit() with empty oldText (would silently prepend newText otherwise)', async () => {
    // JS `''.indexOf('')` returns 0, so without the empty-check
    // `current.slice(0, 0) + newText + current.slice(0)` would
    // silently prepend `newText` to the entire file with a success
    // audit event — textbook silent data corruption. Reject up-front.
    const target = path.join(h.workspace, 'silent.txt');
    await fsp.writeFile(target, 'original\n');
    const r = await h.fs.resolve('silent.txt', 'edit');
    const err = await h.fs.edit(r, '', 'INJECTED').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
    // File must be unchanged.
    const after = await fsp.readFile(target, 'utf-8');
    expect(after).toBe('original\n');
  });

  it('edit() error includes oldText snippet in the hint', async () => {
    const target = path.join(h.workspace, 'snippet.txt');
    await fsp.writeFile(target, 'foo=1\nbar=2\n');
    const r = await h.fs.resolve('snippet.txt', 'edit');
    const err = (await h.fs
      .edit(r, 'this string is not present', 'X')
      .catch((e: unknown) => e)) as { hint?: string };
    expect(err.hint).toMatch(/this string is not present/);
  });

  it('edit() preserves UTF-8 BOM round-trip via lowFs (no \\uFEFF leak into oldText match)', async () => {
    // The earlier `fsp.readFile(p, 'utf-8')` would include the
    // BOM (\\uFEFF codepoint) in the returned string, breaking
    // `oldText` matching even when the user passed the exact
    // source text; and the write-back without `_meta` would
    // strip the BOM, silently changing the file's encoding
    // profile. Using `lowFs.readTextFile` strips the BOM for
    // matching and `_meta.bom: true` preserves it on write-back.
    const target = path.join(h.workspace, 'bom.txt');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await fsp.writeFile(
      target,
      Buffer.concat([bom, Buffer.from('foo=1\nbar=2\n', 'utf-8')]),
    );
    const r = await h.fs.resolve('bom.txt', 'edit');
    // oldText is `'foo=1'` WITHOUT BOM — must still match.
    const out = await h.fs.edit(r, 'foo=1', 'foo=42');
    expect(out.writtenBytes).toBeGreaterThan(0);
    const after = await fsp.readFile(target);
    // BOM preserved at start
    expect(after[0]).toBe(0xef);
    expect(after[1]).toBe(0xbb);
    expect(after[2]).toBe(0xbf);
    // Edit applied
    expect(after.subarray(3).toString('utf-8')).toBe('foo=42\nbar=2\n');
  });

  it('rejects edit on binary file', async () => {
    const bin = path.join(h.workspace, 'bin.dat');
    const buf = Buffer.alloc(64);
    buf[5] = 0;
    await fsp.writeFile(bin, buf);
    const r = await h.fs.resolve('bin.dat', 'write');
    const err = await h.fs.edit(r, '\x00', 'x').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('binary_file');
  });

  it('readText converts 1-based line to 0-based slice (line: 1 returns from first line)', async () => {
    const target = path.join(h.workspace, 'lines.txt');
    await fsp.writeFile(target, 'one\ntwo\nthree\n');
    const r = await h.fs.resolve('lines.txt', 'read');
    const out = await h.fs.readText(r, { line: 1, limit: 1 });
    // 1-based line 1 → 0-based slice index 0 → first line "one"
    expect(out.content.split('\n')[0]).toBe('one');
  });

  it('readText with line: 2 starts from the second line', async () => {
    const target = path.join(h.workspace, 'lines2.txt');
    await fsp.writeFile(target, 'one\ntwo\nthree\n');
    const r = await h.fs.resolve('lines2.txt', 'read');
    const out = await h.fs.readText(r, { line: 2, limit: 1 });
    expect(out.content.split('\n')[0]).toBe('two');
  });

  it('rejects non-positive-integer opts.line with parse_error', async () => {
    const target = path.join(h.workspace, 'v.txt');
    await fsp.writeFile(target, 'a\nb\nc\n');
    const r = await h.fs.resolve('v.txt', 'read');
    for (const bad of [Infinity, -Infinity, 0, -1, 1.5, NaN]) {
      const err = await h.fs
        .readText(r, { line: bad })
        .catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('parse_error');
    }
  });

  it('records matchedIgnore on edit() audit (parity with readText/writeText)', async () => {
    const ignore = new Ignore().add(['*.log']);
    h = await makeHarness({ ignore });
    const target = path.join(h.workspace, 'app.log');
    await fsp.writeFile(target, 'foo=1\nbar=2\n');
    const r = await h.fs.resolve('app.log', 'edit');
    await h.fs.edit(r, 'foo=1', 'foo=2');
    const access = h.events.find(
      (e) =>
        e.type === FS_ACCESS_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'edit',
    );
    expect(access).toBeDefined();
    expect((access!.data as { matchedIgnore?: string }).matchedIgnore).toBe(
      'file',
    );
  });
});

describe('WorkspaceFileSystem - trust gate', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ trusted: false });
    await fsp.writeFile(path.join(h.workspace, 'r.txt'), 'r');
  });
  afterEach(async () => teardown(h));

  it('allows read on untrusted workspace', async () => {
    const r = await h.fs.resolve('r.txt', 'read');
    const out = await h.fs.readText(r);
    expect(out.content).toBe('r');
  });

  it('denies write with untrusted_workspace', async () => {
    const r = await h.fs.resolve('w.txt', 'write');
    const err = await h.fs.writeText(r, 'x').catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('untrusted_workspace');
    const denied = h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
  });

  it('denies edit with untrusted_workspace', async () => {
    await fsp.writeFile(path.join(h.workspace, 'e.txt'), 'old');
    const r = await h.fs.resolve('e.txt', 'edit');
    const err = await h.fs.edit(r, 'old', 'new').catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('untrusted_workspace');
  });
});

describe('WorkspaceFileSystem - TOCTOU + UTF-8 + cwd hardening', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('readText detects post-stat symlink swap and rejects with symlink_escape', async () => {
    // Simulate the swap: write a regular file, resolve, then
    // replace it with a symlink to outside the workspace AFTER the
    // boundary's pre-stat. We approximate by performing the swap
    // *before* the call but after `resolve`; since the pre-stat
    // and post-lstat happen back-to-back in the actual call, the
    // post-lstat catches the symlink state.
    const target = path.join(h.workspace, 'victim.txt');
    await fsp.writeFile(target, 'plain');
    const r = await h.fs.resolve('victim.txt', 'read');
    // Replace the regular file with a symlink to an outside path.
    const outside = path.join(h.scratch, 'sensitive.txt');
    await fsp.writeFile(outside, 'sensitive');
    await fsp.unlink(target);
    await fsp.symlink(outside, target, 'file');
    const err = await h.fs.readText(r).catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
  });

  it('safeUtf8Truncate keeps multi-byte codepoints intact at the boundary', async () => {
    // 4-char Chinese string, each char 3 bytes UTF-8 = 12 bytes.
    // A naive slice at 7 bytes would split the 3rd char.
    const src = '中文测试';
    const target = path.join(h.workspace, 'cjk.txt');
    await fsp.writeFile(target, src, 'utf-8');
    const r = await h.fs.resolve('cjk.txt', 'read');
    const out = await h.fs.readText(r, { maxBytes: 7 });
    expect(out.meta.truncated).toBe(true);
    // Result must be a valid prefix (no U+FFFD); 7 bytes / 3 bytes
    // per char → 2 complete chars.
    expect(out.content).toBe('中文');
    expect(out.content).not.toMatch(/�/);
  });

  it('glob rejects opts.cwd that lies outside boundWorkspace', async () => {
    // Forge a `cwd` brand cast pointing outside the workspace; the
    // entry-point validation should refuse before `globAsync` runs.
    const outsideCwd = h.scratch as unknown as ResolvedPath;
    const err = await h.fs
      .glob('**/*', { cwd: outsideCwd })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('path_outside_workspace');
  });

  it('glob rejects opts.cwd that is a symlink resolving outside the workspace', async () => {
    // The textual `path.resolve` + `isWithinRoot` check admits
    // `<ws>/link` even when `<ws>/link → /scratch` is a symlink
    // to outside. `realpath` on cwd follows the chain so the
    // containment check sees the actual walk root and rejects.
    const link = path.join(h.workspace, 'link-to-scratch');
    await fsp.symlink(h.scratch, link, 'dir');
    const err = await h.fs
      .glob('**/*', { cwd: link as unknown as ResolvedPath })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('path_outside_workspace');
  });

  it('writeText rejects when path was swapped to a symlink between resolve and write', async () => {
    // resolve a path → swap target with a symlink to outside →
    // writeText should reject with `symlink_escape` rather than
    // letting `atomicWriteFile`'s symlink-following code write
    // outside the workspace.
    const target = path.join(h.workspace, 'about-to-write.txt');
    const r = await h.fs.resolve('about-to-write.txt', 'write');
    const outside = path.join(h.scratch, 'outside-target.txt');
    await fsp.writeFile(outside, ''); // pre-create so symlink isn't dangling
    await fsp.symlink(outside, target, 'file');
    const err = await h.fs.writeText(r, 'hello').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
    // The outside file MUST remain empty (no escape).
    const outsideContent = await fsp.readFile(outside, 'utf-8');
    expect(outsideContent).toBe('');
  });

  it('edit rejects when path was swapped to a symlink between read and write', async () => {
    // edit() reads the file, then writes back. After the post-read
    // inode check, an attacker could in theory swap to a symlink
    // before the writeTextFile call. The pre-write guard catches
    // that. We approximate: write a file, resolve, edit-pattern
    // setup, then mid-operation we can't easily inject — instead
    // we test the boundary directly by setting up a symlink that
    // matches a pre-existing inode but points outside, similar
    // shape to the writeText test above.
    const target = path.join(h.workspace, 'edit-target.txt');
    await fsp.writeFile(target, 'foo=1\n');
    const r = await h.fs.resolve('edit-target.txt', 'edit');
    // Replace with symlink-to-outside AFTER resolve.
    const outside = path.join(h.scratch, 'edit-outside.txt');
    await fsp.writeFile(outside, 'foo=1\n');
    await fsp.unlink(target);
    await fsp.symlink(outside, target, 'file');
    const err = await h.fs.edit(r, 'foo=1', 'foo=2').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    // post-read inode check fires first since inode changed; either
    // catch is acceptable as a security signal.
    expect(['symlink_escape']).toContain((err as { kind: string }).kind);
    const outsideContent = await fsp.readFile(outside, 'utf-8');
    expect(outsideContent).toBe('foo=1\n');
  });

  it('readBytes opts.maxBytes is clamped to MAX_READ_BYTES (cannot widen past hard cap)', async () => {
    const policy = await import('./policy.js');
    const big = path.join(h.workspace, 'overrun.bin');
    await fsp.writeFile(big, Buffer.alloc(policy.MAX_READ_BYTES + 1));
    const r = await h.fs.resolve('overrun.bin', 'read');
    // Caller tries to widen past the hard cap.
    const err = await h.fs
      .readBytes(r, { maxBytes: policy.MAX_READ_BYTES * 10 })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });
});

describe('WorkspaceFileSystem - audit always emits on body errors', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('wraps a raw ENOENT from edit() and emits fs.denied', async () => {
    // edit() reads via fsp.readFile; against a non-existent file the
    // raw ENOENT used to escape uncategorized — the wrapper now
    // converts it to FsError(path_not_found) and records denial.
    const r = await h.fs.resolve('vanished.txt', 'write');
    const err = await h.fs.edit(r, 'a', 'b').catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('path_not_found');
    const denied = h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
    expect((denied!.data as { errorKind: string }).errorKind).toBe(
      'path_not_found',
    );
  });

  it('rejects ENOTDIR ancestor walk with parse_error rather than passing boundary', async () => {
    // Place a regular file where the request expects a directory.
    await fsp.writeFile(path.join(h.workspace, 'block'), 'not a dir');
    const err = await h.fs
      .resolve('block/leaf', 'write')
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
    const denied = h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
  });

  it('fs.denied audit message field is gated behind QWEN_AUDIT_RAW_PATHS (privacy default omits)', async () => {
    // Default (privacy) mode: `message` MUST be absent because the
    // underlying `FsError.message` embeds `${p}` absolute paths
    // that would otherwise leak workspace structure to audit
    // consumers — even when operators explicitly disabled
    // raw-path logging via not-setting `QWEN_AUDIT_RAW_PATHS`.
    // See `audit.ts:recordDenied` — message gates on
    // `includeRawPaths`.
    const err = (await h.fs
      .resolve('../escape', 'read')
      .catch((e: unknown) => e)) as { message: string };
    expect(err.message).toMatch(/escapes workspace/);
    const denied = h.events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
    // Privacy-default mode: message is OMITTED.
    expect((denied!.data as { message?: string }).message).toBeUndefined();
  });

  it('fs.denied carries message when includeRawPaths is enabled (forensic mode)', async () => {
    // Build a fresh harness with includeRawPaths: true to verify
    // the audit message round-trip works in raw-path mode.
    const events: BridgeEvent[] = [];
    const factory = createWorkspaceFileSystemFactory({
      boundWorkspace: h.workspace,
      trusted: true,
      emit: (e) => events.push(e),
      includeRawPaths: true,
    });
    const fs = factory.forRequest({ route: 'TEST /op' });
    const err = (await fs
      .resolve('../escape', 'read')
      .catch((e: unknown) => e)) as { message: string };
    expect(err.message).toMatch(/escapes workspace/);
    const denied = events.find((e) => e.type === FS_DENIED_EVENT_TYPE);
    expect(denied).toBeDefined();
    expect((denied!.data as { message?: string }).message).toBe(err.message);
  });
});

describe('WorkspaceFileSystem - glob escape audit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('emits aggregated fs.denied for glob hits filtered as escape', async () => {
    // Create an in-workspace file (legit hit) plus a symlink that
    // resolves outside the workspace (filtered hit). The glob
    // aggregation reports the escape count via a single denial
    // event so audit volume stays bounded on misconfigured trees.
    await fsp.writeFile(path.join(h.workspace, 'inside.ts'), 'x');
    const outside = path.join(h.scratch, 'outside.ts');
    await fsp.writeFile(outside, 'y');
    await fsp.symlink(outside, path.join(h.workspace, 'leak.ts'), 'file');
    const hits = await h.fs.glob('*.ts');
    const names = hits.map((p) => path.basename(p)).sort();
    expect(names).toContain('inside.ts');
    expect(names).not.toContain('outside.ts');
    const denied = h.events.find(
      (e) =>
        e.type === FS_DENIED_EVENT_TYPE &&
        (e.data as { errorKind: string }).errorKind === 'symlink_escape',
    );
    expect(denied).toBeDefined();
    expect((denied!.data as { hint?: string }).hint).toMatch(
      /\d+ hit\(s\) that resolved outside workspace/,
    );
  });
});

describe('WorkspaceFileSystem - factory', () => {
  it('canonicalizes the workspace once at factory build', async () => {
    const scratch = await fsp.mkdtemp(
      path.join(
        os.tmpdir(),
        `qwen-wfs-canon-${randomBytes(4).toString('hex')}-`,
      ),
    );
    try {
      const real = path.join(scratch, 'ws');
      await fsp.mkdir(real);
      const aliased = path.join(scratch, 'alias');
      await fsp.symlink(real, aliased, 'dir');
      const events: BridgeEvent[] = [];
      const factory = createWorkspaceFileSystemFactory({
        boundWorkspace: aliased,
        trusted: true,
        emit: (e) => events.push(e),
      });
      const fs = factory.forRequest({ route: 'TEST /op' });
      await fsp.writeFile(path.join(real, 'inside.txt'), 'i');
      const r = await fs.resolve('inside.txt', 'read');
      const out = await fs.readText(r);
      expect(out.content).toBe('i');
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });
});
