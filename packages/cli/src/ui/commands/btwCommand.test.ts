/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type {
  BtwRunParams,
  BtwRunResult,
} from '@qwen-code/qwen-code-core/agents/btw-session.js';
import { btwCommand } from './btwCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItemBtw } from '../types.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [k, v]) => str.replace(`{{${k}}}`, v),
        key,
      );
    }
    return key;
  },
}));

const { runner, recordBtwUse } = vi.hoisted(() => ({
  runner: vi.fn<(params: BtwRunParams) => Promise<BtwRunResult | null>>(),
  recordBtwUse: vi.fn(),
}));

vi.mock('../../services/tips/index.js', () => ({ recordBtwUse }));

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('btwCommand', () => {
  let mockContext: CommandContext;

  const createConfig = (overrides: Record<string, unknown> = {}) => ({
    getModel: () => 'test-model',
    getSessionId: () => 'test-session-id',
    ...overrides,
  });

  const lastBtw = () =>
    (
      vi.mocked(mockContext.ui.setBtwItem).mock.calls.at(-1)?.[0] as
        | HistoryItemBtw
        | null
        | undefined
    )?.btw;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockCommandContext({
      services: { config: createConfig() },
    });
  });

  it('should have correct metadata', () => {
    expect(btwCommand.name).toBe('btw');
    expect(btwCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should return usage when no question is provided and nothing to reopen', async () => {
    expect(await btwCommand.action!(mockContext, '  ')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Please provide a question. Usage: /btw <your question>',
    });
  });

  it('should return error when question exceeds BTW_MAX_INPUT_LENGTH', async () => {
    expect(
      await btwCommand.action!(mockContext, 'x'.repeat(4097)),
    ).toMatchObject({
      messageType: 'error',
      content: 'Question too long (max 4096 chars)',
    });
  });

  it('should return error when config is not loaded', async () => {
    mockContext = createMockCommandContext({ services: { config: null } });
    expect(await btwCommand.action!(mockContext, 'hi')).toMatchObject({
      messageType: 'error',
      content: 'Config not loaded.',
    });
  });

  describe('interactive mode', () => {
    it('streams into the btw area and shows the answer without blocking', async () => {
      const result = deferred<BtwRunResult>();
      let params: BtwRunParams | undefined;
      runner.mockImplementation((p) => {
        params = p;
        return result.promise;
      });

      expect(await btwCommand.action!(mockContext, 'why?')).toBeUndefined();
      expect(lastBtw()).toMatchObject({
        question: 'why?',
        answer: '',
        isPending: true,
      });
      expect(mockContext.ui.btwAbortControllerRef.current).toBeInstanceOf(
        AbortController,
      );
      expect(recordBtwUse).toHaveBeenCalledTimes(1);

      await params!.onText('because');
      expect(lastBtw()).toMatchObject({ answer: 'because', isPending: true });

      result.resolve({ text: 'because' });
      await flush();
      expect(
        vi.mocked(mockContext.ui.setBtwItem).mock.calls.at(-1)?.[0],
      ).toEqual({
        type: MessageType.BTW,
        btw: {
          question: 'why?',
          answer: 'because',
          isPending: false,
          historyCount: 0,
        },
      });
    });

    it('keeps an earlier question running when a new one starts', async () => {
      const results: Array<ReturnType<typeof deferred<BtwRunResult>>> = [];
      runner.mockImplementation(() => {
        const result = deferred<BtwRunResult>();
        results.push(result);
        return result.promise;
      });

      await btwCommand.action!(mockContext, 'first?');
      await btwCommand.action!(mockContext, 'second?');
      results[0].resolve({ text: 'first answer' });
      results[1].resolve({ text: 'second answer' });
      await flush();

      expect(lastBtw()).toMatchObject({
        question: 'second?',
        answer: 'second answer',
        historyCount: 1,
      });
    });

    it('threads earlier answers and reopens the last one with a bare /btw', async () => {
      runner.mockResolvedValueOnce({ text: 'one' });
      runner.mockResolvedValueOnce({ text: 'two' });

      await btwCommand.action!(mockContext, 'first?');
      await flush();
      await btwCommand.action!(mockContext, 'second?');
      await flush();
      expect(runner.mock.calls[1][0].history).toEqual([
        { question: 'first?', response: 'one' },
      ]);

      vi.mocked(mockContext.ui.setBtwItem).mockClear();
      expect(await btwCommand.action!(mockContext, '')).toBeUndefined();
      expect(lastBtw()).toMatchObject({
        question: 'second?',
        answer: 'two',
        isPending: false,
      });
    });

    it('cancels the shown request through cancelBtw', async () => {
      runner.mockImplementation(
        (params) =>
          new Promise((_, reject) =>
            params.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      );

      await btwCommand.action!(mockContext, 'why?');
      mockContext.ui.btwAbortControllerRef.current!.abort();
      await flush();

      expect(runner.mock.calls[0][0].signal.aborted).toBe(true);
      // Nothing to reopen: the cancelled question never became history.
      expect(await btwCommand.action!(mockContext, '')).toMatchObject({
        messageType: 'error',
      });
    });

    it('shows a failure in the btw area without recording it', async () => {
      runner.mockRejectedValue(new Error('rate limited'));

      await btwCommand.action!(mockContext, 'why?');
      await flush();

      expect(lastBtw()).toMatchObject({
        answer: '(API error: rate limited)',
        isError: true,
        isPending: false,
      });
    });
  });

  describe('acp mode', () => {
    beforeEach(() => {
      mockContext = createMockCommandContext({
        services: { config: createConfig() },
        executionMode: 'acp',
      });
    });

    it('returns the answer as a message', async () => {
      runner.mockResolvedValue({ text: 'answer' });
      expect(await btwCommand.action!(mockContext, 'why?')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'answer',
      });
      expect(mockContext.ui.setBtwItem).not.toHaveBeenCalled();
      expect(recordBtwUse).not.toHaveBeenCalled();
    });

    it('returns the no-response fallback when the model returns no text', async () => {
      runner.mockResolvedValue({ text: null });
      expect(await btwCommand.action!(mockContext, 'why?')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'No response received.',
      });
    });

    it('returns an error message on failure', async () => {
      runner.mockRejectedValue(new Error('boom'));
      expect(await btwCommand.action!(mockContext, 'why?')).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Failed to answer btw question: boom',
      });
    });

    it('returns an error when no conversation context exists', async () => {
      runner.mockResolvedValue(null);
      expect(await btwCommand.action!(mockContext, 'why?')).toMatchObject({
        messageType: 'error',
        content:
          'Failed to answer btw question: No conversation context available for /btw',
      });
    });

    it('does not reopen with a bare /btw', async () => {
      runner.mockResolvedValue({ text: 'answer' });
      await btwCommand.action!(mockContext, 'why?');
      expect(await btwCommand.action!(mockContext, '')).toMatchObject({
        messageType: 'error',
      });
    });
  });
});
