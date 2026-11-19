/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  formatSshWorkspaceUrl,
  parseSshWorkspaceUrl,
  SshWorkspaceClient,
  type SshWorkspace,
} from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import { getGlobalQwenDirLite } from '../config/storage-paths-lite.js';

function sshWorkspaceRoot(): string {
  const global = getGlobalQwenDirLite();
  try {
    return path.join(realpathSync(global), 'ssh-workspaces');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(global, 'ssh-workspaces');
  }
}

function connectionId(connection: SshWorkspace): string {
  return createHash('sha256')
    .update(formatSshWorkspaceUrl(connection))
    .digest('hex');
}

export function readSshWorkspace(cwd: string): SshWorkspace | undefined {
  let resolved = path.resolve(cwd);
  try {
    resolved = realpathSync(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const relative = path.relative(sshWorkspaceRoot(), resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const parts = relative.split(path.sep);
  if (
    parts.length !== 2 ||
    !/^[a-f0-9]{64}$/.test(parts[0]!) ||
    parts[1] !== 'workspace'
  ) {
    throw new Error('Invalid SSH workspace session directory.');
  }
  const directory = path.dirname(cwd);
  if (
    lstatSync(directory).isSymbolicLink() ||
    lstatSync(cwd).isSymbolicLink() ||
    realpathSync(cwd) !== path.resolve(cwd)
  ) {
    throw new Error('SSH workspace session directories must not be symlinks.');
  }
  const fd = openSync(
    path.join(directory, 'connection.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024) {
      throw new Error('Invalid SSH workspace connection descriptor.');
    }
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('url' in value) ||
      typeof value.url !== 'string'
    ) {
      throw new Error('Invalid SSH workspace connection descriptor.');
    }
    const connection = parseSshWorkspaceUrl(value.url);
    if (connectionId(connection) !== parts[0]) {
      throw new Error('SSH workspace connection identity does not match.');
    }
    return connection;
  } finally {
    closeSync(fd);
  }
}

export async function prepareSshWorkspace(
  url: string,
  signal?: AbortSignal,
): Promise<{ cwd: string; connection: SshWorkspace }> {
  const requested = parseSshWorkspaceUrl(url);
  const client = new SshWorkspaceClient(requested);
  let directory: unknown;
  try {
    const probe = await client.request<{ directory?: unknown } | null>(
      'probe',
      {},
      signal,
    );
    directory = probe?.directory;
  } finally {
    client.dispose();
  }
  if (typeof directory !== 'string') {
    throw new Error('The SSH host returned an invalid workspace directory.');
  }
  const connection = parseSshWorkspaceUrl(
    formatSshWorkspaceUrl({ ...requested, directory }),
  );
  await mkdir(getGlobalQwenDirLite(), { recursive: true, mode: 0o700 });
  const root = path.join(sshWorkspaceRoot(), connectionId(connection));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (realpathSync(cwd) !== cwd) {
    throw new Error('SSH workspace session directories must not be symlinks.');
  }
  const temporary = path.join(root, `connection-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ url: formatSshWorkspaceUrl(connection) }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await link(temporary, path.join(root, 'connection.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  readSshWorkspace(cwd);
  return {
    cwd,
    connection,
  };
}
