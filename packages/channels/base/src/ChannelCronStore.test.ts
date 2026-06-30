import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelCronStore } from './ChannelCronStore.js';
import type { ChannelCronJobInput } from './ChannelCronStore.js';

describe('ChannelCronStore', () => {
  let tmpDir: string;
  let store: ChannelCronStore;

  const input: ChannelCronJobInput = {
    channelName: 'feishu-main',
    target: {
      channelName: 'feishu-main',
      senderId: 'alice',
      chatId: 'chat-1',
      threadId: 'thread-1',
    },
    cwd: '/repo',
    cron: '0 9 * * *',
    prompt: 'post a daily summary',
    label: 'daily summary',
    recurring: true,
    createdBy: 'Alice',
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-cron-store-'));
    store = new ChannelCronStore({
      filePath: path.join(tmpDir, 'channels', 'cron.json'),
      now: () => new Date('2026-06-30T01:02:03.000Z'),
      idFactory: () => 'job-1',
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates and persists a channel cron job with default status fields', async () => {
    const created = await store.create(input);

    expect(created).toEqual({
      ...input,
      id: 'job-1',
      enabled: true,
      createdAt: '2026-06-30T01:02:03.000Z',
      consecutiveFailures: 0,
    });

    const reloaded = new ChannelCronStore({
      filePath: path.join(tmpDir, 'channels', 'cron.json'),
    });
    await expect(reloaded.list()).resolves.toEqual([created]);
  });

  it('lists only jobs for the current channel target', async () => {
    const first = await store.create(input);
    await store.create({
      ...input,
      target: { ...input.target, chatId: 'chat-2' },
      prompt: 'other chat',
    });

    await expect(
      store.listForTarget('feishu-main', input.target),
    ).resolves.toEqual([first]);
  });

  it('disables a job without deleting its last status', async () => {
    const created = await store.create(input);
    await store.update(created.id, {
      lastStatus: 'error',
      lastError: 'adapter cannot send proactively',
      consecutiveFailures: 1,
    });

    const disabled = await store.disable(created.id);

    expect(disabled).toBe(true);
    await expect(store.list()).resolves.toEqual([
      {
        ...created,
        enabled: false,
        lastStatus: 'error',
        lastError: 'adapter cannot send proactively',
        consecutiveFailures: 1,
      },
    ]);
  });

  it('refuses to treat corrupt JSON as an empty schedule', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'channels', 'cron.json'), '{', 'utf8');

    await expect(store.list()).rejects.toThrow(/Malformed JSON/);
  });
});
