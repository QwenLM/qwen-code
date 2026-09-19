/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
import {
  prepareSshWorkspace,
  readSshWorkspace,
} from './ssh-workspace-store.js';

describe('SSH workspace identity', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'qwen-ssh-store-')),
    );
    vi.stubEnv('QWEN_HOME', root);
    request.mockReset().mockResolvedValue({ directory: '/srv/project' });
    dispose.mockClear();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('persists one canonical identity across concurrent registration and reload', async () => {
    const [first, second] = await Promise.all([
      prepareSshWorkspace('ssh://alice@host/srv/link'),
      prepareSshWorkspace('ssh://alice@host/srv/project'),
    ]);
    expect(first.cwd).toBe(second.cwd);
    expect(readSshWorkspace(first.cwd)).toEqual({
      host: 'alice@host',
      directory: '/srv/project',
    });
    expect(
      JSON.parse(
        await readFile(path.join(first.cwd, '..', 'connection.json'), 'utf8'),
      ),
    ).toEqual({ url: 'ssh://alice@host/srv/project' });
    expect(dispose).toHaveBeenCalledTimes(2);
    const other = await prepareSshWorkspace('ssh://bob@host/srv/project');
    expect(other.cwd).not.toBe(first.cwd);
  });

  it('fails closed for missing or mismatched descriptors', async () => {
    const { cwd } = await prepareSshWorkspace('ssh://host/srv/project');
    const descriptor = path.join(cwd, '..', 'connection.json');
    await writeFile(
      descriptor,
      JSON.stringify({ url: 'ssh://elsewhere/srv/project' }),
    );
    expect(() => readSshWorkspace(cwd)).toThrow('identity does not match');
    await unlink(descriptor);
    expect(() => readSshWorkspace(cwd)).toThrow();
    expect(readSshWorkspace(root)).toBeUndefined();
  });

  it('recognizes and rejects a local symlink alias instead of treating it as local', async () => {
    const { cwd } = await prepareSshWorkspace('ssh://host/srv/project');
    const alias = path.join(root, 'alias');
    await symlink(cwd, alias);
    expect(() => readSshWorkspace(alias)).toThrow('must not be symlinks');
  });

  it('never persists a failed connection and disposes its client', async () => {
    request.mockRejectedValueOnce(new Error('Host key verification failed'));
    await expect(prepareSshWorkspace('ssh://host/srv/project')).rejects.toThrow(
      'Host key',
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
