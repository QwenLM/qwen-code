import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelUserInputRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import { FeishuQuestionCardController } from './question-card-controller.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createContext(
  requestId = 'request-1',
  overrides: Partial<ChannelUserInputRequestContext> = {},
) {
  const listeners = new Set<(reason: UserInputSettlementReason) => void>();
  const respond = vi.fn().mockResolvedValue(true);
  const context: ChannelUserInputRequestContext = {
    requestId,
    sessionId: 'session-1',
    runId: 'run-1',
    owner: { kind: 'channel_user', id: 'owner-1' },
    target: {
      channelName: 'feishu',
      chatId: 'oc_1',
      senderId: 'owner-1',
      isGroup: true,
    },
    questions: [
      {
        answerKey: '0',
        header: 'Region',
        question: 'Which region?',
        options: [{ label: 'Beijing', description: 'Use Beijing.' }],
        multiSelect: false,
      },
    ],
    submitOptionId: 'allow-once',
    onSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond,
    ...overrides,
  };
  return {
    context,
    respond,
    settle(reason: UserInputSettlementReason) {
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

function createHarness(timeoutMs = 270_000) {
  const sendCard = vi.fn().mockResolvedValue('om_1');
  const patchCard = vi.fn().mockResolvedValue(true);
  const sendFallback = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const controller = new FeishuQuestionCardController({
    timeoutMs,
    sendCard,
    patchCard,
    sendFallback,
    onError,
  });
  return { controller, onError, patchCard, sendCard, sendFallback };
}

describe('FeishuQuestionCardController presentation', () => {
  beforeEach(() => vi.useRealTimers());

  it('reserves the request before delivery and does not reactivate it after settlement', async () => {
    const delivery = deferred<string>();
    const { controller, patchCard, sendCard } = createHarness();
    sendCard.mockReturnValue(delivery.promise);
    const { context, settle } = createContext();

    const presenting = controller.present(context);
    settle('resolved_outside_presenter');
    delivery.resolve('om_1');

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(patchCard).toHaveBeenCalledWith(
      'om_1',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).not.toContain(
      '已取消',
    );
    expect(controller.claim(validCancel())).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('unsubscribes when settlement fires during listener registration', async () => {
    const unsubscribe = vi.fn();
    const { controller, patchCard, sendCard } = createHarness();
    const { context } = createContext('request-synchronously-settled', {
      onSettled(listener) {
        listener('cancelled');
        return unsubscribe;
      },
    });

    await expect(controller.present(context)).resolves.toEqual({
      kind: 'presented',
    });

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(sendCard).not.toHaveBeenCalled();
    expect(patchCard).not.toHaveBeenCalled();
  });

  it('returns presented only after native delivery provides a message id', async () => {
    const { controller, sendCard } = createHarness();
    const { context } = createContext();

    await expect(controller.present(context)).resolves.toEqual({
      kind: 'presented',
    });
    expect(sendCard).toHaveBeenCalledWith(
      'oc_1',
      expect.objectContaining({ schema: '2.0' }),
    );
  });

  it('falls back visibly and cancels when native delivery fails', async () => {
    const { controller, onError, sendCard, sendFallback } = createHarness();
    sendCard.mockRejectedValue(new Error('delivery failed'));
    const { context, respond } = createContext();

    await expect(controller.present(context)).resolves.toEqual({
      kind: 'handled',
    });
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('互动问题卡片投递失败'),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('Which region?'),
    );
    expect(respond).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
    expect(onError).toHaveBeenCalledWith(
      'question card delivery',
      expect.any(Error),
    );

    sendCard.mockResolvedValue('om_retry');
    await expect(
      controller.present(createContext('request-retry').context),
    ).resolves.toEqual({ kind: 'presented' });
  });

  it('falls back and cancels when delivery resolves without a message id', async () => {
    const { controller, sendCard, sendFallback } = createHarness();
    sendCard.mockResolvedValue('');
    const { context, respond } = createContext('request-empty-id');

    await expect(controller.present(context)).resolves.toEqual({
      kind: 'handled',
    });
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('互动问题卡片投递失败'),
    );
    expect(respond).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
  });

  it('keeps a synchronously settled request from falling back on delivery failure', async () => {
    const delivery = deferred<string>();
    const { controller, sendCard, sendFallback } = createHarness();
    sendCard.mockReturnValue(delivery.promise);
    const { context, respond, settle } = createContext('request-sync-settled');

    const presenting = controller.present(context);
    settle('run_cancelled');
    delivery.reject(new Error('delivery failed'));

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(sendFallback).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('rejects a second same-scope request while the first delivery is in flight', async () => {
    const delivery = deferred<string>();
    const { controller, sendCard } = createHarness();
    sendCard.mockReturnValue(delivery.promise);
    const first = createContext('first-in-flight');

    const presenting = controller.present(first.context);
    await expect(
      controller.present(createContext('second-in-flight').context),
    ).resolves.toEqual({ kind: 'unsupported' });
    delivery.resolve('om_first');
    await expect(presenting).resolves.toEqual({ kind: 'presented' });

    expect(
      controller.claim(
        validCancel('first-in-flight', { messageId: 'om_first' }),
      ),
    ).toMatchObject({ kind: 'handled', execute: expect.any(Function) });
  });

  it('returns unsupported for a second live request in the same session and owner scope', async () => {
    const { controller } = createHarness();
    const first = createContext();
    const second = createContext('request-2');

    await expect(controller.present(first.context)).resolves.toEqual({
      kind: 'presented',
    });
    await expect(controller.present(second.context)).resolves.toEqual({
      kind: 'unsupported',
    });
  });

  it('keeps concurrent owners in one shared session and chat independent', async () => {
    const { controller, sendCard } = createHarness();
    sendCard.mockResolvedValueOnce('om_one').mockResolvedValueOnce('om_two');
    const first = createContext('request-shared-1');
    const second = createContext('request-shared-2', {
      owner: { kind: 'channel_user', id: 'owner-2' },
      target: {
        channelName: 'feishu',
        chatId: 'oc_1',
        senderId: 'owner-2',
        isGroup: true,
      },
    });

    await expect(controller.present(first.context)).resolves.toEqual({
      kind: 'presented',
    });
    await expect(controller.present(second.context)).resolves.toEqual({
      kind: 'presented',
    });
    expect(
      controller.claim(
        validCancel('request-shared-1', { messageId: 'om_one' }),
      ),
    ).toMatchObject({ kind: 'handled', execute: expect.any(Function) });
    expect(
      controller.claim(
        validCancel('request-shared-2', {
          operatorId: 'owner-2',
          messageId: 'om_two',
        }),
      ),
    ).toMatchObject({ kind: 'handled', execute: expect.any(Function) });
  });

  it('projects 已取消 when a delivered question settles as cancelled', async () => {
    const { controller, patchCard } = createHarness();
    const { context, settle } = createContext('request-settle-cancelled');
    await controller.present(context);

    settle('cancelled');
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledOnce());

    const card = JSON.stringify(patchCard.mock.calls[0]?.[1]);
    expect(card).toContain('已取消');
    expect(card).not.toContain('已过期');
  });
});

describe('FeishuQuestionCardController callbacks', () => {
  it('claims a valid owner submit synchronously and responds only from execute', async () => {
    const { controller, patchCard, sendFallback } = createHarness();
    const { context, respond } = createContext('request-submit', {
      questions: [
        {
          answerKey: '0',
          header: 'Region',
          question: 'Which region?',
          options: [{ label: 'Beijing', description: 'Use Beijing.' }],
          multiSelect: false,
        },
        {
          answerKey: '1',
          header: 'Sources',
          question: 'Which sources?',
          options: [
            { label: 'Logs', description: 'Use logs.' },
            { label: 'Metrics', description: 'Use metrics.' },
          ],
          multiSelect: true,
        },
      ],
    });
    await controller.present(context);

    const claimed = controller.claim(
      submit('request-submit', { '0': 'Beijing', '1': ['Logs', 'Metrics'] }),
    );
    expect(claimed).toMatchObject({
      kind: 'handled',
      response: {
        toast: { type: 'success', content: '答案已提交，正在处理。' },
        card: {
          type: 'raw',
          data: expect.objectContaining({ schema: '2.0' }),
        },
      },
    });
    expect(JSON.stringify(claimed)).toContain('正在处理...');
    expect(JSON.stringify(claimed)).toContain('Beijing');
    expect(JSON.stringify(claimed)).toContain('Logs, Metrics');
    expect(respond).not.toHaveBeenCalled();
    expect(controller.claim(validCancel('request-submit'))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });

    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }
    await claimed.execute();

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
      answers: { '0': 'Beijing', '1': 'Logs, Metrics' },
    });
    expect(patchCard).toHaveBeenCalledWith(
      'om_1',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(JSON.stringify(patchCard.mock.calls.at(-1)?.[1])).toContain(
      'Logs, Metrics',
    );
    expect(JSON.stringify(patchCard.mock.calls.at(-1)?.[1])).toContain(
      '已提交',
    );
    expect(sendFallback).not.toHaveBeenCalled();

    await expect(
      controller.present(createContext('request-after-submit').context),
    ).resolves.toEqual({ kind: 'presented' });
  });

  it('claims a valid owner cancellation and responds from execute', async () => {
    const { controller, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    const { context, respond } = createContext('request-cancel');
    await controller.present(context);

    const claimed = controller.claim(validCancel('request-cancel'));
    expect(claimed).toMatchObject({
      kind: 'handled',
      response: {
        toast: { type: 'info', content: '已取消。' },
        card: {
          type: 'raw',
          data: expect.objectContaining({ schema: '2.0' }),
        },
      },
    });
    expect(JSON.stringify(claimed)).toContain('**已取消**');
    expect(respond).not.toHaveBeenCalled();
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }
    await claimed.execute();

    expect(respond).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
    // The terminal card already went out in the claim callback response: no
    // redundant PATCH, and no fallback even if patching would fail.
    expect(patchCard).not.toHaveBeenCalled();
    expect(sendFallback).not.toHaveBeenCalled();
    await expect(
      controller.present(createContext('request-after-cancel').context),
    ).resolves.toEqual({ kind: 'presented' });
  });

  it('correlates callbacks with the chat id captured at delivery time', async () => {
    const { controller } = createHarness();
    const { context } = createContext('request-captured-chat');
    await controller.present(context);
    context.target.chatId = 'oc_changed';

    expect(
      controller.claim(validCancel('request-captured-chat')),
    ).toMatchObject({
      kind: 'handled',
      execute: expect.any(Function),
    });
  });

  it('projects the terminal fallback to the chat id captured at delivery time', async () => {
    const { controller, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    const { context } = createContext('request-captured-fallback');
    await controller.present(context);
    context.target.chatId = 'oc_changed';

    const claimed = controller.claim(
      submit('request-captured-fallback', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }
    await claimed.execute();

    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('已提交'),
    );
  });

  it.each([
    ['missing operator', validCancel('request-1', { operatorId: undefined })],
    [
      'foreign operator',
      validCancel('request-1', { operatorId: 'other-user' }),
    ],
    ['missing chat', validCancel('request-1', { chatId: undefined })],
    ['wrong chat', validCancel('request-1', { chatId: 'oc_other' })],
    ['missing message', validCancel('request-1', { messageId: undefined })],
    ['wrong message', validCancel('request-1', { messageId: 'om_other' })],
    [
      'submit with missing operator',
      submit('request-1', { '0': 'Beijing' }, { operatorId: undefined }),
    ],
    [
      'submit with foreign operator',
      submit('request-1', { '0': 'Beijing' }, { operatorId: 'other-user' }),
    ],
    [
      'submit from wrong chat',
      submit('request-1', { '0': 'Beijing' }, { chatId: 'oc_other' }),
    ],
    [
      'submit with wrong message',
      submit('request-1', { '0': 'Beijing' }, { messageId: 'om_other' }),
    ],
  ])(
    'fails closed for %s without claiming the request',
    async (_name, data) => {
      const { controller, patchCard } = createHarness();
      const { context, respond } = createContext();
      await controller.present(context);

      expect(controller.claim(data)).toEqual({
        kind: 'handled',
        response: {
          toast: { type: 'warning', content: '该问题已过期或已处理。' },
        },
      });
      expect(patchCard).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      const claimed = controller.claim(validCancel());
      expect(claimed).toMatchObject({
        kind: 'handled',
        execute: expect.any(Function),
      });
    },
  );

  it('keeps a malformed form pending for a later valid owner submission', async () => {
    const { controller, patchCard } = createHarness();
    const { context } = createContext();
    await controller.present(context);

    expect(controller.claim(submit('request-1', { '0': 'Unknown' }))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '请完整选择有效答案。' },
      },
    });
    expect(patchCard).not.toHaveBeenCalled();
    expect(
      controller.claim(submit('request-1', { '0': 'Beijing' })),
    ).toMatchObject({
      kind: 'handled',
      execute: expect.any(Function),
    });
  });

  it('returns an expiry acknowledgement for an unknown explicit Ask action', () => {
    const { controller } = createHarness();

    expect(controller.claim(validCancel('unknown'))).toMatchObject({
      kind: 'handled',
      response: { toast: expect.any(Object) },
    });
  });

  it.each([
    ['returns false', vi.fn().mockResolvedValue(false)],
    ['throws', vi.fn().mockRejectedValue(new Error('response failed'))],
  ])(
    'keeps the callback-delivered cancel card when the responder %s',
    async (_name, respond) => {
      const { controller, onError, patchCard } = createHarness();
      const { context } = createContext('request-failed', { respond });
      await controller.present(context);
      const claimed = controller.claim(validCancel('request-failed'));
      if (claimed.kind !== 'handled' || !claimed.execute) {
        throw new Error('Expected claimed callback execution');
      }

      await claimed.execute();

      expect(onError).toHaveBeenCalledWith(
        'question response',
        expect.any(Error),
      );
      // The cancel card was delivered by the callback response; a rejected
      // responder must not flip it to 已过期 or post a fallback beside it.
      expect(patchCard).not.toHaveBeenCalled();
      expect(controller.claim(validCancel('request-failed'))).toEqual({
        kind: 'handled',
        response: {
          toast: { type: 'warning', content: '该问题已过期或已处理。' },
        },
      });
      // The failed respond must still release the session+owner scope.
      await expect(
        controller.present(createContext('request-after-reject').context),
      ).resolves.toEqual({ kind: 'presented' });
    },
  );

  it.each([
    ['returns false', vi.fn().mockResolvedValue(false)],
    ['throws', vi.fn().mockRejectedValue(new Error('response failed'))],
  ])(
    'terminalizes an unaccepted submission as expired when the responder %s',
    async (_name, respond) => {
      const { controller, onError, patchCard } = createHarness();
      const { context } = createContext('request-submit-failed', { respond });
      await controller.present(context);
      const claimed = controller.claim(
        submit('request-submit-failed', { '0': 'Beijing' }),
      );
      if (claimed.kind !== 'handled' || !claimed.execute) {
        throw new Error('Expected claimed callback execution');
      }

      await claimed.execute();

      expect(onError).toHaveBeenCalledWith(
        'question response',
        expect.any(Error),
      );
      expect(patchCard).toHaveBeenCalledOnce();
      expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
      // The request stays closed and the session+owner scope is released.
      expect(
        controller.claim(submit('request-submit-failed', { '0': 'Beijing' })),
      ).toEqual({
        kind: 'handled',
        response: {
          toast: { type: 'warning', content: '该问题已过期或已处理。' },
        },
      });
      await expect(
        controller.present(
          createContext('request-after-submit-failure').context,
        ),
      ).resolves.toEqual({ kind: 'presented' });
    },
  );

  it('falls back to text when an unaccepted submission cannot patch the card', async () => {
    const { controller, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    const respond = vi.fn().mockResolvedValue(false);
    const { context } = createContext('request-submit-expiry', { respond });
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-submit-expiry', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    await claimed.execute();

    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('已过期'),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('Region: Which region?'),
    );
  });

  it('does not reopen an accepted response when its terminal patch fails', async () => {
    const { controller, onError, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    const { context, respond } = createContext('request-patch');
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-patch', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    await claimed.execute();

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
      answers: { '0': 'Beijing' },
    });
    expect(onError).toHaveBeenCalledWith(
      'question card finalization',
      expect.any(Error),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('已提交'),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('Region: Beijing'),
    );
    expect(controller.claim(validCancel('request-patch'))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('falls back to text when the terminal patch rejects', async () => {
    const { controller, onError, patchCard, sendFallback } = createHarness();
    patchCard.mockRejectedValue(new Error('patch failed'));
    const { context, respond } = createContext('request-patch-reject');
    await controller.present(context);

    controller.cancelRun('run-1');
    await vi.waitFor(() => expect(sendFallback).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith(
      'question card finalization',
      expect.any(Error),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('已取消'),
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it('contains a rejected terminal fallback without leaking a rejection', async () => {
    const { controller, onError, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    sendFallback.mockRejectedValue(new Error('fallback failed'));
    const { context } = createContext('request-fallback-reject');
    await controller.present(context);

    controller.cancelRun('run-1');
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        'question terminal fallback delivery',
        expect.any(Error),
      );
    });
    expect(onError).toHaveBeenCalledWith(
      'question card finalization',
      expect.any(Error),
    );
  });

  it('includes submitted answers in the patch-failure fallback', async () => {
    const { controller, patchCard, sendFallback } = createHarness();
    patchCard.mockResolvedValue(false);
    const { context, respond } = createContext('request-answer-fallback');
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-answer-fallback', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    await claimed.execute();

    expect(respond).toHaveBeenCalledWith({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
      answers: { '0': 'Beijing' },
    });
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('已提交'),
    );
    expect(sendFallback).toHaveBeenCalledWith(
      'oc_1',
      expect.stringContaining('Region: Beijing'),
    );
  });

  it('reports a rejected responder without reopening the request', async () => {
    const { controller, onError } = createHarness();
    const respond = vi.fn().mockResolvedValue(false);
    const { context } = createContext('request-rejected', { respond });
    await controller.present(context);
    const claimed = controller.claim(validCancel('request-rejected'));
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    await claimed.execute();

    expect(onError).toHaveBeenCalledWith(
      'question response',
      expect.any(Error),
    );
    expect(controller.claim(validCancel('request-rejected'))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
    // The failed respond must still release the session+owner scope.
    await expect(
      controller.present(createContext('request-after-reject').context),
    ).resolves.toEqual({ kind: 'presented' });
  });

  it('keeps concurrent sessions and owners independent', async () => {
    const { controller, sendCard } = createHarness();
    sendCard
      .mockResolvedValueOnce('om_one')
      .mockResolvedValueOnce('om_two')
      .mockResolvedValueOnce('om_three');
    const first = createContext('request-one');
    const second = createContext('request-two', {
      runId: 'run-2',
      owner: { kind: 'channel_user', id: 'owner-2' },
      target: {
        channelName: 'feishu',
        chatId: 'oc_2',
        senderId: 'owner-2',
        isGroup: true,
      },
    });
    const third = createContext('request-three', {
      runId: 'run-3',
      sessionId: 'session-2',
      target: {
        channelName: 'feishu',
        chatId: 'oc_3',
        senderId: 'owner-1',
        isGroup: true,
      },
    });
    await controller.present(first.context);
    await controller.present(second.context);
    await controller.present(third.context);

    const firstClaimed = controller.claim(
      validCancel('request-one', { messageId: 'om_one' }),
    );
    const secondClaimed = controller.claim(
      validCancel('request-two', {
        operatorId: 'owner-2',
        chatId: 'oc_2',
        messageId: 'om_two',
      }),
    );
    const thirdClaimed = controller.claim(
      validCancel('request-three', {
        chatId: 'oc_3',
        messageId: 'om_three',
      }),
    );
    expect(firstClaimed).toMatchObject({
      kind: 'handled',
      execute: expect.any(Function),
    });
    expect(secondClaimed).toMatchObject({
      kind: 'handled',
      execute: expect.any(Function),
    });
    expect(thirdClaimed).toMatchObject({
      kind: 'handled',
      execute: expect.any(Function),
    });

    // Executing one claimed callback must settle only its own request.
    if (thirdClaimed.kind !== 'handled' || !thirdClaimed.execute) {
      throw new Error('Expected claimed callback execution');
    }
    await thirdClaimed.execute();
    expect(third.respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();

    // A sibling claim must still settle its own request afterwards.
    if (firstClaimed.kind !== 'handled' || !firstClaimed.execute) {
      throw new Error('Expected claimed callback execution');
    }
    await firstClaimed.execute();
    expect(first.respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
    expect(second.respond).not.toHaveBeenCalled();
  });
});

describe('FeishuQuestionCardController terminal cleanup', () => {
  beforeEach(() => vi.useRealTimers());

  it('expires locally before cancelling the original request', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const { controller, patchCard, sendFallback } = createHarness(270_000);
    patchCard.mockImplementation(async () => {
      events.push('patch');
      return true;
    });
    const respond = vi.fn().mockImplementation(async () => {
      events.push('respond');
      return true;
    });
    const { context } = createContext('request-timeout', { respond });
    await controller.present(context);

    await vi.advanceTimersByTimeAsync(270_000);

    expect(events).toEqual(['patch', 'respond']);
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
    expect(sendFallback).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ outcome: { outcome: 'cancelled' } });
    expect(controller.claim(validCancel('request-timeout'))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
    expect(
      (controller as unknown as { byRequest: Map<string, unknown> }).byRequest
        .size,
    ).toBe(0);
    expect(
      (controller as unknown as { activeByScope: Map<string, unknown> })
        .activeByScope.size,
    ).toBe(0);
  });

  it('keeps the expiry timer alive after a malformed-form rejection', async () => {
    vi.useFakeTimers();
    try {
      const respond = vi.fn().mockResolvedValue(true);
      const { controller, patchCard } = createHarness(270_000);
      const { context } = createContext('request-malformed-expiry', {
        respond,
      });
      await controller.present(context);

      expect(
        controller.claim(
          submit('request-malformed-expiry', { '0': 'Unknown' }),
        ),
      ).toEqual({
        kind: 'handled',
        response: {
          toast: { type: 'warning', content: '请完整选择有效答案。' },
        },
      });

      await vi.advanceTimersByTimeAsync(270_000);

      expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
      expect(respond).toHaveBeenCalledWith({
        outcome: { outcome: 'cancelled' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels every live request for a run exactly once', async () => {
    const { controller, patchCard, sendCard } = createHarness();
    sendCard
      .mockResolvedValueOnce('om_one')
      .mockResolvedValueOnce('om_two')
      .mockResolvedValueOnce('om_three');
    const first = createContext('request-run-one');
    const second = createContext('request-run-two', {
      sessionId: 'session-2',
      owner: { kind: 'channel_user', id: 'owner-2' },
      target: {
        channelName: 'feishu',
        chatId: 'oc_2',
        senderId: 'owner-2',
        isGroup: true,
      },
    });
    const otherRun = createContext('request-run-other', {
      runId: 'run-2',
      sessionId: 'session-3',
      owner: { kind: 'channel_user', id: 'owner-3' },
      target: {
        channelName: 'feishu',
        chatId: 'oc_3',
        senderId: 'owner-3',
        isGroup: true,
      },
    });
    await controller.present(first.context);
    await controller.present(second.context);
    await controller.present(otherRun.context);

    controller.cancelRun('run-1');
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledTimes(2));
    controller.cancelRun('run-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCard).toHaveBeenCalledTimes(2);
    expect(patchCard).toHaveBeenCalledWith(
      'om_one',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(patchCard).toHaveBeenCalledWith(
      'om_two',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已取消');
    expect(JSON.stringify(patchCard.mock.calls[1]?.[1])).toContain('已取消');
    expect(
      controller.claim(
        validCancel('request-run-other', {
          operatorId: 'owner-3',
          chatId: 'oc_3',
          messageId: 'om_three',
        }),
      ),
    ).toMatchObject({ kind: 'handled', execute: expect.any(Function) });
    expect(
      controller.claim(validCancel('request-run-one', { messageId: 'om_one' })),
    ).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
    expect(
      controller.claim(
        validCancel('request-run-two', {
          operatorId: 'owner-2',
          chatId: 'oc_2',
          messageId: 'om_two',
        }),
      ),
    ).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('disposes live records and ignores settlement or callbacks afterwards', async () => {
    const { controller, patchCard } = createHarness();
    const { context, settle, respond } = createContext('request-dispose');
    await controller.present(context);

    controller.dispose();
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledTimes(1));
    settle('cancelled');

    expect(patchCard).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
    expect(controller.claim(validCancel('request-dispose'))).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('patches a terminal card after late delivery without reactivating it', async () => {
    const delivery = deferred<string>();
    const { controller, patchCard, sendCard } = createHarness();
    sendCard.mockReturnValue(delivery.promise);
    const { context, respond } = createContext('request-late');

    const presenting = controller.present(context);
    controller.cancelRun('run-1');
    delivery.resolve('om_late');

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(patchCard).toHaveBeenCalledWith(
      'om_late',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已取消');
    expect(respond).not.toHaveBeenCalled();
    expect(
      controller.claim(validCancel('request-late', { messageId: 'om_late' })),
    ).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('patches a terminal card when delivery lands across disposal', async () => {
    const delivery = deferred<string>();
    const { controller, patchCard, sendCard } = createHarness();
    sendCard.mockReturnValue(delivery.promise);
    const { context, respond } = createContext('request-dispose-late');

    const presenting = controller.present(context);
    controller.dispose();
    delivery.resolve('om_late');

    await expect(presenting).resolves.toEqual({ kind: 'presented' });
    expect(patchCard).toHaveBeenCalledWith(
      'om_late',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
    expect(respond).not.toHaveBeenCalled();
    expect(
      controller.claim(
        validCancel('request-dispose-late', { messageId: 'om_late' }),
      ),
    ).toEqual({
      kind: 'handled',
      response: {
        toast: { type: 'warning', content: '该问题已过期或已处理。' },
      },
    });
  });

  it('ignores a claimed callback execution after disposal', async () => {
    const { controller, patchCard } = createHarness();
    const { context, respond } = createContext('request-claimed-dispose');
    await controller.present(context);
    const claimed = controller.claim(validCancel('request-claimed-dispose'));
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    controller.dispose();
    await Promise.resolve();
    await claimed.execute();

    expect(respond).not.toHaveBeenCalled();
    // The callback response already delivered the terminal cancel card; the
    // dispose-time expiry terminalization must not re-patch it.
    expect(patchCard).not.toHaveBeenCalled();
  });

  it('terminalizes a claimed callback settled before execute starts', async () => {
    const { controller, patchCard } = createHarness();
    const { context, respond, settle } = createContext(
      'request-claimed-settled',
    );
    await controller.present(context);
    const claimed = controller.claim(validCancel('request-claimed-settled'));
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    settle('run_cancelled');
    await Promise.resolve();
    await claimed.execute();

    expect(respond).not.toHaveBeenCalled();
    // The callback response already delivered the terminal card; settlement
    // and the late execute must not re-patch it.
    expect(patchCard).not.toHaveBeenCalled();
  });

  it('absorbs the settlement echo of an in-flight accepted response', async () => {
    const response = deferred<boolean>();
    const respond = vi.fn().mockReturnValue(response.promise);
    const { controller, patchCard } = createHarness();
    const { context, settle } = createContext('request-echo', { respond });
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-echo', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    const executing = claimed.execute();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());

    // ChannelBase settles the request in the same turn that accepts the
    // controller's own response; the echo must not terminalize the record.
    settle('resolved_outside_presenter');
    await Promise.resolve();
    await Promise.resolve();

    expect(patchCard).not.toHaveBeenCalled();
    expect(
      (controller as unknown as { byRequest: Map<string, unknown> }).byRequest
        .size,
    ).toBe(1);

    response.resolve(true);
    await executing;

    expect(patchCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已提交');
  });

  it('lets an accepted in-flight submission override run cancellation', async () => {
    const response = deferred<boolean>();
    const cancelledPatch = deferred<boolean>();
    const respond = vi.fn().mockReturnValue(response.promise);
    const { controller, patchCard } = createHarness();
    patchCard
      .mockReturnValueOnce(cancelledPatch.promise)
      .mockResolvedValueOnce(true);
    const { context } = createContext('request-in-flight', { respond });
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-in-flight', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    const executing = claimed.execute();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    controller.cancelRun('run-1');
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledOnce());
    response.resolve(true);
    await Promise.resolve();
    expect(patchCard).toHaveBeenCalledTimes(1);
    cancelledPatch.resolve(true);
    await executing;

    expect(patchCard).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(patchCard.mock.calls.at(-1)?.[1])).toContain(
      '已提交',
    );
  });

  it('keeps the run-cancelled label when an in-flight response settles not-accepted', async () => {
    const response = deferred<boolean>();
    const respond = vi.fn().mockReturnValue(response.promise);
    const { controller, onError, patchCard } = createHarness();
    const { context } = createContext('request-race-expiry', { respond });
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-race-expiry', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    const executing = claimed.execute();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    controller.cancelRun('run-1');
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledOnce());
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已取消');

    // Run cancellation also settles the pending permission, so the in-flight
    // response resolves not-accepted; the 已取消 card must hold.
    response.resolve(false);
    await executing;

    expect(patchCard).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'question response',
      expect.any(Error),
    );
  });

  it('cleans an in-flight record on dispose and ignores its late projection', async () => {
    const response = deferred<boolean>();
    const respond = vi.fn().mockReturnValue(response.promise);
    const { controller, patchCard } = createHarness();
    const { context } = createContext('request-in-flight-dispose', { respond });
    await controller.present(context);
    const claimed = controller.claim(
      submit('request-in-flight-dispose', { '0': 'Beijing' }),
    );
    if (claimed.kind !== 'handled' || !claimed.execute) {
      throw new Error('Expected claimed callback execution');
    }

    const executing = claimed.execute();
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    controller.dispose();
    await vi.waitFor(() => expect(patchCard).toHaveBeenCalledOnce());
    await expect(
      controller.present(createContext('replacement').context),
    ).resolves.toEqual({ kind: 'unsupported' });
    response.resolve(true);
    await executing;

    expect(patchCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(patchCard.mock.calls[0]?.[1])).toContain('已过期');
  });
});

function validCancel(
  requestId = 'request-1',
  options: { operatorId?: string; chatId?: string; messageId?: string } = {},
) {
  const operatorId = Object.hasOwn(options, 'operatorId')
    ? options.operatorId
    : 'owner-1';
  const chatId = Object.hasOwn(options, 'chatId') ? options.chatId : 'oc_1';
  const messageId = Object.hasOwn(options, 'messageId')
    ? options.messageId
    : 'om_1';
  return {
    ...(operatorId ? { operator: { open_id: operatorId } } : {}),
    ...(chatId || messageId
      ? {
          context: {
            ...(chatId ? { open_chat_id: chatId } : {}),
            ...(messageId ? { open_message_id: messageId } : {}),
          },
        }
      : {}),
    action: {
      name: `qwen_ask_cancel_${requestId}`,
      value: { action: 'qwen_ask_cancel', operation_id: requestId },
    },
  };
}

function submit(
  requestId: string,
  formValue: Record<string, unknown>,
  options: { operatorId?: string; chatId?: string; messageId?: string } = {},
) {
  const operatorId = Object.hasOwn(options, 'operatorId')
    ? options.operatorId
    : 'owner-1';
  const chatId = Object.hasOwn(options, 'chatId') ? options.chatId : 'oc_1';
  const messageId = Object.hasOwn(options, 'messageId')
    ? options.messageId
    : 'om_1';
  return {
    ...(operatorId ? { operator: { open_id: operatorId } } : {}),
    ...(chatId || messageId
      ? {
          context: {
            ...(chatId ? { open_chat_id: chatId } : {}),
            ...(messageId ? { open_message_id: messageId } : {}),
          },
        }
      : {}),
    action: {
      name: `qwen_ask_submit_${requestId}`,
      value: { action: 'qwen_ask_submit', operation_id: requestId },
      form_value: formValue,
    },
  };
}
