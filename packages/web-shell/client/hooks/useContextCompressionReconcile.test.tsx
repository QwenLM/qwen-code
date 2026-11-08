// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { useContextCompressionReconcile } from './useContextCompressionReconcile';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Props = Parameters<typeof useContextCompressionReconcile>[0];
type RenderProps = Omit<
  Props,
  'getContextUsage' | 'currentModel' | 'contextWindow'
> &
  Partial<Pick<Props, 'currentModel' | 'contextWindow'>>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => mounted.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function block(
  id: string,
  contextCompression: Record<string, unknown>,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text: 'Context compressed.',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    meta: { source: 'slash_command', contextCompression },
  } as DaemonTranscriptBlock;
}

/** An assistant round that reported usage — what a session's counters seed from. */
function usageBlock(
  id: string,
  parentToolCallId?: string,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text: 'Round output.',
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 1000, outputTokens: 10 },
    ...(parentToolCallId ? { parentToolCallId } : {}),
  } as DaemonTranscriptBlock;
}

const DONE = {
  phase: 'done',
  originalTokenCount: 200,
  newTokenCount: 100,
  originalTokenCountIsEstimated: false,
  newTokenCountIsEstimated: false,
};

describe('useContextCompressionReconcile', () => {
  function mount(initial: RenderProps) {
    const getContextUsage = vi.fn().mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (props: RenderProps) => {
      const mountedRoot = root!;
      act(() => {
        mountedRoot.render(
          <Probe
            currentModel="test-model"
            contextWindow={31_250}
            {...props}
            getContextUsage={getContextUsage as Props['getContextUsage']}
          />,
        );
      });
    };
    render(initial);
    return { getContextUsage, render };
  }

  function Probe(props: Props) {
    useContextCompressionReconcile(props);
    return null;
  }

  it('reconciles for a compression that arrives after the session is live', () => {
    const h = mount({ blocks: [], sessionId: 's1', live: true });

    h.render({ blocks: [block('c1', DONE)], sessionId: 's1', live: true });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);
    expect(h.getContextUsage).toHaveBeenCalledWith({
      detail: true,
      silent: true,
      syncCounters: true,
    });
  });

  it('reconciles an attach whose transcript ends on a compression', () => {
    // The counters a session seeds from its replay are the last usage frame in
    // it, and a compression emits none — so this attach opens describing the
    // context the compression replaced.
    const h = mount({
      blocks: [block('c1', DONE)],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<Pick<Props, 'currentModel' | 'contextWindow'>>]>([
    ['the model', { currentModel: 'other-model' }],
    ['the context window', { contextWindow: 62_500 }],
  ])(
    'reads again when %s settles after the session is live',
    (_label, settled) => {
      // `syncCounters` refuses the write when either moved while the read was in
      // flight, and an attach resolves both after the session is already live —
      // so the read that raced that resolution is not the last word.
      const h = mount({
        blocks: [block('c1', DONE)],
        sessionId: 's1',
        live: true,
      });

      expect(h.getContextUsage).toHaveBeenCalledTimes(1);

      h.render({
        blocks: [block('c1', DONE)],
        sessionId: 's1',
        live: true,
        ...settled,
      });

      expect(h.getContextUsage).toHaveBeenCalledTimes(2);
    },
  );

  it('leaves an attach whose compression a later round already reported', () => {
    const h = mount({
      blocks: [block('c1', DONE), usageBlock('round-1')],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).not.toHaveBeenCalled();
  });

  it('counts only main-session usage, as the seed does', () => {
    // getReplayTokenUsage skips sub-agent usage, so a sub-agent round after the
    // compression cannot leave the seeded counters current.
    const h = mount({
      blocks: [block('c1', DONE), usageBlock('subagent-1', 'task-1')],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);
  });

  it('defers a compression that landed while the transcript was catching up', () => {
    // The write is refused while catching up, so the read has to wait for it to
    // end rather than be issued and dropped.
    const h = mount({ blocks: [], sessionId: 's1', live: false });

    h.render({ blocks: [block('c1', DONE)], sessionId: 's1', live: false });
    expect(h.getContextUsage).not.toHaveBeenCalled();

    h.render({ blocks: [block('c1', DONE)], sessionId: 's1', live: true });
    expect(h.getContextUsage).toHaveBeenCalledTimes(1);

    h.render({
      blocks: [block('c1', DONE), block('c2', DONE)],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(2);
  });

  it('ignores the transient progress frame', () => {
    const h = mount({ blocks: [], sessionId: 's1', live: true });

    h.render({
      blocks: [block('c1', { phase: 'progress' })],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).not.toHaveBeenCalled();
  });

  it('does not double-read when the same block re-renders', () => {
    const h = mount({ blocks: [], sessionId: 's1', live: true });

    h.render({ blocks: [block('c1', DONE)], sessionId: 's1', live: true });
    h.render({
      blocks: [block('c1', { ...DONE })],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);
  });

  it('settles each session on its own transcript', () => {
    const h = mount({
      blocks: [block('c1', DONE)],
      sessionId: 's1',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);

    // The next session's transcript already accounts for its own compression:
    // its attach check has to establish that rather than inherit s1's state.
    h.render({
      blocks: [block('c2', DONE), usageBlock('round-2')],
      sessionId: 's2',
      live: true,
    });

    expect(h.getContextUsage).toHaveBeenCalledTimes(1);
  });
});
