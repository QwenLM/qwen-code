import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelPermissionDecision,
  ChannelPermissionRequestContext,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';
import type { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import { QUESTION_CARD_TEMPLATE_ID } from './interactive-card-client.js';
import { PermissionCardController } from './permission-card-controller.js';

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

interface CallbackOptions {
  outTrackId?: string;
  actorId?: string;
  formData?: Record<string, unknown>;
  hasBusinessPayload?: boolean;
  isCancel?: boolean;
}

interface Harness {
  client: {
    createAndDeliver: ReturnType<typeof vi.fn>;
    updateInstance: ReturnType<typeof vi.fn>;
  };
  controller: PermissionCardController;
}

describe('PermissionCardController', () => {
  let listeners = new Set<(reason: UserInputSettlementReason) => void>();
  let respond: ReturnType<typeof vi.fn>;

  function createContext(
    requestId = 'request-1',
    options: {
      withAlways?: boolean;
      sourceLabel?: string;
    } = {},
  ): ChannelPermissionRequestContext {
    const decisions = [
      { kind: 'allow_once' as const, label: 'Allow' },
      ...(options.withAlways === false
        ? []
        : [
            {
              kind: 'allow_always' as const,
              label: 'Always Allow in project',
            },
          ]),
      { kind: 'deny' as const, label: 'Reject' },
    ];
    respond = vi.fn().mockResolvedValue(true);
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
      toolName: 'run_shell_command',
      title: 'Run a command',
      parameterSummary: 'command',
      decisions,
      ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
      onSettled(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      respond: (decision: ChannelPermissionDecision) => respond(decision),
    };
    return context;
  }

  function createHarness(timeoutMs = 300_000): Harness {
    const client = {
      createAndDeliver: vi.fn().mockResolvedValue(undefined),
      openOrUpdateStream: vi.fn().mockResolvedValue(undefined),
      updateInstance: vi.fn().mockResolvedValue(undefined),
    } as unknown as DingtalkInteractiveCardClient;
    const controller = new PermissionCardController({
      client,
      timeoutMs,
    });
    return {
      client: client as unknown as Harness['client'],
      controller,
    };
  }

  async function presentPending(
    harness: Harness,
    context: ChannelPermissionRequestContext,
  ): Promise<string> {
    await expect(
      harness.controller.present(context, { chatId: 'cid-1', isGroup: true }),
    ).resolves.toEqual({ kind: 'presented' });
    const call = harness.client.createAndDeliver.mock.calls[0]!;
    return (call[0] as { outTrackId: string }).outTrackId;
  }

  function callback(harness: Harness, options: CallbackOptions = {}) {
    const call = harness.client.createAndDeliver.mock.calls[0]!;
    const outTrackId =
      options.outTrackId ?? (call[0] as { outTrackId: string }).outTrackId;
    return {
      outTrackId,
      actionId: options.isCancel ? 'cancel' : 'submit',
      actorId: options.actorId ?? 'owner-1',
      formData: options.formData ?? {},
      ...(options.hasBusinessPayload !== undefined
        ? { hasBusinessPayload: options.hasBusinessPayload }
        : {}),
      ...(options.isCancel !== undefined ? { isCancel: options.isCancel } : {}),
    };
  }

  function settle(reason: UserInputSettlementReason): void {
    for (const listener of [...listeners]) listener(reason);
  }

  function deliveredCardData(harness: Harness): Record<string, unknown> {
    const call = harness.client.createAndDeliver.mock.calls[0]!;
    return (call[0] as { cardParamMap: Record<string, unknown> }).cardParamMap;
  }

  function finalCardData(harness: Harness, index = 0): Record<string, string> {
    const call = harness.client.updateInstance.mock.calls[index]!;
    return (call[0] as { cardParamMap: Record<string, string> }).cardParamMap;
  }

  beforeEach(() => {
    vi.useRealTimers();
    listeners = new Set();
  });

  it('renders one decision field with exactly the advertised decisions', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    const data = deliveredCardData(harness);
    expect(harness.client.createAndDeliver).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: QUESTION_CARD_TEMPLATE_ID }),
    );
    expect(data['question_title']).toBe('Permission required to run a tool');
    expect(data['question_desc']).toBe(
      'Tool: run_shell_command\nAction: Run a command\nParameters: command',
    );
    const form = data['form'] as {
      fields: Array<{
        name: string;
        type: string;
        required: boolean;
        options: Array<{ value: string }>;
      }>;
    };
    expect(form.fields).toHaveLength(1);
    expect(form.fields[0]!.name).toBe('permission_decision');
    expect(form.fields[0]!.required).toBe(true);
    expect(form.fields[0]!.options.map((option) => option.value)).toEqual([
      'Allow',
      'Always Allow in project',
      'Reject',
    ]);
  });

  it('hides the persistent-grant choice when the request does not offer it', async () => {
    const harness = createHarness();
    await presentPending(
      harness,
      createContext('request-2', { withAlways: false }),
    );

    const data = deliveredCardData(harness);
    const form = data['form'] as {
      fields: Array<{ options: Array<{ value: string }> }>;
    };
    expect(form.fields[0]!.options.map((option) => option.value)).toEqual([
      'Allow',
      'Reject',
    ]);
  });

  it('prefixes the card description with the source label', async () => {
    const harness = createHarness();
    await presentPending(
      harness,
      createContext('request-3', { sourceLabel: '[ci]' }),
    );

    expect(deliveredCardData(harness)['question_desc']).toBe(
      '\\[ci\\]\n\nTool: run_shell_command\nAction: Run a command\nParameters: command',
    );
  });

  it('settles allow-once exactly once and rejects duplicate callbacks', async () => {
    const harness = createHarness();
    const outTrackId = await presentPending(harness, createContext());

    const first = harness.controller.claim(
      callback(harness, { formData: { permission_decision: 'Allow' } }),
    );
    acceptedExecution(first)();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('allow_once');
    expect(finalCardData(harness)).toMatchObject({
      card_status: 'approved',
      form_btn_text: 'Approved',
    });

    const duplicate = harness.controller.claim(
      callback(harness, {
        outTrackId,
        formData: { permission_decision: 'Reject' },
      }),
    );
    expect(callbackResult(duplicate).kind).toBe('ignored');
    await Promise.resolve();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(harness.client.updateInstance).toHaveBeenCalledTimes(1);
  });

  it('settles the persistent grant with the advertised scope', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    acceptedExecution(
      harness.controller.claim(
        callback(harness, {
          formData: { permission_decision: 'Always Allow in project' },
        }),
      ),
    )();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(respond).toHaveBeenCalledWith('allow_always');
    expect(finalCardData(harness)).toMatchObject({ card_status: 'approved' });
  });

  it('settles deny through the card submit action', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    acceptedExecution(
      harness.controller.claim(
        callback(harness, { formData: { permission_decision: 'Reject' } }),
      ),
    )();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(respond).toHaveBeenCalledWith('deny');
    expect(finalCardData(harness)).toMatchObject({
      card_status: 'denied',
      form_btn_text: 'Denied',
    });
  });

  it('treats the card cancel action as a denial and a cancelled card', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    acceptedExecution(
      harness.controller.claim(callback(harness, { isCancel: true })),
    )();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(respond).toHaveBeenCalledWith('deny');
    expect(finalCardData(harness)).toMatchObject({
      card_status: 'cancelled',
      form_btn_text: 'Cancelled',
    });
  });

  it('rejects foreign actors without settling, then ignores repeats', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    const foreign = callbackResult(
      harness.controller.claim(
        callback(harness, {
          actorId: 'someone-else',
          formData: { permission_decision: 'Allow' },
        }),
      ),
    );
    expect(foreign.kind).toBe('forbidden');

    const repeat = callbackResult(
      harness.controller.claim(
        callback(harness, {
          actorId: 'someone-else',
          formData: { permission_decision: 'Allow' },
        }),
      ),
    );
    expect(repeat.kind).toBe('ignored');
    expect(respond).not.toHaveBeenCalled();
    expect(harness.client.updateInstance).not.toHaveBeenCalled();
  });

  it('ignores malformed submissions before the responder is called', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    for (const formData of [
      {},
      { permission_decision: '' },
      { permission_decision: 'not-a-decision' },
      { permission_decision: 'Allow', permission_decision_other: 'x' },
      { other_field: 'Allow' },
    ]) {
      const result = callbackResult(
        harness.controller.claim(callback(harness, { formData })),
      );
      expect(result.kind).toBe('ignored');
    }
    expect(respond).not.toHaveBeenCalled();
  });

  it('ignores callbacks without business payload or unknown actions', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    expect(
      callbackResult(
        harness.controller.claim(
          callback(harness, { hasBusinessPayload: false }),
        ),
      ).kind,
    ).toBe('ignored');
    const call = harness.client.createAndDeliver.mock.calls[0]!;
    const outTrackId = (call[0] as { outTrackId: string }).outTrackId;
    expect(
      callbackResult(
        harness.controller.claim({
          outTrackId,
          actionId: 'mystery',
          actorId: 'owner-1',
          formData: { permission_decision: 'Allow' },
        }),
      ).kind,
    ).toBe('ignored');
    expect(respond).not.toHaveBeenCalled();
  });

  it('expires and denies through the responder on timeout', async () => {
    vi.useFakeTimers();
    const harness = createHarness(1_000);
    await presentPending(harness, createContext());

    await vi.advanceTimersByTimeAsync(1_000);

    expect(respond).toHaveBeenCalledWith('deny');
    expect(finalCardData(harness)).toMatchObject({
      card_status: 'expired',
      form_btn_text: 'Expired',
    });

    const late = callbackResult(
      harness.controller.claim(
        callback(harness, { formData: { permission_decision: 'Allow' } }),
      ),
    );
    expect(late.kind).toBe('ignored');
    vi.useRealTimers();
  });

  it('falls back to the text permission path when delivery fails', async () => {
    const harness = createHarness();
    harness.client.createAndDeliver.mockRejectedValue(
      new Error('template unavailable'),
    );

    await expect(
      harness.controller.present(createContext(), {
        chatId: 'cid-1',
        isGroup: true,
      }),
    ).resolves.toEqual({ kind: 'unsupported' });

    expect(respond).not.toHaveBeenCalled();
    expect(harness.client.updateInstance).not.toHaveBeenCalled();
  });

  it('finalizes as expired when the responder rejects the response', async () => {
    const harness = createHarness();
    const context = createContext();
    respond.mockResolvedValue(false);
    await presentPending(harness, context);

    acceptedExecution(
      harness.controller.claim(
        callback(harness, { formData: { permission_decision: 'Allow' } }),
      ),
    )();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(finalCardData(harness)).toMatchObject({
      card_status: 'expired',
      question_desc: expect.stringContaining(
        'This permission request is no longer available.',
      ),
    });
  });

  it('finalizes as expired when the responder throws', async () => {
    const harness = createHarness();
    const context = createContext();
    respond.mockRejectedValue(new Error('bridge gone'));
    await presentPending(harness, context);

    await acceptedExecution(
      harness.controller.claim(
        callback(harness, { formData: { permission_decision: 'Allow' } }),
      ),
    )();
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(finalCardData(harness)).toMatchObject({ card_status: 'expired' });
  });

  it('moves the card to expired when resolved outside the card', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    settle('resolved_outside_presenter');
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(respond).not.toHaveBeenCalled();
    expect(finalCardData(harness)).toMatchObject({
      card_status: 'expired',
      question_desc: expect.stringContaining('Resolved outside this card.'),
    });
  });

  it('moves the card to cancelled when the run or request is cancelled', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext());

    settle('run_cancelled');
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalled(),
    );

    expect(finalCardData(harness)).toMatchObject({
      card_status: 'cancelled',
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it('never reactivates a card settled while delivery was in flight', async () => {
    const harness = createHarness();
    let releaseDelivery!: () => void;
    harness.client.createAndDeliver.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        }),
    );
    const context = createContext();
    const presentation = harness.controller.present(context, {
      chatId: 'cid-1',
      isGroup: true,
    });
    await vi.waitFor(() =>
      expect(harness.client.createAndDeliver).toHaveBeenCalled(),
    );

    settle('cancelled');
    releaseDelivery();
    await expect(presentation).resolves.toEqual({ kind: 'presented' });

    expect(finalCardData(harness)).toMatchObject({ card_status: 'cancelled' });
    expect(
      callbackResult(
        harness.controller.claim(
          callback(harness, { formData: { permission_decision: 'Allow' } }),
        ),
      ).kind,
    ).toBe('ignored');
    expect(respond).not.toHaveBeenCalled();
  });

  it('cancels every pending card of a terminal run', async () => {
    const harness = createHarness();
    await presentPending(harness, createContext('request-a'));
    await presentPending(harness, createContext('request-b'));

    harness.controller.cancelRun('run-1');
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalledTimes(2),
    );

    expect(finalCardData(harness, 0)).toMatchObject({
      card_status: 'cancelled',
    });
    expect(finalCardData(harness, 1)).toMatchObject({
      card_status: 'cancelled',
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it('keeps cards of other runs untouched by run cancellation', async () => {
    const harness = createHarness();
    const contextA = createContext('request-a');
    const contextB = { ...createContext('request-b'), runId: 'run-2' };
    await presentPending(harness, contextA);
    await presentPending(harness, contextB);

    harness.controller.cancelRun('run-1');
    await vi.waitFor(() =>
      expect(harness.client.updateInstance).toHaveBeenCalledTimes(1),
    );

    expect(finalCardData(harness, 0)).toMatchObject({
      card_status: 'cancelled',
    });
  });
});
