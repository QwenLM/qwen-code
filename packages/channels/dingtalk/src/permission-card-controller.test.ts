import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelPermissionRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import {
  QUESTION_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import { PermissionCardController } from './permission-card-controller.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createContext(requestId = 'permission-1', includeAlways = true) {
  const listeners = new Set<(reason: UserInputSettlementReason) => void>();
  const respond = vi.fn().mockResolvedValue(true);
  const context: ChannelPermissionRequestContext = {
    requestId,
    sessionId: 'session-1',
    runId: 'run-1',
    owner: { kind: 'channel_user', id: 'owner-1' },
    target: {
      channelName: 'dingtalk',
      chatId: 'cid-1',
      senderId: 'owner-1',
      isGroup: true,
    },
    title: 'Run tests',
    decisions: [
      { kind: 'allow_once', label: 'Allow once' },
      ...(includeAlways
        ? [
            {
              kind: 'allow_always' as const,
              label: 'Always allow for this project',
            },
          ]
        : []),
      { kind: 'deny', label: 'Deny' },
    ],
    onSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond,
  };
  return {
    context,
    respond,
    settle(reason: UserInputSettlementReason) {
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

function createHarness(timeoutMs = 300_000, locale: 'en' | 'zh' = 'en') {
  const client = {
    createAndDeliver: vi.fn().mockResolvedValue(undefined),
    openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
    updateInstance: vi.fn().mockResolvedValue(undefined),
  } as unknown as DingtalkInteractiveCardClient;
  const controller = new PermissionCardController({
    client,
    timeoutMs,
    locale,
  });
  return { client, controller };
}

function callback(
  outTrackId: string,
  decision: unknown = 'allow_once',
  overrides: Record<string, unknown> = {},
) {
  return {
    outTrackId,
    actionId: 'submit',
    actorId: 'owner-1',
    formData: { permission_decision: decision },
    hasBusinessPayload: true,
    ...overrides,
  };
}

function deliveredOutTrackId(client: DingtalkInteractiveCardClient): string {
  const request = vi.mocked(client.createAndDeliver).mock.calls[0]![0];
  return request.outTrackId;
}

function acceptedExecution(
  result: ReturnType<PermissionCardController['claim']>,
) {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    throw new Error(`Expected accepted callback, received ${result.kind}`);
  }
  return result.execute;
}

describe('PermissionCardController', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders only the permission decisions advertised by ChannelBase', async () => {
    const { client, controller } = createHarness();
    const { context } = createContext('permission-once', false);

    await expect(
      controller.present(context, { chatId: 'cid-1', isGroup: true }),
    ).resolves.toEqual({ kind: 'presented' });

    expect(client.createAndDeliver).toHaveBeenCalledWith({
      templateId: QUESTION_CARD_TEMPLATE_ID,
      outTrackId: expect.stringMatching(/^qwen-permission-/),
      target: { chatId: 'cid-1', isGroup: true },
      cardParamMap: expect.objectContaining({
        question_id: 'permission-once',
        question_title: 'Permission required',
        question_desc: 'Run tests',
        card_status: 'pending',
        form: {
          fields: [
            {
              name: 'permission_decision',
              label: 'Choose how to continue',
              type: 'CHECKBOX_GROUP',
              required: true,
              options: [
                { value: 'allow_once', text: 'Allow once' },
                { value: 'deny', text: 'Deny' },
              ],
            },
          ],
        },
      }),
    });
  });

  it('renders permission cards in Chinese', async () => {
    const { client, controller } = createHarness(300_000, 'zh');
    const { context } = createContext('permission-zh', false);
    context.decisions = [
      { kind: 'allow_once', label: '仅允许本次' },
      { kind: 'deny', label: '拒绝' },
    ];

    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          question_title: '需要授权',
          form_btn_text: '提交',
          form: {
            fields: [expect.objectContaining({ label: '请选择后续操作' })],
          },
        }),
      }),
    );
  });

  it.each([
    ['approved', 'allow_once', '已授权。', '已授权'],
    ['denied', 'deny', '已拒绝授权。', '已拒绝'],
    ['expired', undefined, '此授权请求已失效。', '已失效'],
    ['cancelled', undefined, '授权请求已取消。', '已取消'],
  ] as const)(
    'projects the %s terminal state in Chinese',
    async (cardStatus, decision, description, button) => {
      const { client, controller } = createHarness(300_000, 'zh');
      const { context, settle } = createContext(`permission-zh-${cardStatus}`);
      await controller.present(context, { chatId: 'cid-1', isGroup: true });
      const outTrackId = deliveredOutTrackId(client);

      if (decision) {
        await acceptedExecution(
          controller.claim(callback(outTrackId, decision)),
        )();
      } else if (cardStatus === 'expired') {
        settle('resolved_outside_presenter');
      } else {
        controller.cancelRun('run-1');
      }

      await vi.waitFor(() =>
        expect(client.updateInstance).toHaveBeenCalledWith({
          outTrackId,
          cardParamMap: {
            card_status: cardStatus,
            question_desc: description,
            form_btn_text: button,
          },
        }),
      );
    },
  );

  it.each([
    ['allow_once', 'approved'],
    ['allow_always', 'approved'],
    ['deny', 'denied'],
  ] as const)(
    'settles %s once and projects %s',
    async (decision, cardStatus) => {
      const { client, controller } = createHarness();
      const { context, respond } = createContext();
      await controller.present(context, { chatId: 'cid-1', isGroup: true });
      const outTrackId = deliveredOutTrackId(client);

      const first = controller.claim(callback(outTrackId, decision));
      const duplicate = controller.claim(callback(outTrackId, decision));
      await acceptedExecution(first)();

      expect(duplicate).toEqual({ kind: 'ignored', actorId: 'owner-1' });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(decision);
      expect(client.updateInstance).toHaveBeenCalledWith({
        outTrackId,
        cardParamMap: expect.objectContaining({ card_status: cardStatus }),
      });
    },
  );

  it('cancels and denies the permission through the template cancel action', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    const result = controller.claim(
      callback(outTrackId, undefined, {
        actionId: 'cancel',
        formData: {},
        isCancel: true,
      }),
    );
    await acceptedExecution(result)();

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('deny');
    expect(client.updateInstance).toHaveBeenCalledWith({
      outTrackId,
      cardParamMap: expect.objectContaining({ card_status: 'cancelled' }),
    });
  });

  it('rejects foreign actors without exposing a reusable feedback response', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    expect(
      controller.claim(
        callback(outTrackId, 'allow_once', { actorId: 'intruder' }),
      ),
    ).toEqual({
      kind: 'forbidden',
      actorId: 'intruder',
      target: { chatId: 'cid-1', isGroup: true },
    });
    expect(
      controller.claim(
        callback(outTrackId, 'allow_once', { actorId: 'intruder' }),
      ),
    ).toEqual({ kind: 'ignored' });
    expect(
      controller.claim(
        callback(outTrackId, 'allow_once', { actorId: 'intruder-2' }),
      ),
    ).toEqual({
      kind: 'forbidden',
      actorId: 'intruder-2',
      target: { chatId: 'cid-1', isGroup: true },
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown decision', 'not-advertised', {}],
    ['multiple decisions', ['allow_once', 'deny'], {}],
    ['unknown form field', 'allow_once', { extra: 'forged' }],
  ])('ignores %s', async (_name, decision, extraForm) => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    expect(
      controller.claim(
        callback(outTrackId, decision, {
          formData: { permission_decision: decision, ...extraForm },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(respond).not.toHaveBeenCalled();
  });

  it('returns unsupported without settling when card delivery fails', async () => {
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValue(
      new Error('template unavailable'),
    );
    const { context, respond } = createContext();

    await expect(
      controller.present(context, { chatId: 'cid-1', isGroup: true }),
    ).resolves.toEqual({ kind: 'unsupported' });

    expect(respond).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
  });

  it('expires and denies a timed-out permission', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness(1_000);
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(respond).toHaveBeenCalledWith('deny');
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );
  });

  it('claims the timeout denial before terminal card projection settles', async () => {
    vi.useFakeTimers();
    const projection = deferred<void>();
    const { client, controller } = createHarness(1_000);
    vi.mocked(client.updateInstance).mockReturnValue(projection.promise);
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });

    vi.advanceTimersByTime(1_000);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('deny');
    projection.resolve();
    await vi.runAllTimersAsync();
  });

  it('terminalizes when ChannelBase settles the request elsewhere', async () => {
    const { client, controller } = createHarness();
    const { context, respond, settle } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    settle('resolved_outside_presenter');
    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledWith({
        outTrackId,
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );

    expect(respond).not.toHaveBeenCalled();
    expect(controller.claim(callback(outTrackId))).toEqual({
      kind: 'ignored',
      actorId: 'owner-1',
    });
  });

  it('does not reactivate a request settled during delivery', async () => {
    const delivery = deferred<void>();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockReturnValue(delivery.promise);
    const { context, settle, respond } = createContext();

    const presenting = controller.present(context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    settle('resolved_outside_presenter');
    delivery.resolve();

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(respond).not.toHaveBeenCalled();
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );
  });

  it('cancels every pending permission owned by a terminal run', async () => {
    const { client, controller } = createHarness();
    const first = createContext('permission-1');
    const second = createContext('permission-2');
    await controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });

    controller.cancelRun('run-1');

    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledTimes(2),
    );
    expect(
      vi
        .mocked(client.updateInstance)
        .mock.calls.map(([request]) => request.cardParamMap['card_status']),
    ).toEqual(['cancelled', 'cancelled']);
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();
  });
  it('accepts checkbox-shaped decision submissions', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    await acceptedExecution(
      controller.claim(callback(outTrackId, ['allow_once'])),
    )();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('allow_once');

    const second = createContext('permission-2');
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    const secondOutTrackId = vi.mocked(client.createAndDeliver).mock
      .calls[1]![0].outTrackId;

    await acceptedExecution(
      controller.claim(callback(secondOutTrackId, { value: 'allow_once' })),
    )();
    expect(second.respond).toHaveBeenCalledOnce();
    expect(second.respond).toHaveBeenCalledWith('allow_once');
  });

  it('ignores a payload-less callback that only carries the cancel action', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    expect(
      controller.claim(
        callback(outTrackId, undefined, {
          actionId: 'cancel',
          formData: {},
          hasBusinessPayload: false,
          isCancel: false,
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(respond).not.toHaveBeenCalled();
  });

  it('accepts a submit delivered with the requestId action id', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    await acceptedExecution(
      controller.claim(
        callback(outTrackId, 'allow_once', { actionId: 'permission-1' }),
      ),
    )();

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('allow_once');
  });

  it('denies through the template built-in cancel flag alone', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = deliveredOutTrackId(client);

    await acceptedExecution(
      controller.claim(
        callback(outTrackId, undefined, {
          actionId: 'permission-1',
          formData: {},
          isCancel: true,
        }),
      ),
    )();

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith('deny');
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({ card_status: 'cancelled' }),
      }),
    );
  });
});
