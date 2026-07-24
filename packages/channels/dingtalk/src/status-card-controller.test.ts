import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { StatusCardController } from './status-card-controller.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it('clears prior segment content at a response boundary', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();

    controller.append('run-1', 'old segment');
    controller.responseBoundary('run-1');
    controller.append('run-1', 'new segment');
    await vi.advanceTimersByTimeAsync(500);

    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'new segment',
        finalize: false,
      }),
    );
  });

  it('finalizes without prior segment content after a response boundary', async () => {
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    controller.append('run-1', 'old segment');
    controller.responseBoundary('run-1');

    controller.cancel('run-1', 'cancel_command');

    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
          finalize: true,
        }),
      ),
    );
  });

  it('serializes waiting-state and stream writes', async () => {
    vi.useFakeTimers();
    const streamWrite = deferred<void>();
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();
    vi.mocked(client.openOrUpdateStream).mockReturnValueOnce(
      streamWrite.promise,
    );

    controller.append('run-1', 'answer');
    await vi.advanceTimersByTimeAsync(500);
    controller.setWaitingInput('run-1', true);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.updateInstance).not.toHaveBeenCalled();
    streamWrite.resolve();
    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledOnce(),
    );
  });

  it('commits final content through V2 instance fields and rejects late chunks', async () => {
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    controller.append('run-1', 'answer');

    await expect(controller.complete('run-1', 'answer')).resolves.toBe(true);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: '',
        finalize: true,
      }),
    );
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          blockList: '[{"type":0,"markdown":"answer"}]',
          content: 'answer',
          copy_content: 'answer',
          flowStatus: 3,
          statusLine: 'Completed',
          hasAction: '0',
          stop_action: '0',
        },
      }),
    );

    controller.append('run-1', 'late');
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
  });

  it('retains streamed content when completion has no response body', async () => {
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    controller.append('run-1', 'streamed answer');

    await expect(controller.complete('run-1', '')).resolves.toBe(true);

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          blockList: '[{"type":0,"markdown":"streamed answer"}]',
          content: 'streamed answer',
          copy_content: 'streamed answer',
        }),
      }),
    );
  });

  it('does not let a delayed waiting update overwrite completion', async () => {
    const waitingUpdate = deferred<void>();
    const events: string[] = [];
    const { client, controller } = createHarness();
    controller.start(started(), { chatId: 'cid-1', isGroup: true });
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    vi.mocked(client.updateInstance)
      .mockImplementationOnce(async () => {
        events.push('waiting-started');
        await waitingUpdate.promise;
        events.push('waiting-finished');
      })
      .mockImplementationOnce(async () => {
        events.push('completed');
      });

    controller.setWaitingInput('run-1', true);
    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledOnce(),
    );
    const completion = controller.complete('run-1', 'answer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['waiting-started']);

    waitingUpdate.resolve();
    await expect(completion).resolves.toBe(true);
    expect(events).toEqual([
      'waiting-started',
      'waiting-finished',
      'completed',
    ]);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          flowStatus: 3,
          statusLine: 'Completed',
        }),
      }),
    );
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
