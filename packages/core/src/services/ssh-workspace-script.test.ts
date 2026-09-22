/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    script = SSH_WORKSPACE_SCRIPT,
  ): Reply {
    const child = spawnSync('python3', ['-c', script], {
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
    expect(request('readBytes', { path: 'bytes' })).toMatchObject({
      ok: true,
      result: { hash: expect.stringMatching(/^sha256:/) },
    });
    expect(
      request('readBytes', { path: 'bytes', offset: 1, maxBytes: 2 }),
    ).toEqual({
      ok: true,
      result: {
        data: bytes.subarray(1, 3).toString('base64'),
        sizeBytes: 5,
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

  it.each([
    '.agentignore',
    '.aiignore',
    '.cursorignore',
    '.config/ignore',
    './.cursorignore',
    '.config/./ignore',
  ])(
    'applies %s to tracked and untracked search results and listings',
    (ignoreFile) => {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, '.config'));
      writeFileSync(join(root, '.qwenignore'), 'first.txt\n');
      writeFileSync(join(root, ignoreFile), '!first.txt\nsecond.txt\n');
      for (const name of ['first.txt', 'second.txt', 'visible.txt'])
        writeFileSync(join(root, name), 'needle\n');
      execFileSync('git', ['-C', root, 'add', '-f', 'first.txt']);
      const options = ['.agentignore', '.aiignore'].includes(ignoreFile)
        ? {}
        : { ignoreFiles: ['.qwenignore', ignoreFile] };
      expect(request('glob', { pattern: '**/*.txt', ...options })).toEqual({
        ok: true,
        result: { paths: [join(root, 'visible.txt')], truncated: false },
      });
      expect(
        request('grep', { pattern: 'needle', glob: '*.txt', ...options }),
      ).toEqual({
        ok: true,
        result: { text: 'visible.txt:1:needle', truncated: false },
      });
      const listed = request('list', { ...options }).result as Array<{
        name: string;
      }>;
      expect(listed.map((entry) => entry.name)).not.toContain('first.txt');
      expect(listed.map((entry) => entry.name)).not.toContain('second.txt');
      rmSync(join(root, '.git'), { recursive: true });
      rmSync(join(root, '.qwenignore'));
      for (const operation of ['glob', 'grep'])
        expect(request(operation, { pattern: '*', ...options })).toMatchObject({
          ok: false,
          error: { code: 'unsupported_ignore' },
        });
    },
  );

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
    expect(child.status).toBe(0);
    const frames = child.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toEqual({ ok: true, result: { exitCode: 7 } });
    expect(
      frames
        .slice(0, -1)
        .map((frame) => Buffer.from(frame.data, 'base64').toString())
        .join(''),
    ).toBe(`${join(root, "quoted ' directory")}\nvalue\n`);
    expect(child.stderr).toBe('');
  });
  it('executes the Bash syntax advertised to the agent', () => {
    const child = spawnSync('python3', ['-c', SSH_WORKSPACE_SCRIPT], {
      input: JSON.stringify({
        root,
        operation: 'execute',
        params: {
          command:
            '[[ -d . ]] && source /dev/null && set -o pipefail && printf "%s\\n" "$0" {one,two}',
        },
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    const frames = child.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.at(-1)).toEqual({ ok: true, result: { exitCode: 0 } });
    expect(frames.filter((frame) => frame.stream === 'stderr')).toEqual([]);
    const output = frames
      .filter((frame) => frame.stream === 'stdout')
      .map((frame) => Buffer.from(frame.data, 'base64').toString())
      .join('');
    expect(output).toBe('bash\none\ntwo\n');
  });

  it.each([
    ['silent', 'touch started; sleep 4; touch after-disconnect', false],
    [
      'redirected output',
      'exec >/dev/null 2>&1; touch started; sleep 4; touch after-disconnect',
      false,
    ],
    [
      'TERM-ignoring child',
      `bash -c 'trap "" TERM; touch started; sleep 4; touch after-disconnect' & wait`,
      false,
    ],
    [
      'broken output pipe',
      'touch started; sleep 1; printf output; sleep 3; touch after-disconnect',
      true,
    ],
  ])(
    'stops the remote process group on disconnect: %s',
    async (_name, command, closeOutput) => {
      const child = spawn('python3', ['-c', SSH_WORKSPACE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', () => resolve());
      });
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.write(
        JSON.stringify({
          root,
          operation: 'execute',
          watchStdin: true,
          params: { command: `printf '%s' "$$" > group-pid; ${command}` },
        }) + '\n',
      );
      try {
        await vi.waitFor(
          () => expect(existsSync(join(root, 'started'))).toBe(true),
          { timeout: 3000 },
        );
        const disconnectedAt = Date.now();
        if (closeOutput) child.stdout.destroy();
        else child.stdin.end();
        await closed;
        expect(Date.now() - disconnectedAt).toBeLessThan(4000);
        await new Promise((resolve) =>
          setTimeout(resolve, 4500 - (Date.now() - disconnectedAt)),
        );
        expect(existsSync(join(root, 'after-disconnect'))).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          if (existsSync(join(root, 'group-pid'))) {
            const group = Number(readFileSync(join(root, 'group-pid'), 'utf8'));
            if (Number.isSafeInteger(group) && group > 1) {
              try {
                process.kill(-group, 'SIGKILL');
              } catch {
                /* Already exited. */
              }
            }
          }
          child.kill('SIGKILL');
        }
        child.stdin.destroy();
        await closed;
      }
    },
    10_000,
  );

  it('lists FIFOs without opening them and rejects reading one', () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    expect(request('list')).toMatchObject({
      ok: true,
      result: [{ name: 'pipe', kind: 'other' }],
    });
    expect(request('stat', { path: 'pipe' })).toMatchObject({
      ok: true,
      result: { kind: 'other' },
    });
    expect(request('read', { path: 'pipe' })).toMatchObject({
      ok: false,
      error: { code: 'not_file' },
    });
  });

  it('creates missing parents only for an approved create and refuses symlink parents', () => {
    expect(
      request('write', {
        path: 'new/sub/file',
        content: 'new',
        mode: 'create',
        createParents: true,
      }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'new/sub/file'), 'utf8')).toBe('new');
    expect(statSync(join(root, 'new/sub')).mode & 0o777).toBe(
      0o755 & ~process.umask(),
    );
    symlinkSync(join(root, 'new'), join(root, 'link'));
    expect(
      request('write', {
        path: 'link/escape/file',
        content: 'bad',
        mode: 'create',
        createParents: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'symlink_escape' } });
    expect(existsSync(join(root, 'new/escape'))).toBe(false);
  });

  it('seeks directly to byte windows beyond the text limit without a partial-file hash', () => {
    const offset = 17 * 1024 * 1024;
    writeFileSync(
      join(root, 'large'),
      Buffer.concat([Buffer.alloc(offset), Buffer.from('tail')]),
    );
    expect(
      request('readBytes', { path: 'large', offset, maxBytes: 4 }),
    ).toEqual({
      ok: true,
      result: {
        sizeBytes: offset + 4,
        data: Buffer.from('tail').toString('base64'),
      },
    });
  });

  it('keeps Git warnings separate from paths and never expands ignored untracked trees', () => {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/hidden.txt'), 'needle');
    writeFileSync(join(root, 'visible.txt'), 'needle');
    const bin = join(root, '.git', 'bin');
    mkdirSync(bin);
    const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nprintf 'warning: skipped unreadable entry\n' >&2\ncase " $* " in *" --others "*" --ignored "*) exit 99;; esac\nexec '${git.replaceAll("'", "'\"'\"'")}' "$@"\n`,
      { mode: 0o700 },
    );
    const env = { ...process.env, PATH: bin + ':' + process.env['PATH'] };
    expect(request('glob', { pattern: '*.txt' }, env)).toMatchObject({
      ok: true,
      result: { paths: [join(root, 'visible.txt')], truncated: true },
    });
    expect(
      request('grep', { pattern: 'needle', glob: '*.txt' }, env),
    ).toMatchObject({
      ok: true,
      result: { text: 'visible.txt:1:needle', truncated: true },
    });
  });

  it('matches glob case when requested and preserves the default exact-case API', () => {
    writeFileSync(join(root, 'README.MD'), 'text');
    expect(request('glob', { pattern: '*.md' })).toMatchObject({
      result: { paths: [] },
    });
    expect(
      request('glob', { pattern: '*.md', caseSensitive: false }),
    ).toMatchObject({ result: { paths: [join(root, 'README.MD')] } });
  });
  it('honors a nested Qwen ignore file even when Git ignores that rule file', () => {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, '.gitignore'), '.qwenignore\n');
    writeFileSync(join(root, 'nested/.qwenignore'), 'secret.txt\n');
    writeFileSync(join(root, 'nested/secret.txt'), 'needle');
    writeFileSync(join(root, 'nested/visible.txt'), 'needle');
    expect(request('glob', { pattern: '**/*.txt' })).toMatchObject({
      ok: true,
      result: { paths: [join(root, 'nested/visible.txt')], truncated: false },
    });
  });
  it('filters and marks ignored directory entries without descending ignored trees', () => {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(root, '.qwenignore'), 'secret.txt\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/ignored'), 'ignored');
    writeFileSync(join(root, 'secret.txt'), 'secret');
    writeFileSync(join(root, 'visible.txt'), 'visible');
    const filtered = request('list').result as Array<{ name: string }>;
    expect(filtered.map((entry) => entry.name)).toEqual([
      '.gitignore',
      '.qwenignore',
      'visible.txt',
    ]);
    const all = request('list', { includeIgnored: true }).result as Array<{
      name: string;
      ignored: boolean;
    }>;
    expect(
      all.filter((entry) => entry.ignored).map((entry) => entry.name),
    ).toEqual(['.git', 'node_modules', 'secret.txt']);
  });

  it.each(['plain', ':(literal)plain'])(
    'treats directory names literally when listing ignored entries: %s',
    (directory) => {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, '.gitignore'), 'secret.txt\n');
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, 'secret.txt'), 'secret');
      writeFileSync(join(root, directory, 'visible.txt'), 'visible');
      expect(request('list', { path: directory })).toMatchObject({
        ok: true,
        result: [{ name: 'visible.txt', ignored: false }],
      });
      expect(
        request('list', { path: directory, includeIgnored: true }),
      ).toMatchObject({
        ok: true,
        result: [
          { name: 'secret.txt', ignored: true },
          { name: 'visible.txt', ignored: false },
        ],
      });
    },
  );

  it('returns readable grep hits and marks a skipped tail as incomplete', () => {
    writeFileSync(
      join(root, 'a-large.txt'),
      'needle\n' + 'x'.repeat(16 * 1024 * 1024),
    );
    writeFileSync(join(root, 'z-small.txt'), 'needle');
    expect(request('grep', { pattern: 'needle' })).toMatchObject({
      ok: true,
      result: {
        text: 'a-large.txt:1:needle\nz-small.txt:1:needle',
        truncated: true,
      },
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps readable results when files and directories deny access',
    () => {
      writeFileSync(join(root, 'visible.txt'), 'needle');
      writeFileSync(join(root, 'locked.txt'), 'needle', { mode: 0o000 });
      mkdirSync(join(root, 'locked-dir'), { mode: 0o000 });
      try {
        expect(request('grep', { pattern: 'needle' })).toMatchObject({
          ok: true,
          result: { text: 'visible.txt:1:needle', truncated: true },
        });
        expect(request('glob', { pattern: '**/*.txt' })).toMatchObject({
          ok: true,
          result: {
            paths: expect.arrayContaining([join(root, 'visible.txt')]),
            truncated: true,
          },
        });
        expect(
          request('gitUntrackedStats', {
            paths: ['visible.txt', 'locked.txt'],
          }),
        ).toMatchObject({
          ok: true,
          result: [
            { path: 'visible.txt', added: 1 },
            { path: 'locked.txt', added: 0, isBinary: true },
          ],
        });
      } finally {
        chmodSync(join(root, 'locked.txt'), 0o600);
        chmodSync(join(root, 'locked-dir'), 0o700);
      }
    },
  );
  it('removes temporary writes after publication fails and tolerates unsupported directory fsync', () => {
    const failedPublish = SSH_WORKSPACE_SCRIPT.replace(
      'os.link(temporary, name,',
      "fail('io_error', 'injected publish failure')\n                    os.link(temporary, name,",
    );
    expect(
      request(
        'write',
        { path: 'file', content: 'value', mode: 'create' },
        undefined,
        failedPublish,
      ),
    ).toMatchObject({ ok: false, error: { code: 'io_error' } });
    expect(readdirSync(root)).toEqual([]);
    const unsupportedSync = SSH_WORKSPACE_SCRIPT.replace(
      'os.fsync(fd)',
      "raise OSError(errno.EINVAL, 'directory sync unavailable')",
    );
    expect(
      request(
        'write',
        { path: 'file', content: 'value', mode: 'create' },
        undefined,
        unsupportedSync,
      ),
    ).toMatchObject({ ok: true });
    expect(readdirSync(root)).toEqual(['file']);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('value');
  });

  it.each([
    'stat',
    'list',
    'glob',
    'grep',
    'readBytes',
    'mkdir',
    'gitUntrackedStats',
  ])(
    'rejects parent traversal and intermediate symlinks for %s',
    (operation) => {
      symlinkSync(root, join(root, 'link'));
      for (const target of ['../outside', 'link/nested']) {
        expect(
          request(operation, {
            path: target,
            paths: [target],
            pattern: '*',
            recursive: true,
          }),
        ).toMatchObject(
          operation === 'gitUntrackedStats' && target.startsWith('link/')
            ? { ok: true, result: [{ path: target, added: 0, isBinary: true }] }
            : {
                ok: false,
                error: {
                  code: target.startsWith('..')
                    ? 'path_outside_workspace'
                    : 'symlink_escape',
                },
              },
        );
      }
    },
  );

  it('canonicalizes a selected root symlink at registration but rejects later symlink traversal', () => {
    const alias = root + '-alias';
    symlinkSync(root, alias);
    try {
      const script = SSH_WORKSPACE_SCRIPT;
      const probe = spawnSync('python3', ['-c', script], {
        input: JSON.stringify({ root: alias, operation: 'probe', params: {} }),
        encoding: 'utf8',
      });
      expect(JSON.parse(probe.stdout)).toEqual({
        ok: true,
        result: { directory: root },
      });
      const read = spawnSync('python3', ['-c', script], {
        input: JSON.stringify({ root: alias, operation: 'stat', params: {} }),
        encoding: 'utf8',
      });
      expect(JSON.parse(read.stdout)).toMatchObject({
        ok: false,
        error: { code: 'symlink_escape' },
      });
    } finally {
      rmSync(alias);
    }
  });
  it('marks an omitted checked-out submodule as incomplete', () => {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'submodule'));
    writeFileSync(join(root, 'submodule/inside.txt'), 'needle');
    execFileSync('git', [
      '-C',
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      '160000,' + '1'.repeat(40) + ',submodule',
    ]);
    expect(request('glob', { pattern: '**/*.txt' })).toMatchObject({
      ok: true,
      result: { paths: [], truncated: true },
    });
    expect(request('grep', { pattern: 'needle' })).toMatchObject({
      ok: true,
      result: { text: '', truncated: true },
    });
  });

  it('searches a bare repository as a filesystem instead of misclassifying it as a Git failure', () => {
    execFileSync('git', ['init', '--bare', '-q', root]);
    writeFileSync(join(root, 'visible.txt'), 'needle');
    expect(request('glob', { pattern: '*.txt' })).toMatchObject({
      ok: true,
      result: { paths: [join(root, 'visible.txt')], truncated: false },
    });
  });
});
