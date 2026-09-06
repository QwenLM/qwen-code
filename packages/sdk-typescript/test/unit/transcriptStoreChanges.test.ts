/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  createDaemonTranscriptStore,
  reduceDaemonTranscriptEvents,
  type DaemonTranscriptStore,
} from '../../src/daemon/index.js';

function requireSummary(store: DaemonTranscriptStore) {
  const summary = store.getBlockChangeSummary?.();
  if (!summary) throw new Error('block change summary unavailable');
  return summary;
}

describe('daemon transcript store block change summary', () => {
  it.each(['assistant', 'thought'] as const)(
    'keeps the barrier stable across consecutive %s tail appends',
    (kind) => {
      const store = createDaemonTranscriptStore();
      const otherStore = createDaemonTranscriptStore();
      const type = `${kind}.text.delta` as const;
      store.dispatch({ type, text: 'one' });
      const initial = requireSummary(store);
      const blockId =
        kind === 'assistant'
          ? store.getSnapshot().activeAssistantBlockId
          : store.getSnapshot().activeThoughtBlockId;

      expect(initial.source).not.toBe(requireSummary(otherStore).source);
      store.dispatch({ type, text: ' two' });
      store.dispatch({ type, text: ' three' });

      const summary = requireSummary(store);
      expect(summary.source).toBe(initial.source);
      expect(summary).toEqual({
        source: initial.source,
        revision: initial.revision + 2,
        tailAppendBarrierRevision: initial.tailAppendBarrierRevision,
        tailBlockId: blockId,
      });
    },
  );

  it('invalidates a tail append after a local user message', () => {
    const store = createDaemonTranscriptStore();
    store.dispatch({ type: 'assistant.text.delta', text: 'one' });
    const before = requireSummary(store);

    store.appendLocalUserMessage('next');

    const summary = requireSummary(store);
    expect(summary.revision).toBe(before.revision + 1);
    expect(summary.tailAppendBarrierRevision).toBe(summary.revision);
    expect(summary.tailBlockId).toBeUndefined();
  });

  it('advances the barrier for non-tail mutations and resets', () => {
    const store = createDaemonTranscriptStore();
    store.dispatch({ type: 'assistant.text.delta', text: 'one' });
    store.dispatch({ type: 'assistant.text.delta', text: ' two' });
    const tailAppend = requireSummary(store);

    store.dispatch({
      type: 'tool.update',
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'running',
    });
    const toolUpdate = requireSummary(store);
    expect(toolUpdate.revision).toBe(tailAppend.revision + 1);
    expect(toolUpdate.tailAppendBarrierRevision).toBe(toolUpdate.revision);
    expect(toolUpdate.tailBlockId).toBeUndefined();

    store.reset();
    const reset = requireSummary(store);
    expect(reset.revision).toBe(toolUpdate.revision + 1);
    expect(reset.tailAppendBarrierRevision).toBe(reset.revision);
  });

  it('invalidates a mixed batch instead of hiding a tool update', () => {
    const store = createDaemonTranscriptStore();
    store.dispatch({ type: 'assistant.text.delta', text: 'one' });
    store.dispatch([
      { type: 'assistant.text.delta', text: ' two' },
      {
        type: 'tool.update',
        toolCallId: 'call-1',
        toolName: 'read_file',
        status: 'running',
      },
    ]);

    const summary = requireSummary(store);
    expect(summary.tailAppendBarrierRevision).toBe(summary.revision);
    expect(summary.tailBlockId).toBeUndefined();
  });

  it('invalidates when bounded text can no longer append the full delta', () => {
    const store = createDaemonTranscriptStore();
    store.dispatch({
      type: 'assistant.text.delta',
      text: 'x'.repeat(100_000),
    });
    const before = requireSummary(store);

    store.dispatch({ type: 'assistant.text.delta', text: 'y' });

    const summary = requireSummary(store);
    expect(summary.revision).toBe(before.revision + 1);
    expect(summary.tailAppendBarrierRevision).toBe(summary.revision);
    expect(summary.tailBlockId).toBeUndefined();
  });

  it('invalidates when a text delta also changes projection metadata', () => {
    const store = createDaemonTranscriptStore();
    store.dispatch({ type: 'assistant.text.delta', text: 'one' });
    const before = requireSummary(store);

    store.dispatch({
      type: 'assistant.text.delta',
      text: ' two',
      meta: { source: 'background_notification' },
    });

    const summary = requireSummary(store);
    expect(summary.revision).toBe(before.revision + 1);
    expect(summary.tailAppendBarrierRevision).toBe(summary.revision);
    expect(summary.tailBlockId).toBeUndefined();
  });

  it.each(['assistant', 'thought'] as const)(
    'reuses unrelated indexes for top-level %s deltas',
    (kind) => {
      const initial = reduceDaemonTranscriptEvents(
        createDaemonTranscriptState(),
        [
          {
            type: 'tool.update',
            toolCallId: 'call-1',
            toolName: 'read_file',
            status: 'completed',
          },
          {
            type: 'thought.text.delta',
            text: 'nested',
            parentToolCallId: 'parent-1',
          },
          { type: `${kind}.text.delta`, text: 'one' },
        ],
      );
      const before = {
        ...initial,
        toolProgress: { 'call-1': { ratio: 0.5 } },
      };
      const progress = before.toolProgress['call-1'];
      const sideIndexContents = {
        toolBlockByCallId: { ...before.toolBlockByCallId },
        activeAssistantBlockByParent: {
          ...before.activeAssistantBlockByParent,
        },
        activeThoughtBlockByParent: { ...before.activeThoughtBlockByParent },
        trimmedToolNotificationByCallId: {
          ...before.trimmedToolNotificationByCallId,
        },
        permissionBlockByRequestId: { ...before.permissionBlockByRequestId },
        toolProgress: { 'call-1': { ...progress } },
      };

      const after = reduceDaemonTranscriptEvents(before, [
        { type: `${kind}.text.delta`, text: ' two' },
      ]);

      expect(after.blocks).not.toBe(before.blocks);
      expect(after.toolBlockByCallId).toBe(before.toolBlockByCallId);
      expect(after.activeAssistantBlockByParent).toBe(
        before.activeAssistantBlockByParent,
      );
      expect(after.activeThoughtBlockByParent).toBe(
        before.activeThoughtBlockByParent,
      );
      expect(after.trimmedToolNotificationByCallId).toBe(
        before.trimmedToolNotificationByCallId,
      );
      expect(after.permissionBlockByRequestId).toBe(
        before.permissionBlockByRequestId,
      );
      expect(after.toolProgress).toBe(before.toolProgress);
      expect(after.toolProgress['call-1']).toBe(progress);
      for (const key of Object.keys(sideIndexContents) as Array<
        keyof typeof sideIndexContents
      >) {
        expect(after[key]).toEqual(sideIndexContents[key]);
        expect(Object.isFrozen(after[key])).toBe(true);
      }
      expect(Object.isFrozen(after.toolProgress['call-1'])).toBe(true);
    },
  );

  it('does not share side indexes when a reducer maxBlocks override trims', () => {
    const before = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ maxBlocks: 10 }),
      [
        {
          type: 'tool.update',
          toolCallId: 'call-1',
          toolName: 'read_file',
          status: 'completed',
        },
      ],
    );
    const beforeToolBlockId = before.toolBlockByCallId['call-1'];

    const after = reduceDaemonTranscriptEvents(
      before,
      [{ type: 'thought.text.delta', text: 'one' }],
      { maxBlocks: 1 },
    );

    expect(after.blocks).toHaveLength(1);
    expect(after.toolBlockByCallId).not.toBe(before.toolBlockByCallId);
    expect(before.toolBlockByCallId['call-1']).toBe(beforeToolBlockId);
  });

  it('does not mutate shared side indexes when byte trimming starts', () => {
    const before = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ maxBlocks: 10 }),
      [
        {
          type: 'tool.update',
          toolCallId: 'call-1',
          toolName: 'read_file',
          status: 'completed',
        },
        { type: 'thought.text.delta', text: 'one' },
      ],
    );
    const beforeToolBlockId = before.toolBlockByCallId['call-1'];

    const after = reduceDaemonTranscriptEvents(
      before,
      [{ type: 'thought.text.delta', text: 'x'.repeat(1_000) }],
      { maxRetainedBytes: before.retainedBytes + 1 },
    );

    expect(after.blocks).toHaveLength(1);
    expect(after.toolBlockByCallId).not.toBe(before.toolBlockByCallId);
    expect(before.toolBlockByCallId['call-1']).toBe(beforeToolBlockId);
  });
});
