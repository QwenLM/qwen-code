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

  it('creates and opens a status card only after the first visible chunk', async () => {
    const { client, controller } = createHarness();

    expect(client.createAndDeliver).not.toHaveBeenCalled();
    controller.append(segment(), target, '');
    expect(client.createAndDeliver).not.toHaveBeenCalled();

    controller.append(segment(), target, 'first');

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
          content: '',
          finalize: false,
        }),
      ),
    );
  });

  it('coalesces bounded full snapshots with one write in flight', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();
    controller.append(segment(), target, 'a'.repeat(19_000));
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(client.openOrUpdateStream).mockClear();

    controller.append(segment(), target, 'b'.repeat(2_000));
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

  it('hides streamed image paths across chunk boundaries', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness();

    controller.append(segment(), target, 'before [IMA');
    controller.append(
      segment(),
      target,
      'GE: /Users/ben/private/image.png] after',
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

    controller.append(
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

  it('shows the configured model and refreshes elapsed time only on text flushes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
    });

    controller.append(segment(), target, 'first');
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
    await vi.advanceTimersByTimeAsync(500);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · qwen3.7-max · 1s',
        },
      }),
    );

    vi.mocked(client.updateInstance).mockClear();
    vi.setSystemTime(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.updateInstance).not.toHaveBeenCalled();
  });

  it('omits an unconfigured model from running status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness();

    controller.append(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          statusLine: 'Running · 0s',
        }),
      }),
    );

    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: {
          statusLine: 'Running · 1s',
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
    controller.append(segment(), target, 'first');
    await vi.advanceTimersByTimeAsync(0);

    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('metadata failed'),
    );
    vi.setSystemTime(1_200);
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalledWith(
      'status card metadata',
      expect.any(Error),
    );

    vi.mocked(client.openOrUpdateStream).mockClear();
    controller.append(segment(), target, 'second');
    vi.setSystemTime(2_200);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.openOrUpdateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'firstsecond',
        finalize: false,
      }),
    );
  });

  it('writes the exact elapsed second with a stopped terminal state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, controller } = createHarness({
      model: 'qwen3.7-max',
    });
    controller.append(segment(), target, 'answer');
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
    controller.append(segment('segment-1'), target, 'first answer');
    controller.append(segment('segment-2'), target, 'second answer');

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
    controller.append(segment('segment-1'), target, 'one');
    controller.append(segment('segment-2'), target, 'two');
    controller.append(
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

  it('commits final content through V2 instance fields and rejects late chunks', async () => {
    const { client, controller } = createHarness();
    controller.append(segment(), target, 'answer');

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

    controller.append(segment(), target, 'late');
    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.openOrUpdateStream).toHaveBeenCalledTimes(2);
  });

  it('retains streamed content when completion has no response body', async () => {
    const { client, controller } = createHarness();
    controller.append(segment(), target, 'streamed answer');

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
    controller.append(segment(), target, 'answer');
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

  it('does not let a completed historical card stop a later run', async () => {
    const { client, cancelRun, controller } = createHarness();
    controller.append(segment(), target, 'answer');
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
