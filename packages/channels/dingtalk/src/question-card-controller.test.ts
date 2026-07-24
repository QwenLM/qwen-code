import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelUserInputRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { QuestionCardController } from './question-card-controller.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createContext() {
  const listeners = new Set<(reason: UserInputSettlementReason) => void>();
  const respond = vi.fn().mockResolvedValue(true);
  const context: ChannelUserInputRequestContext = {
    requestId: 'request-1',
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
  const setWaitingInput = vi.fn();
  const sendFallback = vi.fn().mockResolvedValue(undefined);
  const controller = new QuestionCardController({
    client,
    timeoutMs,
    setWaitingInput,
    sendFallback,
  });
  return { client, setWaitingInput, sendFallback, controller };
}

describe('QuestionCardController', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders all normalized questions in one form card', async () => {
    const { client, controller, setWaitingInput } = createHarness();
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
                name: '1',
                type: 'MULTI_CHECKBOX_GROUP',
              }),
            ],
          },
        }),
      }),
    );
    expect(setWaitingInput).toHaveBeenCalledWith('run-1', true);
  });

  it('does not reactivate a request settled during delivery', async () => {
    const delivery = deferred<void>();
    const { client, controller, setWaitingInput } = createHarness();
    vi.mocked(client.createAndDeliver).mockReturnValue(delivery.promise);
    const { context, settle, respond } = createContext();

    const presenting = controller.present(context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    settle('resolved_outside_card');
    delivery.resolve();

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(respond).not.toHaveBeenCalled();
    expect(setWaitingInput).not.toHaveBeenCalledWith('run-1', true);
    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          card_status: 'resolved_outside_card',
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

  it('claims one owner callback and submits validated answers', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    expect(
      controller.claim({
        outTrackId,
        actionId: 'submit',
        ownerId: 'other',
        formData: { '0': 'Beijing', '1': ['Logs'] },
      }),
    ).toBeUndefined();
    const action = controller.claim({
      outTrackId,
      actionId: 'submit',
      ownerId: 'owner-1',
      formData: { '0': 'Beijing', '1': ['Logs', 'Metrics'] },
    });
    expect(action).toBeDefined();
    expect(
      controller.claim({
        outTrackId,
        actionId: 'submit',
        ownerId: 'owner-1',
        formData: { '0': 'Shanghai', '1': ['Logs'] },
      }),
    ).toBeUndefined();

    await action?.();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: { '0': 'Beijing', '1': 'Logs, Metrics' },
    });
    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
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
      controller.claim({
        outTrackId,
        actionId: 'submit',
        ownerId: 'owner-1',
        formData: { '0': 'Beijing', unexpected: 'secret' },
      }),
    ).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it('terminalizes a rejected responder without releasing the claim', async () => {
    const { client, controller } = createHarness();
    const { context, respond } = createContext();
    respond.mockResolvedValue(false);
    await controller.present(context, { chatId: 'cid-1', isGroup: true });
    const outTrackId = vi.mocked(client.createAndDeliver).mock.calls[0]![0]
      .outTrackId;

    await controller.claim({
      outTrackId,
      actionId: 'cancel',
      ownerId: 'owner-1',
      formData: {},
    })?.();

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          card_status: 'cancelled',
        }),
      }),
    );
    expect(
      controller.claim({
        outTrackId,
        actionId: 'cancel',
        ownerId: 'owner-1',
        formData: {},
      }),
    ).toBeUndefined();
  });

  it('expires before cancelling the original request', async () => {
    vi.useFakeTimers();
    const { client, controller } = createHarness(1_000);
    const { context, respond } = createContext();
    await controller.present(context, { chatId: 'cid-1', isGroup: true });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.updateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({ card_status: 'expired' }),
      }),
    );
    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
  });
});
