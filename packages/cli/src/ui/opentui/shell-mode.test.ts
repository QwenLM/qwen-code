/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * U-33: executeUserShell reports through the stream events the transcript
 * already folds — a user-shell row, a synthetic run_shell_command card, and
 * an LLM history injection shared with ink's processor.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Config,
  ShellExecutionResult,
  ShellOutputEvent,
} from '@qwen-code/qwen-code-core';
import { executeUserShell } from './shell-mode.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

const executeMock = vi.hoisted(() => vi.fn());
const addHistoryMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    ShellExecutionService: {
      ...actual.ShellExecutionService,
      execute: executeMock,
    },
  };
});

vi.mock('../hooks/shellCommandProcessor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hooks/shellCommandProcessor.js')>();
  return {
    ...actual,
    addShellCommandToLlmHistory: addHistoryMock,
  };
});

const llmClient = {};

function makeConfig(usePty: boolean): Config {
  return {
    getTargetDir: () => '/tmp/project',
    getShouldUseNodePtyShell: () => usePty,
    getShellExecutionConfig: () => ({}),
    getGeminiClient: () => llmClient,
  } as unknown as Config;
}

function makeResult(
  overrides: Partial<ShellExecutionResult> = {},
): ShellExecutionResult {
  return {
    rawOutput: Buffer.from(''),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    promoted: false,
    ...overrides,
  } as ShellExecutionResult;
}

describe('executeUserShell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    executeMock.mockReset();
    addHistoryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(usePty = false) {
    const events: OpenTuiStreamEvent[] = [];
    let onOutputEvent!: (event: ShellOutputEvent) => void;
    let resolveResult!: (result: ShellExecutionResult) => void;
    let executeArgs: unknown[] = [];
    executeMock.mockImplementation((...args: unknown[]) => {
      executeArgs = args;
      onOutputEvent = args[2] as typeof onOutputEvent;
      return Promise.resolve({
        pid: 4242,
        result: new Promise((resolve) => {
          resolveResult = resolve;
        }),
      });
    });
    const done = executeUserShell(
      makeConfig(usePty),
      'echo hello',
      (event) => events.push(event),
      new AbortController().signal,
      { width: 80, height: 24 },
    );
    return {
      events,
      done,
      emitOutput: (chunk: string) => onOutputEvent({ type: 'data', chunk }),
      resolveResult,
      executeArgs,
    };
  }

  const cardIds = (events: OpenTuiStreamEvent[]): Array<string | undefined> =>
    events
      .filter((event) => event.type.startsWith('tool-'))
      .map((event) => (event as { id?: string }).id);

  it('streams throttled deltas and lands a tail-deduped result', async () => {
    const { events, done, emitOutput, resolveResult } = setup();
    emitOutput('hello ');
    vi.advanceTimersByTime(1001);
    emitOutput('world\n');
    expect(events).toEqual([
      { type: 'user-shell', text: 'echo hello' },
      {
        type: 'tool-start',
        id: expect.any(String),
        tool: 'run_shell_command',
        title: 'run_shell_command',
      },
      {
        type: 'tool-description',
        id: expect.any(String),
        description: 'echo hello',
      },
      {
        type: 'tool-output',
        id: expect.any(String),
        delta: 'hello world\n',
      },
    ]);
    expect(new Set(cardIds(events)).size).toBe(1);
    resolveResult(
      makeResult({
        output: 'hello world\n',
        rawOutput: Buffer.from('hello world\n'),
      }),
    );
    await done;
    expect(events[4]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: '',
    });
    expect(events[5]).toEqual({
      type: 'tool-end',
      id: expect.any(String),
      success: true,
      summary: 'ok',
    });
    expect(addHistoryMock).toHaveBeenCalledWith(
      llmClient,
      'echo hello',
      'hello world',
    );
  });

  it('lands the full output on the card when nothing was streamed', async () => {
    const { events, done, resolveResult } = setup();
    resolveResult(
      makeResult({
        output: 'hello world\n',
        rawOutput: Buffer.from('hello world\n'),
      }),
    );
    await done;
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: 'hello world',
    });
    expect(addHistoryMock).toHaveBeenCalledWith(
      llmClient,
      'echo hello',
      'hello world',
    );
  });

  it('prefixes the exit-code status and marks the card failed', async () => {
    const { events, done, resolveResult } = setup();
    resolveResult(
      makeResult({
        exitCode: 1,
        output: 'boom\n',
        rawOutput: Buffer.from('boom\n'),
      }),
    );
    await done;
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: 'Command exited with code 1.\nboom',
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'tool-end',
      success: false,
      summary: 'error',
    });
    expect(addHistoryMock).toHaveBeenCalledWith(
      llmClient,
      'echo hello',
      'Command exited with code 1.\nboom',
    );
  });

  it('marks a cancelled command as failed', async () => {
    const { events, done, resolveResult } = setup();
    resolveResult(makeResult({ aborted: true }));
    await done;
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: 'Command was cancelled.\n(Command produced no output)',
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'tool-end',
      success: false,
    });
  });

  it('keeps card ids unique across two calls in the same millisecond', async () => {
    executeMock.mockImplementation(() =>
      Promise.resolve({ pid: 1, result: Promise.resolve(makeResult()) }),
    );
    const run = () => {
      const events: OpenTuiStreamEvent[] = [];
      const done = executeUserShell(
        makeConfig(false),
        'echo hello',
        (event) => events.push(event),
        new AbortController().signal,
        { width: 80, height: 24 },
      );
      return { events, done };
    };
    // Fake timers freeze Date.now(), so both calls start within the same
    // millisecond — where a Date.now()-derived id would collide.
    const a = run();
    const b = run();
    await Promise.all([a.done, b.done]);
    const startId = (events: OpenTuiStreamEvent[]): string => {
      for (const event of events) {
        if (event.type === 'tool-start') return event.id;
      }
      throw new Error('no tool-start event');
    };
    expect(startId(a.events)).not.toBe(startId(b.events));
  });

  it('substitutes a placeholder for binary output', async () => {
    const { events, done, resolveResult } = setup();
    resolveResult(makeResult({ rawOutput: Buffer.from([0, 1, 2, 3]) }));
    await done;
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: '[Command produced binary output, which is not shown.]',
    });
  });

  it('warns when the command changed the directory and cleans up the pwd file', async () => {
    const { events, done, resolveResult, executeArgs } = setup();
    const wrapped = executeArgs[0] as string;
    expect(wrapped).toMatch(
      /^\{ echo hello; \}; __code=\$\?; pwd > "[^"]+"; exit \$__code$/,
    );
    const pwdFilePath = /pwd > "([^"]+)"/.exec(wrapped)![1];
    expect(executeArgs[4]).toBe(false);
    expect(executeArgs[5]).toEqual({ terminalWidth: 80, terminalHeight: 24 });
    fs.writeFileSync(pwdFilePath, '/tmp/elsewhere\n');
    resolveResult(
      makeResult({ output: 'moved\n', rawOutput: Buffer.from('moved\n') }),
    );
    await done;
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display:
        "WARNING: shell mode is stateless; the directory change to '/tmp/elsewhere' will not persist.\n\nmoved",
    });
    expect(fs.existsSync(pwdFilePath)).toBe(false);
  });

  it('does not stream pty output as deltas', async () => {
    const { events, done, emitOutput, resolveResult, executeArgs } =
      setup(true);
    expect(executeArgs[4]).toBe(true);
    vi.advanceTimersByTime(5000);
    emitOutput('full screen state');
    resolveResult(
      makeResult({ output: 'final\n', rawOutput: Buffer.from('final\n') }),
    );
    await done;
    expect(events.filter((event) => event.type === 'tool-output')).toHaveLength(
      0,
    );
    expect(events[events.length - 2]).toEqual({
      type: 'tool-result',
      id: expect.any(String),
      display: 'final',
    });
  });

  it('reports an execution failure as an error event and a failed card', async () => {
    const events: OpenTuiStreamEvent[] = [];
    executeMock.mockImplementation(() =>
      Promise.reject(new Error('spawn failed')),
    );
    await executeUserShell(
      makeConfig(false),
      'echo hello',
      (event) => events.push(event),
      new AbortController().signal,
      { width: 80, height: 24 },
    );
    expect(events[events.length - 2]).toEqual({
      type: 'error',
      text: 'An unexpected error occurred: spawn failed',
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'tool-end',
      success: false,
      summary: 'error',
    });
  });
});
