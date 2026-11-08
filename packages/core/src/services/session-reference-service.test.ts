/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Content, Part } from '@google/genai';
import { SessionReferenceService } from './session-reference-service.js';
import type { ResumedSessionData } from './sessionService.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

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

/** Resolves session `s1` holding `messages`; fails if it is not found. */
async function resolveS1(
  messages: unknown[],
  opts?: { budgetTokens?: number; title?: string },
) {
  const svc = makeSvc(fakeResumed(messages));
  const res = await svc.resolve('s1', opts);
  if ('notFound' in res) throw new Error('unexpected');
  return { res, svc };
}

const user = (text: string) => ({ type: 'user', message: userText(text) });

const assistant = (message: Content) => ({ type: 'assistant', message });

const toolResult = (
  toolCallResult: Record<string, unknown>,
  ...parts: Part[]
) => ({
  type: 'tool_result',
  toolCallResult,
  message: content('user', ...parts),
});

/** A custom_title system record; `systemPayload` only when a title is given. */
const customTitle = (title?: string) => ({
  type: 'system',
  subtype: 'custom_title',
  ...(title !== undefined ? { systemPayload: { customTitle: title } } : {}),
  message: undefined,
});

/** 50 user turns of ~400 chars each: `turn 0 xxx…` to `turn 49 xxx…`. */
const manyTurns = () =>
  Array.from({ length: 50 }, (_, i) => user(`turn ${i} ` + 'x'.repeat(400)));

describe('SessionReferenceService', () => {
  it('returns notFound when session is missing', async () => {
    const svc = makeSvc(undefined);
    expect(await svc.resolve('missing')).toEqual({ notFound: true });
  });

  it('keeps user + assistant text and drops thoughts', async () => {
    const { res } = await resolveS1([
      user('hi'),
      assistant(
        content('model', { thought: true, text: 'reason' }, { text: 'hello' }),
      ),
    ]);
    expect(res.text).toContain('User: hi');
    expect(res.text).toContain('Assistant: hello');
    expect(res.text).not.toContain('reason');
  });

  it('uses clean user display metadata for referenced text and title', async () => {
    const { res } = await resolveS1([
      {
        type: 'user',
        message: content(
          'user',
          { text: 'expanded model prompt' },
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'hook-only context',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ),
        systemPayload: {
          displayText: 'raw @file prompt',
          hookContext: 'hook-only context',
        },
      },
    ]);

    expect(res.meta.title).toBe('raw @file prompt');
    expect(res.text).toContain('User: raw @file prompt');
    expect(res.text).not.toContain('hook-only context');
  });

  it('keeps notification model text instead of its display label', async () => {
    const { res } = await resolveS1([
      {
        type: 'user',
        subtype: 'notification',
        message: userText('notification model text'),
        systemPayload: { displayText: 'Background agent completed' },
      },
    ]);

    expect(res.text).toContain('User: notification model text');
    expect(res.text).not.toContain('Background agent completed');
  });

  it('collapses tool calls to one-line summaries without result bodies', async () => {
    const { res } = await resolveS1([
      toolResult({ callId: 'c1' }, fnResponse('read_file', { huge: 'BODY' })),
    ]);
    expect(res.text).toContain('[tool: read_file — ok]');
    expect(res.text).not.toContain('BODY');
  });

  it('marks a failed tool call as error', async () => {
    const { res } = await resolveS1([
      toolResult(
        { callId: 'c1', error: new Error('boom') },
        fnResponse('write_file', {}),
      ),
    ]);
    expect(res.text).toContain('[tool: write_file — error]');
  });

  it('marks a cancelled tool call as cancelled, not ok', async () => {
    const { res } = await resolveS1([
      toolResult(
        { callId: 'c1', status: 'cancelled' },
        fnResponse('read_file', {}),
      ),
    ]);
    expect(res.text).toContain('[tool: read_file — cancelled]');
    expect(res.text).not.toContain('[tool: read_file — ok]');
  });

  it('maps a successful tool call status to the ok display label', async () => {
    const { res } = await resolveS1([
      toolResult(
        { callId: 'c1', status: 'success' },
        fnResponse('read_file', {}),
      ),
    ]);
    expect(res.text).toContain('[tool: read_file — ok]');
    expect(res.text).not.toContain('success');
  });

  it('surfaces an error tool_result that has no functionResponse parts', async () => {
    const { res } = await resolveS1([
      toolResult({ callId: 'c1', error: new Error('permission denied') }),
    ]);
    // No functionResponse names to derive a tool line from; the record
    // contributes nothing to the slimmed output. Verify it does not throw
    // and the session still resolves.
    expect(res.text).toContain('Referenced session');
  });

  it('keeps assistant text on a turn that ALSO calls a tool', async () => {
    // An assistant turn that calls a tool is a SINGLE record carrying both the
    // text and the functionCall parts; the paired tool_result carries the
    // response. The assistant preamble must not be dropped.
    const { res } = await resolveS1([
      assistant(
        content(
          'model',
          { text: "I'll read the config to check X" },
          fnCall('read_file', {}),
        ),
      ),
      toolResult({ callId: 'c1' }, fnResponse('read_file', { huge: 'BODY' })),
    ]);
    expect(res.text).toContain("Assistant: I'll read the config to check X");
    // exactly one tool line (from the response side), not duplicated
    expect(res.text.match(/\[tool: read_file — ok\]/g)).toHaveLength(1);
    expect(res.text).not.toContain('BODY');
  });

  it('emits one tool line per parallel tool call in a single turn', async () => {
    const { res } = await resolveS1([
      toolResult(
        { callId: 'c1' },
        fnResponse('read_file', {}),
        fnResponse('grep', {}),
      ),
    ]);
    expect(res.text).toContain('[tool: read_file — ok]');
    expect(res.text).toContain('[tool: grep — ok]');
  });

  it('retains the newest turn even when it alone exceeds the budget', async () => {
    const { res } = await resolveS1(
      [
        user('old turn'),
        assistant(modelText('huge newest turn ' + 'y'.repeat(4000))),
      ],
      { budgetTokens: 50, title: 's1' },
    );
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('[earlier turns omitted]');
    // the newest turn is still present, not collapsed to just the marker
    expect(res.text).toContain('huge newest turn');
    expect(res.text).not.toContain('old turn');
  });

  it('tail-trims to budget and marks truncated', async () => {
    const { res } = await resolveS1(manyTurns(), {
      budgetTokens: 200,
      title: 's1',
    });
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('[earlier turns omitted]');
    expect(res.text).toContain('turn 49'); // newest retained
    expect(res.text).not.toContain('turn 0 '); // oldest dropped
  });

  it('emits a placeholder when there is no textual content', async () => {
    const { res } = await resolveS1([customTitle()]);
    expect(res.text).toContain('(no textual content)');
    expect(res.truncated).toBe(false);
  });

  it('includes header overhead in approxTokens', async () => {
    const { res, svc } = await resolveS1([user('hello')], { title: 'Test' });
    // approxTokens must account for the header overhead, not just the body.
    const bodyOnly = svc['estimate'](['User: hello']);
    expect(res.meta.approxTokens).toBeGreaterThan(bodyOnly);
  });

  it('excludes omission marker cost from approxTokens when not truncated', async () => {
    const { res, svc } = await resolveS1([user('hello')], { title: 'Test' });
    expect(res.truncated).toBe(false);
    const header = '--- Referenced session "Test" (slimmed, read-only) ---';
    const expected =
      svc['estimate'](['User: hello']) + svc['estimate']([header]);
    expect(res.meta.approxTokens).toBe(expected);
  });

  it('includes omission marker cost in approxTokens when truncated', async () => {
    const { res, svc } = await resolveS1(manyTurns(), {
      budgetTokens: 200,
      title: 's1',
    });
    expect(res.truncated).toBe(true);
    const header = '--- Referenced session "s1" (slimmed, read-only) ---';
    const overhead = svc['estimate']([header, '[earlier turns omitted]']);
    const kept = res.text
      .replace(header + '\n', '')
      .replace('[earlier turns omitted]\n', '')
      .split('\n');
    expect(res.meta.approxTokens).toBe(svc['estimate'](kept) + overhead);
  });
});

describe('title derivation', () => {
  it('derives title from first user message when no explicit title given', async () => {
    const { res } = await resolveS1([
      user('Fix the auth bug'),
      assistant(modelText('Sure')),
    ]);
    expect(res.meta.title).toBe('Fix the auth bug');
    expect(res.text).toContain('Referenced session "Fix the auth bug"');
  });

  it('prefers a custom_title system record over the first user message', async () => {
    const { res } = await resolveS1([
      customTitle('Auth bug investigation'),
      user('Fix the auth bug'),
    ]);
    expect(res.meta.title).toBe('Auth bug investigation');
  });

  it('uses the last custom_title when a session has been renamed', async () => {
    const { res } = await resolveS1([
      customTitle('Fix the auth bug'),
      user('hello'),
      customTitle('Auth investigation'),
    ]);
    expect(res.meta.title).toBe('Auth investigation');
  });

  it('truncates a long first user message to 80 chars', async () => {
    const { res } = await resolveS1([user('A'.repeat(120))]);
    expect(res.meta.title).toHaveLength(80);
    expect(res.meta.title.endsWith('...')).toBe(true);
  });

  it('uses only the first line of a multi-line user message', async () => {
    const { res } = await resolveS1([user('Short title\nLonger body text')]);
    expect(res.meta.title).toBe('Short title');
  });

  it('falls back to sessionId when there are no user messages', async () => {
    const { res } = await resolveS1([customTitle()]);
    expect(res.meta.title).toBe('s1');
  });

  it('prefers an explicit title over derivation', async () => {
    const { res } = await resolveS1([user('First message')], {
      title: 'Custom Title',
    });
    expect(res.meta.title).toBe('Custom Title');
  });
});
