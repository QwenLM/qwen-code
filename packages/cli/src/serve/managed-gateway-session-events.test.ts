/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedGatewayPromptRequest } from './managed-prompt-types.js';
import { ManagedGatewaySessionEvents } from './managed-gateway-session-events.js';

function request(
  overrides: Partial<ManagedGatewayPromptRequest> = {},
): ManagedGatewayPromptRequest {
  return {
    mode: 'gateway',
    turnKind: 'bootstrap',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    workspaceCwd: '/workspace-a',
    sessionId: 'session-a',
    messageId: 'prompt-a',
    managedClientId: 'managed-client-a',
    prompt: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

describe('ManagedGatewaySessionEvents', () => {
  it('authorizes one managed client and records model and Runtime stages', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.markRuntimeStarting(input);
    events.markAgentStarted(input, 0, 'definition-1');
    events.markRuntimeReady(input);
    events.appendAssistantThought(input, 'considering');
    events.appendAssistantDelta(input, 'answer');
    events.complete(input);

    expect(events.authorize(input.sessionId, 'wrong')).toBeUndefined();
    const status = events.authorize(input.sessionId, input.managedClientId);
    expect(status).toMatchObject({
      phase: 'completed',
      runtimeReady: true,
    });
    expect(status).not.toHaveProperty('runtimeClientId');
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual([
      'accepted',
      'runtime_starting',
      'agent_started',
      'runtime_ready',
      'assistant_thought',
      'assistant_delta',
      'completed',
    ]);
  });

  it('updates a completed task after intentional Runtime release without changing its outcome', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.markRuntimeStarting(input);
    events.markRuntimeReady(input);
    events.complete(input);
    events.markRuntimeLost(input, true);
    expect(
      events.authorize(input.sessionId, input.managedClientId),
    ).toMatchObject({
      phase: 'completed',
      runtimeState: 'unknown',
      runtimeReady: false,
    });
    expect(
      (
        await events.transcript(input.sessionId, input.managedClientId)
      ).events.at(-1)?.type,
    ).toBe('runtime_released');
    events.markRuntimeLost(input, false);
    expect(
      events.authorize(input.sessionId, input.managedClientId),
    ).toMatchObject({ phase: 'completed', runtimeState: 'failed' });
    const next = request({
      messageId: 'queued-next',
      turnKind: 'continuation',
    });
    events.ensure(next);
    events.markRuntimeLost(input, false);
    expect(
      events.authorize(input.sessionId, input.managedClientId),
    ).toMatchObject({ phase: 'admitted', runtimeState: 'unknown' });
  });

  it('records a late Runtime result without reopening a completed turn', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.markRuntimeStarting(input);
    events.markAgentStarted(input, 0, 'definition-1');
    events.complete(input);
    events.markRuntimeReady(input);

    expect(
      events.authorize(input.sessionId, input.managedClientId),
    ).toMatchObject({ phase: 'completed', runtimeReady: true });
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual([
      'accepted',
      'runtime_starting',
      'agent_started',
      'completed',
      'runtime_ready',
    ]);
  });

  it('deduplicates exact admission and rejects Session identity reuse', () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    const first = events.ensure(input);
    expect(events.ensure(structuredClone(input))).toEqual(first);
    expect(() =>
      events.ensure(request({ workspaceId: 'workspace-b' })),
    ).toThrow('reused with a different identity');
    expect(() => events.ensure(request({ messageId: 'prompt-b' }))).toThrow(
      'already has an active turn',
    );
  });

  it('preserves one event ring while advancing sequential turns', async () => {
    const events = new ManagedGatewaySessionEvents();
    const first = request();
    events.ensure(first);
    events.markRuntimeReady(first);
    events.complete(first);
    const second = request({
      turnKind: 'continuation',
      messageId: 'prompt-b',
      prompt: [{ type: 'text', text: 'follow up' }],
    });

    expect(events.ensure(second)).toMatchObject({
      promptId: 'prompt-b',
      phase: 'admitted',
      runtimeReady: false,
    });
    events.markRuntimeStarting(second);
    events.markRuntimeReady(second);
    events.complete(second);

    const streamed = [];
    for await (const event of events.subscribe(
      second.sessionId,
      second.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event);
    }
    expect(streamed.map((event) => event.id)).toEqual(
      streamed.map((_, index) => index + 1),
    );
    expect(
      streamed
        .filter((event) => event.type === 'accepted')
        .map((event) => event.data),
    ).toEqual([
      { sessionId: 'session-a', promptId: 'prompt-a', prompt: first.prompt },
      { sessionId: 'session-a', promptId: 'prompt-b', prompt: second.prompt },
    ]);
    expect(streamed.at(-1)).toMatchObject({
      type: 'completed',
      data: { sessionId: 'session-a', promptId: 'prompt-b' },
    });
  });

  it('wakes a live subscriber and stops after the terminal', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    const observed: string[] = [];
    const subscription = (async () => {
      for await (const event of events.subscribe(
        input.sessionId,
        input.managedClientId,
        1,
        new AbortController().signal,
      )) {
        observed.push(event.type);
      }
    })();
    await Promise.resolve();
    events.appendAssistantDelta(input, 'x');
    events.complete(input);
    await subscription;
    expect(observed).toEqual(['assistant_delta', 'completed']);
  });

  it('does not skip a terminal appended while a prior event is being yielded', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    const iterator = events
      .subscribe(
        input.sessionId,
        input.managedClientId,
        undefined,
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'accepted' },
      done: false,
    });
    events.appendAssistantDelta(input, 'x');
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'assistant_delta' },
      done: false,
    });
    events.complete(input);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'completed' },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('reports a reconnect gap after the bounded preview ring rolls over', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    for (let index = 0; index < 2050; index += 1) {
      events.appendAssistantDelta(input, String(index));
    }
    events.complete(input);
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      1,
      new AbortController().signal,
    )) {
      streamed.push(event);
    }
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({ type: 'stream_gap' });
    const gap = streamed[0]!;
    const resumed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      gap.id,
      new AbortController().signal,
    )) {
      resumed.push(event);
    }
    expect(resumed[0]?.id).toBe(gap.id + 1);
    expect(resumed.at(-1)).toMatchObject({ type: 'completed' });
  });

  it('replaces an oversized model event with a terminal preview gap', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.appendAssistantDelta(input, 'x'.repeat(800 * 1024));
    events.complete(input);
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual(['accepted', 'stream_gap']);
  });
});

describe('durable Managed presentation', () => {
  it('restores catalog, bounded history pages and monotonic IDs after restart and a partial tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'managed-presentation-'));
    const file = path.join(root, 'events.jsonl');
    try {
      const first = await ManagedGatewaySessionEvents.open(file);
      const input = request();
      first.ensure(input);
      for (let i = 0; i < 8; i++)
        first.appendAssistantDelta(input, `part-${i}`);
      first.markRuntimeReady(input);
      first.complete(input);
      await first.flush();
      const page = await first.transcript(
        input.sessionId,
        input.managedClientId,
        undefined,
        3,
      );
      expect(page.events).toHaveLength(3);
      expect(page.olderCursor).toBeDefined();
      const older = await first.transcript(
        input.sessionId,
        input.managedClientId,
        Number(page.olderCursor),
        100,
      );
      expect(
        [...older.events, ...page.events].map((event) => event.id),
      ).toEqual(Array.from({ length: page.lastEventId }, (_, i) => i + 1));
      first.dispose();
      await appendFile(file, '{"partial":');
      const reopened = await ManagedGatewaySessionEvents.open(file);
      expect(reopened.list(input.managedClientId)).toHaveLength(1);
      expect(
        reopened.authorize(input.sessionId, input.managedClientId),
      ).toMatchObject({ phase: 'completed', runtimeState: 'unknown' });
      expect(reopened.list('another-client')).toHaveLength(0);
      const next = request({
        messageId: 'next',
        turnKind: 'continuation',
        prompt: [{ type: 'text', text: 'continue' }],
      });
      reopened.ensure(next);
      reopened.appendAssistantDelta(next, 'follow-up');
      reopened.complete(next);
      await reopened.flush();
      const later = await reopened.transcript(
        input.sessionId,
        input.managedClientId,
      );
      expect(later.lastEventId).toBe(page.lastEventId + 3);
      expect(later.events.at(-1)?.promptId).toBe('next');
      expect(
        later.events
          .filter((event) => event.type === 'accepted')
          .map((event) => event.data),
      ).toEqual([
        expect.objectContaining({ prompt: input.prompt }),
        expect.objectContaining({ prompt: next.prompt }),
      ]);
      reopened.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps durable completed sessions readable after live cache eviction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'managed-presentation-'));
    try {
      const events = await ManagedGatewaySessionEvents.open(
        path.join(root, 'events.jsonl'),
      );
      for (let i = 0; i < 66; i++) {
        const input = request({ sessionId: `session-${i}` });
        events.ensure(input);
        events.appendAssistantDelta(input, 'saved answer');
        events.complete(input);
      }
      await events.flush();
      expect(events.list('managed-client-a')).toHaveLength(66);
      const history = await events.transcript('session-0', 'managed-client-a');
      expect(
        history.events.some((event) => event.type === 'assistant_delta'),
      ).toBe(true);
      const replay = [];
      for await (const event of events.subscribe(
        'session-0',
        'managed-client-a',
        0,
        new AbortController().signal,
      ))
        replay.push(event);
      expect(replay).toEqual([
        expect.objectContaining({
          type: 'stream_gap',
          id: history.lastEventId,
        }),
      ]);
      events.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('separates waiting, actual Tool execution, terminal outcome and stale warmup results', () => {
    const events = new ManagedGatewaySessionEvents();
    const first = request();
    events.ensure(first);
    events.markRuntimeStarting(first);
    events.markAgentStarted(first, 0, 'definition');
    events.markToolRequested(first, 'call', 'read_file');
    expect(
      events.authorize(first.sessionId, first.managedClientId)?.phase,
    ).toBe('waiting_runtime');
    events.markRuntimeReady(first);
    events.markToolStarted(first, 'call', 'read_file', { path: 'file' });
    expect(
      events.authorize(first.sessionId, first.managedClientId)?.phase,
    ).toBe('tool_running');
    events.complete(first);
    const next = request({ messageId: 'next', turnKind: 'continuation' });
    events.ensure(next);
    events.markRuntimeStarting(next);
    events.markRuntimeFailed(first);
    expect(
      events.authorize(first.sessionId, first.managedClientId)?.runtimeState,
    ).toBe('starting');
    events.complete(next);
    events.markRuntimeFailed(next);
    expect(
      events.authorize(first.sessionId, first.managedClientId),
    ).toMatchObject({ phase: 'completed', runtimeState: 'failed' });
  });
});

describe('inbox presentation reconciliation', () => {
  it('repairs a missing terminal before a newly admitted turn, without replaying older turns', async () => {
    const events = new ManagedGatewaySessionEvents();
    const first = request();
    const next = request({ messageId: 'next', turnKind: 'continuation' });
    events.ensure(first, 10);
    events.appendAssistantDelta(first, 'saved answer');
    const firstStatus = {
      messageId: first.messageId,
      state: 'finished' as const,
      outcome: 'completed' as const,
      activationReady: true,
      admittedAt: 10,
    };
    const nextStatus = {
      messageId: next.messageId,
      state: 'admitted' as const,
      activationReady: true,
      admittedAt: 20,
    };
    events.recover(first, firstStatus);
    events.recover(next, nextStatus);
    events.recover(first, firstStatus);
    events.recover(next, nextStatus);
    expect(
      events.authorize(first.sessionId, first.managedClientId),
    ).toMatchObject({
      promptId: 'next',
      phase: 'admitted',
      createdAt: 10,
      admittedAt: 20,
    });
    const page = await events.transcript(
      first.sessionId,
      first.managedClientId,
    );
    expect(page.events.map((e) => [e.promptId, e.type])).toEqual([
      ['prompt-a', 'accepted'],
      ['prompt-a', 'assistant_delta'],
      ['prompt-a', 'completed'],
      ['next', 'accepted'],
    ]);
  });
});
