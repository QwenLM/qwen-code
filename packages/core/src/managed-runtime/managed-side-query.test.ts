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

  it.each(['main', 'private'] as const)(
    'fits %s history before sizing the default output for a tight HF route',
    async (source) => {
      const f = fixture();
      const question = 'What did we decide?';
      const text = 'Use the inventory marker. ' + 'x'.repeat(12_656);
      if (source === 'main') f.turn('good', 'completed', question, text);
      const request = await prepareManagedSideQuery(
        {
          kind: 'btw',
          question: 'What is the marker?',
          privateHistory: source === 'private' ? [{ question, text }] : [],
          throughSequence: f.events.length,
        },
        f.events,
        f.resources,
        {
          model: 'MiniMaxAI/MiniMax-M2.5:digitalocean',
          baseUrl: 'https://router.huggingface.co/v1',
        },
      );
      const contents = request?.contents as Content[];
      expect(contents).toHaveLength(3);
      expect(contents[1]?.parts?.[0]?.text).toBe(text);
      const maxOutput = request?.config?.maxOutputTokens ?? 0;
      expect(maxOutput).toBeGreaterThan(4_000);
      expect(maxOutput).toBeLessThan(58_982);
    },
  );

  it('keeps CJK history and leaves room for the DigitalOcean tokenizer count', async () => {
    const f = fixture();
    const text =
      'The inventory marker is inventory-marker-neptune-88621.\n' +
      '协调，检查，撤回，超时，等待，分配，重试，终止，恢复，降级，拒绝，忽略，转移，冻结。\n'.repeat(
        720,
      );
    f.turn('good', 'completed', 'Record my new inventory marker.', text);
    const request = await prepareManagedSideQuery(
      {
        kind: 'btw',
        question:
          'What inventory marker did I record in the previous exchange?',
        privateHistory: [],
        throughSequence: f.events.length,
      },
      f.events,
      f.resources,
      {
        model: 'MiniMaxAI/MiniMax-M2.5:digitalocean',
        baseUrl: 'https://router.huggingface.co/v1',
      },
    );

    const contents = request?.contents as Content[];
    expect(contents[1]?.parts?.[0]?.text).toBe(text);
    // The published MiniMax tokenizer counts 17,368 input tokens for this replay.
    expect(request?.config?.maxOutputTokens).toBeLessThanOrEqual(
      65_536 - 17_368,
    );
  });

  it('fits denser Cantonese history within the DigitalOcean window', async () => {
    const f = fixture();
    const question = 'Keep the inventory marker.';
    const text =
      '呢啲嘢唔好掂住；噚日個掣郁唔到，依家仲係咁。佢噚晚收咗工至嚟睇，冇話畀我哋知幾時整得掂。\n'.repeat(
        430,
      );
    const request = await prepareManagedSideQuery(
      {
        kind: 'btw',
        question: 'What is the marker?',
        privateHistory: [{ question, text }],
        throughSequence: f.events.length,
      },
      f.events,
      f.resources,
      {
        model: 'MiniMaxAI/MiniMax-M2.5:digitalocean',
        baseUrl: 'https://router.huggingface.co/v1',
      },
    );

    expect((request?.contents as Content[])[1]?.parts?.[0]?.text).toBe(text);
    // The published MiniMax tokenizer counts 25,008 input tokens for this replay.
    expect(request?.config?.maxOutputTokens).toBeLessThanOrEqual(
      65_536 - 25_008,
    );
  });

  it.each([
    { kind: 'btw', length: 112_000, maxTokens: undefined },
    { kind: 'btw', length: 68_000, maxTokens: 32_000 },
    { kind: 'recap', length: 132_000, maxTokens: undefined },
  ] as const)(
    'keeps $length characters of English history for $kind with max_tokens $maxTokens',
    async ({ kind, length, maxTokens }) => {
      const f = fixture();
      const text =
        'Find the account marker, preserve the original document, and record the new window in the audit notes. '
          .repeat(1_320)
          .slice(0, length);
      f.turn('good', 'completed', 'Keep the inventory marker.', text);
      const request = await prepareManagedSideQuery(
        {
          kind,
          question: kind === 'btw' ? 'What is the marker?' : null,
          privateHistory: [],
          throughSequence: f.events.length,
        },
        f.events,
        f.resources,
        {
          model: 'MiniMaxAI/MiniMax-M2.5:digitalocean',
          baseUrl: 'https://router.huggingface.co/v1',
          ...(maxTokens && { samplingParams: { max_tokens: maxTokens } }),
        },
      );

      expect((request?.contents as Content[])[1]?.parts?.[0]?.text).toBe(text);
      if (maxTokens || kind === 'recap') {
        expect(request?.config?.maxOutputTokens).toBe(maxTokens ?? 300);
      }
    },
  );

  it('reserves an explicit hosted output budget before fitting history', async () => {
    const f = fixture();
    f.turn(
      'good',
      'completed',
      'Previous question',
      'Keep the original marker in the audit notes. '.repeat(1_000),
    );
    const request = await prepareManagedSideQuery(
      {
        kind: 'btw',
        question: 'Current question',
        privateHistory: [],
        throughSequence: f.events.length,
      },
      f.events,
      f.resources,
      {
        model: 'MiniMaxAI/MiniMax-M2.5:digitalocean',
        baseUrl: 'https://router.huggingface.co/v1',
        samplingParams: { max_tokens: 58_982 },
      },
    );

    expect(request?.contents).toEqual([
      { role: 'user', parts: [{ text: 'Current question' }] },
    ]);
    expect(request?.config?.maxOutputTokens).toBe(58_982);
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
