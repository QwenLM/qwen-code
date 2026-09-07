/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-turn regression tests (R2): the prompt reaches the client as a full
 * PartListUnion (multimodal included) and the per-turn modelOverride travels
 * through SendMessageOptions. Plus the two hops Batch 8 added: text drained at
 * a tool boundary is resolved like an idle submission (`@path` expansion under
 * a read deadline, with a queue restore when the turn dies mid-read), and an
 * image reaching the model goes through the prompt-side vision bridge.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  ApprovalMode,
  getUnsupportedImageFormatWarning,
  SendMessageType,
} from '@qwen-code/qwen-code-core';
import type {
  Config,
  ToolCallConfirmationDetails,
  VisionBridgeModelSelection,
} from '@qwen-code/qwen-code-core';
import {
  livePromptEvents,
  nextApprovalMode,
  resetPromptCountForTesting,
  selectAutoApprovals,
  STARTUP_CHAT_WAIT_MS,
  type WaitingCallInfo,
} from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { HandleAtCommandResult } from '../hooks/atCommandProcessor.js';
import { ToolCallStatus, type IndividualToolCallDisplay } from '../types.js';

// `runVisionBridge` is the one bridge collaborator that would reach a real
// provider, so it is recorded here; every other core export (including the
// bridge's gates and formatters) stays real.
const visionMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

// The round-trip tests also replace the tool scheduler with a stub that
// completes the pending calls immediately.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    runVisionBridge: (params: unknown) => visionMocks.run(params),
    CoreToolScheduler: class FakeScheduler {
      private readonly opts: {
        onAllToolCallsComplete: (calls: unknown[]) => unknown;
        onToolCallsUpdate?: (calls: unknown[]) => unknown;
        outputUpdateHandler?: (callId: string, chunk: unknown) => unknown;
      };
      constructor(opts: {
        onAllToolCallsComplete: (calls: unknown[]) => unknown;
        onToolCallsUpdate?: (calls: unknown[]) => unknown;
        outputUpdateHandler?: (callId: string, chunk: unknown) => unknown;
      }) {
        this.opts = opts;
      }
      async schedule(
        calls: Array<{ callId: string; name?: string; args?: unknown }>,
      ): Promise<void> {
        const bounce = calls.some(
          (c) =>
            (c.args as { __bounceApproval?: boolean } | undefined)
              ?.__bounceApproval,
        );
        if (bounce) {
          // PreToolUse 'ask' bounce shape: awaiting → executing → back to
          // awaiting_approval under the same callId with fresh details.
          const waiting = (title: string) =>
            calls.map((c) => ({
              status: 'awaiting_approval',
              request: c,
              confirmationDetails: {
                type: 'ask_user_question',
                title,
                questions: [],
                onConfirm: async () => {},
              },
            }));
          const executing = calls.map((c) => ({
            status: 'executing',
            request: c,
          }));
          await this.opts.onToolCallsUpdate?.(waiting('original'));
          await this.opts.onToolCallsUpdate?.(executing);
          await this.opts.onToolCallsUpdate?.(
            waiting('Hook requested confirmation to run'),
          );
        } else {
          // Emit one awaiting_approval update per call (twice, to prove the
          // live-session dedupe). A call with `__invocationDesc` args also
          // carries a scheduler-style invocation whose getDescription feeds
          // the tool-description event (R1-104).
          for (let i = 0; i < 2; i++) {
            await this.opts.onToolCallsUpdate?.(
              calls.map((c) => {
                const desc = ((c.args ?? {}) as { __invocationDesc?: string })
                  .__invocationDesc;
                return {
                  status: 'awaiting_approval',
                  request: c,
                  ...(desc
                    ? { invocation: { getDescription: () => desc } }
                    : {}),
                  confirmationDetails: {
                    type: 'ask_user_question',
                    title: '',
                    questions: [],
                    onConfirm: async () => {},
                  },
                };
              }),
            );
          }
        }
        // Live output bridge: one chunk per call before completion (the
        // shape is chosen by the individual tests via the call args).
        for (const c of calls) {
          const chunks = ((c.args ?? {}) as { __liveChunks?: unknown[] })
            .__liveChunks ?? ['live output\n'];
          for (const chunk of chunks) {
            this.opts.outputUpdateHandler?.(c.callId, chunk);
          }
        }
        await this.opts.onAllToolCallsComplete(
          calls.map((c) => ({
            request: {
              callId: c.callId,
              name: c.name ?? 'test_tool',
              args: c.args ?? {},
            },
            status: 'success',
            response: {
              responseParts: [
                {
                  functionResponse: {
                    name: c.name ?? 'test_tool',
                    id: c.callId,
                    response: { ok: true },
                  },
                },
              ],
              resultDisplay: 'done',
            },
          })),
        );
      }
    },
  };
});

// The `@`-mention expander reads files through Config; record the queries it
// receives and answer with the configured result. live-session owns the
// expansion (ink expands in processQuery / resolveSteeredMessages, never at the
// composer), so this is where the behaviour is pinned.
const atMocks = vi.hoisted(() => ({
  calls: [] as string[],
  result: {
    processedQuery: null,
    shouldProceed: true,
  } as HandleAtCommandResult,
  /**
   * Set to hang the expander forever — a read that ignores its signal. The hook
   * runs first, so a test can abort the turn from inside the read.
   */
  hang: null as (() => void) | null,
}));

vi.mock('../hooks/atCommandProcessor.js', () => ({
  handleAtCommand: async ({ query }: { query: string }) => {
    atMocks.calls.push(query);
    if (atMocks.hang) {
      atMocks.hang();
      return new Promise<HandleAtCommandResult>(() => {});
    }
    return atMocks.result;
  },
}));

function createFakeConfig(
  sendMessageStream: (...args: unknown[]) => unknown,
  bridgeModel?: VisionBridgeModelSelection,
  isInitialized: () => boolean = () => true,
) {
  return {
    initialize: vi.fn(async () => {}),
    getGeminiClient: () => ({
      sendMessageStream,
      isInitialized,
      // A chat the startup flight has already completed: `setTools()` ran, so
      // its declarations are in the generation config the send reads.
      getChat: () => ({
        getGenerationConfig: () => ({ tools: [{ functionDeclarations: [] }] }),
      }),
    }),
    getSessionId: () => 'session-1',
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
    getContentGeneratorConfig: () => ({ authType: 'qwen-oauth' }),
    // Pinning a bridge model is what turns `shouldRunVisionBridge` on; every
    // other test leaves it undefined and the prompt rides through untouched.
    getDefaultVisionBridgeModel: () => bridgeModel,
    getDebugLogger: () => ({
      debug: () => {},
      warn: () => {},
      error: () => {},
    }),
  } as unknown as Config;
}

/** One tool batch on call 1, plain finish on the continuation call. */
function oneToolBatchStream(request: {
  callId: string;
  name: string;
  args?: unknown;
}) {
  let calls = 0;
  return vi.fn(function* (): Generator<{
    type: string;
    value?: unknown;
  }> {
    calls += 1;
    if (calls === 1) {
      yield { type: 'tool_call_request', value: request };
      return;
    }
    yield { type: 'finished', value: {} };
  });
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('livePromptEvents', () => {
  /** A `@path` read as the expander reports it (ink's tool_group entry). */
  const readDisplay = (
    overrides: Partial<IndividualToolCallDisplay> = {},
  ): IndividualToolCallDisplay => ({
    callId: 'client-read-1',
    name: 'Read File(s)',
    description: 'src/a.ts',
    resultDisplay: 'FILE BODY',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    ...overrides,
  });

  /** An attached image, as the composer hands it to the stream. */
  const imagePart = {
    inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
  };

  beforeEach(() => {
    resetPromptCountForTesting();
    atMocks.calls.length = 0;
    atMocks.result = { processedQuery: null, shouldProceed: true };
    atMocks.hang = null;
    visionMocks.run.mockReset();
  });

  it('forwards string prompts as an explicit UserQuery send', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const signal = new AbortController().signal;

    await drain(livePromptEvents(config, 'hello', signal));

    expect(config.initialize).toHaveBeenCalled();
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt, passedSignal, , options] = sendMessageStream.mock
      .calls[0] as unknown[];
    expect(prompt).toBe('hello');
    expect(passedSignal).toBe(signal);
    expect(options).toEqual({ type: SendMessageType.UserQuery });
  });

  it('waits for the chat an in-flight startup initialization creates', async () => {
    // The boot-time command-registry load owns the initialize() flight, so the
    // turn's own call throws "already initialized" and its catch proceeds
    // while startChat() has not run yet. The real client then throws from
    // getChat(); the stand-in throws the same way, so the wait is what keeps
    // the turn alive.
    let chatReady = false;
    const sendMessageStream = vi.fn(function* () {
      if (!chatReady) throw new Error('Chat not initialized');
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream, undefined, () => chatReady),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
    } as unknown as Config;
    setTimeout(() => {
      chatReady = true;
    }, 250);

    await drain(livePromptEvents(config, 'hello'));

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('holds the first send until the startup chat has tool declarations', async () => {
    // `startChat()` assigns the chat (client.ts:2261) and only then awaits the
    // SessionStart hook, the session-start context and `setTools()`. A wait
    // that releases on chat existence alone sends the first prompt of the
    // session with no tool declarations at all.
    let chatExists = false;
    let tools: unknown[] | undefined;
    let toolsAtSend: unknown[] | undefined;
    const sendMessageStream = vi.fn(function* () {
      toolsAtSend = tools;
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => chatExists,
        getChat: () => ({ getGenerationConfig: () => ({ tools }) }),
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      chatExists = true;
      const pending = drain(livePromptEvents(config, 'hello'));
      // The chat exists while the startup flight is still inside setTools().
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendMessageStream).not.toHaveBeenCalled();
      tools = [{ functionDeclarations: [] }];
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    // A literal, not the mutable `tools`, so a send that observed no tools
    // cannot pass by comparing two undefined values.
    expect(toolsAtSend).toEqual([{ functionDeclarations: [] }]);
  });

  it('reports the client error once the startup chat wait is spent', async () => {
    // The bound is what keeps a config that never finishes initializing from
    // polling forever: the turn falls through to the send and surfaces the
    // client's own error instead of hanging the prompt.
    const sendMessageStream = vi.fn(function* () {
      throw new Error('Chat not initialized');
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => false,
        getChat: () => {
          throw new Error('Chat not initialized');
        },
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      const pending = drain(livePromptEvents(config, 'hello'));
      // The wait expires deep inside the virtual-time run, so keep the
      // rejection handled until the assertion below can claim it.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(STARTUP_CHAT_WAIT_MS + 1_000);
      await expect(pending).rejects.toThrow('Chat not initialized');
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('settles an Esc pressed during the startup wait without sending', async () => {
    // Releasing the wait is not enough: a text-only prompt has no abort gate
    // between the loop and `sendMessageStream`, so falling through would fire
    // the UserPromptSubmit hooks and push history for a cancelled prompt.
    const controller = new AbortController();
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    // A startup flight that never creates the chat, so the wait is still
    // running when the abort lands.
    const config = createFakeConfig(sendMessageStream, undefined, () => false);

    vi.useFakeTimers();
    try {
      const pending = drain(
        livePromptEvents(config, 'hello', controller.signal),
      );
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      void pending.then(markSettled, markSettled);
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();
      // Poll ticks, not the budget: the abort must release the wait at once.
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).not.toHaveBeenCalled();
  });

  it('fails the turn when the startup wait expires on a chat with no tools', async () => {
    // `startChat()` assigns the chat before the SessionStart hook and
    // `setTools()`, so a flight still inside that gap — or one that died in
    // it — leaves a chat that is not ready: a send against it declares zero
    // tools, silently.
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => true,
        getChat: () => ({ getGenerationConfig: () => ({ tools: undefined }) }),
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      const pending = drain(livePromptEvents(config, 'hello'));
      // The wait expires deep inside the virtual-time run, so keep the
      // rejection handled until the assertion below can claim it.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(STARTUP_CHAT_WAIT_MS + 1_000);
      await expect(pending).rejects.toThrow(
        `Timed out after ${STARTUP_CHAT_WAIT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).not.toHaveBeenCalled();
  });

  it('uses the ink promptId format and increments promptCount per turn', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(livePromptEvents(config, 'one'));
    await drain(livePromptEvents(config, 'two'));

    // ink parity: sessionId + '########' + promptCount (useGeminiStream:3287)
    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      'session-1########0',
    );
    expect((sendMessageStream.mock.calls[1] as unknown[])[2]).toBe(
      'session-1########1',
    );
  });

  it('keeps one promptId across the tool-continuation loop of a turn', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(livePromptEvents(config, 'go'));

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      (sendMessageStream.mock.calls[1] as unknown[])[2],
    );
  });

  it('prefers the caller-minted promptId over the module counter (R1-16)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'go', undefined, {
        promptId: 'session-9########7',
      }),
    );

    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      'session-9########7',
    );
  });

  it('forwards multimodal part lists unchanged', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const parts = [
      { text: 'describe this: ' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ];

    // Production always reaches this seam with provenance set (the composer
    // submit passes `submittedPrompt`), so the options here are what force the
    // gate's string check — not the provenance short-circuit — to decide.
    await drain(
      livePromptEvents(config, parts, undefined, {
        submittedPrompt: 'describe this: ',
      }),
    );

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
    // ink expands only a string query (prepareQueryForLlm's
    // `typeof query === 'string'` branch), so an attachment payload rides
    // through untouched.
    expect(atMocks.calls).toEqual([]);
  });

  it('passes the per-turn modelOverride through send options', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'go', undefined, { modelOverride: 'fast-x' }),
    );

    const [, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      modelOverride: 'fast-x',
    });
  });

  it('rides submittedPrompt on the first send and drops it on continuation', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'expanded payload', undefined, {
        submittedPrompt: '@file.txt raw composer text',
      }),
    );

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    const [firstOptions, secondOptions] = sendMessageStream.mock.calls.map(
      (call) => (call as unknown[])[3],
    );
    expect(firstOptions).toEqual({
      type: SendMessageType.UserQuery,
      submittedPrompt: '@file.txt raw composer text',
    });
    expect(secondOptions).toEqual({ type: SendMessageType.ToolResult });
  });

  it('expands an @-mention where the prompt enters the stream', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const expanded = [
      { text: 'summarize @src/a.ts' },
      { text: '--- Content from src/a.ts ---\nFILE BODY' },
    ];
    atMocks.result = {
      processedQuery: expanded,
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = await drain(
      livePromptEvents(config, 'summarize @src/a.ts', undefined, {
        submittedPrompt: 'summarize @src/a.ts',
      }),
    );

    expect(atMocks.calls).toEqual(['summarize @src/a.ts']);
    const [prompt, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual(expanded);
    // The transcript item (applied by the caller) keeps the typed text; the
    // expanded payload is for the model, and provenance stays raw.
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      submittedPrompt: 'summarize @src/a.ts',
    });
    // ink renders the read through handleAtCommand's addItem as a tool_group;
    // here it is the same card, already settled.
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-start',
          id: 'client-read-1',
          tool: 'Read File(s)',
          title: 'src/a.ts',
        },
        { type: 'tool-result', id: 'client-read-1', display: 'FILE BODY' },
        { type: 'tool-end', id: 'client-read-1', success: true, summary: 'ok' },
      ]),
    );
  });

  it('reports a failed @-mention read instead of sending the unexpanded text', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: null,
      shouldProceed: false,
      toolDisplays: [
        readDisplay({
          description: 'Error attempting to read files',
          status: ToolCallStatus.Error,
          resultDisplay: 'Error reading files (missing.ts): no such file',
        }),
      ],
    };

    const events = await drain(
      livePromptEvents(config, 'read @missing.ts', undefined, {
        submittedPrompt: 'read @missing.ts',
      }),
    );

    expect(sendMessageStream).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-result',
          id: 'client-read-1',
          display: 'Error reading files (missing.ts): no such file',
        },
        {
          type: 'tool-end',
          id: 'client-read-1',
          success: false,
          summary: 'error',
        },
      ]),
    );
  });

  it('leaves a generated prompt carrying an @-mention unexpanded (R1-6)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    // Decline-shaped: were the gate keyed on the prompt's shape alone, a
    // `/remember my friend @alice …` payload would drop the turn here.
    atMocks.result = { processedQuery: null, shouldProceed: false };

    await drain(livePromptEvents(config, 'remember that @alice reviews PRs'));

    expect(atMocks.calls).toEqual([]);
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe('remember that @alice reviews PRs');
  });

  it('appends drained steering texts after tool responses at the boundary', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['steer me'],
      }),
    );

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      {
        functionResponse: {
          name: 'test_tool',
          id: 't1',
          response: { ok: true },
        },
      },
      { text: 'steer me' },
    ]);
  });

  it('skips steering when the turn is aborted', async () => {
    const drainSteering = vi.fn(() => ['never']);
    const controller = new AbortController();
    const batch = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    // Esc reaches the generator mid-turn, not before it: the abort lands on
    // the tool-response boundary, which is where a real cancel arrives.
    const sendMessageStream = vi.fn(() => {
      controller.abort();
      return batch();
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', controller.signal, { drainSteering }),
    );

    expect(drainSteering).not.toHaveBeenCalled();
  });

  // --- The steering hop resolves the way an idle submission does (U-21) ----

  const toolResponse = {
    functionResponse: { name: 'test_tool', id: 't1', response: { ok: true } },
  };

  it('expands an @-mention in drained steering text before the boundary send', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [
        { text: 'look @src/a.ts' },
        { text: '--- Content from src/a.ts ---\nFILE BODY' },
      ],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['look @src/a.ts'],
      }),
    )) as OpenTuiStreamEvent[];

    expect(atMocks.calls).toEqual(['look @src/a.ts']);
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'look @src/a.ts' },
      { text: '--- Content from src/a.ts ---\nFILE BODY' },
    ]);
    // The read the model received shows up as the settled card ink renders.
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-start',
          id: 'client-read-1',
          tool: 'Read File(s)',
          title: 'src/a.ts',
        },
        { type: 'tool-result', id: 'client-read-1', display: 'FILE BODY' },
        { type: 'tool-end', id: 'client-read-1', success: true, summary: 'ok' },
      ]),
    );
  });

  it('joins drained steering texts with a blank line between messages', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['first', 'second'],
      }),
    );

    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'first' },
      { text: '\n\n' },
      { text: 'second' },
    ]);
    expect(atMocks.calls).toEqual([]);
  });

  it('restores the whole drained batch when the turn dies inside a steering read', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const controller = new AbortController();
    const restoreSteering = vi.fn();
    atMocks.hang = () => controller.abort();

    const events = (await drain(
      livePromptEvents(config, 'start', controller.signal, {
        drainSteering: () => ['read @a.ts', 'then @b.ts'],
        restoreSteering,
      }),
    )) as OpenTuiStreamEvent[];

    // All-or-nothing: the resolved hop dies with the turn, so every text comes
    // back instead of a half-built message reaching the model.
    expect(restoreSteering).toHaveBeenCalledWith(['read @a.ts', 'then @b.ts']);
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([toolResponse]);
    // And nothing the restored hop produced reaches the transcript: the echo
    // belongs to ink's accept step (U-12), which an aborted hop never gets to.
    expect(events.filter((e) => e.type === 'user')).toEqual([]);
  });

  it('gives up on a hung mid-turn read instead of parking the boundary', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const restoreSteering = vi.fn();
    // Empty hook: nothing aborts, so only the read deadline frees the boundary.
    atMocks.hang = () => {};

    vi.useFakeTimers();
    try {
      const pending = drain(
        livePromptEvents(config, 'start', undefined, {
          drainSteering: () => ['read @hanging.ts'],
          restoreSteering,
        }),
      );
      // The turn reaches the boundary through several microtask hops; pump
      // until the read deadline is armed.
      let armed = false;
      for (let i = 0; i < 40 && !armed; i++) {
        await vi.advanceTimersByTimeAsync(1);
        armed = vi.getTimerCount() > 0;
      }
      expect(armed).toBe(true);
      // ink's MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS is 10 s.
      await vi.advanceTimersByTimeAsync(10_500);
      const events = (await pending) as OpenTuiStreamEvent[];

      expect(events.filter((e) => e.type === 'warning')).toEqual([
        {
          type: 'warning',
          text: 'Could not attach file: Mid-turn @ command resolution timed out',
        },
      ]);
      // A timeout is the read's failure, not the turn's: the text is dropped
      // like any declined expansion rather than requeued forever.
      expect(restoreSteering).not.toHaveBeenCalled();
      const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
      expect(secondPrompt).toEqual([toolResponse]);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- U-12: the steer shows up as an unsent user row (ink accept()) -------

  it('echoes each surviving steered text as an unsent user row', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['first', 'second'],
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([
      { type: 'user', text: 'first', sentToModel: false },
      { type: 'user', text: 'second', sentToModel: false },
    ]);
  });

  it('echoes the steer after the resolved read cards, like ink accept()', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [
        { text: 'look @src/a.ts' },
        { text: '--- Content from src/a.ts ---\nFILE BODY' },
      ],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['look @src/a.ts'],
      }),
    )) as OpenTuiStreamEvent[];

    // accept() order: the read cards first, then the USER row at grant.
    const cardIndex = events.findIndex(
      (e) => e.type === 'tool-end' && e.id === 'client-read-1',
    );
    const echoIndex = events.findIndex(
      (e) => e.type === 'user' && e.text === 'look @src/a.ts',
    );
    expect(cardIndex).toBeGreaterThan(-1);
    expect(echoIndex).toBeGreaterThan(cardIndex);
    expect(events[echoIndex]).toEqual({
      type: 'user',
      text: 'look @src/a.ts',
      sentToModel: false,
    });
  });

  it('renders each steered message with its own cards before its own echo', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [{ text: 'expanded' }],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['one @src/a.ts', 'two @src/b.ts'],
      }),
    )) as OpenTuiStreamEvent[];

    // ink accept() runs each message's side effects and then adds its USER row,
    // so the pairs interleave rather than grouping all cards before all rows.
    expect(
      events
        .filter(
          (e) =>
            e.type === 'user' ||
            (e.type === 'tool-end' && e.id === 'client-read-1'),
        )
        .map((e) => (e.type === 'user' ? `echo:${e.text}` : 'card')),
    ).toEqual(['card', 'echo:one @src/a.ts', 'card', 'echo:two @src/b.ts']);
  });

  it('does not echo a steer the expander declined', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = { processedQuery: null, shouldProceed: false };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['@declined.ts'],
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([]);
  });

  it('echoes a steer whose expansion resolved to no parts', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    // Proceeded, but nothing came back. The echo is deliberately decoupled from
    // this message's own parts, which over-shows against ink in the all-empty
    // hop — its caller drops the whole hop (use-llm-stream.ts:3394), so accept()
    // never runs there. That is the divergence Decision 4 of the batch-9 design
    // doc records, not a parity claim.
    atMocks.result = { processedQuery: [], shouldProceed: true };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['@empty.ts'],
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([
      { type: 'user', text: '@empty.ts', sentToModel: false },
    ]);
  });

  // --- The prompt-side vision bridge (U-25) --------------------------------

  const bridgeModel: VisionBridgeModelSelection = { id: 'qwen3-vl' };

  it('converts a composer image through the bridge and discloses the egress', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    visionMocks.run.mockResolvedValue({
      applied: true,
      status: 'ok',
      parts: [{ text: 'what is this?' }, { text: 'IMAGE TRANSCRIPT' }],
      convertedCount: 1,
      omittedCount: 0,
      modelId: 'qwen3-vl',
      egressOccurred: true,
    });
    const parts = [{ text: 'what is this?' }, imagePart];

    const events = (await drain(
      livePromptEvents(config, parts, undefined, {
        submittedPrompt: 'what is this?',
      }),
    )) as OpenTuiStreamEvent[];

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([
      { text: 'what is this?' },
      { text: 'IMAGE TRANSCRIPT' },
    ]);
    expect(visionMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ config, parts }),
    );
    const notice = events.find((e) => e.type === 'info');
    expect(notice?.text).toContain('Converted 1 image(s) to text via qwen3-vl');
    expect(notice?.text).toContain('sent to that model');
  });

  it('drops the image rather than forwarding it when the bridge yields nothing', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    visionMocks.run.mockResolvedValue({
      applied: false,
      status: 'failed',
      convertedCount: 0,
      omittedCount: 1,
      modelId: 'qwen3-vl',
      error: 'the vision model request failed',
    });

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart]),
    )) as OpenTuiStreamEvent[];

    // A text-only model must never receive raw inlineData.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('routes the whole turn onto an agent-capable vision model without bridging', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream, {
      id: 'qwen3-vl',
      agentCapable: true,
    });
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart], undefined, {
        drainSteering: () => ['read @shot.png'],
      }),
    )) as OpenTuiStreamEvent[];

    expect(visionMocks.run).not.toHaveBeenCalled();
    // The images stay: the model reading them can see them.
    const [firstPrompt, secondPrompt] = sendMessageStream.mock.calls.map(
      (call) => (call as unknown[])[0],
    );
    expect(firstPrompt).toEqual([{ text: 'look' }, imagePart]);
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      imagePart,
    ]);
    // The pick is a trailing-NUL selector, and it holds for the continuation.
    const overrides = sendMessageStream.mock.calls.map(
      (call) =>
        (call as unknown[])[3] as { modelOverride?: string } | undefined,
    );
    expect(overrides.map((o) => o?.modelOverride)).toEqual([
      'qwen3-vl\0',
      'qwen3-vl\0',
    ]);
    expect(events.filter((e) => e.type === 'info').map((e) => e.text)).toEqual([
      'Routing this image turn to qwen3-vl; retries and tool continuations will stay on that model until the turn ends.',
    ]);
  });

  it('carries a full-turn pick made mid-turn into the rest of the turn', async () => {
    // Here the image arrives only through the steered `@` mention, so the pick
    // happens at the boundary — after the first send already went out on the
    // primary model. A per-turn override read once would leave both the
    // continuation call and the model named in its own notice on the old one.
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 't1', name: 'test_tool', args: {} },
        };
        return;
      }
      yield { type: 'chat_compressed', value: {} };
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream, {
      id: 'qwen3-vl',
      agentCapable: true,
    });
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['read @shot.png'],
      }),
    )) as OpenTuiStreamEvent[];

    const readOptions = (call: unknown[]) =>
      call[3] as { modelOverride?: string } | undefined;
    expect(readOptions(sendMessageStream.mock.calls[0])).toEqual({
      type: SendMessageType.UserQuery,
    });
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      imagePart,
    ]);
    expect(readOptions(sendMessageStream.mock.calls[1])?.modelOverride).toBe(
      'qwen3-vl\0',
    );
    expect(events.filter((e) => e.type === 'info').map((e) => e.text)).toEqual([
      'Routing this image turn to qwen3-vl; retries and tool continuations will stay on that model until the turn ends.',
      expect.stringContaining('input token limit for qwen3-vl'),
    ]);
  });

  it('leaves an inline submit_prompt override off the bridge', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    const parts = [{ text: 'look' }, imagePart];

    const events = (await drain(
      livePromptEvents(config, parts, undefined, {
        modelOverride: 'fast-x',
        submittedPrompt: 'look',
      }),
    )) as OpenTuiStreamEvent[];

    expect(visionMocks.run).not.toHaveBeenCalled();
    const [prompt, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      modelOverride: 'fast-x',
      submittedPrompt: 'look',
    });
    expect(events.filter((e) => e.type === 'info')).toEqual([]);
  });

  it('converts an image a steered @-mention pulled into the message', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };
    visionMocks.run.mockResolvedValue({
      applied: true,
      status: 'ok',
      parts: [{ text: 'read @shot.png' }, { text: 'BRIDGE TRANSCRIPT' }],
      convertedCount: 1,
      omittedCount: 0,
      modelId: 'qwen3-vl',
      egressOccurred: true,
    });

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['read @shot.png'],
      }),
    );

    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      { text: 'BRIDGE TRANSCRIPT' },
    ]);
  });

  it('discloses the egress when the bridge is cancelled after sending', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    const controller = new AbortController();
    visionMocks.run.mockImplementation(async () => {
      controller.abort();
      return {
        applied: false,
        status: 'skipped',
        convertedCount: 0,
        omittedCount: 0,
        modelId: 'qwen3-vl',
        egressOccurred: true,
      };
    });

    const events = (await drain(
      livePromptEvents(
        config,
        [{ text: 'look' }, imagePart],
        controller.signal,
      ),
    )) as OpenTuiStreamEvent[];

    // Esc stops the send, but the images already left: the notice survives.
    expect(sendMessageStream).not.toHaveBeenCalled();
    const notice = events.find((e) => e.type === 'info');
    expect(notice?.text).toContain('Vision bridge cancelled.');
    expect(notice?.text).toContain('were sent to qwen3-vl');
  });

  // --- U-27: unsupported image formats are disclosed on both hops ----------

  it('discloses an unsupported image format once before the first send', async () => {
    const yielded: OpenTuiStreamEvent[] = [];
    let disclosedAtSend: boolean | undefined;
    // Captured in the call body, not in a generator body: the request goes out
    // when the client is called, and a generator's body would only run at the
    // first `next()`. A check moved after the send leaves `yielded` empty here.
    const sendMessageStream = vi.fn(() => {
      disclosedAtSend = yielded.some(
        (e) =>
          e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
      );
      return (function* () {})();
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };

    for await (const ev of livePromptEvents(config, [{ text: 'look' }, avif])) {
      yielded.push(ev);
    }

    expect(disclosedAtSend).toBe(true);
    // Exactly one notice, with ink's own text naming the supported set.
    expect(yielded.filter((e) => e.type === 'info')).toEqual([
      { type: 'info', text: getUnsupportedImageFormatWarning() },
    ]);
    // ink forwards the image anyway; only the disclosure is added.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }, avif]);
  });

  it('does not disclose an accepted format (png rides through silently)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart]),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'info')).toEqual([]);
  });

  it('discloses an unsupported format carried as fileData', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const avif = {
      fileData: { mimeType: 'image/avif', fileUri: 'gs://bucket/shot.avif' },
    };

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, avif]),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'info')).toEqual([
      { type: 'info', text: getUnsupportedImageFormatWarning() },
    ]);
    // ink forwards the part anyway — the disclosure is the only addition.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }, avif]);
  });

  it('discloses the format warning on the steering hop before the echo', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };
    atMocks.result = {
      processedQuery: [{ text: 'see @shot.avif' }, avif],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['see @shot.avif'],
      }),
    )) as OpenTuiStreamEvent[];

    const warnIndex = events.findIndex(
      (e) => e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
    );
    const echoIndex = events.findIndex(
      (e) => e.type === 'user' && e.text === 'see @shot.avif',
    );
    expect(warnIndex).toBeGreaterThan(-1);
    expect(echoIndex).toBeGreaterThan(warnIndex);
  });

  it('attributes the steering disclosure to the message that carries the image', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };
    atMocks.result = {
      processedQuery: [{ text: 'see @shot.avif' }, avif],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => ['plain steer', 'see @shot.avif'],
      }),
    )) as OpenTuiStreamEvent[];

    const indexOf = (match: (e: OpenTuiStreamEvent) => boolean): number =>
      events.findIndex(match);
    const firstEcho = indexOf(
      (e) => e.type === 'user' && e.text === 'plain steer',
    );
    const warn = indexOf(
      (e) => e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
    );
    const secondEcho = indexOf(
      (e) => e.type === 'user' && e.text === 'see @shot.avif',
    );

    // One warning for the drain, and it sits inside the second message's
    // window: a check hoisted above the loop lands after both echoes.
    expect(events.filter((e) => e.type === 'info')).toHaveLength(1);
    expect(firstEcho).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(firstEcho);
    expect(secondEcho).toBeGreaterThan(warn);
  });

  it('forwards awaiting_approval calls to onWaitingCall exactly once per callId', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 'w1', name: 'ask_user_question', args: {} },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const onWaitingCall = vi.fn();

    await drain(livePromptEvents(config, 'q', undefined, { onWaitingCall }));

    // The fake scheduler reports the waiting call twice; dedupe must surface it once.
    expect(onWaitingCall).toHaveBeenCalledTimes(1);
    expect(onWaitingCall.mock.calls[0][0]).toMatchObject({
      callId: 'w1',
      name: 'ask_user_question',
    });
  });

  it('re-surfaces a call that bounces back to awaiting_approval (R1-102)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'b1',
            name: 'run_shell_command',
            args: { __bounceApproval: true },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const onWaitingCall = vi.fn();

    await drain(livePromptEvents(config, 'q', undefined, { onWaitingCall }));

    // The call left awaiting_approval (executing) and re-entered it via a
    // PreToolUse 'ask' bounce under the same callId — the second waiting
    // state must surface its dialog again, with the bounced details.
    expect(onWaitingCall).toHaveBeenCalledTimes(2);
    expect(onWaitingCall.mock.calls[0][0]).toMatchObject({ callId: 'b1' });
    expect(onWaitingCall.mock.calls[1][0]).toMatchObject({
      callId: 'b1',
      confirmationDetails: {
        title: 'Hook requested confirmation to run',
      },
    });
  });

  it('pushes the real invocation description once per callId (R1-104)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'd1',
            name: 'run_shell_command',
            args: { __invocationDesc: 'Running `npm test` in ./pkg' },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'run'),
    )) as OpenTuiStreamEvent[];

    // The fake scheduler reports the waiting call twice; the invocation
    // description rides the stream exactly once per callId (descriptionSeen
    // dedupe, ink mapToDisplay parity).
    const descs = events.filter((e) => e.type === 'tool-description');
    expect(descs).toEqual([
      {
        type: 'tool-description',
        id: 'd1',
        description: 'Running `npm test` in ./pkg',
      },
    ]);
  });

  it('emits no tool-description without an invocation (R1-104)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 'p1', name: 'run_shell_command', args: {} },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'run'),
    )) as OpenTuiStreamEvent[];

    expect(events.some((e) => e.type === 'tool-description')).toBe(false);
  });

  describe('tool execution live output (outputUpdateHandler)', () => {
    it('streams tool-output events while the tool executes', async () => {
      const sendMessageStream = oneToolBatchStream({
        callId: 't1',
        name: 'run_shell_command',
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'run'),
      )) as OpenTuiStreamEvent[];

      const outputIdx = events.findIndex((e) => e.type === 'tool-output');
      expect(outputIdx).toBeGreaterThanOrEqual(0);
      expect(events[outputIdx]).toEqual({
        type: 'tool-output',
        id: 't1',
        delta: 'live output\n',
      });
      // Live output arrives before the tool-end settlement.
      const endIdx = events.findIndex((e) => e.type === 'tool-end');
      expect(outputIdx).toBeLessThan(endIdx);
    });

    it('ignores shell_progress heartbeats', async () => {
      const sendMessageStream = oneToolBatchStream({
        callId: 't1',
        name: 'run_shell_command',
        args: { __liveChunks: [{ type: 'shell_progress', elapsedMs: 5 }] },
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'run'),
      )) as OpenTuiStreamEvent[];

      expect(events.some((e) => e.type === 'tool-output')).toBe(false);
    });

    it('maps task_execution chunks to task card events', async () => {
      const running = {
        type: 'task_execution',
        subagentName: 'researcher',
        taskDescription: 'benchmark renders',
        status: 'running',
        toolCalls: [{ callId: 'x1', name: 'grep_search', status: 'executing' }],
      };
      const completed = {
        ...running,
        status: 'completed',
        toolCalls: [
          { callId: 'x1', name: 'grep_search', status: 'success' },
          {
            callId: 'x2',
            name: 'read_file',
            status: 'success',
            description: 'Read app.tsx',
          },
        ],
        executionSummary: {
          totalToolCalls: 2,
          totalDurationMs: 12400,
          totalTokens: 2100,
        },
      };
      const sendMessageStream = oneToolBatchStream({
        callId: 'agent1',
        name: 'agent',
        args: { __liveChunks: [running, completed] },
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'delegate'),
      )) as OpenTuiStreamEvent[];

      expect(events).toContainEqual({
        type: 'task-start',
        id: 'agent1',
        name: 'researcher',
        description: 'benchmark renders',
      });
      expect(events).toContainEqual({
        type: 'task-progress',
        id: 'agent1',
        line: '↳ grep_search',
      });
      expect(events).toContainEqual({
        type: 'task-progress',
        id: 'agent1',
        line: '↳ Read app.tsx',
      });
      expect(events).toContainEqual({
        type: 'task-end',
        id: 'agent1',
        tools: 2,
        seconds: 12.4,
        tokens: '2.1k',
      });
      // Progress for already-seen subagent tool calls is not repeated.
      expect(
        events.filter(
          (e) => e.type === 'task-progress' && e.line === '↳ grep_search',
        ),
      ).toHaveLength(1);
    });
  });
});

describe('approval-mode helpers', () => {
  it('cycles through the core order including PLAN', () => {
    expect(nextApprovalMode(ApprovalMode.PLAN)).toBe(ApprovalMode.DEFAULT);
    expect(nextApprovalMode(ApprovalMode.DEFAULT)).toBe(ApprovalMode.AUTO_EDIT);
    expect(nextApprovalMode(ApprovalMode.AUTO_EDIT)).toBe(ApprovalMode.AUTO);
    expect(nextApprovalMode(ApprovalMode.AUTO)).toBe(ApprovalMode.YOLO);
    expect(nextApprovalMode(ApprovalMode.YOLO)).toBe(ApprovalMode.PLAN);
    expect(nextApprovalMode(undefined)).toBe(ApprovalMode.AUTO_EDIT);
  });

  const waitingCall = (
    callId: string,
    name: string,
    extra?: Partial<{ hideAlwaysAllow: boolean }>,
  ): WaitingCallInfo => ({
    callId,
    name,
    confirmationDetails: {
      type: 'exec',
      title: name,
      command: 'ls',
      rootCommand: 'ls',
      onConfirm: async () => {},
      ...extra,
    } as ToolCallConfirmationDetails,
  });

  it('YOLO auto-approves every waiting call except hideAlwaysAllow', () => {
    const waiting = [
      waitingCall('a', 'run_shell_command'),
      waitingCall('b', 'ask_user_question'),
      waitingCall('c', 'edit', { hideAlwaysAllow: true }),
    ];
    const approved = selectAutoApprovals(ApprovalMode.YOLO, waiting);
    expect(approved.map((c) => c.callId)).toEqual(['a', 'b']);
  });

  it('AUTO_EDIT auto-approves only edit tools', () => {
    const waiting = [
      waitingCall('a', 'run_shell_command'),
      waitingCall('b', 'edit'),
      waitingCall('c', 'write_file'),
      waitingCall('d', 'notebook_edit'),
      waitingCall('e', 'replace'),
    ];
    const approved = selectAutoApprovals(ApprovalMode.AUTO_EDIT, waiting);
    expect(approved.map((c) => c.callId)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('other mode switches auto-approve nothing', () => {
    const waiting = [waitingCall('a', 'edit')];
    expect(selectAutoApprovals(ApprovalMode.DEFAULT, waiting)).toEqual([]);
    expect(selectAutoApprovals(ApprovalMode.AUTO, waiting)).toEqual([]);
    expect(selectAutoApprovals(ApprovalMode.PLAN, waiting)).toEqual([]);
  });
});
