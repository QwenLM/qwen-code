import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelUserInputRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { QuestionCardController } from './question-card-controller.js';

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createContext(requestId = 'request-1', sourceLabel?: string) {
  const listeners = new Set<(reason: UserInputSettlementReason) => void>();
  const respond = vi.fn().mockResolvedValue(true);
  const context: ChannelUserInputRequestContext = {
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
    questions: [
      {
        answerKey: '0',
        header: 'Region',
        question: 'Which region?',
        options: [
          { label: 'Beijing', description: 'Use Beijing.' },
          { label: 'Shanghai', description: 'Use Shanghai.' },
        ],
        multiSelect: false,
      },
      {
        answerKey: '1',
        header: 'Signals',
        question: 'Which signals?',
        options: [
          { label: 'Logs', description: 'Use logs.' },
          { label: 'Metrics', description: 'Use metrics.' },
        ],
        multiSelect: true,
      },
    ],
    submitOptionId: 'proceed_once',
    ...(sourceLabel ? { sourceLabel } : {}),
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

function createHarness(timeoutMs = 300_000) {
  const client = {
    createAndDeliver: vi.fn().mockResolvedValue(undefined),
    openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
    updateInstance: vi.fn().mockResolvedValue(undefined),
  } as unknown as DingtalkInteractiveCardClient;
  const sendFallback = vi.fn().mockResolvedValue(undefined);
  const controller = new QuestionCardController({
    client,
    timeoutMs,
    sendFallback,
  });
  return { client, sendFallback, controller };
}

describe('QuestionCardController', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders all normalized questions in one form card', async () => {
    const { client, controller } = createHarness();
    const { context } = createContext();

    await expect(
      controller.present(context, { chatId: 'cid-1', isGroup: true }),
    ).resolves.toEqual({ kind: 'presented' });

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: expect.stringMatching(/^qwen-question-/),
        cardParamMap: expect.objectContaining({
          card_status: 'pending',
          form: {
            fields: [
              expect.objectContaining({
                name: '0',
                type: 'CHECKBOX_GROUP',
              }),
              expect.objectContaining({
                name: '0_other',
                type: 'TEXT',
              }),
              expect.objectContaining({
                name: '1',
                type: 'MULTI_CHECKBOX_GROUP',
              }),
              expect.objectContaining({
                name: '1_other',
                type: 'TEXT',
              }),
            ],
          },
        }),
      }),
    );
  });

  it('retains the escaped source label in pending and terminal question cards', async () => {
    const { client, controller } = createHarness();
    const { context, settle } = createContext('request-1', '[review_*]');

    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          question_desc: '\\[review\\_\\*\\]\n\nWhich region?',
        }),
      }),
    );

    settle('cancelled');
    await vi.waitFor(() => {
      expect(client.updateInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          cardParamMap: expect.objectContaining({
            question_desc: '\\[review\\_\\*\\]\n\nCancelled.',
          }),
        }),
      );
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
        cardParamMap: expect.objectContaining({
          card_status: 'expired',
          question_desc: 'Resolved outside this card.',
        }),
      }),
    );
  });

  it('falls back visibly and cancels when card delivery fails', async () => {
    const { client, controller, sendFallback } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValue(
      new Error('template unavailable'),
    );
    const { context, respond } = createContext();

    await expect(
      controller.present(context, { chatId: 'cid-1', isGroup: true }),
    ).resolves.toEqual({ kind: 'handled' });

    expect(sendFallback).toHaveBeenCalledWith(
      'cid-1',
      expect.stringContaining('request was cancelled'),
    );
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('passes the source label separately when card delivery falls back', async () => {
    const { client, controller, sendFallback } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValue(
      new Error('template unavailable'),
    );
    const { context } = createContext('request-1', '[review_*]');

    await controller.present(context, { chatId: 'cid-1', isGroup: true });

    expect(sendFallback).toHaveBeenCalledWith(
      'cid-1',
      expect.not.stringContaining('[review'),
      '[review_*]',
    );
  });

  it('does not cancel again when delivery fails after external settlement', async () => {
    const delivery = deferred<void>();
    const { client, controller, sendFallback } = createHarness();
    vi.mocked(client.createAndDeliver).mockReturnValue(delivery.promise);
    const { context, settle, respond } = createContext();

    const presenting = controller.present(context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    settle('resolved_outside_presenter');
    delivery.reject(new Error('late delivery failure'));

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(sendFallback).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('claims one owner callback and submits validated answers', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'submit',
          actorId: 'other',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ),
    ).toEqual({
      kind: 'forbidden',
      actorId: 'other',
      target: { chatId: 'cid-1', isGroup: true },
    });
    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'submit',
          actorId: 'other',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ),
    ).toEqual({ kind: 'ignored' });
    const execute = acceptedExecution(
      controller.claim({
        outTrackId,
        actionId: 'submit',
        actorId: 'owner-1',
        formData: { '0': 'Beijing', '1': ['Logs', 'Metrics'] },
      }),
    );
    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Shanghai', '1': ['Logs'] },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'cancel',
          actorId: 'owner-1',
          formData: {},
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });

    await execute();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: { '0': 'Beijing', '1': 'Logs, Metrics' },
    });
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outTrackId,
        cardParamMap: expect.objectContaining({
          card_status: 'submitted',
        }),
      }),
    );
  });

  it('rejects unknown answer keys before claiming the request', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', unexpected: 'secret' },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(respond).not.toHaveBeenCalled();
  });

  it('submits the built-in cancel callback without form answers', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    await acceptedExecution(
      controller.claim({
        outTrackId,
        actionId: 'request-1',
        actorId: 'owner-1',
        formData: {},
        hasBusinessPayload: true,
        isCancel: true,
      }),
    )();

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outTrackId,
        cardParamMap: expect.objectContaining({
          card_status: 'cancelled',
        }),
      }),
    );
  });

  it('ignores non-business callbacks and accepts custom answers', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'request-1',
          actorId: 'owner-1',
          formData: {},
          hasBusinessPayload: false,
          isCancel: false,
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    await acceptedExecution(
      controller.claim({
        outTrackId,
        actionId: 'request-1',
        actorId: 'owner-1',
        formData: {
          '0': '__qwen_other__',
          '0_other': 'Shenzhen',
          '1': ['Logs'],
          '1_other': '',
        },
        hasBusinessPayload: true,
        isCancel: false,
      }),
    )();

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: { '0': 'Shenzhen', '1': 'Logs' },
    });
  });

  it('terminalizes a rejected responder without releasing the claim', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    respond.mockResolvedValue(false);
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    await acceptedExecution(
      controller.claim({
        outTrackId,
        actionId: 'cancel',
        actorId: 'owner-1',
        formData: {},
      }),
    )();

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          card_status: 'expired',
          question_desc: 'This question is no longer available.',
        }),
      }),
    );
    expect(
      callbackResult(
        controller.claim({
          outTrackId,
          actionId: 'cancel',
          actorId: 'owner-1',
          formData: {},
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
  });

  it('expires before cancelling the original request', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness(1_000);
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId,
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('expires a card superseded by a new message without responding to the agent', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    controller.cancelRun('run-1', 'expired');
    await vi.waitFor(() =>
      expect(client.updateInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          outTrackId,
          cardParamMap: expect.objectContaining({
            card_status: 'expired',
          }),
        }),
      ),
    );

    expect(respond).not.toHaveBeenCalled();
  });

  it('keeps pending requests in different sessions independently claimable', async () => {
    const { client, controller } = createHarness();
    const first = createContext('request-1');
    const second = createContext('request-2');
    second.context.sessionId = 'session-2';
    second.context.runId = 'run-2';
    await controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);

    await acceptedExecution(
      controller.claim({
        outTrackId: firstOutTrackId,
        actionId: 'submit',
        actorId: 'owner-1',
        formData: { '0': 'Beijing', '1': ['Logs'] },
      }),
    )();

    expect(first.respond).toHaveBeenCalledOnce();
    expect(second.respond).not.toHaveBeenCalled();
    const executeSecond = acceptedExecution(
      controller.claim({
        outTrackId: secondOutTrackId,
        actionId: 'submit',
        actorId: 'owner-1',
        formData: { '0': 'Shanghai', '1': ['Metrics'] },
      }),
    );
    await executeSecond();
    expect(second.respond).toHaveBeenCalledOnce();
  });

  it('expires the prior card when a newer run is presented in the same scope', async () => {
    const { client, controller } = createHarness();
    const first = createContext('request-1');
    const second = createContext('request-2');
    second.context.runId = 'run-2';

    await controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        outTrackId: firstOutTrackId,
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );
    expect(first.respond).not.toHaveBeenCalled();
    expect(
      callbackResult(
        controller.claim({
          outTrackId: firstOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(
      callbackResult(
        controller.claim({
          outTrackId: secondOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Shanghai', '1': ['Metrics'] },
        }),
      ).kind,
    ).toBe('accepted');
  });

  it('keeps a newer run claimable after old settlement and callback events', async () => {
    const { client, controller } = createHarness();
    const first = createContext('request-1');
    const second = createContext('request-2');
    second.context.runId = 'run-2';
    await controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);
    vi.mocked(client.updateInstance).mockClear();

    controller.cancelRun('run-1', 'expired');
    first.settle('resolved_outside_presenter');

    expect(
      callbackResult(
        controller.claim({
          outTrackId: firstOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(client.updateInstance).not.toHaveBeenCalledWith(
      expect.objectContaining({ outTrackId: secondOutTrackId }),
    );

    const executeSecond = acceptedExecution(
      controller.claim({
        outTrackId: secondOutTrackId,
        actionId: 'submit',
        actorId: 'owner-1',
        formData: { '0': 'Shanghai', '1': ['Metrics'] },
      }),
    );
    await executeSecond();
    expect(second.respond).toHaveBeenCalledOnce();
  });

  it('keeps the first card active when the same run requests another question', async () => {
    const firstDelivery = deferred<void>();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver).mockReturnValueOnce(
      firstDelivery.promise,
    );
    const first = createContext('request-1');
    const second = createContext('request-2');
    const firstPresentation = controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await vi.waitFor(() =>
      expect(client.createAndDeliver).toHaveBeenCalledOnce(),
    );
    const firstOutTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    await expect(
      controller.present(second.context, {
        chatId: 'cid-1',
        isGroup: true,
      }),
    ).resolves.toEqual({ kind: 'unsupported' });

    expect(client.createAndDeliver).toHaveBeenCalledOnce();
    expect(client.updateInstance).not.toHaveBeenCalledWith(
      expect.objectContaining({ outTrackId: firstOutTrackId }),
    );
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();

    firstDelivery.resolve();
    await expect(firstPresentation).resolves.toEqual({ kind: 'presented' });
    expect(
      callbackResult(
        controller.claim({
          outTrackId: firstOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ).kind,
    ).toBe('accepted');
  });

  it('keeps the newer card active when deliveries finish out of order', async () => {
    const firstDelivery = deferred<void>();
    const { client, controller } = createHarness();
    vi.mocked(client.createAndDeliver)
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValueOnce(undefined);
    const first = createContext('request-1');
    const second = createContext('request-2');
    second.context.runId = 'run-2';

    const firstPresentation = controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    firstDelivery.resolve();
    await firstPresentation;
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);

    expect(
      callbackResult(
        controller.claim({
          outTrackId: firstOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ),
    ).toEqual({ kind: 'ignored', actorId: 'owner-1' });
    expect(
      callbackResult(
        controller.claim({
          outTrackId: secondOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Shanghai', '1': ['Metrics'] },
        }),
      ).kind,
    ).toBe('accepted');
  });

  it('keeps pending cards isolated between users', async () => {
    const { client, controller } = createHarness();
    const first = createContext('request-1');
    const second = createContext('request-2');
    second.context.owner = { kind: 'channel_user', id: 'owner-2' };
    second.context.target = {
      ...second.context.target,
      senderId: 'owner-2',
    };
    await controller.present(first.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await controller.present(second.context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    const [firstOutTrackId, secondOutTrackId] = vi
      .mocked(client.createAndDeliver)
      .mock.calls.map(([request]) => request.outTrackId);

    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(
      callbackResult(
        controller.claim({
          outTrackId: firstOutTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      ).kind,
    ).toBe('accepted');
    expect(
      callbackResult(
        controller.claim({
          outTrackId: secondOutTrackId,
          actionId: 'submit',
          actorId: 'owner-2',
          formData: { '0': 'Shanghai', '1': ['Metrics'] },
        }),
      ).kind,
    ).toBe('accepted');
  });

  it('does not roll back an accepted answer when terminal projection fails', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;
    vi.mocked(client.updateInstance).mockRejectedValueOnce(
      new Error('projection failed'),
    );

    await expect(
      acceptedExecution(
        controller.claim({
          outTrackId,
          actionId: 'submit',
          actorId: 'owner-1',
          formData: { '0': 'Beijing', '1': ['Logs'] },
        }),
      )(),
    ).resolves.toBeUndefined();

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: { '0': 'Beijing', '1': 'Logs' },
    });
  });
});
