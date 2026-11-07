/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type {
  BtwRunParams,
  BtwRunResult,
} from '@qwen-code/qwen-code-core/agents/btw-session.js';

const { runner } = vi.hoisted(() => ({
  runner: vi.fn<(params: BtwRunParams) => Promise<BtwRunResult | null>>(),
}));

vi.mock(
  '@qwen-code/qwen-code-core/agents/btw-session.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/agents/btw-session.js')
      >();
    const sessions = new WeakMap<
      Config,
      InstanceType<typeof actual.BtwSession>
    >();
    return {
      ...actual,
      getBtwSession: (config: Config) => {
        let session = sessions.get(config);
        if (!session) {
          session = new actual.BtwSession(config, runner);
          sessions.set(config, session);
        }
        return session;
      },
    };
  },
);

import { executeBtwGeneration } from './btw-generation.js';

let config: Config;

beforeEach(() => {
  vi.clearAllMocks();
  config = {
    getModel: () => 'main',
    getSessionId: () => 'session',
  } as unknown as Config;
});

describe('executeBtwGeneration', () => {
  it('streams the side answer and returns usage', async () => {
    runner.mockImplementation(async (params) => {
      await params.onText('Hello');
      await params.onText(' world');
      return {
        text: 'Hello world',
        usage: { model: 'resolved', inputTokens: 3, outputTokens: 2 },
      };
    });
    const emit = vi.fn().mockResolvedValue(undefined);

    expect(
      await executeBtwGeneration(
        config,
        ' Why? ',
        new AbortController().signal,
        emit,
      ),
    ).toEqual({
      model: 'resolved',
      modelSource: 'main',
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ config, question: 'Why?', history: [] }),
    );
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'started', model: 'main', modelSource: 'main' },
      { type: 'delta', seq: 0, text: 'Hello' },
      { type: 'delta', seq: 1, text: ' world' },
    ]);
  });

  it('threads earlier answers into the next question', async () => {
    runner.mockResolvedValueOnce({ text: 'first answer' });
    runner.mockResolvedValueOnce({ text: 'second answer' });
    const emit = vi.fn().mockResolvedValue(undefined);
    const signal = new AbortController().signal;

    await executeBtwGeneration(config, 'first?', signal, emit);
    await executeBtwGeneration(config, 'second?', signal, emit);

    expect(runner.mock.calls[1][0].history).toEqual([
      { question: 'first?', response: 'first answer' },
    ]);
  });

  it('emits reset when a retry restarts the answer', async () => {
    runner.mockImplementation(async (params) => {
      await params.onText('partial');
      await params.onRetry({ restart: true });
      await params.onText('final');
      return { text: 'final' };
    });
    const emit = vi.fn().mockResolvedValue(undefined);

    await executeBtwGeneration(
      config,
      'Why?',
      new AbortController().signal,
      emit,
    );

    expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
      'started',
      'delta',
      'reset',
      'delta',
    ]);
  });

  it('emits the notice when a retried attempt only tries to call a tool', async () => {
    runner.mockImplementation(async (params) => {
      await params.onText('partial');
      await params.onRetry({ restart: true });
      return { text: null, toolCallName: 'shell' };
    });
    const emit = vi.fn().mockResolvedValue(undefined);

    await executeBtwGeneration(
      config,
      'Why?',
      new AbortController().signal,
      emit,
    );

    expect(emit).toHaveBeenLastCalledWith({
      type: 'delta',
      seq: 1,
      text: expect.stringContaining('tried to call shell'),
    });
  });

  it('emits the notice when the only streamed text is whitespace', async () => {
    runner.mockImplementation(async (params) => {
      await params.onText(' ');
      return { text: ' ', toolCallName: 'shell' };
    });
    const emit = vi.fn().mockResolvedValue(undefined);

    await executeBtwGeneration(
      config,
      'Why?',
      new AbortController().signal,
      emit,
    );

    expect(emit).toHaveBeenLastCalledWith({
      type: 'delta',
      seq: 1,
      text: expect.stringContaining('tried to call shell'),
    });
  });

  it('streams the notice when the model only tried to call a tool', async () => {
    runner.mockResolvedValue({ text: null, toolCallName: 'shell' });
    const emit = vi.fn().mockResolvedValue(undefined);

    await executeBtwGeneration(
      config,
      'Why?',
      new AbortController().signal,
      emit,
    );

    expect(emit).toHaveBeenLastCalledWith({
      type: 'delta',
      seq: 0,
      text: expect.stringContaining('tried to call shell'),
    });
  });

  it('completes with no answer when no conversation context exists', async () => {
    runner.mockResolvedValue(null);
    const emit = vi.fn().mockResolvedValue(undefined);

    expect(
      await executeBtwGeneration(
        config,
        'Why?',
        new AbortController().signal,
        emit,
      ),
    ).toEqual({ model: 'main', modelSource: 'main' });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('rethrows a model failure', async () => {
    runner.mockRejectedValue(new Error('boom'));

    await expect(
      executeBtwGeneration(
        config,
        'Why?',
        new AbortController().signal,
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow('boom');
  });

  it('does not publish text or succeed after cancellation', async () => {
    const controller = new AbortController();
    runner.mockImplementation(async (params) => {
      controller.abort();
      await params.onText('late text');
      throw new Error('Should not reach completion');
    });
    const emit = vi.fn();

    await expect(
      executeBtwGeneration(config, 'Why?', controller.signal, emit),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
