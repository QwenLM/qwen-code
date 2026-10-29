/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSshBootstrap } from './managed-runtime-bootstrap.js';
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  type SessionWorkspaceFileScope,
} from './managed-workspace-files.js';
import {
  workspaceUploadRequest,
  type WorkspaceUploadMetadata,
  type WorkspaceUploadResult,
} from './managed-workspace-upload.js';

describe('Managed Workspace upload receipts and filesystem', () => {
  let temporary: string;
  let root: string;
  let stateDirectory: string;
  let identity: { device: string; inode: string };

  beforeEach(async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-upload-test-')),
    );
    root = path.join(temporary, 'workspace');
    stateDirectory = path.join(temporary, 'private');
    await fs.mkdir(root);
    await fs.mkdir(stateDirectory, { mode: 0o700 });
    const stat = await fs.stat(root, { bigint: true });
    identity = { device: String(stat.dev), inode: String(stat.ino) };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  function metadata(
    bytes: Buffer,
    relative = 'file.bin',
  ): WorkspaceUploadMetadata {
    return {
      uploadId: randomUUID(),
      path: relative,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async function request(
    info: WorkspaceUploadMetadata,
    bytes?: Buffer,
    cwdRelative = '.',
    sessionFileScope?: SessionWorkspaceFileScope,
  ) {
    const result = await executeSshBootstrap({
      protocolVersion: 1,
      operation: 'probe',
      nodeId: 'node-a',
      root,
      stateDirectory,
      allowedRoots: [temporary],
      localRootIdentity: identity,
      cwdRelative,
      ...(sessionFileScope ? { sessionFileScope } : {}),
      files: {
        protocolVersion: 1,
        operation: bytes === undefined ? 'upload-status' : 'upload',
        ...info,
        ...(bytes === undefined ? {} : { data: bytes.toString('base64') }),
      },
    });
    return result['files'] as WorkspaceUploadResult;
  }

  const receiptDirectory = (info: WorkspaceUploadMetadata) =>
    path.join(stateDirectory, 'workspace-uploads', info.uploadId);

  it('freezes the Session identity in upload receipts and refuses replay into another Session', async () => {
    const cwd = '.qwen-managed-worktrees/owned';
    await fs.mkdir(path.join(root, cwd), { recursive: true });
    const stat = await fs.stat(path.join(root, cwd), { bigint: true });
    const scope: SessionWorkspaceFileScope = {
      sessionId: 'session-a',
      contextDigest: `sha256:${'a'.repeat(64)}`,
      worktreeId: 'owned',
      worktreeRevision: 2,
      cwdRelative: cwd,
      worktreeRootIdentity: {
        device: String(stat.dev),
        inode: String(stat.ino),
      },
    };
    const bytes = Buffer.from('session upload');
    const info = metadata(bytes);
    await expect(request(info, bytes, cwd)).rejects.toThrow();
    expect(await request(info, bytes, cwd, scope)).toMatchObject({
      state: 'completed',
    });
    expect(await fs.readFile(path.join(root, cwd, info.path))).toEqual(bytes);
    expect(await request(info, undefined, cwd, scope)).toMatchObject({
      state: 'completed',
    });
    await expect(
      request(info, undefined, cwd, { ...scope, sessionId: 'session-b' }),
    ).rejects.toMatchObject({ code: 'ssh_runtime_file_upload_conflict' });
    await fs.rename(path.join(root, cwd), path.join(root, 'moved'));
    await fs.mkdir(path.join(root, cwd));
    expect(
      await request(metadata(bytes, 'new.bin'), bytes, cwd, scope),
    ).toMatchObject({
      state: 'failed',
      code: 'ssh_runtime_file_changed',
    });
    expect(await fs.readdir(path.join(root, cwd))).toEqual([]);
    await fs.unlink(path.join(receiptDirectory(info), 'receipt.json'));
    const temporary = path.join(
      root,
      cwd,
      `.qwen-managed-upload-${info.uploadId}.tmp`,
    );
    await fs.writeFile(temporary, 'belongs to replacement');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
    await expect(request(info, undefined, cwd, scope)).rejects.toMatchObject({
      code: 'ssh_runtime_file_changed',
    });
    expect(await fs.readFile(temporary, 'utf8')).toBe('belongs to replacement');
  });

  it('preserves binary bytes, Unicode paths and cwd and advertises its size limit', async () => {
    await fs.mkdir(path.join(root, 'working', 'nested'), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 10, 1]);
    const info = metadata(bytes, 'nested/你好.bin');
    expect(await request(info, bytes, 'working')).toEqual({
      protocolVersion: 1,
      ...info,
      state: 'completed',
    });
    const filename = path.join(root, 'working', info.path);
    expect(await fs.readFile(filename)).toEqual(bytes);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(filename))).toEqual(['你好.bin']);
    const listing = await executeSshBootstrap({
      protocolVersion: 1,
      operation: 'probe',
      nodeId: 'node-a',
      root,
      stateDirectory,
      allowedRoots: [temporary],
      localRootIdentity: identity,
      cwdRelative: 'working',
      files: { protocolVersion: 1, operation: 'query' },
    });
    expect(listing['files']).toMatchObject({
      maxUploadBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    });
  });

  it.each([0, MAX_WORKSPACE_UPLOAD_BYTES])(
    'supports %i exact bytes',
    async (size) => {
      const bytes = Buffer.alloc(size, 0xff);
      const info = metadata(bytes);
      expect(await request(info, bytes)).toMatchObject({ state: 'completed' });
      expect(
        (await fs.readFile(path.join(root, info.path))).equals(bytes),
      ).toBe(true);
    },
  );

  it('refuses oversized, corrupt and noncanonical payloads before creating a claim', async () => {
    const bytes = Buffer.from('payload');
    const info = metadata(bytes);
    await expect(
      request({ ...info, sizeBytes: MAX_WORKSPACE_UPLOAD_BYTES + 1 }, bytes),
    ).rejects.toThrow();
    await expect(
      request({ ...info, sha256: '0'.repeat(64) }, bytes),
    ).rejects.toThrow();
    await expect(
      request({ ...info, uploadId: '../not-an-id' }, bytes),
    ).rejects.toThrow();
    const oneByte = metadata(Buffer.from([0]));
    expect(() =>
      workspaceUploadRequest({
        protocolVersion: 1,
        operation: 'upload',
        ...oneByte,
        data: 'AB==',
      }),
    ).toThrow();
    expect(() =>
      workspaceUploadRequest({
        protocolVersion: 1,
        operation: 'upload-status',
        ...oneByte,
        data: '',
      }),
    ).toThrow();
    expect(await fs.readdir(stateDirectory)).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('reconciles repeated IDs without executing again and rejects a changed request', async () => {
    const bytes = Buffer.from('original');
    const info = metadata(bytes);
    const completed = await request(info, bytes);
    expect(await request(info)).toEqual(completed);
    await fs.unlink(path.join(root, info.path));
    expect(await request(info, bytes)).toEqual(completed);
    await expect(
      request({ ...info, path: 'different' }, bytes),
    ).rejects.toMatchObject({ code: 'ssh_runtime_file_upload_conflict' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('claims concurrent repeats once and never exposes a partial destination', async () => {
    const bytes = Buffer.alloc(256 * 1024, 0x97);
    const info = metadata(bytes);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(info, bytes)),
    );
    expect(
      results.every((result) =>
        ['completed', 'pending'].includes(result.state),
      ),
    ).toBe(true);
    expect(await request(info)).toMatchObject({ state: 'completed' });
    expect(await fs.readFile(path.join(root, info.path))).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual([info.path]);
  });

  it('refuses occupied paths without overwrite or automatic numbering', async () => {
    const bytes = Buffer.from('new');
    const info = metadata(bytes);
    await fs.writeFile(path.join(root, info.path), 'original');
    const result = await request(info, bytes);
    expect(result).toMatchObject({
      state: 'failed',
      code: 'ssh_runtime_file_exists',
    });
    expect(await request(info)).toEqual(result);
    expect(await fs.readFile(path.join(root, info.path), 'utf8')).toBe(
      'original',
    );
    expect(await fs.readdir(root)).toEqual([info.path]);
  });

  it('publishes only one destination under concurrent different uploads', async () => {
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    const results = await Promise.all([
      request(metadata(first), first),
      request(metadata(second), second),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual([
      'completed',
      'failed',
    ]);
    const completed = results.find((result) => result.state === 'completed')!;
    const actual = await fs.readFile(path.join(root, completed.path));
    expect(createHash('sha256').update(actual).digest('hex')).toBe(
      completed.sha256,
    );
    expect(await fs.readdir(root)).toEqual([completed.path]);
  });

  it.each([
    '../escape',
    '/absolute',
    '.git/config',
    '.qwen-managed-storage.json',
    '.qwen-child-workspaces/file',
    'a//b',
    'a\\b',
    '.',
  ])('rejects reserved or invalid path %s', async (relative) => {
    const bytes = Buffer.from('file');
    await expect(request(metadata(bytes, relative), bytes)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('refuses symlink destinations, symlink ancestors and absent directories', async () => {
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'original'), 'original');
    await fs.symlink(outside, path.join(root, 'alias'));
    await fs.symlink(path.join(outside, 'original'), path.join(root, 'link'));
    const bytes = Buffer.from('new');
    for (const relative of ['alias/new', 'link', 'absent/new']) {
      expect(await request(metadata(bytes, relative), bytes)).toMatchObject({
        state: 'failed',
      });
    }
    expect(await fs.readdir(outside)).toEqual(['original']);
    expect(await fs.readFile(path.join(outside, 'original'), 'utf8')).toBe(
      'original',
    );
    expect((await fs.readdir(root)).sort()).toEqual(['alias', 'link']);
  });

  it('fails a changed root identity without creating a file', async () => {
    identity = { ...identity, inode: '0' };
    const bytes = Buffer.from('file');
    expect(await request(metadata(bytes), bytes)).toMatchObject({
      state: 'failed',
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('tombstones an unstarted operation before a delayed mutation arrives', async () => {
    const bytes = Buffer.from('late');
    const info = metadata(bytes);
    const result = await request(info);
    expect(result).toMatchObject({
      state: 'failed',
      code: 'ssh_runtime_file_upload_not_started',
    });
    expect(await request(info, bytes)).toEqual(result);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('returns private terminal receipts after registered SSH storage changes while fencing new filesystem access', async () => {
    const probe = await executeSshBootstrap({
      protocolVersion: 1,
      operation: 'probe',
      nodeId: 'node-a',
      root,
      stateDirectory,
      allowedRoots: [temporary],
    });
    const sshIdentity = probe['identity'] as Record<string, unknown>;
    const marker = {
      ...sshIdentity,
      version: 2,
      tenantId: 'tenant-a',
      storageId: 'storage-a',
      registrationId: randomUUID(),
    };
    await executeSshBootstrap({
      protocolVersion: 1,
      operation: 'register-storage',
      nodeId: 'node-a',
      stateDirectory,
      identity: sshIdentity,
      marker,
    });
    const send = async (files: Record<string, unknown>) =>
      (
        await executeSshBootstrap({
          protocolVersion: 1,
          operation: 'probe',
          nodeId: 'node-a',
          root,
          stateDirectory,
          allowedRoots: [temporary],
          cwdRelative: '.',
          identity: sshIdentity,
          marker,
          files: { protocolVersion: 1, ...files },
        })
      )['files'];
    const bytes = Buffer.from('original');
    const info = metadata(bytes);
    const result = await send({
      ...info,
      operation: 'upload',
      data: bytes.toString('base64'),
    });
    expect(result).toMatchObject({ state: 'completed' });
    await fs.rename(root, `${root}-original`);
    await fs.mkdir(root);
    expect(await send({ ...info, operation: 'upload-status' })).toEqual(result);
    await expect(send({ operation: 'query' })).rejects.toThrow();
    expect(
      await send({ ...metadata(bytes), operation: 'upload-status' }),
    ).toMatchObject({
      state: 'failed',
      code: 'ssh_runtime_file_upload_not_started',
    });
    expect(
      await send({
        ...metadata(bytes),
        operation: 'upload',
        data: bytes.toString('base64'),
      }),
    ).toMatchObject({ state: 'failed' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps a live or unverified original process pending and leaves its temporary file', async () => {
    const bytes = Buffer.from('original');
    const info = metadata(bytes);
    await request(info, bytes);
    await fs.unlink(path.join(receiptDirectory(info), 'receipt.json'));
    const temp = path.join(root, `.qwen-managed-upload-${info.uploadId}.tmp`);
    await fs.writeFile(temp, 'in progress');
    expect(await request(info)).toMatchObject({ state: 'pending' });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('unknown'), { code: 'EPERM' });
    });
    expect(await request(info)).toMatchObject({ state: 'pending' });
    expect(await fs.readFile(temp, 'utf8')).toBe('in progress');
  });

  it.each([true, false])(
    'reconciles only after definite process absence with matching destination %s',
    async (matching) => {
      const bytes = Buffer.from('original');
      const info = metadata(bytes);
      await request(info, bytes);
      await fs.unlink(path.join(receiptDirectory(info), 'receipt.json'));
      if (!matching)
        await fs.writeFile(path.join(root, info.path), 'different');
      const temp = path.join(root, `.qwen-managed-upload-${info.uploadId}.tmp`);
      await fs.writeFile(temp, 'leftover');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('absent'), { code: 'ESRCH' });
      });
      const result = await request(info);
      expect(result.state).toBe(matching ? 'completed' : 'failed');
      expect(await fs.readdir(root)).toEqual([info.path]);
      expect(await request(info, bytes)).toEqual(result);
      expect(await fs.readFile(path.join(root, info.path), 'utf8')).toBe(
        matching ? 'original' : 'different',
      );
    },
  );

  it('leaves an uncertain cleanup without a terminal receipt', async () => {
    const bytes = Buffer.from('original');
    const info = metadata(bytes);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async (filename) => {
      if (
        String(filename).endsWith(`.qwen-managed-upload-${info.uploadId}.tmp`)
      )
        throw Object.assign(new Error('cannot clean'), { code: 'EACCES' });
      return unlink(filename);
    });
    await expect(request(info, bytes)).rejects.toThrow('cannot clean');
    await expect(
      fs.stat(path.join(receiptDirectory(info), 'receipt.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await request(info)).toMatchObject({ state: 'pending' });
  });

  it('cleans an interrupted prepublication temporary file without executing it', async () => {
    const bytes = Buffer.from('original');
    const info = metadata(bytes);
    await request(info, bytes);
    await fs.unlink(path.join(receiptDirectory(info), 'receipt.json'));
    await fs.unlink(path.join(root, info.path));
    await fs.writeFile(
      path.join(root, `.qwen-managed-upload-${info.uploadId}.tmp`),
      bytes,
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
    const result = await request(info);
    expect(result).toMatchObject({
      state: 'failed',
      code: 'ssh_runtime_file_upload_incomplete',
    });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await request(info, bytes)).toEqual(result);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
