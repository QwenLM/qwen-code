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

import { describe, it, expect, vi } from 'vitest';
import { SendMessageType } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import { livePromptEvents } from './live-session.js';

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
      };
      constructor(opts: {
        onAllToolCallsComplete: (calls: unknown[]) => unknown;
        onToolCallsUpdate?: (calls: unknown[]) => unknown;
      }) {
        this.opts = opts;
      }
      async schedule(
        calls: Array<{ callId: string; name?: string; args?: unknown }>,
      ): Promise<void> {
        // Emit one awaiting_approval update per call (twice, to prove the
        // live-session dedupe), then complete the calls.
        for (let i = 0; i < 2; i++) {
          await this.opts.onToolCallsUpdate?.(
            calls.map((c) => ({
              status: 'awaiting_approval',
              request: c,
              confirmationDetails: {
                type: 'ask_user_question',
                title: '',
                questions: [],
                onConfirm: async () => {},
              },
            })),
          );
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
  } as unknown as Config;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('livePromptEvents', () => {
  it('forwards string prompts without send options', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const signal = new AbortController().signal;

    await drain(livePromptEvents(config, 'hello', signal));

    expect(config.initialize).toHaveBeenCalled();
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt, passedSignal, promptId, options] = sendMessageStream.mock
      .calls[0] as unknown[];
    expect(prompt).toBe('hello');
    expect(passedSignal).toBe(signal);
    expect(String(promptId)).toMatch(/^opentui-/);
    expect(options).toBeUndefined();
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
});
