/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { Storage } from '../config/storage.js';

export interface ChannelMemoryTarget {
  channelName: string;
  chatId: string;
  threadId?: string;
}

export interface ChannelMemoryWriteResult {
  changed: boolean;
  filePath: string;
}

export const CHANNEL_MEMORY_FILE_NAME = 'CHANNEL.md';
export const MAX_CHANNEL_MEMORY_BYTES = 1024 * 1024;
const pendingAppends = new Map<string, Promise<void>>();
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    randomize: true,
  },
  stale: 5000,
};

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function safeChannelName(channelName: string): string {
  const safeName = channelName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  if (safeName === '.' || safeName === '..') {
    return '_';
  }
  return safeName || '_';
}

function hashedThreadPath(target: ChannelMemoryTarget): string {
  return createHash('sha256')
    .update(target.chatId)
    .update('\0')
    .update(target.threadId ?? '')
    .digest('hex')
    .slice(0, 32);
}

export function getChannelMemoryFilePath(target: ChannelMemoryTarget): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'memory',
    safeChannelName(target.channelName),
    hashedThreadPath(target),
    CHANNEL_MEMORY_FILE_NAME,
  );
}

async function serializeAppend<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pendingAppends.get(filePath) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  pendingAppends.set(filePath, queued);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pendingAppends.get(filePath) === queued) {
      pendingAppends.delete(filePath);
    }
  }
}

export async function readChannelMemory(
  target: ChannelMemoryTarget,
): Promise<string> {
  const filePath = getChannelMemoryFilePath(target);
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (error) {
    if (isMissingFile(error)) {
      return '';
    }
    throw error;
  }
  if (size > MAX_CHANNEL_MEMORY_BYTES) {
    process.stderr.write(
      `[channel-memory] ${filePath} is ${size} bytes, exceeding ${MAX_CHANNEL_MEMORY_BYTES}; treating as empty\n`,
    );
    return '';
  }
  return fs.readFile(filePath, 'utf8');
}

export async function appendChannelMemory(
  target: ChannelMemoryTarget,
  text: string,
): Promise<ChannelMemoryWriteResult> {
  const filePath = getChannelMemoryFilePath(target);
  const entry = text.trim();
  if (!entry) {
    return { changed: false, filePath };
  }

  return serializeAppend(filePath, async () => {
    const appendBytes = Buffer.byteLength(`${entry}\n`, 'utf8');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const initialHandle = await fs.open(filePath, 'a+');
    await initialHandle.close();
    const release = await lockfile.lock(filePath, LOCK_OPTIONS);
    try {
      const handle = await fs.open(filePath, 'a+');
      try {
        const existingSize = (await handle.stat()).size;
        if (existingSize + appendBytes > MAX_CHANNEL_MEMORY_BYTES) {
          throw new Error('Channel memory exceeds maximum size');
        }
        await handle.appendFile(`${entry}\n`, 'utf8');
      } finally {
        await handle.close();
      }
    } finally {
      await release();
    }
    return { changed: true, filePath };
  });
}

export async function clearChannelMemory(
  target: ChannelMemoryTarget,
): Promise<ChannelMemoryWriteResult> {
  const filePath = getChannelMemoryFilePath(target);
  try {
    await fs.unlink(filePath);
    return { changed: true, filePath };
  } catch (error) {
    if (isMissingFile(error)) {
      return { changed: false, filePath };
    }
    throw error;
  }
}
