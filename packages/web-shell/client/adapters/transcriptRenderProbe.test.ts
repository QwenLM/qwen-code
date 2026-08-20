import { describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { probeTranscriptRenderIdentity } from './transcriptRenderProbe';

function block(
  value: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
): DaemonTranscriptBlock {
  return {
    ...value,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } as DaemonTranscriptBlock;
}

describe('probeTranscriptRenderIdentity', () => {
  it('is stable across folding and preserves every action source', () => {
    const blocks = [
      block({ id: 'user-1', kind: 'user', text: 'request' }),
      block({ id: 'assistant-1', kind: 'assistant', text: 'first ' }),
      block({ id: 'assistant-2', kind: 'assistant', text: 'second' }),
      block({
        id: 'tool-1',
        kind: 'tool',
        toolCallId: 'read-1',
        title: 'Read file',
        status: 'completed',
        toolName: 'read',
        toolKind: 'read',
        preview: { kind: 'file_read', path: 'src/index.ts' },
        resultPreview: { kind: 'text', text: 'contents' },
      }),
      block({
        id: 'tool-2',
        kind: 'tool',
        toolCallId: 'search-1',
        title: 'Search',
        status: 'completed',
        toolName: 'search',
        toolKind: 'search',
        preview: { kind: 'search', query: 'needle' },
      }),
    ];

    const first = probeTranscriptRenderIdentity(blocks);
    const second = probeTranscriptRenderIdentity(blocks);

    expect(second).toEqual(first);
    expect(first.items).toMatchObject([
      {
        sourceBlockIds: ['user-1'],
        capabilities: ['copy', 'edit-user-message'],
      },
      {
        sourceBlockIds: ['assistant-1', 'assistant-2'],
        capabilities: ['copy'],
      },
      {
        sourceBlockIds: ['tool-1', 'tool-2'],
        sourceToolCallIds: ['read-1', 'search-1'],
        capabilities: ['copy', 'open-file'],
      },
    ]);
    expect(Object.keys(first.semanticCopyHashes)).toHaveLength(3);
    expect(first.actions.copyAll.renderedItemIds).toEqual(
      first.items.map((item) => item.renderedItemId),
    );
    expect(first.actions.copyLastReply?.renderedItemId).toBe(
      first.items[1]?.renderedItemId,
    );
    expect(first.actions.editLastUserMessage?.renderedItemId).toBe(
      first.items[0]?.renderedItemId,
    );
    expect(first.actions.openFiles).toEqual([
      {
        renderedItemId: first.items[2]?.renderedItemId,
        sourceToolCallId: 'read-1',
      },
    ]);
  });

  it('changes semantic hash without leaking copied content into evidence', () => {
    const first = probeTranscriptRenderIdentity([
      block({ id: 'assistant-1', kind: 'assistant', text: 'secret one' }),
    ]);
    const second = probeTranscriptRenderIdentity([
      block({ id: 'assistant-1', kind: 'assistant', text: 'secret two' }),
    ]);

    expect(first.items).toEqual(second.items);
    expect(first.semanticCopyHashes).not.toEqual(second.semanticCopyHashes);
    expect(JSON.stringify(first)).not.toContain('secret one');
  });

  it('includes nested subagent content in semantic copy evidence', () => {
    const transcript = (nestedResult: string): DaemonTranscriptBlock[] => [
      block({
        id: 'agent-start',
        kind: 'tool',
        toolCallId: 'agent-1',
        title: 'Delegate',
        status: 'in_progress',
        toolName: 'agent',
        preview: {
          kind: 'subagent_delegation',
          agentName: 'reviewer',
          task: 'Review',
        },
      }),
      block({
        id: 'nested-tool',
        kind: 'tool',
        toolCallId: 'read-1',
        title: 'Read file',
        status: 'completed',
        toolName: 'read',
        preview: { kind: 'file_read', path: 'src/index.ts' },
        resultPreview: { kind: 'text', text: nestedResult },
        parentToolCallId: 'agent-1',
      }),
      block({
        id: 'agent-end',
        kind: 'tool',
        toolCallId: 'agent-1',
        title: 'Delegate',
        status: 'completed',
        toolName: 'agent',
        preview: {
          kind: 'subagent_delegation',
          agentName: 'reviewer',
          task: 'Review',
        },
        resultPreview: { kind: 'text', text: 'Done' },
      }),
    ];

    const first = probeTranscriptRenderIdentity(transcript('nested one'), {
      safeToolProjection: true,
    });
    const second = probeTranscriptRenderIdentity(transcript('nested two'), {
      safeToolProjection: true,
    });

    expect(first.items).toEqual(second.items);
    expect(first.semanticCopyHashes).not.toEqual(second.semanticCopyHashes);
    expect(JSON.stringify(first)).not.toContain('nested one');
  });

  it('uses the renderer parallel-agent grouping for item identity', () => {
    const transcript: DaemonTranscriptBlock[] = [
      block({
        id: 'agent-1-block',
        kind: 'tool',
        toolCallId: 'agent-1',
        title: 'First agent',
        status: 'completed',
        toolName: 'agent',
        preview: {
          kind: 'subagent_delegation',
          agentName: 'reviewer',
          task: 'Review',
        },
      }),
      block({
        id: 'nested-tool-block',
        kind: 'tool',
        toolCallId: 'read-1',
        title: 'Read evidence',
        status: 'completed',
        toolName: 'read',
        preview: { kind: 'file_read', path: 'contract.md' },
        parentToolCallId: 'agent-1',
      }),
      block({
        id: 'agent-2-block',
        kind: 'tool',
        toolCallId: 'agent-2',
        title: 'Second agent',
        status: 'completed',
        toolName: 'agent',
        preview: {
          kind: 'subagent_delegation',
          agentName: 'tester',
          task: 'Test',
        },
      }),
    ];

    const first = probeTranscriptRenderIdentity(transcript);
    const prepended = probeTranscriptRenderIdentity([
      block({ id: 'older-user', kind: 'user', text: 'older' }),
      ...transcript,
    ]);

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      sourceBlockIds: ['agent-1-block', 'nested-tool-block', 'agent-2-block'],
      sourceToolCallIds: ['agent-1', 'read-1', 'agent-2'],
      capabilities: ['copy', 'open-file'],
    });
    expect(prepended.items[1]?.renderedItemId).toBe(
      first.items[0]?.renderedItemId,
    );
  });

  it('assigns unique stable identities to split items from one source block', () => {
    const insight = block({
      id: 'insight-1',
      kind: 'assistant',
      text: 'before {"insight_ready":{"path":"/tmp/report.md"}} after',
    });
    const first = probeTranscriptRenderIdentity([insight]);
    const withPrependedHistory = probeTranscriptRenderIdentity([
      block({ id: 'older-user', kind: 'user', text: 'older' }),
      insight,
    ]);
    const firstIds = first.items.map((item) => item.renderedItemId);
    const replayedIds = withPrependedHistory.items
      .filter((item) => item.sourceBlockIds.includes('insight-1'))
      .map((item) => item.renderedItemId);

    expect(new Set(firstIds).size).toBe(3);
    expect(replayedIds).toEqual(firstIds);
    expect(withPrependedHistory.actions.copyLastReply).toEqual(
      first.actions.copyLastReply,
    );
  });
});
