import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { StatusCardController } from './status-card-controller.js';

function started(
  overrides: Partial<
    Extract<ChannelTaskLifecycleEvent, { type: 'started' }>
  > = {},
): Extract<ChannelTaskLifecycleEvent, { type: 'started' }> {
  return {
    type: 'started',
    channelName: 'dingtalk',
    chatId: 'cid-1',
    sessionId: 'session-1',
    runId: 'run-1',
    owner: { kind: 'channel_user', id: 'owner-1' },
    ...overrides,
  };
}

function createHarness() {
  const client = {
    createAndDeliver: vi.fn().mockResolvedValue(undefined),
    openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
    updateInstance: vi.fn().mockResolvedValue(undefined),
  } as unknown as DingtalkInteractiveCardClient;
  const cancelRun = vi.fn().mockResolvedValue(true);
  const controller = new StatusCardController({
    client,
    cancelRun,
  });
  return { client, cancelRun, controller };
}

describe('StatusCardController', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('creates and opens one attended status card', async () => {
    const { client, controller } = createHarness();

    controller.start(started(), { chatId: 'cid-1', isGroup: true });

    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: expect.stringMatching(/^qwen-status-/),
        target: { chatId: 'cid-1', isGroup: true },
      }),
    );
    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
          finalize: false,
        }),
      ),
    );
  });

  it('coalesces bounded full snapshots with one write in flight', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();

    controller.append('run-1', 'a'.repeat(19_000));
    controller.append('run-1', 'b'.repeat(2_000));
    await vi.advanceTimersByTimeAsync(499);
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
    const content = vi.mocked(client.openOrUpdateStream).mock.calls[0]![0]
      .content;
    expect(content.length).toBeLessThanOrEqual(20_000);
    expect(content).toContain('[Earlier output truncated]');
    expect(content.endsWith('b'.repeat(2_000))).toBe(true);
  });

  it('awaits terminal writes and rejects late chunks', async () => {
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    controller.append('run-1', 'answer');

    await expect(controller.complete('run-1', 'answer')).resolves.toBe(true);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'answer',
        finalize: true,
      }),
    );
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          flowStatus: 3,
          statusLine: 'Completed',
        }),
      }),
    );

    controller.append('run-1', 'late');
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
  });

  it('allows only the owner to stop the exact current run', async () => {
    const { client, cancelRun, controller } = createHarness();
    const outTrackId = controller.start(started(), {
      chatId: 'cid-1',
      isGroup: true,
    });
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );

    expect(controller.claimStop(outTrackId, 'other')).toBeUndefined();
    const action = controller.claimStop(outTrackId, 'owner-1');
    expect(action).toBeDefined();
    await action?.();

    expect(cancelRun).toHaveBeenCalledWith('session-1', 'run-1');
  });
});
