import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueScheduledDelivery,
  readScheduledDeliveryOutbox,
  Storage,
} from '@qwen-code/qwen-code-core';
import { ChannelDeliveryError } from './channel-delivery-ipc.js';
import { createScheduledDeliveryDispatcher } from './scheduled-delivery-dispatcher.js';

describe('scheduled delivery dispatcher', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-dispatch-'));
    workspace = path.join(scratch, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    Storage.setRuntimeBaseDir(scratch);
    await enqueueScheduledDelivery(workspace, {
      deliveryId: 'task-1:1000',
      taskId: 'task-1',
      firedAt: 1000,
      channelName: 'dingtalk',
      target: { type: 'chat', id: 'group-42' },
      text: 'daily result',
      createdAt: 1001,
    });
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('delivers one claimed record through the exact workspace', async () => {
    const deliver = vi.fn().mockResolvedValue({ delivered: true });
    const dispatcher = createScheduledDeliveryDispatcher({
      listWorkspaces: () => [workspace],
      deliver,
      now: () => 2000,
    });

    await dispatcher.runOnce();

    expect(deliver).toHaveBeenCalledWith(workspace, {
      deliveryId: 'task-1:1000',
      channelName: 'dingtalk',
      target: { type: 'chat', id: 'group-42' },
      text: 'daily result',
    });
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 1 }),
    ]);
  });

  it('backs off a transient transport failure without changing task work', async () => {
    let now = 2000;
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        new ChannelDeliveryError(
          'channel_delivery_timeout',
          'worker timed out',
        ),
      )
      .mockResolvedValueOnce({ delivered: true });
    const dispatcher = createScheduledDeliveryDispatcher({
      listWorkspaces: () => [workspace],
      deliver,
      now: () => now,
      baseRetryMs: 1000,
    });

    await dispatcher.runOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([
      expect.objectContaining({
        status: 'retryable',
        attempts: 1,
        nextAttemptAt: 3000,
        lastError: expect.objectContaining({
          code: 'channel_delivery_timeout',
        }),
      }),
    ]);

    await dispatcher.runOnce();
    expect(deliver).toHaveBeenCalledTimes(1);
    now = 3000;
    await dispatcher.runOnce();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 2 }),
    ]);
  });

  it('marks invalid delivery permanently failed without retrying', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValue(
        new ChannelDeliveryError(
          'channel_delivery_invalid',
          'target is invalid',
        ),
      );
    const dispatcher = createScheduledDeliveryDispatcher({
      listWorkspaces: () => [workspace],
      deliver,
      now: () => 2000,
    });

    await dispatcher.runOnce();
    await dispatcher.runOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([
      expect.objectContaining({
        status: 'failed',
        lastError: expect.objectContaining({
          code: 'channel_delivery_invalid',
        }),
      }),
    ]);
  });

  it('stops admitting polls and waits for the active delivery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async () => {
      await gate;
      return { delivered: true as const };
    });
    const dispatcher = createScheduledDeliveryDispatcher({
      listWorkspaces: () => [workspace],
      deliver,
      now: () => 2000,
      pollIntervalMs: 10,
    });
    dispatcher.start();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    const stopping = dispatcher.stop();
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    release();
    await stopping;
  });
});
