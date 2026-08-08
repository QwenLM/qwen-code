/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import { createEventMapper } from './event-adapter.js';

type AnyEv = Parameters<ReturnType<typeof createEventMapper>>[0];

describe('event-adapter (ServerGeminiStreamEvent -> neutral)', () => {
  it('maps content to text delta', () => {
    const map = createEventMapper();
    expect(
      map({ type: 'content', value: 'hello' } as unknown as AnyEv),
    ).toEqual([{ type: 'text', delta: 'hello' }]);
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

  it('maps finished to done', () => {
    const map = createEventMapper();
    expect(map({ type: 'finished', value: {} } as unknown as AnyEv)).toEqual([
      { type: 'done' },
    ]);
  });
});
