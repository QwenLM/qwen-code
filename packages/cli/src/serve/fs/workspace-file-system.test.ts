/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Ignore } from '@qwen-code/qwen-code-core';
import {
  FS_ACCESS_EVENT_TYPE,
  FS_DENIED_EVENT_TYPE,
  createWorkspaceFileSystemFactory,
  type ResolvedPath,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
} from './index.js';
import type { BridgeEvent } from '../event-bus.js';
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
  includeRawPaths?: boolean;
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
    includeRawPaths: opts?.includeRawPaths,
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

function rawHash(data: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
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
    expect(out.meta.sizeBytes).toBe(12);
    expect(out.meta.hash).toBe(rawHash('hello\nworld\n'));
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

  it('reads a bounded window from a file larger than MAX_READ_BYTES', async () => {
    const policy = await import('./policy.js');
    const target = path.join(h.workspace, 'huge.bin');
    await fsp.writeFile(target, Buffer.alloc(policy.MAX_READ_BYTES + 1));
    const r = await h.fs.resolve('huge.bin', 'read');
    const out = await h.fs.readBytesWindow(r, { maxBytes: 16 });
    expect(out.sizeBytes).toBe(policy.MAX_READ_BYTES + 1);
    expect(out.returnedBytes).toBe(16);
    expect(out.truncated).toBe(true);
    expect(out.hash).toBeUndefined();
  });

  it('readBytesWindow honors byte offsets', async () => {
    const target = path.join(h.workspace, 'offset.bin');
    await fsp.writeFile(target, Buffer.from([1, 2, 3, 4, 5, 6]));
    const r = await h.fs.resolve('offset.bin', 'read');
    const out = await h.fs.readBytesWindow(r, { offset: 2, maxBytes: 3 });
    expect(Array.from(out.buffer)).toEqual([3, 4, 5]);
    expect(out.offset).toBe(2);
    expect(out.returnedBytes).toBe(3);
    expect(out.truncated).toBe(true);
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

  it('stops collecting entries once maxEntries is reached', async () => {
    const r = await h.fs.resolve('.', 'list');
    const entries = await h.fs.list(r, {
      includeIgnored: true,
      maxEntries: 2,
    });
    expect(entries).toHaveLength(2);
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

  it('writeTextAtomic creates a new file and returns a raw-byte hash', async () => {
    const r = await h.fs.resolve('atomic-new.txt', 'write');
    const out = await h.fs.writeTextAtomic(r, 'hello\n', {
      mode: 'create',
    });
    expect(out.created).toBe(true);
    expect(out.sizeBytes).toBe(6);
    expect(out.hash).toBe(rawHash('hello\n'));
    expect(await fsp.readFile(r as string, 'utf-8')).toBe('hello\n');
  });

  it('writeTextAtomic create rejects existing files', async () => {
    const target = path.join(h.workspace, 'exists.txt');
    await fsp.writeFile(target, 'old');
    const r = await h.fs.resolve('exists.txt', 'write');
    const err = await h.fs
      .writeTextAtomic(r, 'new', { mode: 'create' })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_already_exists');
    expect(await fsp.readFile(target, 'utf-8')).toBe('old');
  });

  it('writeTextAtomic replace requires the current expectedHash', async () => {
    const target = path.join(h.workspace, 'replace.txt');
    await fsp.writeFile(target, 'old\n');
    const r = await h.fs.resolve('replace.txt', 'write');
    const err = await h.fs
      .writeTextAtomic(r, 'new\n', {
        mode: 'replace',
        expectedHash: rawHash('not current'),
      })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('hash_mismatch');
    expect(await fsp.readFile(target, 'utf-8')).toBe('old\n');

    const out = await h.fs.writeTextAtomic(r, 'new\n', {
      mode: 'replace',
      expectedHash: rawHash('old\n'),
    });
    expect(out.created).toBe(false);
    expect(out.hash).toBe(rawHash('new\n'));
    expect(await fsp.readFile(target, 'utf-8')).toBe('new\n');
  });

  it('rejects oversize writes with file_too_large', async () => {
    const r = await h.fs.resolve('huge.txt', 'write');
    const err = await h.fs
      .writeText(r, 'a'.repeat(6 * 1024 * 1024))
      .catch((e) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });

  // ----- writeTextOverwrite -----
  // The "unconditional create-or-overwrite, no client hash" primitive
  // used by adapters whose wire format omits expectedHash (ACP
  // `WriteTextFileRequest` is the immediate consumer). Tests pin the
  // BridgeFileSystem-contract guarantees the adapter relies on:
  // atomic write, mode preservation, `0o600` default for new files,
  // symlink rejection.

  it('writeTextOverwrite creates a new file at 0o600 (no umask leakage)', async () => {
    // Skipped on Windows where POSIX permission bits are not honored.
    if (process.platform === 'win32') return;
    const r = await h.fs.resolve('new-overwrite.txt', 'write');
    const out = await h.fs.writeTextOverwrite(r, 'hello\n');
    expect(out.created).toBe(true);
    expect(out.sizeBytes).toBe(6);
    expect(out.hash).toBe(rawHash('hello\n'));
    expect(await fsp.readFile(r as string, 'utf-8')).toBe('hello\n');
    const st = await fsp.lstat(r as string);
    expect(st.mode & 0o7777).toBe(0o600);
  });

  it('writeTextOverwrite preserves existing target mode bits', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(h.workspace, 'secret.txt');
    await fsp.writeFile(target, 'old', { mode: 0o600 });
    await fsp.chmod(target, 0o600);
    const r = await h.fs.resolve('secret.txt', 'write');
    const out = await h.fs.writeTextOverwrite(r, 'new');
    expect(out.created).toBe(false);
    expect(out.hash).toBe(rawHash('new'));
    expect(await fsp.readFile(target, 'utf-8')).toBe('new');
    const st = await fsp.lstat(target);
    expect(st.mode & 0o7777).toBe(0o600);
  });

  it('writeTextOverwrite preserves an executable +x bit on overwrite', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(h.workspace, 'exec.sh');
    await fsp.writeFile(target, '#!/bin/sh\necho old\n', { mode: 0o755 });
    await fsp.chmod(target, 0o755);
    const r = await h.fs.resolve('exec.sh', 'write');
    await h.fs.writeTextOverwrite(r, '#!/bin/sh\necho new\n');
    const st = await fsp.lstat(target);
    expect(st.mode & 0o7777).toBe(0o755);
  });

  it('writeTextOverwrite rejects symlink targets planted post-resolve (symlink_escape)', async () => {
    // Parity with writeTextAtomic and HTTP POST /file from PR 20 —
    // the inline pre-F1 BridgeClient proxy resolved symlinks; PR 18
    // intentionally rejects them so a planted link can't redirect a
    // write outside the operator's expectation. Mirrors the existing
    // `writeText rejects when path was swapped to a symlink between
    // resolve and write` shape so the test only differs in which
    // method is invoked (writeTextOverwrite).
    if (process.platform === 'win32') return;
    const target = path.join(h.workspace, 'about-to-overwrite.txt');
    const r = await h.fs.resolve('about-to-overwrite.txt', 'write');
    const outside = path.join(h.scratch, 'overwrite-outside.txt');
    await fsp.writeFile(outside, ''); // pre-create so symlink isn't dangling
    await fsp.symlink(outside, target, 'file');
    const err = await h.fs
      .writeTextOverwrite(r, 'attacker')
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
    // The outside file MUST remain empty (no escape).
    expect(await fsp.readFile(outside, 'utf-8')).toBe('');
  });

  it('writeTextOverwrite enforces the trust gate', async () => {
    const untrusted = await makeHarness({ trusted: false });
    try {
      const r = await untrusted.fs.resolve('denied.txt', 'write');
      const err = await untrusted.fs
        .writeTextOverwrite(r, 'x')
        .catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('untrusted_workspace');
    } finally {
      await teardown(untrusted);
    }
  });

  it('writeTextOverwrite emits fs.access on success', async () => {
    const r = await h.fs.resolve('audited.txt', 'write');
    await h.fs.writeTextOverwrite(r, 'audited-content');
    const access = h.events.find(
      (e) =>
        e.type === FS_ACCESS_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'write',
    );
    expect(access).toBeDefined();
  });

  it('writeTextOverwrite succeeds over an existing >MAX_READ_BYTES file', async () => {
    // wenshao #4334 review: the meta-read inside writeTextOverwrite is
    // best-effort (only used for encoding / BOM / line-ending hints).
    // A `file_too_large` thrown by `readExistingTextMeta` must NOT
    // block the overwrite — pre-PR the inline `BridgeClient` proxy
    // never read the existing file, so overwriting a 1 MiB log via
    // the agent was always supported. Regression guard for that.
    const { MAX_READ_BYTES } = await import('./policy.js');
    const target = path.join(h.workspace, 'big-existing.log');
    await fsp.writeFile(target, 'a'.repeat(MAX_READ_BYTES + 1024));
    const r = await h.fs.resolve('big-existing.log', 'write');
    const out = await h.fs.writeTextOverwrite(r, 'tiny');
    expect(out.created).toBe(false);
    expect(await fsp.readFile(target, 'utf-8')).toBe('tiny');
  });

  it('writeTextOverwrite succeeds over an existing 0o000 (unreadable) file', async () => {
    // wenshao #4334 review: EACCES on the best-effort meta-read must
    // NOT block the overwrite. Pre-PR the inline BridgeClient proxy
    // never read the existing file, so the daemon could always
    // overwrite an unreadable target (subject only to the parent dir's
    // write permission). The 0o000 case also matters as a probing
    // defense — bubbling EACCES on overwrite would let agents probe
    // file readability indirectly.
    // Skipped on Windows + when running as root (root bypasses mode bits).
    if (process.platform === 'win32') return;
    if (process.getuid && process.getuid() === 0) return;
    const target = path.join(h.workspace, 'unreadable-secret.txt');
    await fsp.writeFile(target, 'old-secret', { mode: 0o000 });
    await fsp.chmod(target, 0o000);
    try {
      const r = await h.fs.resolve('unreadable-secret.txt', 'write');
      const out = await h.fs.writeTextOverwrite(r, 'new-content');
      expect(out.created).toBe(false);
      // Restore mode so the test can read back the content for verification.
      await fsp.chmod(target, 0o600);
      expect(await fsp.readFile(target, 'utf-8')).toBe('new-content');
    } finally {
      // Best-effort restore so afterEach rm doesn't trip on a 0o000 file.
      await fsp.chmod(target, 0o600).catch(() => {});
    }
  });

  it('writeTextOverwrite succeeds over an existing binary file', async () => {
    // Sibling of the >MAX_READ_BYTES regression: existing binary
    // content makes `readExistingTextMeta` throw `binary_file`. The
    // overwrite must still succeed since the new content is text and
    // ACP semantics is "just write".
    const target = path.join(h.workspace, 'binary-existing.bin');
    const buf = Buffer.alloc(64);
    buf[5] = 0; // null byte → looksBinary()
    await fsp.writeFile(target, buf);
    const r = await h.fs.resolve('binary-existing.bin', 'write');
    const out = await h.fs.writeTextOverwrite(r, 'now-text');
    expect(out.created).toBe(false);
    expect(await fsp.readFile(target, 'utf-8')).toBe('now-text');
  });

  it('writeTextOverwrite rejects a directory target with parse_error', async () => {
    // wenshao #4334 review sub-bullet: `assertAtomicTargetPrecondition`
    // throws `parse_error` for non-regular files in the 'overwrite'
    // branch (parity with 'replace'). Pin it so a future refactor that
    // accidentally relaxes that branch (e.g. by treating a directory
    // as "missing target → create") is caught.
    const dir = path.join(h.workspace, 'a-dir');
    await fsp.mkdir(dir);
    const r = await h.fs.resolve('a-dir', 'write');
    const err = await h.fs
      .writeTextOverwrite(r, 'noop')
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
  });

  it('writeTextOverwrite rejects content exceeding MAX_WRITE_BYTES with file_too_large', async () => {
    // wenshao #4334 review: the `enforceWriteSize(decodedSizeBytes)`
    // call at the top of `writeTextOverwrite` mirrors `writeText`'s
    // 5 MiB cap. The existing oversized-write test only exercises
    // `writeText`; pin the cap for `writeTextOverwrite` too since it's
    // the primary consumer (ACP adapter). A regression dropping this
    // check would let agents write arbitrarily large files undetected.
    const { MAX_WRITE_BYTES } = await import('./policy.js');
    const r = await h.fs.resolve('huge-overwrite.txt', 'write');
    const err = await h.fs
      .writeTextOverwrite(r, 'a'.repeat(MAX_WRITE_BYTES + 1024))
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('file_too_large');
  });

  it('writeTextAtomic rejects mode="overwrite" with parse_error (internal-only)', async () => {
    // wenshao #4334 review: `'overwrite'` is a `WriteMode` value but
    // `writeTextAtomic`'s `existingMeta` branch only reads metadata for
    // `'replace'` AND its `created` outcome is hard-coded to `opts.mode
    // === 'create'`. A direct caller of `writeTextAtomic({mode:
    // 'overwrite'})` would silently drop CRLF on Windows files and
    // report `created: false` for new files. The validator explicitly
    // rejects this combination so the only supported path for
    // unconditional-overwrite semantics is the dedicated
    // `writeTextOverwrite()` method (which handles both correctly).
    const r = await h.fs.resolve('atomic-overwrite-reject.txt', 'write');
    const err = await h.fs
      .writeTextAtomic(r, 'x', { mode: 'overwrite' as never })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
    expect((err as Error).message).toMatch(/writeTextOverwrite/);
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

  it('rejects non-positive-integer opts.limit with parse_error', async () => {
    const target = path.join(h.workspace, 'v.txt');
    await fsp.writeFile(target, 'a\nb\nc\n');
    const r = await h.fs.resolve('v.txt', 'read');
    for (const bad of [
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      0,
      -1,
      1.5,
      NaN,
    ]) {
      const err = await h.fs
        .readText(r, { limit: bad })
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

  it('editAtomic applies exactly one replacement and returns the new hash', async () => {
    const target = path.join(h.workspace, 'atomic-edit.txt');
    await fsp.writeFile(target, 'foo=1\nbar=2\n');
    const r = await h.fs.resolve('atomic-edit.txt', 'edit');
    const out = await h.fs.editAtomic(r, 'foo=1', 'foo=42', {
      expectedHash: rawHash('foo=1\nbar=2\n'),
    });
    expect(out.writtenBytes).toBe(Buffer.byteLength('foo=42\nbar=2\n'));
    expect(out.hash).toBe(rawHash('foo=42\nbar=2\n'));
    expect(await fsp.readFile(target, 'utf-8')).toBe('foo=42\nbar=2\n');
  });

  it('editAtomic validates expectedHash against the edited snapshot first', async () => {
    const target = path.join(h.workspace, 'atomic-edit-stale.txt');
    await fsp.writeFile(target, 'foo=1\n');
    const r = await h.fs.resolve('atomic-edit-stale.txt', 'edit');
    const err = await h.fs
      .editAtomic(r, 'missing', 'foo=2', {
        expectedHash: rawHash('different\n'),
      })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('hash_mismatch');
    expect(await fsp.readFile(target, 'utf-8')).toBe('foo=1\n');
  });

  it('editAtomic rejects absent and ambiguous matches with typed errors', async () => {
    const target = path.join(h.workspace, 'atomic-ambiguous.txt');
    await fsp.writeFile(target, 'x\nx\n');
    const r = await h.fs.resolve('atomic-ambiguous.txt', 'edit');
    const missing = await h.fs
      .editAtomic(r, 'y', 'z', { expectedHash: rawHash('x\nx\n') })
      .catch((e: unknown) => e);
    expect(isFsError(missing)).toBe(true);
    expect((missing as { kind: string }).kind).toBe('text_not_found');
    const ambiguous = await h.fs
      .editAtomic(r, 'x', 'z', { expectedHash: rawHash('x\nx\n') })
      .catch((e: unknown) => e);
    expect(isFsError(ambiguous)).toBe(true);
    expect((ambiguous as { kind: string }).kind).toBe('ambiguous_text_match');
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

  it('writeTextAtomic does not write through a swapped temporary symlink', async () => {
    const outside = path.join(h.scratch, 'temp-race-outside.txt');
    await fsp.writeFile(outside, 'outside\n');
    const originalOpen = fsp.open.bind(fsp);
    const openSpy = vi
      .spyOn(fsp, 'open')
      .mockImplementation(async (...args) => {
        const fh = await originalOpen(...args);
        const candidate = String(args[0]);
        if (
          candidate.includes('.temp-race.txt.') &&
          candidate.endsWith('.tmp') &&
          args[1] === 'wx'
        ) {
          const originalWriteFile = fh.writeFile.bind(fh);
          vi.spyOn(fh, 'writeFile').mockImplementation(async (...writeArgs) => {
            await fsp.unlink(candidate);
            await fsp.symlink(outside, candidate, 'file');
            return originalWriteFile(...writeArgs);
          });
        }
        return fh;
      });

    try {
      const r = await h.fs.resolve('temp-race.txt', 'write');
      const err = await h.fs
        .writeTextAtomic(r, 'secret\n', { mode: 'create' })
        .catch((e: unknown) => e);
      expect(isFsError(err)).toBe(true);
      expect((err as { kind: string }).kind).toBe('symlink_escape');
      expect(await fsp.readFile(outside, 'utf-8')).toBe('outside\n');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('readBytes rejects opts.maxBytes above MAX_READ_BYTES', async () => {
    const policy = await import('./policy.js');
    const big = path.join(h.workspace, 'overrun.bin');
    await fsp.writeFile(big, Buffer.alloc(policy.MAX_READ_BYTES + 1));
    const r = await h.fs.resolve('overrun.bin', 'read');
    const err = await h.fs
      .readBytes(r, { maxBytes: policy.MAX_READ_BYTES * 10 })
      .catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('parse_error');
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
  // `pattern` rides on the same privacy gate as `relPath` /
  // `message`. Use `includeRawPaths: true` so the orchestrator's
  // pattern wiring is observable in the test harness.
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ includeRawPaths: true });
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
    expect((denied!.data as { pattern?: string }).pattern).toBe('*.ts');
  });

  it('records fs.access with workspace-hashed pathHash and pattern field on glob success (raw-paths mode)', async () => {
    await fsp.writeFile(path.join(h.workspace, 'one.ts'), 'a');
    await h.fs.glob('*.ts');
    const access = h.events.find(
      (e) =>
        e.type === FS_ACCESS_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'glob',
    );
    expect(access).toBeDefined();
    const data = access!.data as { pathHash: string; pattern?: string };
    expect(data.pattern).toBe('*.ts');
    // Hash equals sha256(boundWorkspace) sliced to 16 hex chars —
    // every glob audit row in this workspace shares the same
    // pathHash, and `pattern` is the per-call signal.
    const expectedHash = createHash('sha256')
      .update(h.workspace)
      .digest('hex')
      .slice(0, 16);
    expect(data.pathHash).toBe(expectedHash);
  });

  it('emits fs.denied with pattern when glob pattern is rejected as parse_error (raw-paths mode)', async () => {
    await expect(h.fs.glob('../../**')).rejects.toThrow(/'..' segments/);
    const denied = h.events.find(
      (e) =>
        e.type === FS_DENIED_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'glob' &&
        (e.data as { errorKind: string }).errorKind === 'parse_error',
    );
    expect(denied).toBeDefined();
    expect((denied!.data as { pattern?: string }).pattern).toBe('../../**');
  });
});

describe('WorkspaceFileSystem - glob audit privacy default', () => {
  // Default factory has `includeRawPaths: false`. The orchestrator
  // still passes the pattern, but the audit publisher must strip it
  // — same gate as `relPath` / `message`. Locks the privacy regression
  // surfaced by the round-1 review on PR #4269.
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => teardown(h));

  it('strips pattern from fs.access in privacy default', async () => {
    await fsp.writeFile(path.join(h.workspace, 'one.ts'), 'a');
    await h.fs.glob('*.ts');
    const access = h.events.find(
      (e) =>
        e.type === FS_ACCESS_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'glob',
    );
    expect(access).toBeDefined();
    expect(access!.data).not.toHaveProperty('pattern');
    expect(access!.data).not.toHaveProperty('relPath');
  });

  it('strips pattern from fs.denied in privacy default', async () => {
    await expect(h.fs.glob('../../**')).rejects.toThrow();
    const denied = h.events.find(
      (e) =>
        e.type === FS_DENIED_EVENT_TYPE &&
        (e.data as { intent: string }).intent === 'glob' &&
        (e.data as { errorKind: string }).errorKind === 'parse_error',
    );
    expect(denied).toBeDefined();
    expect(denied!.data).not.toHaveProperty('pattern');
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
