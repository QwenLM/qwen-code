/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type {
  ManagedSessionEvent,
  ManagedSessionJsonValue,
} from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import { prepareManagedSideQuery } from './managed-side-query.js';

function fixture() {
  const events: ManagedSessionEvent[] = [];
  const bodies = new Map<string, Buffer>();
  const resources: ManagedSessionResourceStore = {
    publish: async () => {
      throw new Error('read-only');
    },
    read: async (ref) => {
      const body = bodies.get(ref.resourceId);
      if (!body) throw new Error('missing');
      return body;
    },
  };
  const event = (
    kind: ManagedSessionEvent['kind'],
    payload: Record<string, ManagedSessionJsonValue>,
  ) => {
    events.push({
      v: 1,
      sequence: events.length + 1,
      eventId: `event-${events.length}`,
      sessionKey: { tenantId: 't', workspaceId: 'w', sessionId: 's' },
      kind,
      occurredAt: 1,
      payload,
    });
  };
  const message = (
    record: Partial<ChatRecord> & Pick<ChatRecord, 'type' | 'message'>,
  ) => {
    const id = `record-${events.length}`;
    const bytes = Buffer.from(
      JSON.stringify({
        uuid: id,
        sessionId: 's',
        timestamp: '2026-01-01T00:00:00Z',
        parentUuid: null,
        ...record,
      }),
    );
    bodies.set(id, bytes);
    event('message.committed', {
      messageId: id,
      contentRef: {
        resourceId: id,
        kind: 'managed-message',
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    });
  };
  const turn = (
    id: string,
    outcome: string | undefined,
    question: string,
    answer: string,
    source = 'web_shell',
  ) => {
    event('input.accepted', { inputId: id, turnId: id, source });
    message({
      type: 'user',
      promptId: id,
      provenance: 'real_user',
      message: { role: 'user', parts: [{ text: question }] },
    });
    // Assistant/tool records do not have promptId in the real recorder.
    message({
      type: 'assistant',
      provenance: 'assistant_output',
      message: { role: 'model', parts: [{ text: answer }] },
    });
    if (outcome) event('turn.settled', { turnId: id, outcome });
  };
  const prepare = (kind: 'btw' | 'recap', extra = {}) =>
    prepareManagedSideQuery(
      {
        kind,
        question: '侧问题',
        privateHistory: [],
        throughSequence: events.length,
        ...extra,
      },
      events,
      resources,
      { model: 'qwen-plus', samplingParams: { max_tokens: 1000 } },
    );
  return { events, event, message, turn, prepare, resources };
}

describe('frozen Managed side-query input', () => {
  it('uses original successful turns and never a contaminated compaction', async () => {
    const f = fixture();
    f.turn('good', 'completed', 'keep question', 'keep answer');
    f.turn('bad', 'error', 'failed instruction', 'failed partial');
    f.turn('cancel', 'cancelled', 'cancel instruction', 'cancel partial');
    f.event('context.compacted', {
      summaryRef: {
        resourceId: 'unreadable-poison',
        kind: 'managed-message',
        schemaVersion: 1,
        byteLength: 1,
        digest: 'a'.repeat(64),
      },
    });
    f.turn(
      'running',
      undefined,
      'unfinished instruction',
      'unfinished partial',
    );
    const request = await f.prepare('btw');
    const serialized = JSON.stringify(request?.contents);
    expect(serialized).toContain('keep question');
    expect(serialized).toContain('keep answer');
    expect(serialized).not.toMatch(/failed|cancel|unfinished|poison/);
    expect(request?.config?.tools).toBeUndefined();
  });

  it('recaps only visible original dialogue and uses the pre-hook display text', async () => {
    const f = fixture();
    f.event('input.accepted', {
      inputId: 'good',
      turnId: 'good',
      source: 'web_shell',
    });
    f.message({
      type: 'user',
      promptId: 'good',
      provenance: 'real_user',
      systemPayload: { displayText: '用户原文', hookContext: 'hook injection' },
      message: {
        role: 'user',
        parts: [{ text: 'model input hook injection' }],
      },
    });
    f.message({
      type: 'system',
      subtype: 'memory_catalog_snapshot',
      message: { role: 'user', parts: [{ text: 'memory injection' }] },
    });
    f.message({
      type: 'assistant',
      provenance: 'assistant_output',
      message: {
        role: 'model',
        parts: [
          { text: 'hidden reasoning', thought: true },
          { text: '用户可见答案' },
          { functionCall: { name: 'tool', args: {} } },
        ],
      },
    });
    f.message({
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'tool',
              response: { text: 'secret file dump' },
            },
          },
        ],
      },
    });
    f.event('turn.settled', { turnId: 'good', outcome: 'completed' });
    f.turn(
      'background',
      'completed',
      'background instruction',
      'background answer',
      'automation',
    );
    const request = await f.prepare('recap');
    expect(request?.config?.maxOutputTokens).toBe(300);
    expect(request?.config?.systemInstruction).toContain(
      'language of the conversation',
    );
    const contents = JSON.stringify(request?.contents);
    expect(contents).toContain('用户原文');
    expect(contents).toContain('用户可见答案');
    expect(contents).not.toMatch(
      /injection|reasoning|secret|functionCall|background instruction/,
    );
  });

  it('does not call a model for an empty recap context', async () => {
    expect(await fixture().prepare('recap')).toBeUndefined();
  });

  it('drops oldest complete recap turns to fit while retaining the latest dialogue', async () => {
    const f = fixture();
    f.turn('old', 'completed', 'old-context '.repeat(4000), 'old-answer');
    f.turn('new', 'completed', 'current goal', 'current progress');
    const request = await prepareManagedSideQuery(
      {
        kind: 'recap',
        question: null,
        privateHistory: [],
        throughSequence: f.events.length,
      },
      f.events,
      f.resources,
      { model: 'qwen-plus', contextWindowSize: 4096 },
    );
    const contents = JSON.stringify(request?.contents);
    expect(contents).not.toContain('old-context');
    expect(contents).not.toContain('old-answer');
    expect(contents).toContain('current goal');
    expect(contents).toContain('current progress');
  });

  it('uses native settlement boundaries when a failed continuation has no user record', async () => {
    const f = fixture();
    f.turn('good', 'completed', 'first question', 'first answer');
    f.event('input.accepted', {
      inputId: 'failed',
      turnId: 'failed',
      source: 'web_shell',
    });
    f.message({
      type: 'assistant',
      provenance: 'assistant_output',
      message: {
        role: 'model',
        parts: [{ text: 'failed continuation without prompt stamp' }],
      },
    });
    f.event('turn.settled', { turnId: 'failed', outcome: 'error' });
    f.turn('next', 'completed', 'next question', 'next answer');
    expect(JSON.stringify((await f.prepare('btw'))?.contents)).not.toContain(
      'failed continuation',
    );
  });

  it('keeps only the latest twenty successful private pairs', async () => {
    const f = fixture();
    const request = await f.prepare('btw', {
      privateHistory: Array.from({ length: 21 }, (_, i) => ({
        question: `private-question-${i}!`,
        text: `private-answer-${i}!`,
      })),
    });
    const contents = JSON.stringify(request?.contents);
    expect(contents).not.toContain('private-question-0!');
    expect(contents).toContain('private-question-20!');
    expect((request?.contents as Content[]).at(-1)?.parts?.[0]?.text).toBe(
      '侧问题',
    );
  });

  it('fails closed for remote attachment reads', async () => {
    const f = fixture();
    f.event('input.accepted', { inputId: 'a', turnId: 'a', source: 'user' });
    f.message({
      type: 'user',
      promptId: 'a',
      message: {
        role: 'user',
        parts: [{ fileData: { fileUri: 'file:///secret' } }],
      },
    });
    f.event('turn.settled', { turnId: 'a', outcome: 'completed' });
    await expect(f.prepare('btw')).rejects.toMatchObject({
      code: 'unsupported_attachment',
    });
  });

  it('rejects remote media nested in historical tool results before execution', async () => {
    const f = fixture();
    f.event('input.accepted', { inputId: 'a', turnId: 'a', source: 'user' });
    f.message({
      type: 'user',
      promptId: 'a',
      message: { role: 'user', parts: [{ text: 'inspect image' }] },
    });
    f.message({
      type: 'assistant',
      message: {
        role: 'model',
        parts: [{ functionCall: { id: 'call', name: 'image', args: {} } }],
      },
    });
    f.message({
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call',
              name: 'image',
              response: {},
              parts: [
                {
                  fileData: {
                    mimeType: 'image/png',
                    fileUri: 'https://remote.example/private.png',
                  },
                },
              ],
            },
          },
        ],
      },
    });
    f.event('turn.settled', { turnId: 'a', outcome: 'completed' });
    await expect(f.prepare('btw')).rejects.toMatchObject({
      code: 'unsupported_attachment',
    });
  });
});
