/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../../src/daemon/types.js';
import { projectChatRecordsToDaemonTranscript } from '../../src/daemon/transcript.js';
import { normalizeDaemonEvent } from '../../src/daemon/ui/normalizer.js';
import { createDaemonTranscriptStore } from '../../src/daemon/ui/store.js';
import { estimateDaemonTranscriptBlockBytes } from '../../src/daemon/ui/transcript.js';
import type { DaemonEmbeddedResource } from '../../src/daemon/index.js';

const resource: DaemonEmbeddedResource = {
  type: 'resource',
  resource: {
    uri: 'context://example/selection',
    mimeType: 'application/json',
    text: '{"items":["example"]}',
  },
  _meta: { selection: 'current' },
};

function frame(content: unknown): DaemonEvent {
  return {
    v: 1,
    id: 10,
    type: 'session_update',
    promptId: 'prompt-1',
    originatorClientId: 'client-1',
    data: {
      update: {
        sessionUpdate: 'user_message_chunk',
        content,
        _meta: { source: 'user', qwenTranscript: { sourceRecordIds: ['r1'] } },
      },
    },
  };
}

describe('daemon embedded text resources', () => {
  it('normalizes a typed resource without inventing an attachment or fetching its URI', () => {
    const [event] = normalizeDaemonEvent(frame(resource));
    expect(event).toMatchObject({
      type: 'user.resource.delta',
      resource,
      promptId: 'prompt-1',
      sourceRecordIds: ['r1'],
    });
    expect(event).not.toHaveProperty('attachmentId');
    expect(
      normalizeDaemonEvent(frame(resource), {
        suppressOwnUserEcho: true,
        clientId: 'client-1',
      }),
    ).toEqual([]);
    expect(
      normalizeDaemonEvent(frame({ type: 'resource', resource: { uri: 'x' } })),
    ).toEqual([]);
  });

  it('keeps a resource-only prompt separate from the next prompt and clears it on rewind', () => {
    const event = normalizeDaemonEvent(frame(resource))[0]!;
    const store = createDaemonTranscriptStore({ now: 1 });
    store.dispatch([
      event,
      {
        type: 'assistant.text.delta',
        text: 'used context',
        promptId: 'prompt-1',
      },
      { type: 'assistant.done', promptId: 'prompt-1' },
      { type: 'user.text.delta', text: 'next', promptId: 'prompt-2' },
    ]);
    const users = store
      .getSnapshot()
      .blocks.filter((block) => block.kind === 'user');
    expect(users.map((block) => block.promptId)).toEqual([
      'prompt-1',
      'prompt-2',
    ]);
    expect(users[0]).toMatchObject({ text: '', embeddedResources: [resource] });
    expect(users[1]).not.toHaveProperty('embeddedResources');

    store.dispatch({
      type: 'session.rewound',
      promptId: 'prompt-2',
      targetTurnIndex: 1,
    });
    expect(
      store.getSnapshot().blocks.filter((block) => block.kind === 'user'),
    ).toHaveLength(1);
    store.reset();
    expect(store.getSnapshot().blocks).toEqual([]);
  });

  it('deduplicates only identical echoes and counts distinct metadata against retention', () => {
    const store = createDaemonTranscriptStore({ now: 1 });
    const original = normalizeDaemonEvent(frame(resource))[0]!;
    const changed = normalizeDaemonEvent(
      frame({ ...resource, _meta: { selection: 'updated' } }),
    )[0]!;
    store.dispatch([original, original, changed]);
    const [block] = store.getSnapshot().blocks;
    expect(block).toMatchObject({
      kind: 'user',
      embeddedResources: [
        resource,
        { ...resource, _meta: { selection: 'updated' } },
      ],
    });
    expect(store.getSnapshot().retainedBytes).toBe(
      estimateDaemonTranscriptBlockBytes(block!),
    );
  });

  it('bounds retained resource text so one echo cannot pin the store over budget', () => {
    // The live echo caps block count only, and retention trimming never
    // evicts the newest block, so an unbounded resource text would hold the
    // store above maxRetainedBytes with no eviction able to reclaim it.
    const maxRetainedBytes = 1024 * 1024;
    const store = createDaemonTranscriptStore({ now: 1, maxRetainedBytes });
    const oversized = normalizeDaemonEvent(
      frame({
        type: 'resource',
        resource: {
          uri: 'context://example/large',
          mimeType: 'text/plain',
          text: 'x'.repeat(4 * 1024 * 1024),
        },
      }),
    )[0]!;
    store.dispatch(oversized);

    const snapshot = store.getSnapshot();
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(maxRetainedBytes);
    const block = snapshot.blocks.find((b) => b.kind === 'user');
    if (!block || block.kind !== 'user') {
      throw new Error('expected one retained user block');
    }
    expect(block.embeddedResources).toHaveLength(1);
    const retained = block.embeddedResources![0]!;
    expect(retained.resource.uri).toBe('context://example/large');
    expect(retained.resource.mimeType).toBe('text/plain');
    expect(retained.resource.text.length).toBeLessThanOrEqual(100_000);
    expect(retained.resource.text).toContain('[truncated]');
  });

  it('reconstructs the active branch from persisted user records', () => {
    const record = (
      uuid: string,
      parentUuid: string | null,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      uuid,
      parentUuid,
      sessionId: 'session-1',
      timestamp: '2026-09-23T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [] },
      ...overrides,
    });
    const records = [
      record('first', null, {
        daemonPromptId: 'prompt-1',
        systemPayload: {
          displayText: '',
          hookContext: '',
          embeddedResources: [resource],
        },
      }),
      record('abandoned', 'first', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'old' }] },
      }),
      record('active', 'first', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'used context' }] },
      }),
      record('second', 'active', {
        daemonPromptId: 'prompt-2',
        message: { role: 'user', parts: [{ text: 'next' }] },
      }),
    ];
    const projection = projectChatRecordsToDaemonTranscript(records);
    expect(projection.complete).toBe(true);
    const users = projection.blocks.filter((block) => block.kind === 'user');
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      promptId: 'prompt-1',
      sourceRecordIds: ['first'],
      embeddedResources: [resource],
    });
    expect(users[1]).toMatchObject({ promptId: 'prompt-2', text: 'next' });
    expect(users[1]).not.toHaveProperty('embeddedResources');
  });
});
