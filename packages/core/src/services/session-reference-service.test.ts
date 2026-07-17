/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionReferenceService } from './session-reference-service.js';
import type { ResumedSessionData } from './sessionService.js';

function fakeResumed(messages: unknown[]): ResumedSessionData {
  return {
    conversation: {
      sessionId: 's1',
      projectHash: 'h',
      startTime: '',
      lastUpdated: '',
      messages: messages as never,
    },
    filePath: '/tmp/s1.jsonl',
    lastCompletedUuid: null,
  } as ResumedSessionData;
}

function makeSvc(resumed: ResumedSessionData | undefined) {
  const svc = new SessionReferenceService('/proj');
  (svc as unknown as { loadSession: () => Promise<unknown> }).loadSession = vi
    .fn()
    .mockResolvedValue(resumed);
  return svc;
}

describe('SessionReferenceService', () => {
  it('returns notFound when session is missing', async () => {
    const svc = makeSvc(undefined);
    expect(await svc.resolve('missing')).toEqual({ notFound: true });
  });

  it('keeps user + assistant text and drops thoughts', async () => {
    const svc = makeSvc(
      fakeResumed([
        { type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } },
        {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [{ thought: true, text: 'reason' }, { text: 'hello' }],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('User: hi');
    expect(res.text).toContain('Assistant: hello');
    expect(res.text).not.toContain('reason');
  });

  it('collapses tool calls to one-line summaries without result bodies', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'tool_result',
          toolCallResult: { callId: 'c1' },
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { huge: 'BODY' },
                },
              },
            ],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('[tool: read_file — ok]');
    expect(res.text).not.toContain('BODY');
  });

  it('marks a failed tool call as error', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'tool_result',
          toolCallResult: { callId: 'c1', error: new Error('boom') },
          message: {
            role: 'user',
            parts: [{ functionResponse: { name: 'write_file', response: {} } }],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('[tool: write_file — error]');
  });

  it('tail-trims to budget and marks truncated', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: `turn ${i} ` + 'x'.repeat(400) }],
      },
    }));
    const svc = makeSvc(fakeResumed(many));
    const res = await svc.resolve('s1', { budgetTokens: 200 });
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('[earlier turns omitted]');
    expect(res.text).toContain('turn 49'); // newest retained
    expect(res.text).not.toContain('turn 0 '); // oldest dropped
  });

  it('emits a placeholder when there is no textual content', async () => {
    const svc = makeSvc(
      fakeResumed([
        { type: 'system', subtype: 'custom_title', message: undefined },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('(no textual content)');
    expect(res.truncated).toBe(false);
  });
});
