// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { cleanupReact, flushReact } from '../../test/reactHarness';
import type { SessionChatController } from '../../chat-core/contract';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import { javaSessionPayload } from './managed-agent-sse.test-fixtures';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { pendingQuestion } from './managed-question.test-fixtures';
import { useManagedChatController } from './use-managed-chat-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function summary(sessionId: string): ManagedAgentSessionSummary {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    activeTurnId: 'turn-1',
    phase: 'agent_running',
    createdAt: 1,
    admittedAt: 1,
    updatedAt: 1,
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: {
      canSend: true,
      canCancel: true,
      actions: true,
    },
  };
}

function event(
  id: number,
  sessionId: string,
  type: ManagedAgentSessionEvent['type'] = 'assistant_delta',
): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type,
    sessionId,
    turnId: 'turn-1',
    data: {
      text: `message-${id}`,
      actionId: 'tool_approval_question',
      state: 'requested',
    },
  };
}

function stream() {
  let id = 0;
  const next = new Map<number, (value: ManagedAgentSessionEvent) => void>();
  return {
    async *subscribe(
      signal: AbortSignal,
    ): AsyncGenerator<ManagedAgentSessionEvent> {
      for (;;) {
        if (signal.aborted) return;
        const release = deferred<ManagedAgentSessionEvent | undefined>();
        next.set(id, (value) => release.resolve(value));
        const stop = () => release.resolve(undefined);
        signal.addEventListener('abort', stop, { once: true });
        const received = await release.promise;
        signal.removeEventListener('abort', stop);
        if (received === undefined || signal.aborted) return;
        yield received;
        id++;
      }
    },
    push(value: ManagedAgentSessionEvent) {
      const slot = next.get(id);
      expect(slot).toBeDefined();
      slot!(value);
      next.delete(id);
    },
  };
}

describe('useManagedChatController', () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    cleanupReact();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  function mount(
    initial: {
      clientId?: string;
      sessionId?: string;
      pending?: readonly ManagedAgentPendingAction[];
    } = {},
  ) {
    const feed = stream();
    let pending = initial.pending ?? [];
    const getSession = vi.fn(async (id: string) => summary(id));
    const submitPrompt = vi.fn<ManagedAgentProvider['submitPrompt']>(
      async (sessionId) => ({
        sessionId,
        turnId: 'turn-1',
        operationId: 'prompt-1',
      }),
    );
    const respond = vi.fn<
      NonNullable<ManagedAgentProvider['actions']>['respond']
    >(async (action, _response, options) => {
      options.onAccepted?.({
        operationId: 'answer-1',
        sessionId: action.sessionId,
      });
      options.onSettlement?.({
        operationId: 'answer-1',
        sessionId: action.sessionId,
        status: 'completed',
      });
    });
    const provider = {
      storageKey: 'fixture:client',
      getSession,
      getTranscript: vi.fn(async () => ({ events: [], lastEventId: 0 })),
      subscribeEvents: vi.fn(
        (_sessionId: string, options: { signal: AbortSignal }) =>
          feed.subscribe(options.signal),
      ),
      submitPrompt,
      cancel: vi.fn(async (sessionId: string, turnId: string) => ({
        sessionId,
        turnId,
        operationId: 'cancel-1',
      })),
      queryCancelOperation: vi.fn(async (sessionId: string) => ({
        sessionId,
        operationId: 'cancel-1',
        type: 'cancel',
        status: 'completed',
        admissionStage: 'java_durable',
        deliveryState: 'confirmed',
        replayed: false,
      })),
      actions: {
        listPending: vi.fn(async (sessionId: string) =>
          pending.filter((action) => action.sessionId === sessionId),
        ),
        get respond() {
          return respond;
        },
      },
    } as unknown as ManagedAgentProvider;
    let controller: SessionChatController | undefined;
    let props = {
      provider,
      clientId: initial.clientId ?? 'client-1',
      sessionId: initial.sessionId ?? 'session-1',
    };
    function Probe(current: typeof props) {
      controller = useManagedChatController(current);
      return null;
    }
    root = createRoot(document.createElement('div'));
    const render = (next: Partial<typeof props> = {}) => {
      props = { ...props, ...next };
      return act(async () => {
        root!.render(
          <I18nProvider language="en">
            <Probe {...props} />
          </I18nProvider>,
        );
        await Promise.resolve();
      });
    };
    return {
      provider,
      submitPrompt,
      get controller() {
        return controller;
      },
      render,
      emit: feed.push,
      get pending() {
        return pending;
      },
      setPending(next: readonly ManagedAgentPendingAction[]) {
        pending = next;
      },
    };
  }

  it('keeps one controller across ordinary updates and preserves question identity for expiry-only changes', async () => {
    const action = pendingQuestion();
    const h = mount({ pending: [action] });
    await h.render();
    await flushReact();
    const controller = h.controller!;
    expect(h.controller!.pendingQuestions).toHaveLength(1);
    const rawInput = h.controller!.pendingQuestions[0]!.request.rawInput;
    const request = h.controller!.pendingQuestions[0]!.request;

    h.setPending([{ ...action, expiresAt: action.expiresAt + 60_000 }]);
    await act(async () => h.emit(event(2, action.sessionId, 'action_updated')));
    await flushReact();
    expect(h.controller).toBe(controller);
    expect(h.controller!.pendingQuestions[0]!.request.rawInput).toBe(rawInput);
    expect(h.controller!.pendingQuestions[0]!.request).toBe(request);
  });

  it('binds a pre-admission turn result to the matching pending submission and encodes attachments', async () => {
    const h = mount();
    await h.render();
    const controller = h.controller!;
    await flushReact();
    const submission = deferred<{
      sessionId: string;
      turnId: string;
      operationId: string;
    }>();
    vi.mocked(h.provider.submitPrompt).mockReturnValue(submission.promise);
    const png = btoa('\x89PNG\r\n\x1a\n');
    const arrayBuffer = vi.fn(
      async () => new TextEncoder().encode('notes').buffer,
    );
    const promise = controller.submit({
      text: 'Review',
      images: [{ data: png, media_type: 'image/png' }],
      files: [
        {
          name: 'notes.md',
          media_type: 'text/markdown',
          data: { size: 16, arrayBuffer } as Blob,
        },
      ],
    });
    await flushReact();
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.submitPrompt.mock.calls[0]?.[1]).toEqual({
      text: 'Review',
      input: [
        { type: 'input_text', text: 'Review' },
        {
          type: 'input_file',
          name: 'notes.md',
          mime_type: 'text/markdown',
          text: 'notes',
        },
        { type: 'input_image', mime_type: 'image/png', data: png },
      ],
    });
    expect(h.submitPrompt.mock.calls[0]?.[2].idempotencyKey).toMatch(
      /^managed_/,
    );

    await act(async () => h.emit(event(2, 'session-1', 'completed')));
    await flushReact();
    expect(controller.operations[0]?.state).toBe('pending');
    submission.resolve({
      sessionId: 'session-1',
      turnId: 'turn-1',
      operationId: 'prompt-1',
    });
    const result = await promise;
    expect(result).toEqual({
      admission: 'accepted',
      outcome: 'established',
      target: { sessionId: 'session-1' },
    });
  });

  it.each([409, 503])(
    'classifies submit transport failures as unaccepted or unknown (%s)',
    async (status) => {
      const h = mount();
      await h.render();
      await flushReact();
      vi.mocked(h.provider.submitPrompt).mockRejectedValue(
        Object.assign(new Error(`status ${status}`), { status }),
      );
      const result = await h.controller!.submit({ text: 'uncertain' });
      expect(result.admission).toBe(status === 409 ? 'rejected' : 'unknown');
      expect(h.controller!.operations).toEqual([]);
    },
  );

  it('preserves structured question fields and keeps late operation failure distinct from fulfilment', async () => {
    const action = pendingQuestion();
    const h = mount({ pending: [action] });
    await h.render();
    await flushReact();
    const finish = deferred<void>();
    let options:
      | Parameters<NonNullable<ManagedAgentProvider['actions']>['respond']>[2]
      | undefined;
    vi.mocked(h.provider.actions!.respond).mockImplementation(
      async (_action, _answers, command) => {
        options = command;
        command.onAccepted?.({
          operationId: 'answer-1',
          sessionId: action.sessionId,
        });
        await finish.promise;
      },
    );
    const promise = h.controller!.respondQuestion(action.actionId, [
      { questionId: 'q1', value: '', optionIds: ['q1o2'] },
      {
        questionId: 'q2',
        value: '',
        optionIds: ['q2o1'],
        text: 'Separate text, kept',
      },
    ]);
    await flushReact();
    const accepted = await promise;
    expect(accepted.outcome).toBe('unsettled');
    expect(h.provider.actions!.respond).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: action.actionId }),
      {
        kind: 'question',
        answers: [
          { questionId: 'q1', optionIds: ['q1o2'] },
          {
            questionId: 'q2',
            optionIds: ['q2o1'],
            text: 'Separate text, kept',
          },
        ],
      },
      expect.objectContaining({
        clientId: 'client-1',
      }),
    );
    expect(options!.idempotencyKey).toMatch(/^question:/);
    await act(async () => {
      options!.onSettlement?.({
        operationId: 'answer-1',
        sessionId: action.sessionId,
        status: 'failed',
      });
      finish.resolve();
    });
    expect(h.controller!.operations[0]?.state).toBe('failed');
  });

  it('does not regard a fulfilled provider without observation as accepted', async () => {
    const action = pendingQuestion();
    const h = mount({ pending: [action] });
    await h.render();
    await flushReact();
    vi.mocked(h.provider.actions!.respond).mockResolvedValue(undefined);
    const result = await h.controller!.respondQuestion(action.actionId, [
      { questionId: 'q1', value: '', optionIds: ['q1o2'] },
      { questionId: 'q2', value: '', optionIds: ['q2o1'] },
    ]);
    expect(result.admission).toBe('unknown');
  });

  it('captures cancellation for the original turn and preserves native terminal outcomes', async () => {
    const h = mount();
    await h.render();
    await flushReact();
    const result = await act(async () => h.controller!.cancel());
    await flushReact();
    expect(result.admission).toBe('accepted');
    expect(result.outcome).toBe('unsettled');
    expect(h.controller!.operations.at(-1)?.state).toBe('established');
    expect(h.provider.cancel).toHaveBeenCalledWith(
      'session-1',
      'turn-1',
      expect.objectContaining({ clientId: 'client-1' }),
    );
  });

  it('maps cancel recovery_blocked to unsettled rather than established', async () => {
    const h = mount();
    vi.mocked(h.provider.cancel).mockResolvedValue({
      sessionId: 'session-1',
      turnId: 'turn-1',
      operationId: 'cancel-blocked',
    });
    vi.mocked(h.provider.queryCancelOperation).mockResolvedValue({
      sessionId: 'session-1',
      operationId: 'cancel-blocked',
      type: 'cancel',
      status: 'recovery_blocked',
      admissionStage: 'java_durable',
      deliveryState: 'confirmed',
      replayed: false,
    });
    await h.render();
    await flushReact();
    const blocked = await act(async () => h.controller!.cancel());
    await flushReact();
    expect(blocked.admission).toBe('accepted');
    expect(h.controller!.operations).toEqual([
      expect.objectContaining({
        kind: 'cancel',
        state: 'unsettled',
      }),
    ]);
  });

  it('separates owners and discards late responses after an owner switch', async () => {
    const action = pendingQuestion();
    const h = mount({ pending: [action] });
    await h.render();
    await flushReact();
    const original = h.controller!;
    const settle = deferred<void>();
    let lateObserver:
      | ((value: {
          operationId: string;
          sessionId: string;
          status: 'completed';
        }) => void)
      | undefined;
    vi.mocked(h.provider.actions!.respond).mockImplementation(
      async (_action, _answers, command) => {
        lateObserver = command.onSettlement;
        command.onAccepted?.({
          operationId: 'answer-1',
          sessionId: action.sessionId,
        });
        await settle.promise;
      },
    );
    await h.controller!.respondQuestion(action.actionId, [
      { questionId: 'q1', value: '', optionIds: ['q1o2'] },
      { questionId: 'q2', value: '', optionIds: ['q2o1'] },
    ]);
    await h.render({ sessionId: 'other' });
    await flushReact();
    expect(h.controller).not.toBe(original);
    expect(h.controller!.sessionId).toBe('other');
    lateObserver?.({
      operationId: 'answer-1',
      sessionId: 'session-1',
      status: 'completed',
    });
    settle.resolve();
    expect(h.controller!.operations).toEqual([]);

    const second = h.controller;
    await h.render({ clientId: 'client-other' });
    expect(h.controller).not.toBe(second);
  });

  it('enforces canSend and canCancel without dispatching disabled commands', async () => {
    const h = mount();
    vi.mocked(h.provider.getSession).mockResolvedValue({
      ...summary('session-1'),
      capabilities: { canSend: false, canCancel: false, actions: true },
    });
    await h.render();
    await flushReact();
    const submitResult = await h.controller!.submit({ text: 'denied' });
    expect(submitResult.admission).toBe('rejected');
    expect(h.submitPrompt).not.toHaveBeenCalled();

    const cancelResult = await h.controller!.cancel();
    expect(cancelResult.admission).toBe('rejected');
    expect(h.provider.cancel).not.toHaveBeenCalled();
  });

  it('rejects locally invalid input before dispatching submitPrompt', async () => {
    const h = mount();
    await h.render();
    await flushReact();
    const result = await h.controller!.submit({
      text: 'bad image',
      images: [{ data: btoa('not-a-png'), media_type: 'image/png' }],
    });
    expect(result.admission).toBe('rejected');
    expect(h.submitPrompt).not.toHaveBeenCalled();
  });

  it('returns undefined when no sessionId or matching summary is available', async () => {
    const h = mount({ sessionId: undefined });
    await h.render({ sessionId: undefined });
    await flushReact();
    expect(h.controller).toBeUndefined();
  });

  it('wires a real createJavaManagedAgentProvider over mocked HTTP for structured question admission and settlement', async () => {
    vi.useFakeTimers();
    try {
      const question = pendingQuestion();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      const sessionBody = {
        ...JSON.parse(javaSessionPayload(0)),
        capabilities: { actions: true, tasks: true, artifacts: false },
      };
      const recordedBodies: Array<{ path: string; body: unknown }> = [];
      let operationPoll = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        const path = url.replace(
          'https://product.example/api/agent/web-shell/v1',
          '',
        );
        const body =
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        recordedBodies.push({ path, body });
        if (path === '/sessions/get') {
          return json(sessionBody);
        }
        if (
          path === '/transcript/query' ||
          path === '/transcript/items/query'
        ) {
          return json({
            sessionId: question.sessionId,
            events: [],
            items: [],
            coveredSequence: 0,
            hasMore: false,
            lastSequence: 0,
          });
        }
        if (path === '/events/stream') {
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () => {
                  try {
                    controller.close();
                  } catch {
                    // already closed
                  }
                });
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        }
        if (path === '/actions/query') {
          return json({
            data: [
              {
                ...question,
                source: { kind: 'tool_call', id: question.functionCallId },
                state: 'requested',
                createdAt: 1,
              },
            ],
            hasMore: false,
          });
        }
        if (path === '/actions/respond') {
          return json({
            operationId: 'op-real-q-1',
            sessionId: question.sessionId,
            type: 'action_response',
            status: 'pending',
            admissionStage: 'java_durable',
            deliveryState: 'leased',
            replayed: false,
          });
        }
        if (path === '/operations/query') {
          operationPoll += 1;
          return json({
            operationId: 'op-real-q-1',
            sessionId: question.sessionId,
            type: 'action_response',
            status: operationPoll === 1 ? 'running' : 'completed',
            admissionStage: 'java_durable',
            deliveryState: operationPoll === 1 ? 'leased' : 'confirmed',
            replayed: false,
          });
        }
        throw new Error(`Unexpected mocked HTTP route: ${path}`);
      });

      const realProvider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: fetchImpl,
      });

      let controller: SessionChatController | undefined;
      function RealProbe() {
        controller = useManagedChatController({
          provider: realProvider,
          clientId: 'client-real',
          sessionId: question.sessionId,
        });
        return null;
      }
      root = createRoot(document.createElement('div'));
      await act(async () => {
        root!.render(
          <I18nProvider language="en">
            <RealProbe />
          </I18nProvider>,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(controller).toBeDefined();
      expect(controller!.pendingQuestions).toHaveLength(1);
      expect(controller!.capabilities.tasks).toBe(true);
      expect(controller!.capabilities.artifacts).toBe(false);

      const responsePromise = controller!.respondQuestion(question.actionId, [
        { questionId: 'q1', value: '', optionIds: ['q1o2'] },
        {
          questionId: 'q2',
          value: '',
          optionIds: ['q2o1'],
          text: 'Wire verified text',
        },
      ]);
      await act(async () => {
        await Promise.resolve();
      });
      const admitted = await responsePromise;
      expect(admitted).toEqual({
        admission: 'accepted',
        outcome: 'unsettled',
        target: { sessionId: 'session-1', requestId: question.actionId },
      });
      expect(controller!.operations[0]?.state).toBe('pending');

      const respondCall = recordedBodies.find(
        (entry) => entry.path === '/actions/respond',
      );
      expect(respondCall?.body).toEqual({
        requestId: expect.any(String),
        idempotencyKey: expect.stringMatching(/^question:/),
        sessionId: question.sessionId,
        actionId: question.actionId,
        response: {
          kind: 'question',
          inputRevision: question.inputRevision,
          policyRevision: question.policyRevision,
          answers: [
            { questionId: 'q1', optionIds: ['q1o2'] },
            {
              questionId: 'q2',
              optionIds: ['q2o1'],
              text: 'Wire verified text',
            },
          ],
        },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(operationPoll).toBeGreaterThanOrEqual(2);
      expect(controller!.operations[0]?.state).toBe('established');
    } finally {
      vi.useRealTimers();
    }
  });
});
