/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function safeChannelName(channelName: string): string {
  const safeName = channelName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\.+/g, '_')
    .slice(0, 80);
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

async function getExistingSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    throw error;
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

  const appendBytes = Buffer.byteLength(`${entry}\n`, 'utf8');
  const existingSize = await getExistingSize(filePath);
  if (existingSize + appendBytes > MAX_CHANNEL_MEMORY_BYTES) {
    throw new Error('Channel memory exceeds maximum size');
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${entry}\n`, 'utf8');
  return { changed: true, filePath };
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
