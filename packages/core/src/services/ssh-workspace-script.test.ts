/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  statSync,
  readFileSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SSH_WORKSPACE_SCRIPT } from './ssh-workspace-script.js';

interface Reply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

describe.skipIf(process.platform === 'win32')('SSH filesystem script', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-ssh-script-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function request(
    operation: string,
    params: Record<string, unknown> = {},
    env?: NodeJS.ProcessEnv,
  ): Reply {
    const child = spawnSync('python3', ['-c', SSH_WORKSPACE_SCRIPT], {
      input: JSON.stringify({ root, operation, params }),
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout) as Reply;
  }

  it('probes the remote root and preserves UTF-8 BOM and CRLF in reads and conditional writes', () => {
    expect(request('probe')).toEqual({ ok: true, result: { directory: root } });
    const content = '\uFEFF你好\r\nsecond\r\n';
    writeFileSync(join(root, 'script.sh'), content, { mode: 0o700 });
    const read = request('read', { path: 'script.sh' });
    expect(read.ok).toBe(true);
    const result = read.result as {
      content: string;
      hash: string;
      sizeBytes: number;
    };
    expect(result).toMatchObject({
      content,
      sizeBytes: Buffer.byteLength(content),
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(
      request('write', {
        path: 'script.sh',
        content: 'changed\r\n',
        expectedHash: result.hash,
        mode: 'replace',
      }),
    ).toMatchObject({ ok: true, result: { created: false } });
    expect(statSync(join(root, 'script.sh')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe('changed\r\n');
    expect(
      request('write', {
        path: 'script.sh',
        content: 'stale',
        expectedHash: result.hash,
        mode: 'replace',
      }),
    ).toMatchObject({ ok: false, error: { code: 'hash_mismatch' } });
    expect(readFileSync(join(root, 'script.sh'), 'utf8')).toBe('changed\r\n');
  });

  it('creates private files atomically and rejects overwrite through create mode', () => {
    expect(request('mkdir', { path: 'a/b', recursive: true }).ok).toBe(true);
    expect(
      request('write', { path: 'a/b/new', content: 'one', mode: 'create' }),
    ).toMatchObject({ ok: true, result: { created: true, sizeBytes: 3 } });
    expect(statSync(join(root, 'a/b/new')).mode & 0o777).toBe(0o600);
    expect(
      request('write', { path: 'a/b/new', content: 'two', mode: 'create' }),
    ).toMatchObject({ ok: false, error: { code: 'file_already_exists' } });
    expect(
      request('write', { path: 'a/b/new', content: 'two', mode: 'replace' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
  });

  it('rejects traversal and symbolic links for both reads and writes', () => {
    writeFileSync(join(root, 'safe'), 'original');
    symlinkSync(join(root, 'safe'), join(root, 'link'));
    symlinkSync(root, join(root, 'directory-link'));
    for (const operation of ['read', 'write']) {
      expect(
        request(operation, { path: '../outside', content: 'changed' }),
      ).toMatchObject({ ok: false, error: { code: 'path_outside_workspace' } });
      expect(
        request(operation, { path: '/etc/passwd', content: 'changed' }),
      ).toMatchObject({ ok: false, error: { code: 'path_outside_workspace' } });
      expect(
        request(operation, { path: 'link', content: 'changed' }),
      ).toMatchObject({ ok: false, error: { code: 'symlink_escape' } });
      expect(
        request(operation, { path: 'directory-link/safe', content: 'changed' }),
      ).toMatchObject({ ok: false, error: { code: 'symlink_escape' } });
    }
    expect(readFileSync(join(root, 'safe'), 'utf8')).toBe('original');
    expect(request('stat', { path: 'link' })).toMatchObject({
      ok: true,
      result: { kind: 'symlink' },
    });
  });

  it('returns bounded byte windows with the full file size and hash', () => {
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    expect(
      request('write', {
        path: 'bytes',
        data: bytes.toString('base64'),
        mode: 'create',
      }).ok,
    ).toBe(true);
    const full = request('readBytes', { path: 'bytes' }).result as {
      hash: string;
    };
    expect(
      request('readBytes', { path: 'bytes', offset: 1, maxBytes: 2 }),
    ).toEqual({
      ok: true,
      result: {
        data: bytes.subarray(1, 3).toString('base64'),
        sizeBytes: 5,
        hash: full.hash,
      },
    });
    expect(request('readBytes', { path: 'bytes', offset: -1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' },
    });
    expect(request('read', { path: 'bytes' })).toMatchObject({
      ok: false,
      error: { code: 'binary_file' },
    });
    writeFileSync(join(root, 'non-utf8'), Buffer.from([255, 254]));
    expect(request('read', { path: 'non-utf8' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported_encoding' },
    });
  });

  it('enforces the file size limit without returning partial text as complete', () => {
    const file = join(root, 'large');
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(request('read', { path: file })).toMatchObject({
      ok: false,
      error: { code: 'file_too_large' },
    });
    expect(request('read', { path: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'path_not_found' },
    });
  });

  it('honors Git and Qwen ignore rules, including tracked files, and bounds search results', () => {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(root, '.qwenignore'), 'secret.txt\n');
    for (const name of [
      'ignored.txt',
      'secret.txt',
      'visible.txt',
      'src/nested.txt',
    ]) {
      writeFileSync(join(root, name), 'needle\nNEEDLE\n');
    }
    execFileSync('git', [
      '-C',
      root,
      'add',
      '--force',
      'ignored.txt',
      'secret.txt',
    ]);
    const monitor = join(root, '.git', 'test-fsmonitor');
    writeFileSync(monitor, '#!/bin/sh\ntouch "$PWD/fsmonitor-ran"\n', {
      mode: 0o700,
    });
    execFileSync('git', ['-C', root, 'config', 'core.fsmonitor', monitor]);
    expect(request('glob', { pattern: '**/*.txt' })).toEqual({
      ok: true,
      result: {
        paths: [join(root, 'src/nested.txt'), join(root, 'visible.txt')],
        truncated: false,
      },
    });
    expect(
      request(
        'glob',
        { pattern: '**/*.txt' },
        { ...process.env, GIT_DIR: join(root, 'missing-git-directory') },
      ),
    ).toMatchObject({
      ok: true,
      result: {
        paths: [join(root, 'src/nested.txt'), join(root, 'visible.txt')],
      },
    });
    expect(
      request('grep', {
        pattern: 'needle',
        glob: '*.txt',
        caseSensitive: false,
        limit: 1,
      }),
    ).toEqual({
      ok: true,
      result: { text: 'src/nested.txt:1:needle', truncated: true },
    });
    expect(request('glob', { pattern: '*.txt', path: 'src' })).toEqual({
      ok: true,
      result: { paths: [join(root, 'src/nested.txt')], truncated: false },
    });
    expect(request('grep', { pattern: 'needle', glob: '*.txt' })).toMatchObject(
      {
        ok: true,
        result: {
          text: 'src/nested.txt:1:needle\nvisible.txt:1:needle',
          truncated: false,
        },
      },
    );
    expect(existsSync(join(root, 'fsmonitor-ran'))).toBe(false);
  });

  it('collects bounded Git untracked statistics in one request without following links', () => {
    writeFileSync(join(root, 'text'), 'one\ntwo\n');
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2]));
    symlinkSync('/outside-workspace', join(root, 'link'));
    expect(
      request('gitUntrackedStats', {
        paths: ['text', 'binary', 'link', 'missing'],
        maxBytes: 6,
      }),
    ).toEqual({
      ok: true,
      result: [
        { path: 'text', added: 2, isBinary: false, truncated: true },
        { path: 'binary', added: 0, isBinary: true, truncated: false },
        { path: 'link', added: 0, isBinary: true, truncated: false },
        { path: 'missing', added: 0, isBinary: true, truncated: false },
      ],
    });
    expect(
      request('gitUntrackedStats', { paths: ['../outside'] }),
    ).toMatchObject({
      ok: false,
      error: { code: 'path_outside_workspace' },
    });
    expect(
      request('gitUntrackedStats', { paths: ['text'], maxLines: 1 }),
    ).toMatchObject({
      ok: true,
      result: [{ path: 'text', added: 2, lines: ['one'], truncated: true }],
    });
  });

  it('sorts glob matches by modification time before applying the result limit', () => {
    writeFileSync(join(root, 'a.txt'), 'older');
    writeFileSync(join(root, 'z.txt'), 'newer');
    utimesSync(join(root, 'a.txt'), 100, 100);
    utimesSync(join(root, 'z.txt'), 200, 200);
    expect(request('glob', { pattern: '*.txt', limit: 1 })).toEqual({
      ok: true,
      result: { paths: [join(root, 'z.txt')], truncated: true },
    });
  });

  it('returns the requested directory window and accepts the route glob truncation probe', () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(join(root, name), 'text');
    expect(request('list', { maxEntries: 2 })).toEqual({
      ok: true,
      result: [
        { name: 'a.txt', kind: 'file', ignored: false },
        { name: 'b.txt', kind: 'file', ignored: false },
      ],
    });
    const result = request('glob', { pattern: '*.txt', maxResults: 50001 });
    expect(result).toMatchObject({ ok: true, result: { truncated: false } });
    expect((result.result as { paths: string[] }).paths).toHaveLength(3);
  });

  it('matches a glob filter against an explicitly selected file name', () => {
    writeFileSync(join(root, 'visible.txt'), 'needle\n');
    expect(
      request('grep', {
        pattern: 'needle',
        path: 'visible.txt',
        glob: '*.txt',
      }),
    ).toMatchObject({
      ok: true,
      result: { text: 'visible.txt:1:needle', truncated: false },
    });
  });

  it('fails explicitly for unsupported ignore files and glob features', () => {
    writeFileSync(join(root, '.gitignore'), 'secret\n');
    writeFileSync(join(root, 'secret'), 'secret');
    expect(request('glob', { pattern: '**/*' })).toMatchObject({
      ok: false,
      error: { code: 'unsupported_ignore' },
    });
    expect(
      request('glob', { pattern: '{a,b}', includeIgnored: true }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported_pattern' } });
  });

  it('runs shell commands in a checked remote directory without interpolating the command', () => {
    mkdirSync(join(root, "quoted ' directory"));
    const child = spawnSync('python3', ['-c', SSH_WORKSPACE_SCRIPT], {
      input: JSON.stringify({
        root,
        operation: 'execute',
        params: {
          path: "quoted ' directory",
          command: 'pwd; printf "value\\n"; exit 7',
        },
      }),
      encoding: 'utf8',
    });
    expect(child.status).toBe(7);
    expect(child.stdout).toBe(`${join(root, "quoted ' directory")}\nvalue\n`);
    expect(child.stderr).toBe('');
  });
});
