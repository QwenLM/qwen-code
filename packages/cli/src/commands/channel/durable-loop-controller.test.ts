import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readCronTasks,
  Storage,
  updateCronTasks,
} from '@qwen-code/qwen-code-core';
import type { ChannelLoopInput, SessionTarget } from '@qwen-code/channel-base';
import { createDurableChannelLoopController } from './durable-loop-controller.js';

describe('createDurableChannelLoopController', () => {
  let scratch: string;
  const workspaceCwd = '/workspace/project';
  const target: SessionTarget = {
    channelName: 'dingtalk',
    senderId: 'user-1',
    chatId: 'group-42',
    isGroup: true,
  };
  const input: ChannelLoopInput = {
    channelName: 'dingtalk',
    target,
    cwd: workspaceCwd,
    cron: '0 9 * * *',
    prompt: 'post summary',
    label: 'Daily summary',
    recurring: true,
    createdBy: 'Alice',
  };

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-channel-loop-'));
    Storage.setRuntimeBaseDir(scratch);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('persists a shared-session durable task with channel delivery', async () => {
    const controller = createDurableChannelLoopController({
      workspaceCwd,
      now: () => new Date('2026-07-18T01:02:03.000Z'),
      idFactory: () => 'loop0001',
    });

    const loop = await controller.createForSession!(input, 10, 'session-1');

    expect(loop).toMatchObject({
      id: 'loop0001',
      target,
      createdAt: '2026-07-18T01:02:03.000Z',
      enabled: true,
    });
    expect(await readCronTasks(workspaceCwd)).toEqual([
      expect.objectContaining({
        id: 'loop0001',
        cron: '0 9 * * *',
        prompt: 'post summary',
        name: 'Daily summary',
        sessionId: 'session-1',
        sessionOwnership: 'shared',
        delivery: {
          kind: 'channel',
          channelName: 'dingtalk',
          target: { type: 'chat', id: 'group-42' },
        },
        channelLoop: {
          senderId: 'user-1',
          createdBy: 'Alice',
          label: 'Daily summary',
        },
      }),
    ]);
  });

  it('enforces the per-target enabled quota atomically', async () => {
    let nextId = 0;
    const controller = createDurableChannelLoopController({
      workspaceCwd,
      idFactory: () => `loop000${++nextId}`,
    });

    const results = await Promise.all([
      controller.createForSession!(input, 1, 'session-1'),
      controller.createForSession!(input, 1, 'session-1'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readCronTasks(workspaceCwd)).toHaveLength(1);
  });

  it('persists a direct loop as a user target', async () => {
    const controller = createDurableChannelLoopController({
      workspaceCwd,
      idFactory: () => 'loop0001',
    });
    const directTarget: SessionTarget = {
      channelName: 'dingtalk',
      senderId: 'user-1',
      chatId: 'staff-1',
      isGroup: false,
    };

    await controller.createForSession!(
      { ...input, target: directTarget },
      10,
      'session-1',
    );

    expect(await readCronTasks(workspaceCwd)).toEqual([
      expect.objectContaining({
        delivery: {
          kind: 'channel',
          channelName: 'dingtalk',
          target: { type: 'user', id: 'staff-1' },
        },
      }),
    ]);
  });

  it('rejects threaded daemon loops instead of dropping the topic', async () => {
    const controller = createDurableChannelLoopController({ workspaceCwd });

    await expect(
      controller.createForSession!(
        { ...input, target: { ...target, threadId: 'thread-7' } },
        10,
        'session-1',
      ),
    ).rejects.toThrow(/threaded targets/);
  });

  it('lists and disables only loops owned by the exact channel target', async () => {
    const controller = createDurableChannelLoopController({
      workspaceCwd,
      idFactory: () => 'loop0001',
    });
    await controller.createForSession!(input, 10, 'session-1');
    await updateCronTasks(workspaceCwd, (tasks) => [
      ...tasks,
      {
        ...tasks[0]!,
        id: 'other001',
        channelLoop: { ...tasks[0]!.channelLoop!, senderId: 'user-2' },
      },
    ]);

    const loops = await controller.listForTarget('dingtalk', target);
    expect(loops.map((loop) => loop.id)).toEqual(['loop0001']);
    expect(await controller.disable('loop0001')).toBe(true);
    expect(
      (await controller.listForTarget('dingtalk', target))[0]?.enabled,
    ).toBe(false);
    expect(await controller.disable('missing')).toBe(false);
  });

  it('validates cron expressions and rejects unbound creation', async () => {
    const controller = createDurableChannelLoopController({ workspaceCwd });

    expect(() => controller.validateCron('0 9 * * *')).not.toThrow();
    expect(() => controller.validateCron('not cron')).toThrow();
    await expect(controller.create(input)).rejects.toThrow(/session-bound/);
  });
});
