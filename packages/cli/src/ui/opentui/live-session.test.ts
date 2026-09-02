/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-turn regression tests (R2): the prompt reaches the client as a full
 * PartListUnion (multimodal included) and the per-turn modelOverride travels
 * through SendMessageOptions.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ApprovalMode, SendMessageType } from '@qwen-code/qwen-code-core';
import type {
  Config,
  ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import {
  livePromptEvents,
  nextApprovalMode,
  resetPromptCountForTesting,
  selectAutoApprovals,
  type WaitingCallInfo,
} from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

// The steering test drives one full tool round-trip; replace the scheduler
// with a stub that completes the pending calls immediately.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
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

function createFakeConfig(sendMessageStream: (...args: unknown[]) => unknown) {
  return {
    initialize: vi.fn(async () => {}),
    getGeminiClient: () => ({ sendMessageStream }),
    getSessionId: () => 'session-1',
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
    getContentGeneratorConfig: () => ({ authType: 'qwen-oauth' }),
  } as unknown as Config;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('livePromptEvents', () => {
  beforeEach(() => {
    resetPromptCountForTesting();
  });

  it('forwards string prompts without send options', async () => {
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
    expect(options).toBeUndefined();
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
      yield { type: 'finished', value: {} };
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

    await drain(livePromptEvents(config, parts));

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
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

  it('passes submittedPrompt only on the initial user query', async () => {
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
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, [{ text: 'expanded prompt' }], undefined, {
        submittedPrompt: '@context.txt review this',
      }),
    );

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect((sendMessageStream.mock.calls[0] as unknown[])[3]).toEqual({
      type: SendMessageType.UserQuery,
      submittedPrompt: '@context.txt review this',
    });
    expect((sendMessageStream.mock.calls[1] as unknown[])[3]).toEqual({
      type: SendMessageType.ToolResult,
    });
  });

  it('appends drained steering texts after tool responses at the boundary', async () => {
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
      yield { type: 'finished', value: {} };
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
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const controller = new AbortController();
    controller.abort();

    await drain(
      livePromptEvents(config, 'start', controller.signal, { drainSteering }),
    );

    expect(drainSteering).not.toHaveBeenCalled();
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
