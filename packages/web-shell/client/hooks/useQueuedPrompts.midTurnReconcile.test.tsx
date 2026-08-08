// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useQueuedPrompts,
  type UseQueuedPromptsResult,
} from './useQueuedPrompts';
import type { DaemonStreamingState } from '@qwen-code/webui/daemon-react-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdkMock = vi.hoisted(() => ({
  actions: {
    enqueueMidTurnMessage: vi.fn(),
    getMidTurnMessages: vi.fn(),
    submitPrompt: vi.fn(),
    removePendingPrompt: vi.fn(),
    getPendingPrompts: vi.fn(),
    removeMidTurnMessage: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/webui/daemon-react-sdk')
  >('@qwen-code/webui/daemon-react-sdk');
  // useSyncExternalStore needs reference-stable snapshots; a fresh [] per
  // call loops the store into "Maximum update depth exceeded".
  const EMPTY_EVENTS: readonly unknown[] = Object.freeze([]);
  return {
    ...actual,
    useDaemonMidTurnInjected: () => ({ batches: [], consume: vi.fn() }),
    subscribePendingPromptEvents: () => () => {},
    getPendingPromptEvents: () => EMPTY_EVENTS,
    subscribePendingPromptVersion: () => () => {},
    getPendingPromptVersion: () => 0,
    consumePendingPromptEvents: vi.fn(),
  };
});

const CLIENT_ID = 'client-self';

interface HarnessOptions {
  connected?: boolean;
  sessionId?: string;
  clientId?: string;
  canMutateMidTurn?: boolean;
  canQueryMidTurn?: boolean;
  streamingState?: DaemonStreamingState;
}

function createHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: UseQueuedPromptsResult | undefined;

  // Stable identities: inline objects would change every render, rebuilding
  // the hook's callbacks and re-firing its effects on each commit.
  const stableStore = {
    appendLocalUserMessage: vi.fn(),
    dispatch: vi.fn(),
  } as never;
  const stableEditorRef = { current: null };
  const stableT = ((key: string) => key) as never;
  const stableReportError = vi.fn();

  function TestComponent(opts: HarnessOptions) {
    latest = useQueuedPrompts({
      connected: opts.connected ?? true,
      sessionId: opts.sessionId ?? 'session-a',
      clientId: opts.clientId ?? CLIENT_ID,
      canMutateMidTurn: opts.canMutateMidTurn ?? true,
      canQueryMidTurn: opts.canQueryMidTurn ?? true,
      streamingState: opts.streamingState ?? 'streaming',
      sessionActions: sdkMock.actions as never,
      store: stableStore,
      editorRef: stableEditorRef,
      reportError: stableReportError,
      t: stableT,
    });
    return null;
  }

  const render = async (opts: HarnessOptions) => {
    await act(async () => {
      root.render(<TestComponent {...opts} />);
    });
    // Flush the async reconciliation microtasks chained off the effects.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const dispose = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };

  return {
    render,
    dispose,
    result: () => {
      if (!latest) throw new Error('harness not rendered');
      return latest;
    },
  };
}

describe('useQueuedPrompts mid-turn reconciliation (session_mid_turn_message_query)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.actions.enqueueMidTurnMessage.mockResolvedValue({
      accepted: true,
      messageId: 'm1',
    });
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [],
      injectedMessageIds: [],
    });
    sdkMock.actions.submitPrompt.mockResolvedValue({ promptId: 'prompt-1' });
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores queued rows lost to a page refresh from the daemon snapshot', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm1',
          text: 'restored note',
          originatorClientId: CLIENT_ID,
        },
      ],
      injectedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'streaming' });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        sessionId: 'session-a',
        text: 'restored note',
        midTurnState: 'queued',
        midTurnMessageId: 'm1',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('does not adopt messages queued by another originator client', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-other',
          text: 'someone else pushed this',
          originatorClientId: 'client-peer',
        },
      ],
      injectedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'streaming' });
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('prunes a stale queued row whose id was already injected (no resend)', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'streaming' });
      // Enqueue mid-turn; the admission response carries the daemon id.
      await act(async () => {
        harness.result().enqueuePrompt('note');
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        midTurnState: 'queued',
        midTurnMessageId: 'm1',
      });

      // The drain happened but its SSE echo was missed — the snapshot's
      // injected ring is the proof. Going idle must drop the row WITHOUT
      // resending it.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        injectedMessageIds: ['m1'],
      });
      await harness.render({ streamingState: 'idle' });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('falls back to resending when reconciliation is unavailable (legacy)', async () => {
    // Query fails (or an older daemon answers 404): the action resolves
    // undefined and the legacy resend-all behavior applies.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'streaming' });
      await act(async () => {
        harness.result().enqueuePrompt('note');
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      await harness.render({ streamingState: 'idle' });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'note',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('never queries when the daemon lacks the capability (degraded)', async () => {
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'streaming',
        canQueryMidTurn: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('note');
      });
      await harness.render({
        streamingState: 'idle',
        canQueryMidTurn: false,
      });
      // Legacy path: resend directly, no reconciliation round-trip.
      expect(sdkMock.actions.getMidTurnMessages).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'note',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('resends restored rows immediately when the session already settled', async () => {
    // Refreshed AFTER the turn ended: the daemon already dropped the
    // undrained messages at the idle boundary, so restored rows honor the
    // legacy resend contract instead of parking forever.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm1',
          text: 'late note',
          originatorClientId: CLIENT_ID,
        },
      ],
      injectedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'late note',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
    } finally {
      await harness.dispose();
    }
  });
});
