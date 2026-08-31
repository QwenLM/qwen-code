import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelOutputSegmentContext } from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { StatusCardController } from './status-card-controller.js';

type ExpectedCallbackResult =
  | { kind: 'accepted'; execute: () => Promise<void> }
  | {
      kind: 'forbidden';
      actorId: string;
      target: { chatId: string; isGroup: boolean };
    }
  | { kind: 'ignored'; actorId?: string };

function callbackResult(value: unknown): ExpectedCallbackResult {
  return value as ExpectedCallbackResult;
}

function acceptedExecution(value: unknown): () => Promise<void> {
  const result = callbackResult(value);
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    throw new Error(`Expected accepted callback, received ${result.kind}`);
  }
  return result.execute;
}

function segment(
  segmentId = 'segment-1',
  overrides: Partial<ChannelOutputSegmentContext> = {},
): ChannelOutputSegmentContext {
  return {
    channelName: 'dingtalk',
    sessionId: 'session-1',
    runId: 'run-1',
    segmentId,
    owner: { kind: 'channel_user', id: 'owner-1' },
    target: { chatId: 'cid-1' },
    ...overrides,
  };
}

const target = { chatId: 'cid-1', isGroup: true };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createHarness(
  options: {
    model?: string;
    onError?(operation: string, error: unknown): void;
  } = {},
) {
  const client = {
    createAndDeliver: vi.fn().mockResolvedValue(undefined),
    openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
    updateInstance: vi.fn().mockResolvedValue(undefined),
  } as unknown as DingtalkInteractiveCardClient;
  const cancelRun = vi.fn().mockResolvedValue(true);
  const controller = new StatusCardController({
    client,
    cancelRun,
    ...options,
  });
  return { client, cancelRun, controller };
}

describe('StatusCardController', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('creates and opens a status card on the first content snapshot', async () => {
    const { client, controller } = createHarness();

    expect(client.createAndDeliver).not.toHaveBeenCalled();
    controller.replace(segment(), target, 'first');

    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: expect.stringMatching(/^qwen-status-/),
        target: { chatId: 'cid-1', isGroup: true },
        cardParamMap: expect.objectContaining({
          hasAction: 'true',
          stop_action: 'true',
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '🤔 Thinking\n\nfirst',
          finalize: false,
        }),
      ),
    );
  });

  it('includes replacement content in the initial card delivery', async () => {
    const { client, controller } = createHarness();

    controller.replace(segment(), target, '@Alice');

    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledWith(
        expect.objectContaining({
          cardParamMap: expect.objectContaining({
            content: '🤔 Thinking\n\n@Alice',
          }),
        }),
      ),
    );
    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '🤔 Thinking\n\n@Alice',
        finalize: false,
      }),
    );
  });

  it('coalesces bounded full snapshots with one write in flight', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'a'.repeat(19_000));
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();

    controller.replace(
      segment(),
      target,
      'a'.repeat(19_000) + 'b'.repeat(2_000),
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
    const content = vi.mocked(client.openOrUpdateStream).mock.calls[0]![0]
      .content;
    expect(content.length).toBeLessThanOrEqual(20_000);
    expect(content.startsWith('🤔 Thinking\n\n')).toBe(true);
    expect(content).toContain('[Earlier output truncated]');
    expect(content.endsWith('b'.repeat(2_000))).toBe(true);
  });

  it('hides streamed image paths in status snapshots', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();

    controller.replace(
      segment(),
      target,
      'before [IMAGE: /Users/ben/private/image.png] after',
    );
    await vi.advanceTimersByTimeAsync(500);

    const streamContents = vi
      .mocked(client.openOrUpdateStream)
      .mock.calls.map(([request]) => request.content);
    expect(streamContents.join('\n')).not.toContain('/Users/ben/private');
    expect(streamContents.at(-1)).toBe(
      '🤔 Thinking\n\nbefore [Image pending] after',
    );
  });

  it('hides image paths when a streaming card is cancelled', async () => {
    const { client, controller } = createHarness();

    controller.replace(
      segment(),
      target,
      'before [IMAGE: /Users/ben/private/image.png] after',
    );
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );

    controller.cancelRun('run-1', 'cancel_command');

    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          cardParamMap: expect.objectContaining({
            content: 'before [Image pending] after',
            copy_content: 'before [Image pending] after',
          }),
        }),
      ),
    );
    const terminalPayload = JSON.stringify(
      vi.mocked(client.updateInstance).mock.calls.at(-1)?.[0].cardParamMap,
    );
    expect(terminalPayload).not.toContain('/Users/ben/private');
  });

  it('shows the configured model and refreshes elapsed time while idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
    });

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: '🤔 Thinking\n\nfirst',
          statusLine: 'qwen3.7-max · 0s',
        }),
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'qwen3.7-max · 2s',
        },
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'qwen3.7-max · 3s',
        },
      }),
    );
  });

  it('omits an unconfigured model from the active status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: '🤔 Thinking\n\nfirst',
          statusLine: '0s',
        }),
      }),
    );

    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: '2s',
        },
      }),
    );
  });

  it('shows the current lifecycle phase before response text arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
    });

    controller.ensure(segment(), target);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockClear();

    void controller.updateRunPhase('run-1', 'searching');
    void controller.updateRunPhase('run-1', 'searching');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '🔎 Searching',
        finalize: false,
      }),
    );
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);

    vi.mocked(client.updateInstance).mockClear();
    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'qwen3.7-max · 2s',
        },
      }),
    );
  });

  it('keeps the replying phase in the body while streaming output', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();

    controller.ensure(segment(), target);
    await vi.advanceTimersByTimeAsync(0);
    await controller.updateRunPhase('run-1', 'replying');
    controller.replace(segment(), target, 'answer');
    await vi.advanceTimersByTimeAsync(500);

    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: '✍️ Replying\n\nanswer',
        finalize: false,
      }),
    );

    await controller.complete('segment-1', 'answer');
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: 'answer',
          copy_content: 'answer',
        }),
      }),
    );
  });

  it('keeps content streaming after a metadata update fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
      onError,
    });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('metadata failed'),
    );
    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(
      'status card metadata',
      expect.any(Error),
    );

    vi.mocked(client.openOrUpdateStream).mockClear();
    controller.replace(segment(), target, 'firstsecond');
    vi.setSystemTime(2_200);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '🤔 Thinking\n\nfirstsecond',
        finalize: false,
      }),
    );
  });

  it('stops status refreshes after repeated metadata failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('metadata down'),
    );

    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.updateInstance).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(3);
  });

  it('resumes status refreshes once metadata updates recover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('metadata down'),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    vi.mocked(client.updateInstance).mockResolvedValue(undefined);
    vi.mocked(client.updateInstance).mockClear();

    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.updateInstance).toHaveBeenCalledTimes(1);

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalled();
  });

  it('writes the exact elapsed second with a stopped terminal state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
    });
    controller.replace(segment(), target, 'answer');
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(12_400);
    controller.cancelRun('run-1', 'cancel_command');
    await vi.runAllTimersAsync();

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          statusLine: 'Stopped · qwen3.7-max · 12s',
        }),
      }),
    );
  });

  it('keeps two segments from the same run independent', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment('segment-1'), target, 'first answer');
    controller.replace(segment('segment-2'), target, 'second answer');

    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledTimes(2),
    );
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);
    expect(firstOutTrackId).not.toBe(secondOutTrackId);

    await expect(
      controller.complete('segment-1', 'first answer'),
    ).resolves.toBe(true);
    await expect(
      controller.complete('segment-2', 'second answer'),
    ).resolves.toBe(true);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: firstOutTrackId,
        cardParamMap: expect.objectContaining({
          content: 'first answer',
        }),
      }),
    );
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: secondOutTrackId,
        cardParamMap: expect.objectContaining({
          content: 'second answer',
        }),
      }),
    );
  });

  it('cancels every live segment from the exact run only', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment('segment-1'), target, 'one');
    controller.replace(segment('segment-2'), target, 'two');
    controller.replace(
      segment('other-segment', {
        runId: 'run-2',
        sessionId: 'session-2',
      }),
      target,
      'other',
    );

    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledTimes(3),
    );
    const [firstOutTrackId, secondOutTrackId, otherOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);

    controller.cancelRun('run-1', 'cancel_command');

    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledTimes(2),
    );
    expect(
      vi
        .mocked(client.updateInstance)
        .mock.calls.map(([request]) => request.outTrackId),
    ).toEqual(expect.arrayContaining([firstOutTrackId, secondOutTrackId]));
    expect(client.updateInstance).not.toHaveBeenCalledWith(
      expect.objectContaining({ outTrackId: otherOutTrackId }),
    );

    await expect(controller.complete('other-segment', 'other')).resolves.toBe(
      true,
    );
  });

  it('commits final content through V2 instance fields and rejects late snapshots', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'answer');

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      true,
    );
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
          statusLine: 'Completed · 0s',
          hasAction: 'false',
          stop_action: 'false',
        },
      }),
    );

    controller.replace(segment(), target, 'late');
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
  });

  it('retains streamed content when completion has no response body', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'streamed answer');

    await expect(controller.complete('segment-1', '')).resolves.toBe(true);

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

  it('allows only the owner to stop the exact current run', async () => {
    const { client, cancelRun, controller } = createHarness();
    controller.replace(segment(), target, 'answer');
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    expect(callbackResult(controller.claimStop(outTrackId, 'other'))).toEqual({
      kind: 'forbidden',
      actorId: 'other',
      target,
    });
    expect(callbackResult(controller.claimStop(outTrackId, 'other'))).toEqual({
      kind: 'ignored',
    });
    const execute = acceptedExecution(
      controller.claimStop(outTrackId, 'owner-1'),
    );
    expect(callbackResult(controller.claimStop(outTrackId, 'owner-1'))).toEqual(
      {
        kind: 'ignored',
        actorId: 'owner-1',
      },
    );
    await execute();

    expect(cancelRun).toHaveBeenCalledWith('session-1', 'run-1');
  });

  it('drains a snapshot queued while the boundary drain write is in flight', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledOnce(),
    );
    const gate = deferred<void>();
    vi.mocked(client.openOrUpdateStream).mockImplementation(async (request) => {
      if (request.content === '🤔 Thinking\n\nfirst more') await gate.promise;
    });
    controller.replace(segment(), target, 'first more');

    const pending = controller.flushPending('segment-1');
    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2),
    );
    controller.replace(segment(), target, 'first more second');
    gate.resolve();

    await expect(pending).resolves.toBe(true);
    expect(
      vi
        .mocked(client.openOrUpdateStream)
        .mock.calls.map(([request]) => request.content),
    ).toContain('🤔 Thinking\n\nfirst more second');
  });

  it('awaits in-flight creation before reporting liveness', async () => {
    const { client, controller } = createHarness();
    const gate = deferred<void>();
    vi.mocked(client.createAndDeliver).mockImplementationOnce(async () => {
      await gate.promise;
    });
    controller.ensure(segment(), target);

    const live = controller.isCardLive('segment-1');
    let settled = false;
    void live.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(live).resolves.toBe(true);
  });

  it('does not claim delivery for a card whose creation failed', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new Error('status template unavailable'),
    );
    controller.ensure(segment(), target);

    await expect(controller.flushPending('segment-1')).resolves.toBe(false);
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();
  });

  it('stops status refreshes after the content stream fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>();
    vi.mocked(client.openOrUpdateStream).mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('stream died');
    });
    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    // The status timer fires while the failing write is still in flight and
    // queues its refresh behind it.
    await vi.advanceTimersByTimeAsync(500);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(
      'status card streaming',
      expect.any(Error),
    );
    expect(client.updateInstance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.updateInstance).not.toHaveBeenCalled();
  });

  it('does not retry the content stream after a latched failure', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('stream died'),
    );

    controller.replace(segment(), target, 'even more');
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(
      'status card streaming',
      expect.any(Error),
    );

    vi.mocked(client.openOrUpdateStream).mockClear();
    controller.replace(segment(), target, 'and again');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.openOrUpdateStream).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('resets the status failure breaker after a successful push', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('metadata down'),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(3);

    vi.mocked(client.updateInstance).mockResolvedValue(undefined);
    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.updateInstance).toHaveBeenCalledTimes(4);

    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('metadata blip'),
    );
    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(3);
  });

  it('revives idle status refreshes via a probe after the breaker trips', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('metadata down'),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(3);

    vi.mocked(client.updateInstance).mockResolvedValue(undefined);
    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.updateInstance.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not let a completed historical card stop a later run', async () => {
    const { client, cancelRun, controller } = createHarness();
    controller.replace(segment(), target, 'answer');
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;
    await controller.complete('segment-1', 'answer');

    expect(callbackResult(controller.claimStop(outTrackId, 'owner-1'))).toEqual(
      {
        kind: 'ignored',
        actorId: 'owner-1',
      },
    );
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
