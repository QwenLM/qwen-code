import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelOutputSegmentContext } from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { StatusCardController } from './status-card-controller.js';

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
          statusLine: 'Completed',
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

    expect(controller.claimStop(outTrackId, 'other')).toBeUndefined();
    const action = controller.claimStop(outTrackId, 'owner-1');
    expect(action).toBeDefined();
    await action?.();

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

    expect(controller.claimStop(outTrackId, 'owner-1')).toBeUndefined();
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
