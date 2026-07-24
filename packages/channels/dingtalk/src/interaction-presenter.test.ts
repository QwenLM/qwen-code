import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelOutputSegmentContext,
  ChannelUserInputRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import {
  QUESTION_CARD_TEMPLATE_ID,
  STATUS_CARD_TEMPLATE_ID,
  type DingtalkInteractiveCardClient,
} from './interactive-card-client.js';
import { DingtalkInteractionPresenter } from './interaction-presenter.js';
import { QuestionCardController } from './question-card-controller.js';
import { StatusCardController } from './status-card-controller.js';

const target = { chatId: 'cid-1', isGroup: true };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function segment(
  segmentId: string,
  overrides: Partial<ChannelOutputSegmentContext> = {},
): ChannelOutputSegmentContext {
  return {
    channelName: 'dingtalk',
    sessionId: 'session-1',
    runId: 'run-1',
    segmentId,
    owner: { kind: 'channel_user', id: 'owner-1' },
    target: {
      channelName: 'dingtalk',
      chatId: 'cid-1',
      senderId: 'owner-1',
      isGroup: true,
    },
    ...overrides,
  };
}

function questionContext(
  precedingSegmentId?: string,
): ChannelUserInputRequestContext {
  const listeners = new Set<(reason: UserInputSettlementReason) => void>();
  return {
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
    precedingSegmentId,
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
    ],
    submitOptionId: 'proceed_once',
    onSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond: vi.fn().mockResolvedValue(true),
  };
}

function createHarness() {
  const projectionOrder: string[] = [];
  const client = {
    createAndDeliver: vi.fn().mockImplementation(async (request) => {
      projectionOrder.push(
        request.templateId === STATUS_CARD_TEMPLATE_ID
          ? 'create:status'
          : 'create:question',
      );
    }),
    openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
    updateInstance: vi.fn().mockImplementation(async (request) => {
      if (request.cardParamMap.statusLine === 'Completed') {
        projectionOrder.push('finalize:segment-1');
      }
      if (request.cardParamMap.card_status === 'submitted') {
        projectionOrder.push('update:question:submitted');
      }
    }),
  } as unknown as DingtalkInteractiveCardClient;
  const statusCards = new StatusCardController({
    client,
    cancelRun: vi.fn().mockResolvedValue(true),
  });
  const presenterRef: { current?: DingtalkInteractionPresenter } = {};
  const sendFallback = vi.fn().mockResolvedValue(undefined);
  const questionCards = new QuestionCardController({
    client,
    timeoutMs: 300_000,
    sendFallback,
    reserveRunProjection: (runId) =>
      presenterRef.current?.reserveProjection(runId),
  });
  const presenter = new DingtalkInteractionPresenter({
    statusCards,
    questionCards,
    sendFallback,
  });
  presenterRef.current = presenter;
  presenter.registerRun('run-1', 'owner-1', target);
  return {
    client,
    presenter,
    projectionOrder,
    questionCards,
    sendFallback,
  };
}

describe('DingtalkInteractionPresenter', () => {
  it('presents a direct question without creating a status card', async () => {
    const { client, presenter } = createHarness();

    await expect(presenter.presentInput(questionContext())).resolves.toEqual({
      kind: 'presented',
    });

    expect(
      vi
        .mocked(client.createAndDeliver)
        .mock.calls.map(([request]) => request.templateId),
    ).toEqual([QUESTION_CARD_TEMPLATE_ID]);
  });

  it('correlates direct runs by conversation and delivers cards to the user', async () => {
    const { client, presenter } = createHarness();
    presenter.registerRun('run-1', 'owner-1', {
      chatId: 'conversation-1',
      isGroup: false,
    });
    const context = questionContext();
    context.target = {
      channelName: 'dingtalk',
      chatId: 'conversation-1',
      senderId: 'owner-1',
      isGroup: false,
    };

    await expect(presenter.presentInput(context)).resolves.toEqual({
      kind: 'presented',
    });

    expect(client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { chatId: 'owner-1', isGroup: false },
      }),
    );
  });

  it('delivers direct output cards to the user after conversation correlation', async () => {
    const { client, presenter } = createHarness();
    presenter.registerRun('run-1', 'owner-1', {
      chatId: 'conversation-1',
      isGroup: false,
    });
    presenter.appendOutput(
      segment('segment-1', {
        target: {
          channelName: 'dingtalk',
          chatId: 'conversation-1',
          senderId: 'owner-1',
          isGroup: false,
        },
      }),
      'Explanation',
    );

    await vi.waitFor(() => {
      expect(client.createAndDeliver).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { chatId: 'owner-1', isGroup: false },
        }),
      );
    });
  });

  it('does not create a status card when direct question delivery fails', async () => {
    const { client, presenter } = createHarness();
    vi.mocked(client.createAndDeliver).mockRejectedValueOnce(
      new Error('question template unavailable'),
    );
    const context = questionContext();

    await expect(presenter.presentInput(context)).resolves.toEqual({
      kind: 'handled',
    });

    expect(
      vi
        .mocked(client.createAndDeliver)
        .mock.calls.map(([request]) => request.templateId),
    ).toEqual([QUESTION_CARD_TEMPLATE_ID]);
    expect(context.respond).toHaveBeenCalledOnce();
    expect(context.respond).toHaveBeenCalledWith({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('finishes preceding output before creating the question card', async () => {
    const { presenter, projectionOrder } = createHarness();
    presenter.appendOutput(segment('segment-1'), 'Explanation');

    await presenter.closeOutput('segment-1', '', 'input_requested');
    await presenter.presentInput(questionContext('segment-1'));

    expect(projectionOrder).toEqual([
      'create:status',
      'finalize:segment-1',
      'create:question',
    ]);
  });

  it('falls back to text before presenting a question when output finalization fails', async () => {
    const { client, presenter, sendFallback } = createHarness();
    vi.mocked(client.createAndDeliver).mockImplementation(async (request) => {
      if (request.templateId === STATUS_CARD_TEMPLATE_ID) {
        throw new Error('status template unavailable');
      }
    });
    presenter.appendOutput(segment('segment-1'), 'Explanation');

    await expect(
      presenter.closeOutput('segment-1', '', 'input_requested'),
    ).resolves.toBe(true);
    await presenter.presentInput(questionContext('segment-1'));

    expect(sendFallback).toHaveBeenCalledWith(
      'cid-1',
      'Explanation',
      'session-1',
    );
    expect(client.createAndDeliver).toHaveBeenLastCalledWith(
      expect.objectContaining({ templateId: QUESTION_CARD_TEMPLATE_ID }),
    );
  });

  it('surfaces a failed text fallback to the shared delivery boundary', async () => {
    const { client, presenter, sendFallback } = createHarness();
    vi.mocked(client.createAndDeliver).mockImplementation(async (request) => {
      if (request.templateId === STATUS_CARD_TEMPLATE_ID) {
        throw new Error('status template unavailable');
      }
    });
    sendFallback.mockRejectedValueOnce(new Error('fallback unavailable'));
    presenter.appendOutput(segment('segment-1'), 'Explanation');

    await expect(
      presenter.closeOutput('segment-1', '', 'input_requested'),
    ).rejects.toThrow('fallback unavailable');
  });

  it('does not merge a colliding segment id from another run', async () => {
    const { client, presenter } = createHarness();
    presenter.registerRun('run-2', 'owner-2', target);
    presenter.appendOutput(segment('segment-1'), 'first');
    presenter.appendOutput(
      segment('segment-1', {
        runId: 'run-2',
        owner: { kind: 'channel_user', id: 'owner-2' },
      }),
      'foreign',
    );

    await presenter.closeOutput('segment-1', '', 'completed');

    expect(client.updateInstance).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cardParamMap: expect.objectContaining({
          content: 'first',
        }),
      }),
    );
  });

  it('creates a new status card after the question is submitted', async () => {
    const { client, presenter, projectionOrder, questionCards } =
      createHarness();
    presenter.appendOutput(segment('segment-1'), 'Explanation');
    await presenter.closeOutput('segment-1', '', 'input_requested');
    await presenter.presentInput(questionContext('segment-1'));
    const questionOutTrackId = vi
      .mocked(client.createAndDeliver)
      .mock.calls.find(
        ([request]) => request.templateId === QUESTION_CARD_TEMPLATE_ID,
      )![0].outTrackId;

    await questionCards.claim({
      outTrackId: questionOutTrackId,
      actionId: 'submit',
      ownerId: 'owner-1',
      formData: { '0': 'Beijing' },
    })?.();
    presenter.appendOutput(segment('segment-2'), 'Continuation');

    await vi.waitFor(() => {
      const statusOutTrackIds = vi
        .mocked(client.createAndDeliver)
        .mock.calls.filter(
          ([request]) => request.templateId === STATUS_CARD_TEMPLATE_ID,
        )
        .map(([request]) => request.outTrackId);
      expect(new Set(statusOutTrackIds).size).toBe(2);
    });
    expect(projectionOrder.indexOf('update:question:submitted')).toBeLessThan(
      projectionOrder.lastIndexOf('create:status'),
    );
  });

  it('does not create continuation output before the question terminal update finishes', async () => {
    const { client, presenter, projectionOrder, questionCards } =
      createHarness();
    presenter.appendOutput(segment('segment-1'), 'Explanation');
    await presenter.closeOutput('segment-1', '', 'input_requested');
    await presenter.presentInput(questionContext('segment-1'));
    const questionOutTrackId = vi
      .mocked(client.createAndDeliver)
      .mock.calls.find(
        ([request]) => request.templateId === QUESTION_CARD_TEMPLATE_ID,
      )![0].outTrackId;
    const terminalUpdate = deferred<void>();
    vi.mocked(client.updateInstance).mockImplementation(async (request) => {
      if (request.cardParamMap.card_status === 'submitted') {
        projectionOrder.push('update:question:submitted');
        await terminalUpdate.promise;
      }
    });

    const response = questionCards.claim({
      outTrackId: questionOutTrackId,
      actionId: 'submit',
      ownerId: 'owner-1',
      formData: { '0': 'Beijing' },
    })?.();
    await vi.waitFor(() =>
      expect(projectionOrder).toContain('update:question:submitted'),
    );
    presenter.appendOutput(segment('segment-2'), 'Continuation');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      vi
        .mocked(client.createAndDeliver)
        .mock.calls.filter(
          ([request]) => request.templateId === STATUS_CARD_TEMPLATE_ID,
        ),
    ).toHaveLength(1);

    terminalUpdate.resolve();
    await response;
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(client.createAndDeliver)
          .mock.calls.filter(
            ([request]) => request.templateId === STATUS_CARD_TEMPLATE_ID,
          ),
      ).toHaveLength(2),
    );
  });
});
