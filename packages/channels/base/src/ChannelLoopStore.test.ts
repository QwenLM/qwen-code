import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelLoopStore } from './ChannelLoopStore.js';
import type { ChannelLoopInput } from './ChannelLoopStore.js';

describe('ChannelLoopStore', () => {
  let tmpDir: string;
  let store: ChannelLoopStore;

  const input: ChannelLoopInput = {
    channelName: 'feishu-main',
    target: {
      channelName: 'feishu-main',
      senderId: 'alice',
      chatId: 'chat-1',
      threadId: 'thread-1',
      isGroup: false,
    },
    cwd: '/repo',
    cron: '0 9 * * *',
    prompt: 'post a daily summary',
    label: 'daily summary',
    recurring: true,
    createdBy: 'Alice',
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-loop-store-'));
    store = new ChannelLoopStore({
      filePath: path.join(tmpDir, 'channels', 'loops.json'),
      now: () => new Date('2026-06-30T01:02:03.000Z'),
      idFactory: () => 'job-1',
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates and persists a channel loop with default status fields', async () => {
    const created = await store.create(input);

    expect(created).toEqual({
      ...input,
      target: { ...input.target, isGroup: false },
      id: 'job-1',
      enabled: true,
      createdAt: '2026-06-30T01:02:03.000Z',
      consecutiveFailures: 0,
      runCount: 0,
    });

    const reloaded = new ChannelLoopStore({
      filePath: path.join(tmpDir, 'channels', 'loops.json'),
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

  it('does not match targets with different group context', async () => {
    await store.create(input);

    await expect(
      store.listForTarget('feishu-main', {
        ...input.target,
        isGroup: true,
      }),
    ).resolves.toEqual([]);
  });

  it('keeps group targets isolated by sender', async () => {
    const created = await store.create({
      ...input,
      target: { ...input.target, isGroup: true },
    });

    await expect(
      store.listForTarget('feishu-main', {
        ...input.target,
        senderId: 'bob',
        isGroup: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      store.listForTarget('feishu-main', {
        ...input.target,
        isGroup: true,
      }),
    ).resolves.toEqual([created]);
  });

  it('creates for a target without counting disabled jobs against the cap', async () => {
    const disabled = await store.create(input);
    await store.disable(disabled.id);

    const created = await store.createForTarget(input, 1);

    expect(created).toMatchObject({
      id: 'job-1-1',
      enabled: true,
      prompt: 'post a daily summary',
    });
    await expect(
      store.listForTarget('feishu-main', input.target),
    ).resolves.toHaveLength(2);
  });

  it('enforces the enabled target cap inside the serialized write', async () => {
    let nextId = 0;
    const cappedStore = new ChannelLoopStore({
      filePath: path.join(tmpDir, 'channels', 'loops.json'),
      now: () => new Date('2026-06-30T01:02:03.000Z'),
      idFactory: () => `job-${++nextId}`,
    });

    const created = await Promise.all([
      cappedStore.createForTarget(input, 1),
      cappedStore.createForTarget(input, 1),
    ]);

    expect(created.filter(Boolean)).toHaveLength(1);
    await expect(
      cappedStore.listForTarget('feishu-main', input.target),
    ).resolves.toHaveLength(1);
  });

  it('does not match legacy targets that omit isGroup', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'channels', 'loops.json'),
      JSON.stringify([
        {
          ...input,
          id: 'old-job',
          target: {
            channelName: 'feishu-main',
            senderId: 'alice',
            chatId: 'chat-1',
            threadId: 'thread-1',
          },
          enabled: true,
          createdAt: '2026-06-30T01:02:03.000Z',
          consecutiveFailures: 0,
        },
      ]),
      'utf8',
    );

    await expect(store.list()).resolves.toMatchObject([
      { id: 'old-job', target: { isGroup: undefined } },
    ]);
    await expect(
      store.listForTarget('feishu-main', input.target),
    ).resolves.toEqual([]);
  });

  it('keeps generated ids unique when the id factory collides', async () => {
    const first = await store.create(input);
    const second = await store.create(input);

    expect(first.id).toBe('job-1');
    expect(second.id).toBe('job-1-1');
  });

  it('writes loop files with private permissions', async () => {
    await store.create(input);

    const channelsDir = path.join(tmpDir, 'channels');
    const filePath = path.join(channelsDir, 'loops.json');
    const dirMode = (await fs.stat(channelsDir)).mode & 0o777;
    const fileMode = (await fs.stat(filePath)).mode & 0o777;

    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
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

  it('refuses to treat corrupt JSON as an empty loop', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'channels', 'loops.json'),
      '{',
      'utf8',
    );

    await expect(store.list()).rejects.toThrow(/Malformed JSON/);
  });

  it('refuses to treat non-array JSON as an empty loop', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'channels', 'loops.json'),
      '{}',
      'utf8',
    );

    await expect(store.list()).rejects.toThrow(/Expected a JSON array/);
  });

  it('refuses to load invalid loop entries', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'channels', 'loops.json'),
      JSON.stringify([{}]),
      'utf8',
    );

    await expect(store.list()).rejects.toThrow(/Invalid channel loop/);
  });

  it('loads jobs created before lifecycle fields existed', async () => {
    await fs.mkdir(path.join(tmpDir, 'channels'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'channels', 'loops.json'),
      JSON.stringify([
        {
          ...input,
          id: 'old-job',
          enabled: true,
          createdAt: '2026-06-30T01:02:03.000Z',
          consecutiveFailures: 0,
        },
      ]),
      'utf8',
    );

    await expect(store.list()).resolves.toEqual([
      {
        ...input,
        id: 'old-job',
        enabled: true,
        createdAt: '2026-06-30T01:02:03.000Z',
        consecutiveFailures: 0,
        target: { ...input.target, isGroup: false },
        runCount: 0,
      },
    ]);
  });
});
