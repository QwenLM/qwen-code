/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChannelMemory,
  CHANNEL_MEMORY_FILE_NAME,
  clearChannelMemory,
  getChannelMemoryFilePath,
  MAX_CHANNEL_MEMORY_BYTES,
  readChannelMemory,
  type ChannelMemoryTarget,
} from './channel-memory.js';

describe('channel memory', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  let qwenHome: string;

  beforeEach(() => {
    qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-channel-memory-'));
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    fs.rmSync(qwenHome, { recursive: true, force: true });
  });

  it('returns a path under QWEN_HOME ending with CHANNEL.md', () => {
    const filePath = getChannelMemoryFilePath({
      channelName: 'prod',
      chatId: 'chat-1',
    });

    expect(filePath.startsWith(qwenHome + path.sep)).toBe(true);
    expect(filePath.endsWith(path.join('', CHANNEL_MEMORY_FILE_NAME))).toBe(
      true,
    );
  });

  it('keeps channel names and chat/thread identifiers safe', () => {
    const filePath = getChannelMemoryFilePath({
      channelName: '../prod/channel',
      chatId: 'raw-chat-id',
      threadId: 'raw-thread-id',
    });
    const relativePath = path.relative(qwenHome, filePath);

    expect(relativePath.split(path.sep)).not.toContain('..');
    expect(filePath).not.toContain('raw-chat-id');
    expect(filePath).not.toContain('raw-thread-id');
  });

  it('keeps a readable channel-name slug in the path', () => {
    const filePath = getChannelMemoryFilePath({
      channelName: 'team..bot',
      chatId: 'chat-1',
    });
    const relativeSegments = path.relative(qwenHome, filePath).split(path.sep);

    expect(relativeSegments[2]).toMatch(/^team\.\.bot-[a-f0-9]{16}$/u);
  });

  it.each(['.', '..'])(
    'does not use exact %s as the channel directory segment',
    (channelName) => {
      const filePath = getChannelMemoryFilePath({
        channelName,
        chatId: 'chat-1',
      });
      const relativePath = path.relative(qwenHome, filePath);
      const relativeSegments = relativePath.split(path.sep);

      expect(filePath.startsWith(qwenHome + path.sep)).toBe(true);
      expect(relativeSegments).not.toContain('.');
      expect(relativeSegments).not.toContain('..');
      expect(relativeSegments[0]).toBe('channels');
      expect(relativeSegments[1]).toBe('memory');
      expect(relativeSegments[2]).toMatch(/^[._]+-[a-f0-9]{16}$/u);
    },
  );

  it('uses different paths for colliding sanitized channel names', () => {
    const first = getChannelMemoryFilePath({
      channelName: 'ops/alerts',
      chatId: 'chat-1',
    });
    const second = getChannelMemoryFilePath({
      channelName: 'ops alerts',
      chatId: 'chat-1',
    });

    expect(first).not.toBe(second);
  });

  it('uses different paths for different thread ids', () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    expect(
      getChannelMemoryFilePath({ ...target, threadId: 'thread-1' }),
    ).not.toBe(getChannelMemoryFilePath({ ...target, threadId: 'thread-2' }));
  });

  it('appends entries and reads the exact content', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    await appendChannelMemory(target, 'Use staging cluster by default.');
    await appendChannelMemory(target, 'Ask before running deploy commands.');

    await expect(readChannelMemory(target)).resolves.toBe(
      'Use staging cluster by default.\nAsk before running deploy commands.\n',
    );
  });

  it('does not create memory for whitespace-only appends', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    const result = await appendChannelMemory(target, ' \n\t ');

    expect(result).toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
    await expect(readChannelMemory(target)).resolves.toBe('');
  });

  it('clears memory when present', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    await appendChannelMemory(target, 'Use staging cluster by default.');
    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: true,
      filePath: getChannelMemoryFilePath(target),
    });
    await expect(readChannelMemory(target)).resolves.toBe('');
  });

  it('reports no change when clearing missing memory', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    await expect(clearChannelMemory(target)).resolves.toEqual({
      changed: false,
      filePath: getChannelMemoryFilePath(target),
    });
  });

  it('rejects writes over the maximum size', async () => {
    await expect(
      appendChannelMemory(
        { channelName: 'prod', chatId: 'chat-1' },
        'a'.repeat(MAX_CHANNEL_MEMORY_BYTES),
      ),
    ).rejects.toThrow('Channel memory exceeds maximum size');
  });

  it('continues appends after a rejected append', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    await expect(
      appendChannelMemory(target, 'a'.repeat(MAX_CHANNEL_MEMORY_BYTES)),
    ).rejects.toThrow('Channel memory exceeds maximum size');
    await appendChannelMemory(target, 'after failure');

    await expect(readChannelMemory(target)).resolves.toBe('after failure\n');
  });

  it('retries append when the file disappears before locking', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };
    const filePath = getChannelMemoryFilePath(target);
    const realLock = lockfile.lock.bind(lockfile);
    let deletedBeforeLock = false;
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation(async (targetPath, options) => {
        if (!deletedBeforeLock && targetPath === filePath) {
          deletedBeforeLock = true;
          fs.rmSync(filePath, { force: true });
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return realLock(targetPath, options);
      });

    try {
      await expect(appendChannelMemory(target, 'after clear')).resolves.toEqual(
        {
          changed: true,
          filePath,
        },
      );
      await expect(readChannelMemory(target)).resolves.toBe('after clear\n');
      expect(lockSpy).toHaveBeenCalledTimes(2);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('keeps concurrent appends within the maximum size', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };
    const firstEntry = 'a'.repeat(MAX_CHANNEL_MEMORY_BYTES - 3);
    await appendChannelMemory(target, firstEntry);

    const results = await Promise.allSettled([
      appendChannelMemory(target, 'b'),
      appendChannelMemory(target, 'c'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      fs.statSync(getChannelMemoryFilePath(target)).size,
    ).toBeLessThanOrEqual(MAX_CHANNEL_MEMORY_BYTES);
  });

  it('serializes clear after pending appends', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };

    const appends = Array.from({ length: 20 }, (_, index) =>
      appendChannelMemory(target, `entry ${index}`),
    );
    await Promise.all([...appends, clearChannelMemory(target)]);

    await expect(readChannelMemory(target)).resolves.toBe('');
  });

  it('reads oversized existing memory as empty', async () => {
    const target: ChannelMemoryTarget = {
      channelName: 'prod',
      chatId: 'chat-1',
    };
    const filePath = getChannelMemoryFilePath(target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(MAX_CHANNEL_MEMORY_BYTES + 1));

    await expect(readChannelMemory(target)).resolves.toBe('');
  });
});
