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

const sdkMock = vi.hoisted(() => {
  const pendingEventListeners = new Set<() => void>();
  const mock = {
    actions: {
      enqueueMidTurnMessage: vi.fn(),
      getMidTurnMessages: vi.fn(),
      submitPrompt: vi.fn(),
      removePendingPrompt: vi.fn(),
      getPendingPrompts: vi.fn(),
      removeMidTurnMessage: vi.fn(),
    },
    injectedBatches: [] as Array<{
      sessionId: string;
      messages: readonly string[];
      messageIds?: readonly string[];
      originatorClientId?: string;
    }>,
    consumeInjected: vi.fn(),
    pendingEvents: [] as Array<Record<string, unknown>>,
    ownerVersion: 0,
    pendingEventListeners,
    publishPendingEvents: (events: Array<Record<string, unknown>>) => {
      mock.pendingEvents = events;
      for (const listener of [...pendingEventListeners]) listener();
    },
  };
  return mock;
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/webui/daemon-react-sdk')
  >('@qwen-code/webui/daemon-react-sdk');
  // useSyncExternalStore needs reference-stable snapshots; a fresh [] per
  // call loops the store into "Maximum update depth exceeded". The mutable
  // sdkMock arrays are only swapped wholesale, so their identity is stable
  // between publishes.
  return {
    ...actual,
    useDaemonMidTurnInjected: () => ({
      batches: sdkMock.injectedBatches,
      consume: sdkMock.consumeInjected,
    }),
    useDaemonSessionOwnerGuard: () => ({
      capture: () => {
        const version = sdkMock.ownerVersion;
        return { isCurrent: () => sdkMock.ownerVersion === version };
      },
    }),
    subscribePendingPromptEvents: (listener: () => void) => {
      sdkMock.pendingEventListeners.add(listener);
      return () => {
        sdkMock.pendingEventListeners.delete(listener);
      };
    },
    getPendingPromptEvents: () => sdkMock.pendingEvents,
    subscribePendingPromptVersion: () => () => {},
    getPendingPromptVersion: () => 0,
    consumePendingPromptEvents: (handled: readonly unknown[]) => {
      if (handled.length === 0) return;
      const handledSet = new Set(handled);
      const next = sdkMock.pendingEvents.filter(
        (event) => !handledSet.has(event),
      );
      if (next.length === sdkMock.pendingEvents.length) return;
      sdkMock.publishPendingEvents(next);
    },
  };
});

const CLIENT_ID = 'client-self';

interface HarnessOptions {
  connected?: boolean;
  writeBlocked?: boolean;
  sessionId?: string;
  workspaceCwd?: string;
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
  };
  const stableEditor = {
    getText: vi.fn(() => ''),
    setText: vi.fn(),
    restoreImages: vi.fn(),
    focus: vi.fn(),
  };
  const stableEditorRef = { current: stableEditor } as never;
  const stableT = ((key: string) => key) as never;
  const stableReportError = vi.fn();

  function TestComponent(opts: HarnessOptions) {
    latest = useQueuedPrompts({
      connected: opts.connected ?? true,
      writeBlocked: opts.writeBlocked ?? false,
      sessionId: opts.sessionId ?? 'session-a',
      workspaceCwd: opts.workspaceCwd ?? '/workspace',
      clientId: opts.clientId ?? CLIENT_ID,
      canMutateMidTurn: opts.canMutateMidTurn ?? true,
      canQueryMidTurn: opts.canQueryMidTurn ?? true,
      streamingState: opts.streamingState ?? 'responding',
      sessionActions: sdkMock.actions as never,
      store: stableStore as never,
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
    editor: stableEditor,
    store: stableStore,
    reportError: stableReportError,
  };
}

describe('useQueuedPrompts mid-turn reconciliation (session_mid_turn_message_query)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.ownerVersion = 0;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) =>
        Promise.resolve({ accepted: true, messageId: opts?.messageId }),
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    sdkMock.actions.submitPrompt.mockResolvedValue({ promptId: 'prompt-1' });
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [],
    });
    sdkMock.actions.removeMidTurnMessage.mockResolvedValue({ removed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sdkMock.injectedBatches = [];
    sdkMock.pendingEvents = [];
  });

  it('restores queued rows lost to a page refresh from the daemon snapshot', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm1',
          text: 'restored note',
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
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

  it('restores the session-wide daemon queue after the client id changes', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-other',
          text: 'someone else pushed this',
        },
        {
          messageId: 'm-anonymous',
          text: 'an anonymous caller pushed this',
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts.map((row) => row.text)).toEqual([
        'someone else pushed this',
        'an anonymous caller pushed this',
      ]);
      await harness.render({ streamingState: 'idle' });
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a connect snapshot across active streaming substates', async () => {
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    sdkMock.actions.getMidTurnMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'waiting' });
      await harness.render({ streamingState: 'responding' });
      resolveSnapshot?.({
        messages: [
          {
            messageId: 'm-active',
            text: 'survives substate change',
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts[0]).toMatchObject({
        midTurnMessageId: 'm-active',
        text: 'survives substate change',
      });
      expect(sdkMock.actions.getMidTurnMessages).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });

  it('removes a daemon-owned row deleted by another client', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-deleted', text: 'delete me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('prunes a stale queued row whose id was already injected (no resend)', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        sdkMock.actions.getMidTurnMessages.mockResolvedValue({
          messages: [],
          settledMessageIds: [opts?.messageId],
          promotedMessageIds: [],
        });
        return Promise.resolve({ accepted: true, messageId: opts?.messageId });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('note', undefined, onComplete);
      });
      await harness.render({ streamingState: 'idle' });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('waits for promoted prompt completion before settling its callback', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        sdkMock.actions.getMidTurnMessages.mockResolvedValue({
          messages: [],
          settledMessageIds: [],
          promotedMessageIds: [opts?.messageId],
        });
        return Promise.resolve({ accepted: true, messageId: opts?.messageId });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('promote me', undefined, onComplete);
      });
      await harness.render({ streamingState: 'idle' });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not resend when a capable daemon reconciliation is unavailable', async () => {
    // An unavailable snapshot is unknown state, not proof that the daemon
    // rejected the message. Resending here could duplicate a committed POST.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('note');
      });
      expect(harness.result().queuedPrompts).toEqual([]);

      await harness.render({ streamingState: 'idle' });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('never queries when the daemon lacks the capability (degraded)', async () => {
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
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

  it('falls back when a legacy admission response reaches an idle turn', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveAdmission = resolve;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        canQueryMidTurn: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('legacy late response');
      });
      await harness.render({
        streamingState: 'idle',
        canQueryMidTurn: false,
      });
      await act(async () => {
        resolveAdmission?.({ accepted: true, messageId: 'legacy-late' });
      });

      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'legacy late response',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not resubmit when an accepted response arrives after idle', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveAdmission = resolve;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('late response');
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      await harness.render({ streamingState: 'idle' });
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [messageId],
      });
      await act(async () => {
        resolveAdmission?.({ accepted: true, messageId });
      });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('reconciles an ambiguous admission without retrying or falling back', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [messageId],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('retry me');
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      // The accepted-but-lost admission must recover silently: restoring the
      // text or raising 'queue failed' would duplicate a committed message.
      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('restores text after the daemon definitively rejects admission', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockResolvedValueOnce({
      accepted: false,
    });
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('queue was full');
      });

      expect(harness.editor.setText).toHaveBeenCalledWith('queue was full');
      expect(harness.editor.focus).toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('retains an unknown row when admission and reconciliation both fail', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('possibly accepted');
      });

      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'possibly accepted',
          midTurnMessageId: messageId,
          admissionOutcome: 'unknown',
          payloadAvailable: true,
        }),
      ]);

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [{ messageId, text: 'possibly accepted' }],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'possibly accepted',
          midTurnMessageId: messageId,
          midTurnState: 'queued',
          admissionOutcome: undefined,
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('restores an unknown mid-turn payload without later completing it', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('recover me', undefined, onComplete);
      });
      const row = harness.result().queuedPrompts[0]!;
      const messageId = row.midTurnMessageId!;
      await act(async () => {
        expect(harness.result().restoreUnknownQueuedPrompt(row.id)).toBe(true);
      });
      expect(harness.editor.setText).toHaveBeenCalledWith('recover me');

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [messageId],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not report an admission failure after the user switches sessions', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a' });
      await act(async () => {
        harness.result().enqueuePrompt('failed before switch');
      });
      await harness.render({ sessionId: 'session-b' });
      await act(async () => {
        rejectAdmission?.(new Error('daemon unavailable'));
      });

      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('settles a peer-deleted ambiguous admission exactly once', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: [],
        promotedMessageIds: [],
        settledMessageIds: [messageId],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('deleted by peer', undefined, onComplete);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not retry a failed admission into the newly selected session', async () => {
    let rejectAdmission: ((reason?: unknown) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a' });
      await act(async () => {
        harness.result().enqueuePrompt('belongs to A');
      });
      await harness.render({ sessionId: 'session-b' });
      await act(async () => {
        rejectAdmission?.(new Error('response lost'));
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('merges a promoted prompt snapshot by the stable message id', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm1', text: 'promoted' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'm1',
          text: 'promoted',
          queuedAt: 1,
          state: 'queued',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        text: 'promoted',
        serverPromptId: 'm1',
        serverState: 'queued',
      });
      expect(harness.result().queuedPrompts[0]?.midTurnState).toBeUndefined();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a promoted row visible when pending-prompt refresh fails', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-promoted', text: 'still visible' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: ['m-promoted'],
      });
      sdkMock.actions.getPendingPrompts.mockRejectedValue(
        new Error('pending snapshot unavailable'),
      );
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });

      expect(harness.result().queuedPrompts[0]).toMatchObject({
        midTurnMessageId: 'm-promoted',
        text: 'still visible',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('reconciles a failed delete against the daemon snapshot', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-delete', text: 'delete me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    sdkMock.actions.removeMidTurnMessage.mockResolvedValue({ removed: false });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        harness
          .result()
          .removeQueuedPrompt(harness.result().queuedPrompts[0]!.id);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore a deleted row from an older snapshot', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'delete-during-reconcile',
          text: 'delete during reconcile',
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const row = harness.result().queuedPrompts[0]!;
      let resolveSnapshot: ((value: unknown) => void) | undefined;
      sdkMock.actions.getMidTurnMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
      );

      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
      });
      resolveSnapshot?.({
        messages: [
          {
            messageId: row.midTurnMessageId,
            text: row.text,
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not create local state while daemon admission is pending', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
        new Promise(() => {}),
      );
      await act(async () => {
        harness.result().enqueuePrompt('note');
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [
          {
            messageId,
            text: 'note',
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      expect(harness.result().queuedPrompts).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it('preserves a stable-id admission across same-session owner replacement', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('survive reattach');
      });
      expect(harness.result().queuedPrompts).toEqual([]);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'responding' });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          sessionId: 'session-a',
          text: 'survive reattach',
          admissionOutcome: 'unknown',
          payloadCompleteness: 'complete',
        }),
      ]);
      expect(harness.editor.setText).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('preserves an ambiguous stable-id admission across later reattachment', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
      await act(async () => {
        harness.result().enqueuePrompt('ambiguous input');
        rejectAdmission?.(new Error('response lost'));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'ambiguous input',
          admissionOutcome: 'unknown',
        }),
      ]);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'responding' });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'ambiguous input',
          admissionOutcome: 'unknown',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not resurrect an admission after authoritative settlement', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
      await act(async () => {
        harness.result().enqueuePrompt('settled input');
        rejectAdmission?.(new Error('response lost'));
        await Promise.resolve();
        await Promise.resolve();
      });
      const messageId = harness.result().queuedPrompts[0]?.midTurnMessageId;
      if (!messageId) throw new Error('missing stable message id');

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [messageId],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'idle' });
      expect(harness.result().queuedPrompts).toEqual([]);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'idle' });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not carry a stable-id admission into another workspace', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });
      await act(async () => {
        harness.result().enqueuePrompt('workspace-a input');
      });

      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-b',
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();

      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'workspace-a input',
          admissionOutcome: 'unknown',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('restores a rejected stable-id admission after returning to its workspace', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((resolve) => {
        resolveAdmission = resolve;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });
      await act(async () => {
        harness.result().enqueuePrompt('rejected in workspace-a');
      });
      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-b',
      });
      await act(async () => {
        resolveAdmission?.({ accepted: false });
        await Promise.resolve();
      });

      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'rejected in workspace-a',
          admissionOutcome: 'unknown',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not apply an old-owner reconcile after same-id reattachment', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      let resolveSnapshot: ((value: unknown) => void) | undefined;
      sdkMock.actions.getMidTurnMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
      );
      await harness.render({ streamingState: 'idle' });

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'idle' });
      resolveSnapshot?.({
        messages: [{ messageId: 'stale', text: 'old owner payload' }],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not fall back after an idle reconciliation is blocked', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getPendingPrompts.mockClear();
      sdkMock.actions.getMidTurnMessages.mockImplementationOnce(
        (opts?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            opts?.signal?.addEventListener('abort', () => resolve(undefined), {
              once: true,
            });
          }),
      );

      await harness.render({ streamingState: 'idle', writeBlocked: false });
      await harness.render({ streamingState: 'idle', writeBlocked: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(sdkMock.actions.getPendingPrompts).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('drops a connect snapshot after the streaming phase changes', async () => {
    const resolveSnapshots: Array<(value: unknown) => void> = [];
    sdkMock.actions.getMidTurnMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshots.push(resolve);
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await harness.render({ streamingState: 'idle' });
      resolveSnapshots.shift()?.({
        messages: [
          {
            messageId: 'm1',
            text: 'stale',
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops a stale snapshot when the session changed mid-query', async () => {
    const deferredSnapshots: Array<(value: unknown) => void> = [];
    sdkMock.actions.getMidTurnMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferredSnapshots.push(resolve);
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
      });
      // Switch to session B while A's reconciliation is still in flight
      // (the hook bumps its seq fence and B starts its own query).
      await harness.render({
        sessionId: 'session-b',
        streamingState: 'responding',
      });
      // A's snapshot arrives late, carrying a row queued for A.
      deferredSnapshots.shift()?.({
        messages: [
          {
            messageId: 'mA',
            text: 'for session A',
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('materializes the queued row mid-turn after an accepted admission', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        sdkMock.actions.getMidTurnMessages.mockResolvedValue({
          messages: [
            {
              messageId: opts?.messageId,
              text: 'mid-turn note',
            },
          ],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        return Promise.resolve({ accepted: true, messageId: opts?.messageId });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('mid-turn note');
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      // The post-admission reconciliation must project the daemon-owned row
      // while the turn is still active, not only at the next boundary.
      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        text: 'mid-turn note',
        midTurnState: 'queued',
        midTurnMessageId:
          sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId,
      });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('settles a callback from the settled ring exactly once', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        sdkMock.actions.getMidTurnMessages.mockResolvedValue({
          messages: [],
          settledMessageIds: [opts?.messageId],
          promotedMessageIds: [],
        });
        return Promise.resolve({ accepted: true, messageId: opts?.messageId });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('note', undefined, onComplete);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(onComplete).toHaveBeenCalledTimes(1);

      // A later snapshot repeating the settled id must not re-invoke the
      // callback: settle deregisters it the first time.
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });

  it('leaves no callback registered after the daemon rejects admission', async () => {
    const onComplete = vi.fn();
    let rejectedId: string | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        rejectedId = opts?.messageId;
        return Promise.resolve({ accepted: false });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('rejected', undefined, onComplete);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.editor.setText).toHaveBeenCalledWith('rejected');
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();

      // If a later snapshot reports the rejected id as settled, the callback
      // must stay silent: rejection deregistered it.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [rejectedId],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('restores text when a failed enqueue is absent from the reconciliation snapshot', async () => {
    const onComplete = vi.fn();
    let failedId: string | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        failedId = opts?.messageId;
        return Promise.reject(new Error('transport failed'));
      },
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('lost in transit', undefined, onComplete);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      // The daemon never saw the message: hand the text back for a retry.
      expect(harness.editor.setText).toHaveBeenCalledWith('lost in transit');
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();

      // The catch path also deregistered the callback: a later snapshot
      // settling the id must not fire it.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [failedId],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'responding', connected: false });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a committed-but-lost admission quiet when the snapshot still queues it', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: [
          {
            messageId,
            text: 'committed anyway',
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('committed anyway');
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        text: 'committed anyway',
        midTurnState: 'queued',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('settles the callback on the injection echo and never on a repeated echo', async () => {
    const onComplete = vi.fn();
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('echoed', undefined, onComplete);
      });
      await act(async () => {
        await Promise.resolve();
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      expect(messageId).toEqual(expect.any(String));

      sdkMock.injectedBatches = [
        {
          sessionId: 'session-a',
          messages: ['echoed'],
          messageIds: [messageId],
        },
      ];
      await harness.render({ streamingState: 'responding' });
      expect(onComplete).toHaveBeenCalledTimes(1);

      // A redelivered echo repeating the same id must not fire the callback
      // a second time.
      sdkMock.injectedBatches = [
        {
          sessionId: 'session-a',
          messages: ['echoed'],
          messageIds: [messageId],
        },
      ];
      await harness.render({ streamingState: 'responding' });
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });

  it('aborts a pending legacy enqueue at the idle transition', async () => {
    let admissionSignal: AbortSignal | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (
        _message: string,
        opts?: { signal?: AbortSignal; messageId?: string },
      ) => {
        admissionSignal = opts?.signal;
        return new Promise(() => {});
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        canQueryMidTurn: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('still in flight');
      });
      expect(admissionSignal).toBeDefined();
      expect(admissionSignal?.aborted).toBe(false);

      await harness.render({ streamingState: 'idle', canQueryMidTurn: false });
      // Without the abort the in-flight admission would land in the next turn.
      expect(admissionSignal?.aborted).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('aborts an in-flight reconcile when the session changes', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    sdkMock.actions.getMidTurnMessages.mockImplementation(
      (opts?: { signal?: AbortSignal }) => {
        signals.push(opts?.signal);
        return new Promise(() => {});
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a', streamingState: 'idle' });
      const firstSignal = [...signals].reverse().find((s) => s !== undefined);
      expect(firstSignal).toBeDefined();
      expect(firstSignal?.aborted).toBe(false);

      await harness.render({ sessionId: 'session-b', streamingState: 'idle' });
      expect(firstSignal?.aborted).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('settles the promoted callback when the pending-prompt turn completes', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string }) => {
        sdkMock.actions.getMidTurnMessages.mockResolvedValue({
          messages: [],
          settledMessageIds: [],
          promotedMessageIds: [opts?.messageId],
        });
        return Promise.resolve({ accepted: true, messageId: opts?.messageId });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('promote me', undefined, onComplete);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      await harness.render({ streamingState: 'idle' });
      expect(onComplete).not.toHaveBeenCalled();
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;

      // The promoted message runs as a pending prompt under the same id; its
      // turn_complete settles the callback registered at enqueue time.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: messageId },
          },
        ]);
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });

  it('renders a stable-id message the daemon promoted and started immediately', async () => {
    // Settle-window case: the turn ends while the POST is in flight, so the
    // daemon promotes the message and starts it without queued events. The
    // started event is the only signal that tells this client to render the
    // user message — its own stream echo is suppressed and the stable-id
    // branch never created a local row.
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      let messageId: string | undefined;
      sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
        (_message: string, opts?: { messageId?: string }) => {
          messageId = opts?.messageId;
          return Promise.resolve({
            accepted: true,
            messageId: opts?.messageId,
          });
        },
      );

      let enqueued = false;
      await act(async () => {
        enqueued = harness.result().enqueuePrompt('settled late');
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(enqueued).toBe(true);
      expect(messageId).toEqual(expect.any(String));

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: messageId,
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: messageId,
              text: 'settled late',
            },
          },
        ]);
      });

      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'settled late',
        undefined,
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });
});
