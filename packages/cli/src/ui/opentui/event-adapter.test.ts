/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { createEventMapper, renderResultDisplay } from './event-adapter.js';

type AnyEv = Parameters<ReturnType<typeof createEventMapper>>[0];

describe('event-adapter (ServerGeminiStreamEvent -> neutral)', () => {
  it('maps content to text delta', () => {
    const map = createEventMapper();
    expect(
      map({ type: 'content', value: 'hello' } as unknown as AnyEv),
    ).toEqual([{ type: 'text', delta: 'hello' }]);
  });

  it('maps content inlineData parts to image events', () => {
    const map = createEventMapper();
    expect(
      map({
        type: 'content',
        value: '',
        parts: [
          { text: 'look:' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
      } as unknown as AnyEv),
    ).toEqual([
      { type: 'text', delta: 'look:' },
      { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
    ]);
  });

  it('closes thought before first content', () => {
    const map = createEventMapper();
    expect(
      map({
        type: 'thought',
        value: { description: 'planning' },
      } as unknown as AnyEv),
    ).toEqual([{ type: 'thinking', delta: 'planning' }]);
    expect(
      map({ type: 'content', value: 'answer' } as unknown as AnyEv),
    ).toEqual([{ type: 'thinking-end' }, { type: 'text', delta: 'answer' }]);
  });

  it('maps tool request/response', () => {
    const map = createEventMapper();
    const s = map({
      type: 'tool_call_request',
      value: { callId: 'c1', name: 'shell' },
    } as unknown as AnyEv);
    expect(s[0].type).toBe('tool-start');
    expect(
      map({
        type: 'tool_call_response',
        value: { callId: 'c1', error: undefined },
      } as unknown as AnyEv),
    ).toEqual([{ type: 'tool-end', id: 'c1', success: true, summary: 'ok' }]);
  });

  it('carries FileDiff resultDisplay as a structured diff payload', () => {
    const map = createEventMapper();
    const fileDiff = '@@ -1,1 +1,1 @@\n-old\n+new';
    const out = map({
      type: 'tool_call_response',
      value: {
        callId: 'c1',
        resultDisplay: { fileDiff, fileName: 'a.txt' },
      },
    } as unknown as AnyEv);
    expect(out).toEqual([
      {
        type: 'tool-result',
        id: 'c1',
        display: '',
        diff: { fileDiff, fileName: 'a.txt' },
      },
      { type: 'tool-end', id: 'c1', success: true, summary: 'ok' },
    ]);
  });

  it('carries TodoWrite resultDisplay as a structured todos payload', () => {
    const map = createEventMapper();
    const out = map({
      type: 'tool_call_response',
      value: {
        callId: 'c1',
        resultDisplay: {
          type: 'todo_list',
          todos: [
            { id: 'a', content: 'A', status: 'in_progress' },
            { id: 'b', content: 'B', status: 'pending' },
            { id: 'c', content: 'C', status: 'completed' },
          ],
        },
      },
    } as unknown as AnyEv);
    expect(out[0]).toEqual({
      type: 'tool-result',
      id: 'c1',
      display: '',
      todos: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'b', content: 'B', status: 'pending' },
        { id: 'c', content: 'C', status: 'completed' },
      ],
    });
  });

  it('drops malformed todo entries but keeps valid ones', () => {
    const map = createEventMapper();
    const out = map({
      type: 'tool_call_response',
      value: {
        callId: 'c1',
        resultDisplay: {
          type: 'todo_list',
          todos: [
            { id: 'a', content: 'A', status: 'pending' },
            { content: 'no id' },
            'garbage',
          ],
        },
      },
    } as unknown as AnyEv);
    expect(out[0]).toEqual({
      type: 'tool-result',
      id: 'c1',
      display: '',
      todos: [{ id: 'a', content: 'A', status: 'pending' }],
    });
  });

  it('carries AnsiOutputDisplay as a structured token grid', () => {
    const map = createEventMapper();
    const grid = [
      [
        {
          text: 'ok',
          bold: true,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
          fg: '#00FF00',
          bg: '',
        },
      ],
      [],
    ];
    const out = map({
      type: 'tool_call_response',
      value: {
        callId: 'c1',
        resultDisplay: {
          ansiOutput: [...grid, ['nope' as unknown as object]],
          totalLines: 30,
          totalBytes: 4096,
        },
      },
    } as unknown as AnyEv);
    expect(out[0]).toEqual({
      type: 'tool-result',
      id: 'c1',
      display: '',
      ansi: {
        grid: [grid[0], grid[1], []],
        totalLines: 30,
        totalBytes: 4096,
      },
    });
  });

  describe('finished (premature-done fix)', () => {
    it('maps finished(STOP) to a segment marker, not done', () => {
      const map = createEventMapper();
      expect(
        map({
          type: 'finished',
          value: { reason: 'STOP' },
        } as unknown as AnyEv),
      ).toEqual([{ type: 'segment-end' }]);
    });

    it('maps finished without reason to a bare segment marker', () => {
      const map = createEventMapper();
      expect(map({ type: 'finished', value: {} } as unknown as AnyEv)).toEqual([
        { type: 'segment-end' },
      ]);
    });

    it('warns on non-STOP finish reasons (ink truncation copy)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'finished',
        value: { reason: 'MAX_TOKENS' },
      } as unknown as AnyEv);
      expect(out).toContainEqual({ type: 'segment-end' });
      expect(out).toContainEqual({
        type: 'info',
        text: '⚠  Response truncated due to token limits.',
      });
    });

    it('warns on safety finish reasons', () => {
      const map = createEventMapper();
      const out = map({
        type: 'finished',
        value: { reason: 'IMAGE_SAFETY' },
      } as unknown as AnyEv);
      expect(out).toContainEqual({
        type: 'info',
        text: '⚠  Response stopped due to image safety violations.',
      });
    });
  });

  describe('error events', () => {
    it('falls back to the raw message without a formatter', () => {
      const map = createEventMapper();
      const out = map({
        type: 'error',
        value: { error: { message: 'boom' } },
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'error',
          text: 'boom',
          hint: 'Press Ctrl+Y to retry',
        },
      ]);
    });

    it('uses the context formatError (parseAndFormatApiError seam)', () => {
      const map = createEventMapper({
        formatError: () => '[API Error: 429]',
      });
      const out = map({
        type: 'error',
        value: { error: { message: 'quota', status: 429 } },
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'error',
          text: '[API Error: 429]',
          hint: 'Press Ctrl+Y to retry',
        },
      ]);
    });
  });

  describe('previously dropped core events', () => {
    // ink parity: useGeminiStream's handleChatCompressionEvent adds a
    // `type: 'info'` history item (InfoMessage row) for auto-compact.
    it('maps chat_compressed to an info notice with token counts', () => {
      const map = createEventMapper({ getModelName: () => 'qwen3-max' });
      const out = map({
        type: 'chat_compressed',
        value: { originalTokenCount: 1200, newTokenCount: 300 },
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'retry-countdown-clear' },
        {
          type: 'info',
          text:
            'IMPORTANT: This conversation approached the input token limit for qwen3-max. ' +
            'A compressed context will be sent for future messages (compressed from: ' +
            '1200 to 300 tokens).',
        },
      ]);
    });

    it('labels image-overflow compaction triggers', () => {
      const map = createEventMapper({ getModelName: () => 'm' });
      const out = map({
        type: 'chat_compressed',
        value: {
          originalTokenCount: 10,
          newTokenCount: 5,
          triggerReason: 'image_overflow',
          warning: 'screenshots dropped',
        },
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'retry-countdown-clear' },
        {
          type: 'info',
          text: expect.stringContaining(
            'accumulated enough tool screenshots to trigger compaction for m',
          ),
        },
      ]);
      expect((out[1] as { text: string }).text).toContain(
        '\n⚠️ screenshots dropped',
      );
    });

    it('maps retry with retryInfo to a structured countdown event', () => {
      const map = createEventMapper();
      const skipDelay = () => {};
      const out = map({
        type: 'retry',
        retryInfo: {
          attempt: 2,
          maxRetries: 3,
          delayMs: 4200,
          message: 'rate limited',
          skipDelay,
        },
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'retry-countdown',
          attempt: 2,
          maxRetries: 3,
          delayMs: 4200,
          message: 'rate limited',
          skipDelay,
          isContinuation: undefined,
        },
      ]);
    });

    it('maps a continuation retry, passing isContinuation through', () => {
      const map = createEventMapper();
      const out = map({
        type: 'retry',
        retryInfo: { attempt: 1, maxRetries: 3, delayMs: 5000 },
        isContinuation: true,
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'retry-countdown',
          attempt: 1,
          maxRetries: 3,
          delayMs: 5000,
          message: undefined,
          skipDelay: undefined,
          isContinuation: true,
        },
      ]);
    });

    it('maps retry without retryInfo to a countdown clear (ink parity)', () => {
      const map = createEventMapper();
      expect(map({ type: 'retry' } as unknown as AnyEv)).toEqual([
        { type: 'retry-countdown-clear' },
      ]);
    });

    it('maps model_fallback to a retry clear + info notice', () => {
      const map = createEventMapper();
      const out = map({
        type: 'model_fallback',
        fromModel: 'qwen3-coder',
        toModel: 'qwen3-max',
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'retry-countdown-clear' },
        {
          type: 'info',
          text: 'Model qwen3-coder unavailable, falling back to qwen3-max',
        },
      ]);
    });

    it('maps session_token_limit_exceeded to error + solutions', () => {
      const map = createEventMapper();
      const out = map({
        type: 'session_token_limit_exceeded',
        value: { currentTokens: 130000, limit: 128000, message: '' },
      } as unknown as AnyEv);
      expect(out).toHaveLength(1);
      const item = out[0] as { type: string; text: string };
      expect(item.type).toBe('error');
      expect(item.text).toContain('✗ Session token limit exceeded:');
      expect(item.text).toContain('Use /clear command');
      expect(item.text).toContain('"sessionTokenLimit"');
      expect(item.text).toContain('Use /compress command');
    });

    it('maps max_session_turns with the configured limit', () => {
      const map = createEventMapper({ getMaxSessionTurns: () => 42 });
      const out = map({ type: 'max_session_turns' } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'info',
          text:
            'The session has reached the maximum number of turns: 42. ' +
            'Please update this limit in your setting.json file.',
        },
      ]);
    });

    it('maps loop_detected to the halt warning text', () => {
      const map = createEventMapper();
      const out = map({ type: 'loop_detected' } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'info',
          text:
            'A potential loop was detected. This can happen due to repetitive ' +
            'tool calls or other model behavior. The request has been halted.',
        },
      ]);
    });

    it('maps user_cancelled to a retry clear + info notice', () => {
      const map = createEventMapper();
      const out = map({ type: 'user_cancelled' } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'retry-countdown-clear' },
        { type: 'info', text: 'User cancelled the request.' },
      ]);
    });

    it('maps citation to an info text (no citation surface yet)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'citation',
        value: 'Sources: [1] https://example.com',
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'info', text: 'Sources: [1] https://example.com' },
      ]);
    });

    it('maps hook_system_message to a stop-hook markdown message', () => {
      const map = createEventMapper();
      const out = map({
        type: 'hook_system_message',
        value: 'run the tests',
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'stop-hook-message', message: 'run the tests' },
      ]);
    });

    it('maps user_prompt_submit_blocked to reason + original prompt', () => {
      const map = createEventMapper();
      const out = map({
        type: 'user_prompt_submit_blocked',
        value: { reason: 'blocked by policy', originalPrompt: 'do it' },
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'warning',
          text:
            '✕ UserPromptSubmit operation blocked by hook:\nblocked by policy\n\n' +
            'Original prompt: do it',
        },
      ]);
    });

    it('redacts the echoed prompt through sanitizeSensitiveText (R1-79)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'user_prompt_submit_blocked',
        value: {
          reason: 'blocked by policy',
          originalPrompt: 'sk-abcdefghijklmnopqrstuvw run the deploy',
        },
      } as unknown as AnyEv);
      expect(out[0]).toMatchObject({ type: 'warning' });
      const text = (out[0] as { text: string }).text;
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvw');
    });

    it('truncates the echoed prompt at 200 chars (R1-79)', () => {
      const map = createEventMapper();
      const long = 'x'.repeat(300);
      const out = map({
        type: 'user_prompt_submit_blocked',
        value: { reason: 'blocked', originalPrompt: long },
      } as unknown as AnyEv);
      const text = (out[0] as { text: string }).text;
      const echoed = text.slice(
        text.lastIndexOf('Original prompt: ') + 'Original prompt: '.length,
      );
      expect(echoed.length).toBe(200);
      expect(echoed.endsWith('...')).toBe(true);
    });

    it('maps stop_hook_loop to the hook error text', () => {
      const map = createEventMapper();
      const out = map({
        type: 'stop_hook_loop',
        value: {
          iterationCount: 3,
          reasons: ['first', 'last failure'],
          stopHookCount: 2,
        },
      } as unknown as AnyEv);
      expect(out).toEqual([
        {
          type: 'info',
          text: 'Ran 2 stop hooks\n  ⎿  Stop hook error: last failure',
        },
      ]);
    });
  });

  describe('goal events', () => {
    // ink parity: addItem({type: 'goal_state', snapshot, cause}) renders via
    // GoalStatusMessage (GoalStateCard) — the adapter passes the snapshot
    // through untouched.
    it('maps goal_state with a displayable cause to a goal event', () => {
      const map = createEventMapper();
      const snapshot = {
        goal: {
          objective: 'ship it',
          status: 'active',
          turnCount: 2,
        },
        activity: 'running',
      };
      const out = map({
        type: 'goal_state',
        value: snapshot,
        cause: 'create',
      } as unknown as AnyEv);
      expect(out).toEqual([{ type: 'goal', snapshot, cause: 'create' }]);
    });

    it('stays silent for non-displayable causes', () => {
      const map = createEventMapper();
      expect(
        map({
          type: 'goal_state',
          value: {
            goal: { objective: 'ship it', status: 'active', turnCount: 3 },
            activity: 'running',
          },
          cause: 'turn_finished',
        } as unknown as AnyEv),
      ).toEqual([]);
    });

    it('stays silent when cause is missing (ink parity)', () => {
      const map = createEventMapper();
      expect(
        map({
          type: 'goal_state',
          value: { goal: { objective: 'ship it', status: 'active' } },
        } as unknown as AnyEv),
      ).toEqual([]);
    });

    it('does not dedupe consecutive displayable snapshots (ink parity)', () => {
      const map = createEventMapper();
      const value = { goal: { objective: 'ship it', status: 'active' } };
      const first = map({
        type: 'goal_state',
        value,
        cause: 'create',
      } as unknown as AnyEv);
      const again = map({
        type: 'goal_state',
        value,
        cause: 'resume',
      } as unknown as AnyEv);
      expect(first).toHaveLength(1);
      expect(again).toHaveLength(1);
    });

    it('maps goal cleared (null goal + clear cause)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'goal_state',
        value: { goal: null },
        cause: 'clear',
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'goal', snapshot: { goal: null }, cause: 'clear' },
      ]);
    });

    it('ignores the legacy active_goal projection (ink parity)', () => {
      const map = createEventMapper();
      expect(
        map({
          type: 'active_goal',
          value: { condition: 'all tests green', iterations: 1 },
        } as unknown as AnyEv),
      ).toEqual([]);
    });
  });

  it('stringifies AnsiOutputDisplay live shell output', () => {
    expect(
      renderResultDisplay({
        ansiOutput: [
          [{ text: 'hello ' }, { text: 'world' }],
          [{ text: 'line2' }],
        ],
      }),
    ).toBe('hello world\nline2');
  });

  describe('citation visibility gate (R1-20)', () => {
    it('suppresses citations when showCitations() is false', () => {
      const map = createEventMapper({ showCitations: () => false });
      expect(
        map({
          type: 'citation',
          value: 'Sources: [1] https://example.com',
        } as unknown as AnyEv),
      ).toEqual([]);
    });

    it('still shows citations when showCitations() is true', () => {
      const map = createEventMapper({ showCitations: () => true });
      expect(
        map({
          type: 'citation',
          value: 'Sources: [1] https://example.com',
        } as unknown as AnyEv),
      ).toEqual([{ type: 'info', text: 'Sources: [1] https://example.com' }]);
    });
  });

  describe('renderResultDisplay structured displays (R1-66/68)', () => {
    it('renders plan_summary as message + plan', () => {
      expect(
        renderResultDisplay({
          type: 'plan_summary',
          message: 'User approved.',
          plan: 'step 1',
        }),
      ).toBe('User approved.\nstep 1');
    });

    it('renders nothing for team_result and task_list', () => {
      expect(renderResultDisplay({ type: 'team_result', summary: 'x' })).toBe(
        '',
      );
      expect(renderResultDisplay({ type: 'task_list', message: 'y' })).toBe('');
    });

    it('renders mcp_tool_progress with the ink spinner line', () => {
      expect(
        renderResultDisplay({
          type: 'mcp_tool_progress',
          progress: 5,
          total: 10,
        }),
      ).toBe('◌ [5/10] Progress: 5');
      expect(
        renderResultDisplay({
          type: 'mcp_tool_progress',
          progress: 2,
          message: 'working',
        }),
      ).toBe('◌ [2] working');
    });

    it('renders mcp_app with its fallbackText only', () => {
      expect(
        renderResultDisplay({
          type: 'mcp_app',
          html: '<b>must not leak</b>',
          fallbackText: 'app fallback',
        }),
      ).toBe('app fallback');
    });
  });
});
