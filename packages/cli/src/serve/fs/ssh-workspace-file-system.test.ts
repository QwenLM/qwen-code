/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { request, dispose } = vi.hoisted(() => ({
  request: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock(
  '@qwen-code/qwen-code-core/services/ssh-workspace.js',
  async (original) => ({
    ...(await original<
      typeof import('@qwen-code/qwen-code-core/services/ssh-workspace.js')
    >()),
    SshWorkspaceClient: class {
      request = request;
      dispose = dispose;
    },
  }),
);
import { SshWorkspaceError } from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import { createSshWorkspaceFileSystemFactory } from './ssh-workspace-file-system.js';
import { MAX_READ_BYTES } from './policy.js';

describe('SSH workspace filesystem boundary', () => {
  const emit = vi.fn();
  function setup(trusted = true, assertOpen: () => void = vi.fn()) {
    return createSshWorkspaceFileSystemFactory({
      cwd: '/local/anchor',
      connection: { host: 'host', directory: '/srv/project' },
      trusted,
      generationGuard: { assertOpen },
      emit,
    }).forRequest({ route: 'test', sessionId: 'session' });
  }
  beforeEach(() => {
    request.mockReset();
    dispose.mockClear();
    emit.mockClear();
  });

  it('maps local aliases and remote paths to the same remote file without local IO', async () => {
    const fs = setup();
    request.mockResolvedValue({
      content: 'remote\n',
      sizeBytes: 7,
      hash: 'sha256:abc',
    });
    for (const input of [
      'src/a.ts',
      '/srv/project/src/a.ts',
      '/local/anchor/src/a.ts',
    ]) {
      const p = await fs.resolve(input, 'read');
      expect(p).toBe(path.join('/local/anchor', 'src', 'a.ts'));
      expect((await fs.readText(p)).content).toBe('remote\n');
      expect(request).toHaveBeenLastCalledWith(
        'read',
        { path: '/srv/project/src/a.ts' },
        expect.any(AbortSignal),
      );
    }
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fs.access',
        data: expect.objectContaining({ sessionId: 'session', route: 'test' }),
      }),
    );
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it('rejects escapes, untrusted and removed runtimes before contacting SSH', async () => {
    await expect(setup().resolve('../escape', 'write')).rejects.toMatchObject({
      kind: 'path_outside_workspace',
    });
    await expect(setup().resolve('/etc/passwd', 'read')).rejects.toMatchObject({
      kind: 'path_outside_workspace',
    });
    await expect(setup(false).resolve('a', 'write')).rejects.toMatchObject({
      kind: 'untrusted_workspace',
    });
    await expect(
      setup(true, () => {
        throw new Error('closed');
      }).resolve('a', 'read'),
    ).rejects.toThrow('closed');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps full-file hashes with BOM metadata and reports partial text honestly', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'read');
    request.mockResolvedValue({
      content: '\ufeffone\r\ntwo\r\n',
      sizeBytes: 13,
      hash: 'sha256:whole',
    });
    expect(await fs.readText(p, { line: 1, limit: 1 })).toEqual({
      content: 'one\r',
      meta: {
        encoding: 'utf-8',
        bom: true,
        lineEnding: 'crlf',
        sizeBytes: 13,
        hash: 'sha256:whole',
        truncated: true,
        hasMore: true,
        originalLineCount: 2,
      },
    });
    request.mockResolvedValue({
      content: 'x'.repeat(MAX_READ_BYTES + 1),
      sizeBytes: MAX_READ_BYTES + 1,
      hash: 'sha256:big',
    });
    await expect(fs.readText(p)).rejects.toMatchObject({
      kind: 'file_too_large',
    });
    expect((await fs.readText(p, { maxBytes: 5 })).content).toBe('xxxxx');
  });

  it('returns byte window metadata without a misleading full-file hash', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'read');
    request.mockResolvedValue({
      data: Buffer.from('bc').toString('base64'),
      sizeBytes: 4,
      hash: 'sha256:whole',
    });
    expect(await fs.readBytesWindow(p, { offset: 1, maxBytes: 2 })).toEqual({
      buffer: Buffer.from('bc'),
      sizeBytes: 4,
      returnedBytes: 2,
      offset: 1,
      truncated: true,
    });
    await expect(fs.readBytes(p)).rejects.toMatchObject({
      kind: 'file_too_large',
    });
  });

  it('sends conditional edits with the read hash and preserves replacement literals', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'edit');
    request.mockResolvedValueOnce({
      content: 'hello\n',
      sizeBytes: 6,
      hash: 'sha256:before',
    });
    request.mockResolvedValueOnce({
      created: false,
      sizeBytes: 3,
      hash: 'sha256:after',
    });
    await fs.editAtomic(p, 'hello', '$&', { expectedHash: 'sha256:before' });
    expect(request).toHaveBeenLastCalledWith(
      'write',
      {
        path: '/srv/project/a',
        content: '$&\n',
        mode: 'replace',
        expectedHash: 'sha256:before',
      },
      expect.any(AbortSignal),
    );
    request.mockResolvedValueOnce({
      content: 'changed',
      sizeBytes: 7,
      hash: 'sha256:new',
    });
    await expect(
      fs.editAtomic(p, 'changed', 'bad', { expectedHash: 'sha256:old' }),
    ).rejects.toMatchObject({ kind: 'hash_mismatch' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('propagates remote denial and connection failures without retry or local fallback', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'read');
    request.mockRejectedValueOnce(
      new SshWorkspaceError('symlink_escape', 'Outside target'),
    );
    await expect(fs.readText(p)).rejects.toMatchObject({
      kind: 'symlink_escape',
      status: 400,
    });
    request.mockRejectedValueOnce(
      new SshWorkspaceError('ssh_failed', 'Connection lost'),
    );
    await expect(fs.readText(p)).rejects.toMatchObject({
      kind: 'io_error',
      status: 503,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fs.denied' }),
    );
  });

  it.each(['replace', 'overwrite'] as const)(
    'preserves existing BOM and CRLF on %s writes without metadata',
    async (mode) => {
      const fs = setup();
      const p = await fs.resolve('a', 'write');
      request.mockImplementation(async (operation, params) =>
        operation === 'read'
          ? {
              content: '\ufeffbefore\r\n',
              sizeBytes: 11,
              hash: 'sha256:before',
            }
          : {
              created: false,
              sizeBytes: Buffer.byteLength(params.content),
              hash: 'sha256:after',
            },
      );
      const read = await fs.readText(p);
      expect(read.content).toBe('before\r\n');
      const content = read.content.replace('before\r\n', 'after\n');
      const written =
        mode === 'replace'
          ? await fs.writeTextAtomic(p, content, {
              mode,
              expectedHash: 'sha256:before',
            })
          : await fs.writeTextOverwrite(p, content);
      expect(request).toHaveBeenLastCalledWith(
        'write',
        expect.objectContaining({ content: '\ufeffafter\r\n', mode }),
        expect.any(AbortSignal),
      );
      expect(written.meta).toMatchObject({ bom: true, lineEnding: 'crlf' });
    },
  );

  it('honors explicit text metadata overrides', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'write');
    request.mockResolvedValue({
      created: false,
      sizeBytes: 6,
      hash: 'sha256:after',
    });
    const written = await fs.writeTextAtomic(p, '\ufeffafter\r\n', {
      mode: 'replace',
      expectedHash: 'sha256:before',
      bom: false,
      lineEnding: 'lf',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenLastCalledWith(
      'write',
      expect.objectContaining({ content: 'after\n' }),
      expect.any(AbortSignal),
    );
    expect(written.meta).toMatchObject({ bom: false, lineEnding: 'lf' });
  });

  it('creates through overwrite when absent, but does not write after an SSH metadata-read failure', async () => {
    const fs = setup();
    const p = await fs.resolve('new', 'write');
    request.mockRejectedValueOnce(
      new SshWorkspaceError('path_not_found', 'Missing file'),
    );
    request.mockResolvedValueOnce({
      created: true,
      sizeBytes: 3,
      hash: 'sha256:new',
    });
    expect((await fs.writeTextOverwrite(p, 'new')).created).toBe(true);
    request.mockRejectedValueOnce(
      new SshWorkspaceError('ssh_failed', 'Connection lost'),
    );
    await expect(fs.writeTextOverwrite(p, 'changed')).rejects.toMatchObject({
      kind: 'io_error',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('permits all read intents while preserving the write trust gate', async () => {
    const fs = setup(false);
    for (const intent of ['read', 'list', 'glob', 'stat'] as const) {
      expect(await fs.resolve('a', intent)).toBe(
        path.join('/local/anchor', 'a'),
      );
    }
    const p = await fs.resolve('a', 'read');
    request.mockResolvedValueOnce({
      content: 'text',
      sizeBytes: 4,
      hash: 'sha256:read',
    });
    expect((await fs.readText(p)).content).toBe('text');
    request.mockResolvedValueOnce({ kind: 'file', sizeBytes: 4 });
    expect(await fs.stat(p)).toMatchObject({ kind: 'file' });
    request.mockResolvedValueOnce([]);
    expect(await fs.list(p)).toEqual([]);
    request.mockResolvedValueOnce({ paths: [] });
    expect(await fs.glob('*')).toEqual([]);
    await expect(
      fs.writeTextAtomic(p, 'bad', { mode: 'create' }),
    ).rejects.toMatchObject({ kind: 'untrusted_workspace' });
    expect(request).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fs.denied',
        data: expect.objectContaining({ errorKind: 'untrusted_workspace' }),
      }),
    );
  });

  it.each([
    ['unsupported_encoding', 422],
    ['not_file', 422],
    ['not_directory', 422],
    ['unsupported_pattern', 400],
    ['invalid_argument', 400],
    ['too_large', 413],
  ] as const)(
    'maps deterministic remote failure %s to %s',
    async (code, status) => {
      const fs = setup();
      const p = await fs.resolve('a', 'read');
      request.mockRejectedValueOnce(new SshWorkspaceError(code, code));
      await expect(fs.stat(p)).rejects.toMatchObject({ status });
    },
  );

  it('does not count a trailing newline as another readable line', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'read');
    request.mockResolvedValue({
      content: 'one\n',
      sizeBytes: 4,
      hash: 'sha256:read',
    });
    expect(await fs.readText(p, { limit: 1 })).toMatchObject({
      meta: { originalLineCount: 1, hasMore: false },
    });
    expect((await fs.readText(p)).content).toBe('one\n');
  });

  it('uses first-match semantics for a hashless edit while atomic edits require uniqueness', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'edit');
    request
      .mockResolvedValueOnce({
        content: 'one one',
        sizeBytes: 7,
        hash: 'sha256:read',
      })
      .mockResolvedValueOnce({
        created: false,
        sizeBytes: 7,
        hash: 'sha256:write',
      });
    await fs.edit(p, 'one', 'two');
    expect(request).toHaveBeenLastCalledWith(
      'write',
      expect.objectContaining({
        content: 'two one',
        expectedHash: 'sha256:read',
      }),
      expect.any(AbortSignal),
    );
    request.mockResolvedValueOnce({
      content: 'one one',
      sizeBytes: 7,
      hash: 'sha256:read',
    });
    await expect(
      fs.editAtomic(p, 'one', 'two', { expectedHash: 'sha256:read' }),
    ).rejects.toMatchObject({ kind: 'ambiguous_text_match' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rejects oversized uploads before encoding or contacting SSH', async () => {
    const fs = setup();
    const p = await fs.resolve('a', 'write');
    await expect(
      fs.writeBytesAtomic(p, Buffer.alloc(16 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ status: 413, kind: 'file_too_large' });
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves remote glob incompleteness below the requested result cap', async () => {
    request.mockResolvedValueOnce({
      paths: ['/srv/project/visible.txt'],
      truncated: true,
    });
    const matches = await setup().glob('*.txt', { maxResults: 10 });
    expect([...matches]).toEqual([path.join('/local/anchor', 'visible.txt')]);
    expect(matches).toHaveProperty('truncated', true);
  });

  it('rejects a result if its runtime generation closes while SSH is active', async () => {
    let open = true;
    const fs = setup(true, () => {
      if (!open) throw new Error('closed');
    });
    const p = await fs.resolve('a', 'read');
    request.mockImplementationOnce(async () => {
      open = false;
      return { content: 'stale', sizeBytes: 5, hash: 'sha256:stale' };
    });
    await expect(fs.readText(p)).rejects.toThrow('closed');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
