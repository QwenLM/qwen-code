/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  createEventMapper,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';

type AnyEv = Parameters<ReturnType<typeof createEventMapper>>[0];

/** Extracts the text deltas of one mapped event batch. */
const texts = (out: OpenTuiStreamEvent[]) =>
  out
    .filter((e): e is Extract<OpenTuiStreamEvent, { type: 'text' }> =>
      e.type === 'text' ? true : false,
    )
    .map((e) => e.delta);

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
      expect(texts(out)).toEqual([
        '⚠  Response truncated due to token limits.',
      ]);
    });

    it('warns on safety finish reasons', () => {
      const map = createEventMapper();
      const out = map({
        type: 'finished',
        value: { reason: 'IMAGE_SAFETY' },
      } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        '⚠  Response stopped due to image safety violations.',
      ]);
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
        { type: 'segment-end' },
        { type: 'text', delta: '[error] boom' },
      ]);
    });

    it('uses the context formatError (parseAndFormatApiError seam)', () => {
      const map = createEventMapper({
        formatError: () => '[API Error: 429]\nPress Ctrl+Y to retry',
      });
      const out = map({
        type: 'error',
        value: { error: { message: 'quota', status: 429 } },
      } as unknown as AnyEv);
      expect(out).toEqual([
        { type: 'segment-end' },
        {
          type: 'text',
          delta: '[error] [API Error: 429]\nPress Ctrl+Y to retry',
        },
      ]);
    });
  });

  describe('previously dropped core events', () => {
    it('maps chat_compressed with token counts and reason', () => {
      const map = createEventMapper({ getModelName: () => 'qwen3-max' });
      const out = map({
        type: 'chat_compressed',
        value: { originalTokenCount: 1200, newTokenCount: 300 },
      } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        'IMPORTANT: This conversation approached the input token limit for qwen3-max. ' +
          'A compressed context will be sent for future messages (compressed from: ' +
          '1200 to 300 tokens).',
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
        },
      } as unknown as AnyEv);
      expect(texts(out)[0]).toContain(
        'accumulated enough tool screenshots to trigger compaction for m',
      );
    });

    it('maps retry with countdown info to text', () => {
      const map = createEventMapper();
      const out = map({
        type: 'retry',
        retryInfo: { attempt: 2, maxRetries: 3, delayMs: 4200 },
      } as unknown as AnyEv);
      expect(texts(out)).toEqual(['Retrying in 5s… (attempt 2/3)']);
    });

    it('maps retry without retryInfo to nothing (ink parity)', () => {
      const map = createEventMapper();
      expect(map({ type: 'retry' } as unknown as AnyEv)).toEqual([]);
    });

    it('maps model_fallback to a notification text', () => {
      const map = createEventMapper();
      const out = map({
        type: 'model_fallback',
        fromModel: 'qwen3-coder',
        toModel: 'qwen3-max',
      } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        'Model qwen3-coder unavailable, falling back to qwen3-max',
      ]);
    });

    it('maps session_token_limit_exceeded to error + solutions', () => {
      const map = createEventMapper();
      const out = map({
        type: 'session_token_limit_exceeded',
        value: { currentTokens: 130000, limit: 128000, message: '' },
      } as unknown as AnyEv);
      const text = texts(out).join('');
      expect(text).toContain('[error] Session token limit exceeded:');
      expect(text).toContain('Use /clear command');
      expect(text).toContain('"sessionTokenLimit"');
      expect(text).toContain('Use /compress command');
    });

    it('maps max_session_turns with the configured limit', () => {
      const map = createEventMapper({ getMaxSessionTurns: () => 42 });
      const out = map({ type: 'max_session_turns' } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        'The session has reached the maximum number of turns: 42. ' +
          'Please update this limit in your setting.json file.',
      ]);
    });

    it('maps loop_detected to the halt warning text', () => {
      const map = createEventMapper();
      const out = map({ type: 'loop_detected' } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        'A potential loop was detected. This can happen due to repetitive ' +
          'tool calls or other model behavior. The request has been halted.',
      ]);
    });

    it('maps user_cancelled to an info notice', () => {
      const map = createEventMapper();
      const out = map({ type: 'user_cancelled' } as unknown as AnyEv);
      expect(texts(out)).toEqual(['User cancelled the request.']);
    });

    it('maps citation to an info text (no citation surface yet)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'citation',
        value: 'Sources: [1] https://example.com',
      } as unknown as AnyEv);
      expect(texts(out)).toEqual(['Sources: [1] https://example.com']);
    });

    it('maps hook_system_message with the Stop-says prefix', () => {
      const map = createEventMapper();
      const out = map({
        type: 'hook_system_message',
        value: 'run the tests',
      } as unknown as AnyEv);
      expect(texts(out)).toEqual(['Stop says: run the tests']);
    });

    it('maps user_prompt_submit_blocked to reason + original prompt', () => {
      const map = createEventMapper();
      const out = map({
        type: 'user_prompt_submit_blocked',
        value: { reason: 'blocked by policy', originalPrompt: 'do it' },
      } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        '✕ UserPromptSubmit operation blocked by hook:\nblocked by policy\n\n' +
          'Original prompt: do it',
      ]);
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
      expect(texts(out)).toEqual([
        'Ran 2 stop hooks\n  ⎿  Stop hook error: last failure',
      ]);
    });
  });

  describe('goal events', () => {
    it('maps goal_state with a displayable cause to a status line', () => {
      const map = createEventMapper();
      const out = map({
        type: 'goal_state',
        value: {
          goal: {
            objective: 'ship it',
            status: 'active',
            turnCount: 2,
          },
          activity: 'running',
        },
        cause: 'create',
      } as unknown as AnyEv);
      expect(texts(out)).toEqual(['Goal running · 2 turns\nGoal: ship it']);
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

    it('dedupes identical consecutive goal texts', () => {
      const map = createEventMapper();
      const ev = {
        type: 'goal_state',
        value: { goal: { objective: 'ship it', status: 'active' } },
        cause: 'checkpoint', // silent cause first
      } as unknown as AnyEv;
      map(ev);
      const out = map({
        type: 'goal_state',
        value: { goal: { objective: 'ship it', status: 'active' } },
        cause: 'create',
      } as unknown as AnyEv);
      expect(texts(out)).toHaveLength(1);
      // Same text again → suppressed.
      const again = map({
        type: 'goal_state',
        value: { goal: { objective: 'ship it', status: 'active' } },
        cause: 'resume',
      } as unknown as AnyEv);
      expect(texts(again)).toHaveLength(0);
    });

    it('maps goal cleared (null goal + clear cause)', () => {
      const map = createEventMapper();
      const out = map({
        type: 'goal_state',
        value: { goal: null },
        cause: 'clear',
      } as unknown as AnyEv);
      expect(texts(out)).toEqual(['Goal cleared']);
    });

    it('maps active_goal (legacy shape) to a status line', () => {
      const map = createEventMapper();
      const out = map({
        type: 'active_goal',
        value: { condition: 'all tests green', iterations: 1 },
      } as unknown as AnyEv);
      expect(texts(out)).toEqual([
        'Goal active · 1 turn\nGoal: all tests green',
      ]);
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
});
