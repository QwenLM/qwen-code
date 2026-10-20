/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

export class WorkspaceFileError extends Error {
  constructor(readonly code: string) {
    super('Workspace file request is unavailable.');
  }
}

function refuse(code = 'unavailable'): never {
  throw new WorkspaceFileError(`ssh_runtime_file_${code}`);
}

export function workspaceFilePath(value: unknown): string {
  if (value === '.') return '.';
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\\\p{Cc}\p{Cs}]/u.test(value) ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part === '.git' ||
          part === '.qwen-child-workspaces' ||
          part.startsWith('.qwen-managed-'),
      )
  )
    refuse('invalid_path');
  return value;
}

function signature(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.birthtimeNs,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

export async function readWorkspaceFiles(
  root: string,
  cwdRelative: string,
  value: unknown,
  expected: { device: string; inode: string },
): Promise<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    refuse('invalid_request');
  const request = value as Record<string, unknown>;
  if (request['protocolVersion'] !== 1) refuse('unsupported');
  const cwd = workspaceFilePath(cwdRelative);
  const anchors = new Map<string, string>();
  async function directory(relative: string): Promise<string> {
    const segments = relative === '.' ? [] : relative.split('/');
    let current = root;
    for (const segment of ['', ...segments]) {
      if (segment) current = path.join(current, segment);
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || (await fs.realpath(current)) !== current)
        refuse();
      if (
        current === root &&
        (String(stat.dev) !== expected.device ||
          String(stat.ino) !== expected.inode)
      )
        refuse();
      const prior = anchors.get(current);
      const identity = [stat.dev, stat.ino, stat.birthtimeNs].join(':');
      if (prior && prior !== identity) refuse('changed');
      anchors.set(current, identity);
    }
    return current;
  }
  async function verify() {
    for (const [name, identity] of anchors) {
      const stat = await fs.lstat(name, { bigint: true });
      if (
        !stat.isDirectory() ||
        (await fs.realpath(name)) !== name ||
        [stat.dev, stat.ino, stat.birthtimeNs].join(':') !== identity
      )
        refuse('changed');
    }
  }
  const base = await directory(cwd);
  const rooted = (relative: string) =>
    cwd === '.' ? relative : relative === '.' ? cwd : `${cwd}/${relative}`;
  if (request['operation'] === 'read') {
    const relative = workspaceFilePath(request['path']);
    if (relative === '.') refuse('invalid_path');
    const parent = path.posix.dirname(relative);
    await directory(rooted(parent));
    const filename = path.join(base, relative);
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size === 0n || before.size > 24n * 1024n)
        refuse('unsupported_content');
      const bytes = Buffer.alloc(24 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (
        BigInt(size) !== before.size ||
        signature(before) !== signature(await handle.stat({ bigint: true })) ||
        signature(before) !==
          signature(await fs.lstat(filename, { bigint: true }))
      )
        refuse('changed');
      let text: string;
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes.subarray(0, size));
      } catch {
        return refuse('unsupported_content');
      }
      if (!text || text.includes('\0')) refuse('unsupported_content');
      await verify();
      const result = {
        protocolVersion: 1,
        path: relative,
        name: path.posix.basename(relative),
        mimeType: 'text/plain',
        text,
        byteLength: size,
        sha256: createHash('sha256')
          .update(bytes.subarray(0, size))
          .digest('hex'),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024)
        refuse('too_large');
      return result;
    } finally {
      await handle.close();
    }
  }
  if (request['operation'] !== 'query') refuse('invalid_request');
  const relative = workspaceFilePath(request['directory'] ?? '.');
  const query = request['query'] ?? '';
  if (
    typeof query !== 'string' ||
    query.length > 256 ||
    /[\p{Cc}\p{Cs}]/u.test(query)
  )
    refuse('invalid_request');
  const entries: Array<{
    path: string;
    name: string;
    kind: 'file' | 'directory';
  }> = [];
  let scanned = 0;
  let truncated = false;
  const deadline = Date.now() + 2000;
  const queue = [{ relative, depth: 0 }];
  while (queue.length) {
    const next = queue.shift()!;
    const dir = await directory(rooted(next.relative));
    const stream = await fs.opendir(dir);
    for await (const entry of stream) {
      if (++scanned > 4096 || Date.now() > deadline || entries.length >= 50) {
        truncated = true;
        break;
      }
      const name =
        next.relative === '.' ? entry.name : `${next.relative}/${entry.name}`;
      try {
        workspaceFilePath(name);
      } catch {
        continue;
      }
      if (!entry.isFile() && !entry.isDirectory()) continue;
      if (query && entry.isDirectory()) {
        if (next.depth < 32)
          queue.push({ relative: name, depth: next.depth + 1 });
        else truncated = true;
      }
      if (
        query &&
        (entry.isDirectory() ||
          !name.toLowerCase().includes(query.toLowerCase()))
      )
        continue;
      const item = {
        path: name,
        name: entry.name,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      };
      if (Buffer.byteLength(JSON.stringify([...entries, item])) > 24 * 1024) {
        truncated = true;
        break;
      }
      entries.push(item);
    }
    if (scanned > 4096 || Date.now() > deadline || entries.length >= 50) {
      truncated = true;
      break;
    }
  }
  await verify();
  return { protocolVersion: 1, directory: relative, entries, truncated };
}
