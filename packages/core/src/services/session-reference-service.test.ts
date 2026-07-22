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

  it('surfaces an error tool_result that has no functionResponse parts', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'tool_result',
          toolCallResult: {
            callId: 'c1',
            error: new Error('permission denied'),
          },
          message: {
            role: 'user',
            parts: [],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    // No functionResponse names to derive a tool line from; the record
    // contributes nothing to the slimmed output. Verify it does not throw
    // and the session still resolves.
    expect(res.text).toContain('Referenced session');
  });

  it('keeps assistant text on a turn that ALSO calls a tool', async () => {
    // An assistant turn that calls a tool is a SINGLE record carrying both the
    // text and the functionCall parts; the paired tool_result carries the
    // response. The assistant preamble must not be dropped.
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              { text: "I'll read the config to check X" },
              { functionCall: { name: 'read_file', args: {} } },
            ],
          },
        },
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
    expect(res.text).toContain("Assistant: I'll read the config to check X");
    // exactly one tool line (from the response side), not duplicated
    expect(res.text.match(/\[tool: read_file — ok\]/g)).toHaveLength(1);
    expect(res.text).not.toContain('BODY');
  });

  it('emits one tool line per parallel tool call in a single turn', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'tool_result',
          toolCallResult: { callId: 'c1' },
          message: {
            role: 'user',
            parts: [
              { functionResponse: { name: 'read_file', response: {} } },
              { functionResponse: { name: 'grep', response: {} } },
            ],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.text).toContain('[tool: read_file — ok]');
    expect(res.text).toContain('[tool: grep — ok]');
  });

  it('retains the newest turn even when it alone exceeds the budget', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'user',
          message: { role: 'user', parts: [{ text: 'old turn' }] },
        },
        {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [{ text: 'huge newest turn ' + 'y'.repeat(4000) }],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1', { budgetTokens: 50, title: 's1' });
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('[earlier turns omitted]');
    // the newest turn is still present, not collapsed to just the marker
    expect(res.text).toContain('huge newest turn');
    expect(res.text).not.toContain('old turn');
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
    const res = await svc.resolve('s1', { budgetTokens: 200, title: 's1' });
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

describe('title derivation', () => {
  it('derives title from first user message when no explicit title given', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Fix the auth bug' }] },
        },
        {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'Sure' }] },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.meta.title).toBe('Fix the auth bug');
    expect(res.text).toContain('Referenced session "Fix the auth bug"');
  });

  it('truncates a long first user message to 80 chars', async () => {
    const long = 'A'.repeat(120);
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'user',
          message: { role: 'user', parts: [{ text: long }] },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.meta.title).toHaveLength(80);
    expect(res.meta.title.endsWith('...')).toBe(true);
  });

  it('uses only the first line of a multi-line user message', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Short title\nLonger body text' }],
          },
        },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.meta.title).toBe('Short title');
  });

  it('falls back to sessionId when there are no user messages', async () => {
    const svc = makeSvc(
      fakeResumed([
        { type: 'system', subtype: 'custom_title', message: undefined },
      ]),
    );
    const res = await svc.resolve('s1');
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.meta.title).toBe('s1');
  });

  it('prefers an explicit title over derivation', async () => {
    const svc = makeSvc(
      fakeResumed([
        {
          type: 'user',
          message: { role: 'user', parts: [{ text: 'First message' }] },
        },
      ]),
    );
    const res = await svc.resolve('s1', { title: 'Custom Title' });
    if ('notFound' in res) throw new Error('unexpected');
    expect(res.meta.title).toBe('Custom Title');
  });
});
