/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { lstat, unlink } from 'node:fs/promises';
import { connect, type Server } from 'node:net';
export interface SocketIdentity {
  dev: number;
  ino: number;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function listen(
  server: Server,
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export function isAddressInUse(error: unknown): boolean {
  return hasErrorCode(error, 'EADDRINUSE');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

export async function recoverStaleSocketAndListen(
  server: Server,
  socketPath: string,
): Promise<boolean> {
  if (!(await removeStaleSocket(socketPath))) return false;
  await listen(server, socketPath);
  return true;
}

/** Remove only an owned Unix socket that no process is accepting connections on. */
async function removeStaleSocket(socketPath: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const info = await lstat(socketPath).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (info === undefined) return true;
  if (!info.isSocket()) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    return false;
  if (await socketAcceptsConnections(socketPath)) return false;
  const current = await lstat(socketPath).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (current === undefined) return true;
  if (
    !current.isSocket() ||
    current.dev !== info.dev ||
    current.ino !== info.ino
  )
    return false;
  await unlink(socketPath).catch((error: unknown) => {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  });
  return true;
}

export async function currentSocketIdentity(
  socketPath: string,
): Promise<SocketIdentity | undefined> {
  if (process.platform === 'win32') return undefined;
  const info = await lstat(socketPath).catch(() => undefined);
  if (info === undefined || !info.isSocket()) return undefined;
  return { dev: info.dev, ino: info.ino };
}

export async function unlinkOwnedSocket(
  socketPath: string,
  identity: SocketIdentity | undefined,
): Promise<void> {
  if (process.platform === 'win32' || identity === undefined) return;
  const current = await currentSocketIdentity(socketPath);
  if (
    current === undefined ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    return;
  await unlink(socketPath).catch((error: unknown) => {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  });
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const candidate = connect(socketPath);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      candidate.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(true), 500);
    candidate.once('connect', () => finish(true));
    candidate.once('error', (error: Error) => {
      finish(
        !hasErrorCode(error, 'ECONNREFUSED') && !hasErrorCode(error, 'ENOENT'),
      );
    });
  });
}
