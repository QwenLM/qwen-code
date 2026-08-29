import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelOutputSegmentContext } from '@qwen-code/channel-base';
import {
  DingtalkCardRequestError,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
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

function tracking(controller: StatusCardController) {
  return controller as unknown as {
    recordsBySegment: Map<string, unknown>;
    recordsByOutTrack: Map<string, unknown>;
    segmentIdsByRun: Map<string, Set<string>>;
    terminalSegmentIds: Set<string>;
  };
}

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
          content: 'first',
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
            content: '@Alice',
          }),
        }),
      ),
    );
    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '@Alice',
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
    expect(content).toContain('[Earlier output truncated]');
    expect(content.endsWith('b'.repeat(2_000))).toBe(true);
  });

  it('does not rewind content after delayed card creation', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    const creationGate = deferred<void>();
    vi.mocked(client.createAndDeliver).mockImplementationOnce(async () => {
      await creationGate.promise;
    });

    controller.replace(segment(), target, 'initial');
    controller.replace(segment(), target, 'queued');
    await vi.advanceTimersByTimeAsync(500);
    controller.replace(segment(), target, 'latest');

    creationGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      vi
        .mocked(client.openOrUpdateStream)
        .mock.calls.map(([request]) => request.content),
    ).toEqual(['latest', 'latest']);
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
    expect(streamContents.at(-1)).toBe('before [Image pending] after');
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
          statusLine: 'Running · qwen3.7-max · 0s',
        }),
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · qwen3.7-max · 2s',
        },
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · qwen3.7-max · 3s',
        },
      }),
    );
  });

  it('periodically republishes the full content for reconnected clients', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockClear();

    controller.replace(
      segment(),
      target,
      'latest [IMAGE: /Users/ben/private/image.png]',
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(
      vi
        .mocked(client.updateInstance)
        .mock.calls.filter(([request]) => request.cardParamMap.content),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          content: 'latest [Image pending]',
          statusLine: 'Running · 5s',
        },
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · 6s',
        },
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          content: 'latest [Image pending]',
          statusLine: 'Running · 10s',
        },
      }),
    );
  });

  it('retries a failed full-content checkpoint on the next status update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockClear();
    controller.replace(segment(), target, 'latest');
    let checkpointFailed = false;
    vi.mocked(client.updateInstance).mockImplementation(async (request) => {
      if (request.cardParamMap.content && !checkpointFailed) {
        checkpointFailed = true;
        throw new Error('checkpoint failed');
      }
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          content: 'latest',
          statusLine: 'Running · 5s',
        },
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      'status card metadata',
      expect.any(Error),
    );

    vi.mocked(client.updateInstance).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: {
          content: 'latest',
          statusLine: 'Running · 6s',
        },
      }),
    );
  });

  it('writes terminal state after an in-flight full-content checkpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();
    const checkpointStarted = deferred<void>();
    const checkpointGate = deferred<void>();

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockClear();
    vi.mocked(client.updateInstance).mockImplementation(async (request) => {
      if (
        request.cardParamMap.content &&
        request.cardParamMap.flowStatus === undefined
      ) {
        checkpointStarted.resolve();
        await checkpointGate.promise;
      }
    });

    controller.replace(segment(), target, 'latest running');
    await vi.advanceTimersByTimeAsync(5_000);
    await checkpointStarted.promise;
    const completion = controller.complete('segment-1', 'final answer');
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    checkpointGate.resolve();
    await expect(completion).resolves.toBe(true);
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: 'final answer',
          flowStatus: 3,
          statusLine: 'Completed · 5s',
        }),
      }),
    );

    const updateCount = vi.mocked(client.updateInstance).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.updateInstance).toHaveBeenCalledTimes(updateCount);
  });

  it('omits an unconfigured model from running status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();

    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          statusLine: 'Running · 0s',
        }),
      }),
    );

    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · 2s',
        },
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
        content: 'firstsecond',
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

  it('updates terminal fields when stream finalization fails', async () => {
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'answer');
    await vi.waitFor(() =>
      expect(client.openOrUpdateStream).toHaveBeenCalledOnce(),
    );
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('stream finalize unavailable'),
    );

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      true,
    );

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          flowStatus: 3,
          hasAction: 'false',
          stop_action: 'false',
        }),
      }),
    );
  });

  it('does not retry a non-retryable terminal update', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'answer');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new DingtalkCardRequestError('terminal rejected', false),
    );

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      false,
    );
    expect(client.updateInstance).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.updateInstance).toHaveBeenCalledOnce();
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
      if (request.content === 'first more') await gate.promise;
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
    ).toContain('first more second');
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

  it('does not retry or claim delivery after a non-retryable creation failure', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new DingtalkCardRequestError('status template denied', false),
    );
    controller.ensure(segment(), target);

    await expect(controller.flushPending('segment-1')).resolves.toBe(false);
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
  });

  it('retries card creation after a transient failure and resumes streaming', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    vi.mocked(client.createAndDeliver)
      .mockRejectedValueOnce(new DingtalkCardRequestError('HTTP 503', true))
      .mockRejectedValueOnce(new DingtalkCardRequestError('HTTP 503', true));
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'status card creation',
      expect.any(Error),
    );

    // A boundary reached during the backoff falls back instead of waiting.
    await expect(controller.isCardLive('segment-1')).resolves.toBe(false);
    await expect(controller.flushPending('segment-1')).resolves.toBe(false);

    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(999);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.createAndDeliver).toHaveBeenCalledTimes(2);
    const firstCreate = vi.mocked(client.createAndDeliver).mock.calls[0]![0];
    const secondCreate = vi.mocked(client.createAndDeliver).mock.calls[1]![0];
    expect(secondCreate).toEqual(
      expect.objectContaining({
        outTrackId: firstCreate.outTrackId,
        cardParamMap: expect.objectContaining({ content: 'first more' }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.createAndDeliver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(client.createAndDeliver).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(client.createAndDeliver).mock.calls[2]![0].outTrackId,
    ).toBe(firstCreate.outTrackId);
    await expect(controller.isCardLive('segment-1')).resolves.toBe(true);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outTrackId: firstCreate.outTrackId,
        content: 'first more',
        finalize: false,
      }),
    );
  });

  it('abandons a backing-off creation when disposed', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new DingtalkCardRequestError('HTTP 503', true),
    );
    controller.ensure(segment(), target);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();

    controller.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.createAndDeliver).toHaveBeenCalledOnce();
  });

  it('reports a card as not live as soon as its creation attempt fails', async () => {
    const { client, controller } = createHarness();
    const gate = deferred<void>();
    vi.mocked(client.createAndDeliver).mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('HTTP 503');
    });
    controller.ensure(segment(), target);
    const live = controller.isCardLive('segment-1');

    gate.resolve();

    await expect(live).resolves.toBe(false);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('abandons a backing-off creation when the segment finalizes', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new Error('HTTP 503'),
    );
    controller.replace(segment(), target, 'answer');
    await vi.advanceTimersByTimeAsync(0);

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.updateInstance).not.toHaveBeenCalled();
  });

  it('drops a queued flush once the stream latches a permanent failure', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    const gate = deferred<void>();
    vi.mocked(client.createAndDeliver).mockImplementationOnce(async () => {
      await gate.promise;
    });
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new DingtalkCardRequestError('stream rejected', false),
    );
    controller.replace(segment(), target, 'first');
    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.openOrUpdateStream).not.toHaveBeenCalled();

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
    await expect(controller.isCardLive('segment-1')).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
  });

  it('finalizes a delivered card when its initial stream fails', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('initial stream connection lost'),
    );
    controller.replace(segment(), target, 'final answer');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('terminal connection lost'),
    );

    await expect(
      controller.complete('segment-1', 'final answer'),
    ).resolves.toBe(false);
    expect(client.updateInstance).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(999);
    expect(client.updateInstance).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.updateInstance).toHaveBeenCalledTimes(2);
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: 'final answer',
          flowStatus: 3,
          hasAction: 'false',
          stop_action: 'false',
        }),
      }),
    );
  });

  it('stops status refreshes after a non-retryable content failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>();
    vi.mocked(client.openOrUpdateStream).mockImplementationOnce(async () => {
      await gate.promise;
      throw new DingtalkCardRequestError('stream rejected', false);
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

  it('retries the latest snapshot after a transient content failure', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();
    vi.mocked(client.openOrUpdateStream)
      .mockRejectedValueOnce(new Error('stream died'))
      .mockRejectedValueOnce(new Error('stream died again'));

    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(
      'status card streaming',
      expect.any(Error),
    );
    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();

    controller.replace(segment(), target, 'latest after recovery');
    await vi.advanceTimersByTimeAsync(999);
    expect(client.openOrUpdateStream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(3);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'latest after recovery',
        finalize: false,
      }),
    );
    await expect(controller.isCardLive('segment-1')).resolves.toBe(true);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('recovers terminal state after content and finalization failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const { client, controller } = createHarness({ onError });
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();
    vi.mocked(client.updateInstance).mockClear();

    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('content connection lost'),
    );
    controller.replace(segment(), target, 'final answer');
    await vi.advanceTimersByTimeAsync(500);

    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('finalize connection lost'),
    );
    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('terminal connection lost'),
    );
    vi.setSystemTime(20_000);
    await expect(
      controller.complete('segment-1', 'final answer'),
    ).resolves.toBe(false);

    expect(client.updateInstance).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(client.updateInstance).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(client.updateInstance).toHaveBeenCalledTimes(2);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ finalize: true }),
    );
    // The elapsed time is the one at completion, not at the retry.
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: 'final answer',
          flowStatus: 3,
          statusLine: 'Completed · 20s',
          hasAction: 'false',
          stop_action: 'false',
        }),
      }),
    );
    expect(
      vi
        .mocked(client.openOrUpdateStream)
        .mock.calls.filter(([request]) => !request.finalize),
    ).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially and caps terminal retries at 30s', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'answer');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockClear();
    vi.mocked(client.updateInstance).mockRejectedValue(
      new Error('terminal connection lost'),
    );

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      false,
    );
    expect(client.updateInstance).toHaveBeenCalledOnce();

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.updateInstance).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.updateInstance).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('falls back when the boundary drain write fails and keeps retrying', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('stream blip'),
    );
    controller.replace(segment(), target, 'first more');

    await expect(controller.flushPending('segment-1')).resolves.toBe(false);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(3);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'first more', finalize: false }),
    );
  });

  it('re-arms flushes promptly after a boundary drain recovers a failed write', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();
    controller.replace(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('stream blip'),
    );
    controller.replace(segment(), target, 'first more');
    await vi.advanceTimersByTimeAsync(500);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);

    await expect(controller.flushPending('segment-1')).resolves.toBe(true);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(3);

    controller.replace(segment(), target, 'first more second');
    await vi.advanceTimersByTimeAsync(499);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(4);
    expect(client.openOrUpdateStream).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'first more second' }),
    );
  });

  it('untracks records once they reach a terminal state', async () => {
    const { client, controller } = createHarness();
    const maps = tracking(controller);
    controller.replace(segment('segment-1'), target, 'answer');
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new DingtalkCardRequestError('status template denied', false),
    );
    controller.replace(segment('segment-2'), target, 'never ready');
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledTimes(2),
    );
    expect(maps.recordsBySegment.size).toBe(2);
    expect(maps.recordsByOutTrack.size).toBe(2);
    expect(maps.segmentIdsByRun.get('run-1')?.size).toBe(2);

    await expect(controller.complete('segment-1', 'answer')).resolves.toBe(
      true,
    );
    await expect(controller.complete('segment-2', 'never ready')).resolves.toBe(
      false,
    );

    expect(maps.recordsBySegment.size).toBe(0);
    expect(maps.recordsByOutTrack.size).toBe(0);
    expect(maps.segmentIdsByRun.size).toBe(0);
    expect(maps.terminalSegmentIds).toEqual(
      new Set(['segment-1', 'segment-2']),
    );

    controller.dispose();
    expect(maps.terminalSegmentIds.size).toBe(0);
  });

  it('cancels pending recovery when disposed', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.replace(segment('stream-segment'), target, 'first');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockRejectedValueOnce(
      new Error('content connection lost'),
    );
    controller.replace(segment('stream-segment'), target, 'updated');
    await vi.advanceTimersByTimeAsync(500);

    controller.replace(segment('terminal-segment'), target, 'answer');
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('terminal connection lost'),
    );
    await expect(
      controller.complete('terminal-segment', 'answer'),
    ).resolves.toBe(false);

    const streamCalls = vi.mocked(client.openOrUpdateStream).mock.calls.length;
    const updateCalls = vi.mocked(client.updateInstance).mock.calls.length;
    const createCalls = vi.mocked(client.createAndDeliver).mock.calls.length;
    controller.dispose();
    controller.dispose();
    controller.replace(segment('late-segment'), target, 'late');
    controller.ensure(segment('post-dispose-segment'), target);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(streamCalls);
    expect(client.updateInstance).toHaveBeenCalledTimes(updateCalls);
    expect(client.createAndDeliver).toHaveBeenCalledTimes(createCalls);
    await expect(
      controller.complete('stream-segment', 'updated'),
    ).resolves.toBe(false);
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
