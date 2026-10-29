/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  WorkspaceFileError,
  workspaceFileDirectories,
  workspaceFilePath,
  type SessionWorkspaceFileScope,
} from './managed-workspace-files.js';

export interface WorkspaceUploadMetadata {
  uploadId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface WorkspaceUploadResult extends WorkspaceUploadMetadata {
  protocolVersion: 1;
  state: 'completed' | 'failed' | 'pending';
  code?: string;
}

function refuse(code: string): never {
  throw new WorkspaceFileError(`ssh_runtime_file_${code}`);
}

function failed(metadata: WorkspaceUploadMetadata, error: unknown) {
  return workspaceUploadResult(
    metadata,
    'failed',
    error instanceof WorkspaceFileError
      ? error.code
      : (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'ssh_runtime_file_exists'
        : 'ssh_runtime_file_unavailable',
  );
}

export function workspaceUploadRequest(value: unknown): {
  metadata: WorkspaceUploadMetadata;
  bytes?: Buffer;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    refuse('invalid_request');
  const request = value as Record<string, unknown>;
  if (
    request['protocolVersion'] !== 1 ||
    !['upload', 'upload-status'].includes(String(request['operation'])) ||
    typeof request['uploadId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      request['uploadId'],
    ) ||
    !Number.isSafeInteger(request['sizeBytes']) ||
    Number(request['sizeBytes']) < 0 ||
    Number(request['sizeBytes']) > MAX_WORKSPACE_UPLOAD_BYTES ||
    typeof request['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(request['sha256'])
  )
    refuse('invalid_request');
  const relative = workspaceFilePath(request['path']);
  if (relative === '.') refuse('invalid_path');
  const metadata = {
    uploadId: request['uploadId'],
    path: relative,
    sizeBytes: Number(request['sizeBytes']),
    sha256: request['sha256'],
  };
  if (request['operation'] === 'upload-status') {
    if (request['data'] !== undefined) refuse('invalid_request');
    return { metadata };
  }
  const data = request['data'];
  if (
    typeof data !== 'string' ||
    data.length !== Math.ceil(metadata.sizeBytes / 3) * 4
  )
    refuse('invalid_content');
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length !== metadata.sizeBytes ||
    bytes.toString('base64') !== data ||
    createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
  )
    refuse('invalid_content');
  return { metadata, bytes };
}

export function workspaceUploadResult(
  metadata: WorkspaceUploadMetadata,
  state: WorkspaceUploadResult['state'],
  code?: string,
): WorkspaceUploadResult {
  return {
    protocolVersion: 1,
    ...metadata,
    state,
    ...(code === undefined ? {} : { code }),
  };
}

function temporaryPath(directory: string, metadata: WorkspaceUploadMetadata) {
  return path.join(directory, `.qwen-managed-upload-${metadata.uploadId}.tmp`);
}

async function removeTemporary(temporary: string): Promise<void> {
  try {
    await fs.unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceUpload(
  root: string,
  cwd: string,
  metadata: WorkspaceUploadMetadata,
  bytes: Buffer,
  expected: { device: string; inode: string },
  verifyStorage: () => Promise<void>,
  sessionScope?: SessionWorkspaceFileScope,
): Promise<WorkspaceUploadResult> {
  let directories: Awaited<ReturnType<typeof workspaceFileDirectories>>;
  let parent: string;
  try {
    await verifyStorage();
    directories = await workspaceFileDirectories(
      root,
      cwd,
      expected,
      sessionScope,
    );
    parent = await directories.directory(path.posix.dirname(metadata.path));
  } catch (error) {
    return failed(metadata, error);
  }
  const destination = path.join(directories.base, metadata.path);
  const temporary = temporaryPath(parent, metadata);
  let ownsTemporary = false;
  let result: WorkspaceUploadResult;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await directories.verify();
    await verifyStorage();
    await fs.link(temporary, destination);
    await directories.verify();
    await verifyStorage();
    result = workspaceUploadResult(metadata, 'completed');
  } catch (error) {
    result = failed(metadata, error);
  } finally {
    if (ownsTemporary) {
      await directories.verify();
      await removeTemporary(temporary);
      await syncDirectory(parent);
    }
  }
  return result;
}

export async function inspectWorkspaceUpload(
  root: string,
  cwd: string,
  metadata: WorkspaceUploadMetadata,
  expected: { device: string; inode: string },
  verifyStorage: () => Promise<void>,
  sessionScope?: SessionWorkspaceFileScope,
): Promise<WorkspaceUploadResult> {
  await verifyStorage();
  const directories = await workspaceFileDirectories(
    root,
    cwd,
    expected,
    sessionScope,
  );
  const parent = await directories.directory(path.posix.dirname(metadata.path));
  const destination = path.join(directories.base, metadata.path);
  let completed = false;
  try {
    const handle = await fs.open(
      destination,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (before.isFile() && before.size === BigInt(metadata.sizeBytes)) {
        const bytes = Buffer.alloc(metadata.sizeBytes + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(
            bytes,
            size,
            bytes.length - size,
            size,
          );
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const current = await fs.lstat(destination, { bigint: true });
        completed =
          size === metadata.sizeBytes &&
          before.dev === current.dev &&
          before.ino === current.ino &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs &&
          before.size === after.size &&
          after.ctimeNs === current.ctimeNs &&
          createHash('sha256').update(bytes.subarray(0, size)).digest('hex') ===
            metadata.sha256;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error;
  }
  await directories.verify();
  await verifyStorage();
  await removeTemporary(temporaryPath(parent, metadata));
  await syncDirectory(parent);
  return workspaceUploadResult(
    metadata,
    completed ? 'completed' : 'failed',
    completed ? undefined : 'ssh_runtime_file_upload_incomplete',
  );
}
