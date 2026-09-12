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
import type { DaemonStreamingState } from '@qwen-code/web-shell/daemon-react-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdkMock = vi.hoisted(() => {
  const pendingEventListeners = new Set<() => void>();
  const mock = {
    actions: {
      uploadAttachment: vi.fn(),
      removeAttachment: vi.fn(),
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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/web-shell/daemon-react-sdk')
  >('@qwen-code/web-shell/daemon-react-sdk');
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HarnessOptions {
  connected?: boolean;
  writeBlocked?: boolean;
  sessionId?: string;
  workspaceCwd?: string;
  clientId?: string;
  canMutateMidTurn?: boolean;
  canQueryMidTurn?: boolean;
  canInjectMidTurnMedia?: boolean;
  streamingState?: DaemonStreamingState;
  sessionHasActivePrompt?: boolean;
  holdQueuedPromptsLocally?: boolean;
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
    restoreFiles: vi.fn(),
    restoreInputAnnotations: vi.fn(),
    focus: vi.fn(),
  };
  const stableEditorRef = { current: stableEditor } as never;
  const stableT = ((key: string) => key) as never;
  const stableReportError = vi.fn();
  const stableWorkspaceFileActions = {
    stat: vi.fn(async () => ({
      type: 'file',
      sizeBytes: 5,
      modifiedMs: 1,
    })),
    readFileBytes: vi.fn(async (path: string) => ({
      kind: 'file_bytes',
      path,
      offset: 0,
      sizeBytes: 5,
      returnedBytes: 5,
      truncated: false,
      contentBase64: btoa('hello'),
    })),
  };

  function TestComponent(opts: HarnessOptions) {
    latest = useQueuedPrompts({
      connected: opts.connected ?? true,
      writeBlocked: opts.writeBlocked ?? false,
      sessionId: opts.sessionId ?? 'session-a',
      workspaceCwd: opts.workspaceCwd ?? '/workspace',
      clientId: opts.clientId ?? CLIENT_ID,
      canMutateMidTurn: opts.canMutateMidTurn ?? true,
      canQueryMidTurn: opts.canQueryMidTurn ?? true,
      canInjectMidTurnMedia: opts.canInjectMidTurnMedia ?? true,
      workspaceFileActions: stableWorkspaceFileActions as never,
      streamingState: opts.streamingState ?? 'responding',
      sessionHasActivePrompt: opts.sessionHasActivePrompt ?? false,
      holdQueuedPromptsLocally: opts.holdQueuedPromptsLocally ?? false,
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
    workspaceFileActions: stableWorkspaceFileActions,
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
    sdkMock.actions.uploadAttachment.mockImplementation(
      async (attachment: { name?: string; mimeType?: string }) =>
        attachment.name
          ? {
              type: 'resource',
              attachmentId: attachment.name,
              mimeType: attachment.mimeType ?? 'application/octet-stream',
              size: 5,
            }
          : {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: attachment.mimeType ?? 'image/png',
              size: 3,
            },
    );
    sdkMock.actions.removeAttachment.mockResolvedValue(true);
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
    sdkMock.actions.removePendingPrompt.mockResolvedValue({ removed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sdkMock.injectedBatches = [];
    sdkMock.pendingEvents = [];
  });

  it('does not restore a row from a snapshot older than its injection', async () => {
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

      await act(async () => {
        harness.result().enqueuePrompt('already injected');
        await Promise.resolve();
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      expect(messageId).toEqual(expect.any(String));

      sdkMock.injectedBatches = [
        {
          sessionId: 'session-a',
          messages: ['already injected'],
          messageIds: [messageId],
        },
      ];
      await harness.render({ streamingState: 'responding' });
      expect(sdkMock.actions.getMidTurnMessages).toHaveBeenCalledTimes(3);
      await act(async () => {
        resolveSnapshot?.({
          messages: [{ messageId, text: 'already injected' }],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
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

  it('removes a started prompt after the client id changes without echoing it twice', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-other', text: 'queued elsewhere' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'm-other',
          text: 'queued elsewhere',
          state: 'running',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: 'client-before-reload',
            data: {
              sessionId: 'session-a',
              promptId: 'm-other',
              text: 'queued elsewhere',
            },
          },
        ]);
        await Promise.resolve();
      });

      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('removes a cross-client started prompt when its refresh fails', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'm-other',
          text: 'queued elsewhere',
          state: 'queued',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts).toMatchObject([
        { serverPromptId: 'm-other', serverState: 'queued' },
      ]);
      sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
        new Error('pending refresh failed'),
      );

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: 'client-before-reload',
            data: {
              sessionId: 'session-a',
              promptId: 'm-other',
              text: 'queued elsewhere',
            },
          },
        ]);
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore a started prompt from an older mid-turn snapshot', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const snapshot = deferred<{
        messages: Array<{ messageId: string; text: string }>;
        settledMessageIds: string[];
        promotedMessageIds: string[];
      }>();
      sdkMock.actions.getMidTurnMessages.mockReturnValueOnce(snapshot.promise);
      await harness.render({ streamingState: 'idle' });

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            data: {
              sessionId: 'session-a',
              promptId: 'm-stale',
              text: 'already started',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        snapshot.resolve({
          messages: [{ messageId: 'm-stale', text: 'already started' }],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore a completed prompt from an older pending response', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-complete', text: 'finish me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const pending = deferred<{
        pendingPrompts: Array<{
          promptId: string;
          text: string;
          state: 'queued';
        }>;
      }>();
      sdkMock.actions.getPendingPrompts.mockReturnValueOnce(pending.promise);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'm-complete',
              text: 'finish me',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'm-complete',
            },
          },
        ]);
      });
      await act(async () => {
        pending.resolve({
          pendingPrompts: [
            {
              promptId: 'm-complete',
              text: 'finish me',
              state: 'queued',
            },
          ],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore an errored prompt from an older pending response', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-error', text: 'fail me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const pending = deferred<{
        pendingPrompts: Array<{
          promptId: string;
          text: string;
          state: 'queued';
        }>;
      }>();
      sdkMock.actions.getPendingPrompts.mockReturnValueOnce(pending.promise);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'm-error',
              text: 'fail me',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_error',
            data: {
              sessionId: 'session-a',
              promptId: 'm-error',
            },
          },
        ]);
      });
      await act(async () => {
        pending.resolve({
          pendingPrompts: [
            {
              promptId: 'm-error',
              text: 'fail me',
              state: 'queued',
            },
          ],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore a settled prompt from an older mid-turn snapshot', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const snapshot = deferred<{
        messages: Array<{ messageId: string; text: string }>;
        settledMessageIds: string[];
        promotedMessageIds: string[];
      }>();
      sdkMock.actions.getMidTurnMessages.mockReturnValueOnce(snapshot.promise);
      await harness.render({ streamingState: 'idle' });

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'm-settled',
              text: 'already settled',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'm-settled',
            },
          },
        ]);
      });
      await act(async () => {
        snapshot.resolve({
          messages: [{ messageId: 'm-settled', text: 'already settled' }],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a row visible when deletion loses a race with prompt start', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-removing', text: 'remove me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.removeMidTurnMessage.mockReturnValueOnce(removal.promise);
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'm-removing',
          text: 'remove me',
          state: 'running',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts[0]?.isRemoving).toBe(true);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: 'client-before-reload',
            data: {
              sessionId: 'session-a',
              promptId: 'm-removing',
              text: 'remove me',
            },
          },
        ]);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      await act(async () => {
        removal.resolve({ removed: false });
        await Promise.resolve();
      });

      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a row visible when editing loses a race with prompt start', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [{ messageId: 'm-editing', text: 'edit me' }],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.removeMidTurnMessage.mockReturnValueOnce(removal.promise);
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'm-editing',
          text: 'edit me',
          state: 'running',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        void harness.result().editQueuedPrompt(row.id);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts[0]?.isEditing).toBe(true);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: 'client-before-reload',
            data: {
              sessionId: 'session-a',
              promptId: 'm-editing',
              text: 'edit me',
            },
          },
        ]);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      await act(async () => {
        removal.resolve({ removed: false });
        await Promise.resolve();
      });

      expect(harness.reportError).toHaveBeenCalledOnce();
      expect(harness.editor.setText).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops a settled server row after its pending action finishes', async () => {
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-settled-action',
          text: 'already started',
          state: 'queued',
        },
      ],
    });
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.removePendingPrompt.mockReturnValueOnce(removal.promise);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts[0]?.isRemoving).toBe(true);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'p-settled-action',
            },
          },
        ]);
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      await act(async () => {
        removal.resolve({ removed: false });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('drops a server row after successful deletion', async () => {
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-delete-success',
          text: 'delete me',
          state: 'queued',
        },
      ],
    });
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.removePendingPrompt.mockReturnValueOnce(removal.promise);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [],
      });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts[0]?.isRemoving).toBe(true);

      await act(async () => {
        removal.resolve({ removed: true });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a server row while deletion is in flight', async () => {
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-delete-race',
          text: 'delete me',
          state: 'queued',
        },
      ],
    });
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.removePendingPrompt.mockReturnValueOnce(removal.promise);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [],
      });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
        await Promise.resolve();
      });

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: 'client-before-reload',
            data: {
              sessionId: 'session-a',
              promptId: 'p-other',
              text: 'other prompt',
            },
          },
        ]);
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.result().queuedPrompts[0]?.isRemoving).toBe(true);

      await act(async () => {
        removal.resolve({ removed: false });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps unrelated prompts from a response that crosses a terminal event', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const pending = deferred<{
        pendingPrompts: Array<{
          promptId: string;
          text: string;
          state: 'queued' | 'running';
        }>;
      }>();
      sdkMock.actions.getPendingPrompts.mockReturnValueOnce(pending.promise);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'm-complete',
              text: 'finish me',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'm-complete',
            },
          },
        ]);
      });
      await act(async () => {
        pending.resolve({
          pendingPrompts: [
            {
              promptId: 'm-complete',
              text: 'finish me',
              state: 'running',
            },
            {
              promptId: 'm-unrelated',
              text: 'keep me',
              state: 'queued',
            },
          ],
        });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toMatchObject([
        {
          serverPromptId: 'm-unrelated',
          text: 'keep me',
          serverState: 'queued',
        },
      ]);
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
        harness
          .result()
          .enqueuePrompt('note', undefined, undefined, onComplete);
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
        harness
          .result()
          .enqueuePrompt('promote me', undefined, undefined, onComplete);
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
    sdkMock.actions.getMidTurnMessages.mockRejectedValue(
      new Error('reconciliation unavailable'),
    );
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

  it('does not resubmit an accepted message without query capability', async () => {
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
      expect(sdkMock.actions.getMidTurnMessages).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not resubmit when a legacy admission is accepted at idle', async () => {
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

      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('falls back when a query admission is rejected after the turn settles', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('query late response');
      });
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        resolveAdmission?.({ accepted: false });
      });

      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'query late response',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('falls back when live state is active but raw streaming is idle', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('live state race');
      });
      await act(async () => {
        resolveAdmission?.({ accepted: false });
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledOnce();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'live state race',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo a reasonless rejection the daemon starts itself', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        // No `reason`: an older daemon, or a rejection with another cause.
        return Promise.resolve({ accepted: false });
      },
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'reasonless fallback',
          queuedAt: Date.now(),
          state: 'running',
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('reasonless fallback');
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });

      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // Only the daemon's started event may echo this message. The UI-idle
      // guess that triggered the fallback does not say the daemon started it,
      // so the row stays visible until the events settle it.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'reasonless fallback',
          serverPromptId: 'prompt-1',
          serverState: 'running',
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('preserves file annotations when a live-state insert falls back', async () => {
    const fileText = '@docs/notes.txt';
    const text = `${fileText} explain this`;
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: fileText.length,
      text: fileText,
      reference: {
        id: 'file:docs/notes.txt',
        kind: 'file' as const,
        value: 'docs/notes.txt',
      },
    };
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(text, undefined, undefined, undefined, [annotation]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith(
        'notes.txt',
        { sessionId: 'session-a' },
      );
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        text,
        expect.objectContaining({
          files: undefined,
          inputAnnotations: [annotation],
          sessionId: 'session-a',
        }),
      );
      expect(harness.reportError).not.toHaveBeenCalled();
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

  it('keeps a row restored by a newer reconcile', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    let resolveOldSnapshot: ((value: unknown) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('committed', undefined, undefined, onComplete);
        await Promise.resolve();
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      if (!messageId) throw new Error('missing stable message id');

      sdkMock.actions.getMidTurnMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldSnapshot = resolve;
          }),
      );
      await act(async () => {
        rejectAdmission?.(new Error('response lost'));
        await Promise.resolve();
      });
      expect(resolveOldSnapshot).toBeTypeOf('function');

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [{ messageId, text: 'committed' }],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({ streamingState: 'idle' });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          midTurnMessageId: messageId,
          midTurnState: 'queued',
        }),
      ]);

      await act(async () => {
        resolveOldSnapshot?.({
          messages: [],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.reportError).not.toHaveBeenCalled();

      sdkMock.injectedBatches = [
        {
          sessionId: 'session-a',
          messages: ['committed'],
          messageIds: [messageId],
        },
      ];
      await harness.render({ streamingState: 'responding' });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it.each([false, true])(
    'falls back on server idle before the UI settles: media=%s',
    async (withMedia) => {
      let rejectAdmission: (() => void) | undefined;
      sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
        (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
          new Promise((resolve) => {
            opts?.onAdmissionStarted?.();
            rejectAdmission = () =>
              resolve({ accepted: false, reason: 'session_idle' });
          }),
      );
      const images = withMedia
        ? [{ data: 'aGVsbG8=', media_type: 'image/png' }]
        : undefined;
      sdkMock.actions.submitPrompt.mockImplementationOnce(() => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'follow-up after server idle',
              queuedAt: Date.now(),
              state: withMedia ? ('running' as const) : ('queued' as const),
              ...(withMedia
                ? {
                    content: [
                      {
                        type: 'image',
                        data: 'aGVsbG8=',
                        mimeType: 'image/png',
                      },
                    ],
                  }
                : {}),
            },
          ],
        });
        return Promise.resolve({ promptId: 'prompt-1' });
      });
      const harness = createHarness();
      try {
        await harness.render({
          streamingState: 'responding',
          sessionHasActivePrompt: true,
        });
        for (let i = 0; i < 3; i++) {
          await act(async () => {
            await Promise.resolve();
          });
        }
        sdkMock.actions.getPendingPrompts.mockClear();
        sdkMock.actions.removePendingPrompt.mockClear();
        await act(async () => {
          harness.result().enqueuePrompt('follow-up after server idle', images);
        });
        expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledOnce();
        await act(async () => {
          rejectAdmission?.();
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
        // A media fallback's confirmation runs while its row is still an
        // unbound attachment submission, which suppresses materializing
        // other queued prompts from that snapshot — so the `.finally`
        // refresh re-applies it once the row stops being one (here: echoed
        // and dropped).
        expect(sdkMock.actions.getPendingPrompts).toHaveBeenCalledTimes(
          withMedia ? 2 : 1,
        );
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
          'follow-up after server idle',
          expect.objectContaining({ sessionId: 'session-a', images }),
        );
        if (withMedia) {
          expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith(
            'media-1',
            { sessionId: 'session-a' },
          );
          expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
          expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
            'follow-up after server idle',
            [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
            { promptId: 'prompt-1' },
            undefined,
          );
          expect(harness.result().queuedPrompts).toEqual([]);
        } else {
          expect(sdkMock.actions.removeAttachment).not.toHaveBeenCalled();
          expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
          expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
          expect(harness.result().queuedPrompts).toEqual([
            expect.objectContaining({
              text: 'follow-up after server idle',
              serverPromptId: 'prompt-1',
              serverState: 'queued',
            }),
          ]);
        }
        expect(harness.reportError).not.toHaveBeenCalled();
        await harness.render({
          streamingState: 'idle',
          sessionHasActivePrompt: false,
        });
        for (let i = 0; i < 3; i++) {
          await act(async () => {
            await Promise.resolve();
          });
        }
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
        if (withMedia) {
          expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
          expect(harness.result().queuedPrompts).toEqual([]);
        } else {
          expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
          expect(harness.result().queuedPrompts).toEqual([
            expect.objectContaining({
              text: 'follow-up after server idle',
              serverPromptId: 'prompt-1',
              serverState: 'queued',
            }),
          ]);
        }
      } finally {
        await harness.dispose();
      }
    },
  );

  it('keeps an image fallback queued when the daemon does not start it immediately', async () => {
    let rejectAdmission: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          rejectAdmission = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        }),
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(() => {
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'queued image fallback',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      return Promise.resolve({ promptId: 'prompt-1' });
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      sdkMock.actions.getPendingPrompts.mockClear();
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('queued image fallback', [
            { data: 'aGVsbG8=', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        rejectAdmission?.();
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'queued image fallback',
          images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('binds an image-only idle fallback by the daemon prompt id when the snapshot carries no originator', async () => {
    let rejectAdmission: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          rejectAdmission = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        }),
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(() => {
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            // No originatorClientId: the matcher refuses an attachment row
            // it cannot attribute, so the sync binds nothing here — the
            // body's own daemon-returned id does the binding.
            text: '[image]',
            content: [
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      return Promise.resolve({ promptId: 'prompt-1' });
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
      });
      await act(async () => {
        rejectAdmission?.();
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: '',
          images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("never binds an image-only idle fallback to another client's prompt", async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const followUp = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        content: Array<{ type: string; data: string; mimeType: string }>;
        queuedAt: number;
        state: 'queued';
        originatorClientId?: string;
      }>;
    }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        // The confirmation snapshot never arrives; the follow-up refresh
        // then lists another client's image-only prompt ahead of our own.
        // Both render as the same '[image]' placeholder, so only the
        // originator tells them apart.
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => followUp.promise,
        );
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The failed confirmation leaves the row unbound rather than guessing.
      const unbound = harness.result().queuedPrompts;
      expect(unbound).toHaveLength(1);
      expect(unbound[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(unbound[0]?.serverPromptId).toBeUndefined();
      await act(async () => {
        followUp.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-other',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued',
              originatorClientId: 'client-other',
            },
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued',
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The row binds its own prompt, never the other client's, and nothing
      // may be deleted on the strength of a rendered placeholder. The
      // foreign prompt is materialized rather than suppressed: the daemon
      // holds it queued in this session, so the panel must show it.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: '',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
        expect.objectContaining({
          text: '[image]',
          serverPromptId: 'prompt-other',
          serverState: 'queued',
        }),
      ]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo an ambiguous image fallback under a started prompt id', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    // Neither resubmission resolves, so both rows stay unbound: the
    // '[image]' rendering cannot tell them apart, and the started event
    // carries no media to compare.
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'QUFB', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'QkJC', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-b',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-b',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // Either row could own the started prompt: ambiguity must degrade to
      // no echo, not the first row's images under the wrong id. Each body
      // echoes its own row once its admission resolves, and a body that
      // already returned without binding leaves the echo to the settle-time
      // consume.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      const echoRows = harness.result().queuedPrompts;
      expect(echoRows).toHaveLength(2);
      expect(echoRows.every((row) => row.serverState === 'submitting')).toBe(
        true,
      );
      expect(echoRows.every((row) => row.serverPromptId === undefined)).toBe(
        true,
      );
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('confirms a released held row whose explicit insert was refused at idle', async () => {
    let rejectInsert: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return new Promise((resolve) => {
          rejectInsert = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        });
      },
    );
    let resolveRelease: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('held follow-up');
        await Promise.resolve();
      });
      const heldId = harness.result().queuedPrompts[0]?.id;
      expect(heldId).toEqual(expect.any(Number));
      // The user asks for it now, and the daemon has already gone idle.
      let insertion!: Promise<void>;
      act(() => {
        insertion = harness.result().insertQueuedPrompt(heldId!);
      });
      await act(async () => {
        rejectInsert?.();
        await insertion;
      });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      // A hold is still active, so the row goes back to being held. It has to
      // carry the provenance with it: the drain releases this row later, and
      // that submission is the one that must not guess from the mirror.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'held follow-up' }),
      ]);
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'held follow-up',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        resolveRelease?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The admission is admission-only and the snapshot says the daemon
      // queued it behind another turn, so echoing it as sent would drop the
      // queue row that is the user's only way to edit or cancel it.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'held follow-up',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('confirms a released held row the daemon refused at idle', async () => {
    let rejectInsert: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return new Promise((resolve) => {
          rejectInsert = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        });
      },
    );
    let resolveRelease: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRelease = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('held follow-up');
        await Promise.resolve();
      });
      // A hold activates while the insert is in flight, so the idle refusal
      // lands on a client that must not submit yet: the row goes back to
      // held, carrying the provenance that the daemon already refused it once.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        rejectInsert?.();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'held follow-up' }),
      ]);
      // The hold lifts while the activity mirror reads idle. Another client's
      // prompt can occupy the daemon's FIFO before this POST without its
      // activity update having reached this browser, so the mirror is not
      // evidence that the released message started.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'held follow-up',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        resolveRelease?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The admission is admission-only: the daemon queued the message behind
      // the other client's turn. Echoing it as sent would drop the queue row
      // that is the user's only way to edit or cancel it, and the displayed
      // marker would stop every later snapshot from restoring that row.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'held follow-up',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not consume a recorded clear from a flight dispatched before it', async () => {
    let resolveStale: ((value: { pendingPrompts: [] }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let resolveResubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResubmit = resolve;
        }),
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('cancel me');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // A refresh dispatched before the admission, parked: its snapshot
      // cannot list a prompt the daemon has not been asked about yet.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStale = resolve;
            }),
        );
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The user clears the row, then the connection drops, so the body's
      // confirming refresh is skipped and it records the clear for the next
      // snapshot that can actually prove something.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        connected: false,
      });
      await act(async () => {
        resolveResubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The stale flight lands. It was dispatched before the clear was
      // recorded, so its empty snapshot is not evidence that the daemon
      // dropped the prompt — it must not consume the record.
      await act(async () => {
        resolveStale?.({ pendingPrompts: [] });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      // Reconnect with a snapshot that lists the prompt still queued: now the
      // recorded clear has positive evidence and must be applied.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'cancel me',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not resurrect a cleared row from the flight that predates the clear', async () => {
    let resolveStale:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
            originatorClientId: string;
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let resolveResubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResubmit = resolve;
        }),
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('cancel me');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStale = resolve;
            }),
        );
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        connected: false,
      });
      await act(async () => {
        resolveResubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The stale flight's snapshot DOES list the prompt as queued, and this
      // client owns it. Skipping the record is not enough: the same pass goes
      // on to sync, and with no local row and nothing suppressing the id it
      // would materialize the row the user just cleared — and stay that way
      // for as long as the client is disconnected, since every later refresh
      // is skipped.
      await act(async () => {
        resolveStale?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cancel me',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      // The record survived the stale pass, so the reconnect still cancels it.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'cancel me',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not re-echo a settled prompt from its confirming snapshot', async () => {
    let resolveConfirm:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    const fileText = '@docs/notes.txt';
    const text = `${fileText} explain this`;
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: fileText.length,
      text: fileText,
      reference: {
        id: 'file:docs/notes.txt',
        kind: 'file' as const,
        value: 'docs/notes.txt',
      },
    };
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let resolveResubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResubmit = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(text, undefined, undefined, undefined, [annotation]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // While the admission is still in flight, a snapshot binds the row by
      // its exact rendered text.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text,
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts[0]?.serverPromptId).toBe(
        'prompt-1',
      );
      // The prompt starts and the bound row echoes it. Because the source is a
      // bound row, the handler writes no re-read marker for the submit body.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: { sessionId: 'session-a', promptId: 'prompt-1', text },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      // The user stops the turn: the settle clears the displayed marker,
      // records the prompt as settled and drops the row.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              stopReason: 'cancelled',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The admission lands at last, and its confirming snapshot was served
      // before the cancel, so it still reports the prompt as running.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveConfirm = resolve;
            }),
        );
        resolveResubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveConfirm?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text,
              queuedAt: Date.now(),
              state: 'running' as const,
            },
          ],
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // Neither dedupe marker survives a settle, so the arm that echoes the
      // body's own payload for a running prompt has to consult the settled
      // set itself — otherwise the message renders twice above a cancelled
      // turn.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        text,
        undefined,
        { promptId: 'prompt-1', inputAnnotations: [annotation] },
        undefined,
      );
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not let a text row claim an attachment prompt that renders alike', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('continue', [
            { data: 'QUFB', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-a',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-a',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The daemon renders the attachment message as its caption, so the two
      // rows are indistinguishable by rendered text — and the started event
      // carries no content, so the matcher cannot see the attachment row at
      // all. A count of one is therefore not evidence of uniqueness: degrade
      // to no echo instead of appending the text row under the attachment
      // prompt's id, which loses the image and duplicates the caption when
      // the text row's own prompt starts. Each body echoes its own row once
      // its admission resolves.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('leaves rival image rows unbound when one placeholder prompt matches both', async () => {
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // An ordinary idle submission stays unflagged; both rows carry the
      // same payload, so uniqueness alone can refuse the bind.
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(2);
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // Two rows could own the one placeholder prompt: neither may claim it.
      const rivalRows = harness.result().queuedPrompts;
      expect(rivalRows).toHaveLength(2);
      expect(rivalRows.every((row) => row.serverState === 'submitting')).toBe(
        true,
      );
      expect(rivalRows.every((row) => row.serverPromptId === undefined)).toBe(
        true,
      );
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not bind an image fallback to an originator-less placeholder prompt', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        // A prompt submitted without a client id renders the same '[image]'
        // placeholder; the relaxed route must not claim it for our row.
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-foreign',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const originlessRows = harness.result().queuedPrompts;
      expect(originlessRows).toHaveLength(1);
      expect(originlessRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(originlessRows[0]?.serverPromptId).toBeUndefined();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not bind a file-bearing fallback to a prompt carrying only its image', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(
            '',
            [{ data: 'aGVsbG8=', media_type: 'image/png' }],
            [{ name: 'notes.md', media_type: 'text/markdown' }],
          );
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      const attachmentRows = harness.result().queuedPrompts;
      expect(attachmentRows).toHaveLength(1);
      expect(attachmentRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      await act(async () => {
        // Every other term of the matcher accepts this pair — the same
        // originator, a text-less row, the placeholder rendering, a fully
        // hydrated image byte-identical to the row's — so the only thing
        // refusing the bind is the row's file, which the snapshot route
        // cannot compare against a server-side attachment reference.
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-earlier',
              text: '[image]',
              content: [
                {
                  type: 'image',
                  data: 'aGVsbG8=',
                  mimeType: 'image/png',
                },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const earlierRows = harness.result().queuedPrompts;
      expect(earlierRows).toHaveLength(1);
      expect(earlierRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(earlierRows[0]?.serverPromptId).toBeUndefined();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    [
      'a prompt that renders a caption',
      'look at this',
      [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    ],
    [
      'a prompt carrying two images',
      '[image]',
      [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'image', data: 'QUFB', mimeType: 'image/png' },
      ],
    ],
  ])(
    'does not bind a blank image row to %s',
    async (_label, serverText, serverContent) => {
      sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
        (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
          opts?.onAdmissionStarted?.();
          return Promise.resolve({ accepted: false, reason: 'session_idle' });
        },
      );
      sdkMock.actions.submitPrompt.mockImplementation(
        () => new Promise<{ promptId: string }>(() => {}),
      );
      const harness = createHarness();
      try {
        await harness.render({
          streamingState: 'responding',
          sessionHasActivePrompt: true,
        });
        await act(async () => {
          harness
            .result()
            .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
        await act(async () => {
          // The snapshot holds a single candidate, so the ambiguity gate
          // cannot be what refuses this bind. A blank row owns a placeholder
          // rendering only, and its one image proves ownership only of a
          // one-image payload — a captioned prompt is a different message,
          // and a longer payload is not the row's.
          sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
            pendingPrompts: [
              {
                promptId: 'prompt-earlier',
                text: serverText,
                content: serverContent,
                queuedAt: Date.now(),
                state: 'queued' as const,
                originatorClientId: CLIENT_ID,
              },
            ],
          });
          sdkMock.publishPendingEvents([
            {
              type: 'pending_prompt_started',
              promptId: 'prompt-other',
              originatorClientId: 'client-other',
              data: {
                sessionId: 'session-a',
                promptId: 'prompt-other',
                text: 'someone else',
              },
            },
          ]);
          for (let i = 0; i < 4; i++) await Promise.resolve();
        });
        const rows = harness.result().queuedPrompts;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.serverPromptId).toBeUndefined();
        expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
        expect(harness.reportError).not.toHaveBeenCalled();
      } finally {
        await harness.dispose();
      }
    },
  );

  it('does not echo a flagged image row under another in-flight prompt', async () => {
    const flaggedImage = { data: 'QkJC', media_type: 'image/png' };
    const ordinaryImage = { data: 'QUFB', media_type: 'image/png' };
    let resolveOrdinary: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(() => new Promise<{ promptId: string }>(() => {}))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOrdinary = resolve;
          }),
      );
    const harness = createHarness();
    try {
      // The first image enqueue is idle-refused and resubmitted flagged; its
      // admission stays in flight.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [flaggedImage]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The second image enqueue takes the ordinary path, also still in
      // flight.
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [ordinaryImage]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      expect(harness.result().queuedPrompts).toHaveLength(2);
      // The ordinary row's prompt starts: the started event carries no
      // content, so neither attachment row can claim it by the shared
      // '[image]' rendering — least of all the flagged one, whose flag is
      // not an identity.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-ord',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-ord',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveOrdinary?.({ promptId: 'prompt-ord' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The ordinary row echoes under its own admission id with its own
      // image; the flagged row's image never enters the transcript.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'QUFB', mimeType: 'image/png' }],
        { promptId: 'prompt-ord' },
        undefined,
      );
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('leaves an image row unbound when two placeholder prompts both match it', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementation(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        // Two identical placeholder prompts of ours are queued: the row
        // cannot tell which one it owns, so it must claim neither and wait
        // for its own id-binding.
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const ambiguousRows = harness.result().queuedPrompts;
      expect(ambiguousRows).toHaveLength(1);
      expect(ambiguousRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(ambiguousRows[0]?.serverPromptId).toBeUndefined();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('leaves an image row unbound when the matching snapshot prompt is partially hydrated', async () => {
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () => new Promise<{ promptId: string }>(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        canInjectMidTurnMedia: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        // The snapshot prompt lost its second image to a 404: its content is
        // silently shortened to the surviving image plus the degradation
        // placeholder, so it cannot prove ownership of the row's payload.
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-p2',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
                {
                  type: 'text',
                  text: '[Attachment is no longer available]',
                },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const rows = harness.result().queuedPrompts;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(rows[0]?.serverPromptId).toBeUndefined();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
      await act(async () => {
        // A transient hydration failure leaves the second image as a raw
        // unhydrated reference: the surviving image matches the row's byte
        // for byte, so only the unhydrated-media refusal keeps this
        // different message from claiming the row.
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-p2',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
                {
                  type: 'image',
                  attachmentId: 'media-2',
                  mimeType: 'image/png',
                  size: 3,
                },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const unhydratedRows = harness.result().queuedPrompts;
      expect(unhydratedRows).toHaveLength(1);
      expect(unhydratedRows[0]?.serverPromptId).toBeUndefined();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('materializes a foreign placeholder prompt beside an unbound image fallback', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const followUp = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        content: Array<{ type: string; data: string; mimeType: string }>;
        queuedAt: number;
        state: 'queued';
        originatorClientId?: string;
      }>;
    }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => followUp.promise,
        );
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      const stuckRows = harness.result().queuedPrompts;
      expect(stuckRows).toHaveLength(1);
      expect(stuckRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(stuckRows[0]?.serverPromptId).toBeUndefined();
      await act(async () => {
        followUp.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-other',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued',
              originatorClientId: 'client-other',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The foreign prompt provably is not a duplicate of the stuck row, so
      // the attachment suppression must not hide it: the daemon holds it
      // queued in this session and the panel must show it.
      const materializedRows = harness.result().queuedPrompts;
      expect(materializedRows).toHaveLength(2);
      expect(materializedRows[0]).toEqual(
        expect.objectContaining({ text: '', serverState: 'submitting' }),
      );
      expect(materializedRows[0]?.serverPromptId).toBeUndefined();
      expect(materializedRows[1]).toEqual(
        expect.objectContaining({
          text: '[image]',
          serverPromptId: 'prompt-other',
          serverState: 'queued',
        }),
      );
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('bounds confirmation refreshes when two idle fallbacks confirm concurrently', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    // Macrotask-separated snapshots: two confirmation bodies retrying
    // against the shared sequence counter supersede each other forever,
    // so an unbounded retry storms the daemon and never binds the rows.
    // The rows are image-identical, so no rendered text can bind them —
    // only each body's id-binding can.
    sdkMock.actions.getPendingPrompts.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                pendingPrompts: [
                  {
                    promptId: 'prompt-1',
                    text: '[image]',
                    content: [
                      {
                        type: 'image',
                        data: 'aGVsbG8=',
                        mimeType: 'image/png',
                      },
                    ],
                    queuedAt: Date.now(),
                    state: 'queued' as const,
                    originatorClientId: CLIENT_ID,
                  },
                  {
                    promptId: 'prompt-2',
                    text: '[image]',
                    content: [
                      {
                        type: 'image',
                        data: 'aGVsbG8=',
                        mimeType: 'image/png',
                      },
                    ],
                    queuedAt: Date.now(),
                    state: 'queued' as const,
                    originatorClientId: CLIENT_ID,
                  },
                ],
              }),
            5,
          ),
        ),
    );
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        resolveSecond?.({ promptId: 'prompt-2' });
      });
      // Adaptive wait on the end state instead of a fixed sleep: each
      // iteration's act commits the pending renders, so a slow runner
      // extends the wait rather than failing, while a retry storm still
      // trips the call-count assertion below.
      let boundIds: Array<string | undefined> = [];
      for (let i = 0; i < 100; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        boundIds = harness
          .result()
          .queuedPrompts.map((row) => row.serverPromptId);
        if (boundIds.length === 2 && boundIds.every(Boolean)) break;
      }
      expect(sdkMock.actions.getPendingPrompts.mock.calls.length).toBeLessThan(
        8,
      );
      const rows = harness.result().queuedPrompts;
      expect(rows.map((row) => row.serverPromptId).sort()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      expect(rows.every((row) => row.serverState === 'queued')).toBe(true);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not confirm a resubmission with a snapshot older than its admission', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const staleConfirmation = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('first');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('second');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The first body's confirmation GET is parked in flight when the
      // second body's admission resolves, so the second body can only share
      // a snapshot dispatched before its own admission — one that cannot
      // list its prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => staleConfirmation.promise,
        );
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        staleConfirmation.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        // The second body must wait the stale flight out and confirm against
        // a fresh snapshot that does list its prompt.
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
            {
              promptId: 'prompt-2',
              text: 'second',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'first',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
        expect.objectContaining({
          text: 'second',
          serverPromptId: 'prompt-2',
          serverState: 'queued',
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('confirms an idle-rejected resubmission even when the session mirror reads idle', async () => {
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('idle race follow-up');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The browser renders idle before the resubmission resolves, while the
      // daemon queued the prompt behind another turn: the confirmation must
      // not key on the client's own lagging activity mirror.
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: false,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'idle race follow-up',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'idle race follow-up',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it("keeps the second body's bound row when the first body's stale flight resolves", async () => {
    const parked = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        content: Array<{ type: string; data: string; mimeType: string }>;
        queuedAt: number;
        state: 'queued';
        originatorClientId: string;
      }>;
    }>();
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(() => Promise.resolve({ promptId: 'prompt-1' }))
      .mockImplementationOnce(() => Promise.resolve({ promptId: 'prompt-2' }));
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    const queuedEntry = (promptId: string) => ({
      promptId,
      text: '[image]',
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      queuedAt: Date.now(),
      state: 'queued' as const,
      originatorClientId: CLIENT_ID,
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        canInjectMidTurnMedia: false,
      });
      // Body 1 binds its row and its tail refresh dispatches a GET whose
      // snapshot predates body 2's admission.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => parked.promise,
        );
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-1'),
      ).toBe(true);
      // Body 2 binds prompt-2 while that GET is still in flight.
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      const boundRowId = harness
        .result()
        .queuedPrompts.find((row) => row.serverPromptId === 'prompt-2')?.id;
      expect(boundRowId).toBeDefined();
      await act(async () => {
        parked.resolve({ pendingPrompts: [queuedEntry('prompt-1')] });
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [queuedEntry('prompt-1'), queuedEntry('prompt-2')],
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // The stale snapshot must not splice out the row body 2 just bound:
      // that same local row has to survive, since a rematerialized
      // replacement carries a new id and a summary-only payload.
      expect(
        harness
          .result()
          .queuedPrompts.some(
            (row) => row.id === boundRowId && row.serverPromptId === 'prompt-2',
          ),
      ).toBe(true);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('drops the local duplicate when two identical idle fallbacks queue', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // Neither local row can be told apart by text, so the refresh binds
      // neither and materializes one row per daemon prompt; each submit body
      // then has to drop its own unbound duplicate, or the message shows twice
      // and no later refresh can clear the copy that never bound.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
            {
              promptId: 'prompt-2',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveFirst?.({ promptId: 'prompt-1' });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      const rows = harness.result().queuedPrompts;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.serverPromptId).sort()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      expect(rows.every((row) => row.serverState === 'queued')).toBe(true);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // Both surviving rows are summary-only, so neither can echo: when the
      // daemon starts each prompt, the transcript copy has to come from the
      // payload the dropped row's submit body still holds.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-2',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(2);
      expect(
        harness.store.appendLocalUserMessage.mock.calls.map((call) => call[2]),
      ).toEqual([{ promptId: 'prompt-1' }, { promptId: 'prompt-2' }]);
      expect(
        harness.store.appendLocalUserMessage.mock.calls.every(
          (call) => call[0] === 'continue',
        ),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('binds two identical image idle fallbacks by daemon prompt id', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const image = { data: 'aGVsbG8=', media_type: 'image/png' };
      await act(async () => {
        harness.result().enqueuePrompt('dup', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('dup', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The rows are text-identical and both carry an image, so the snapshot
      // can neither bind them by text nor materialize rows for them; each
      // submit body must bind its own row by the id the daemon returned, or
      // the fall-through echoes the message and drops a prompt the daemon
      // still holds queued.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'dup',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
            {
              promptId: 'prompt-2',
              text: 'dup',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveFirst?.({ promptId: 'prompt-1' });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      const rows = harness.result().queuedPrompts;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.serverPromptId).sort()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      expect(rows.every((row) => row.serverState === 'queued')).toBe(true);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps an idle fallback submitting when its confirmation snapshot fails', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        harness.result().enqueuePrompt('uncertain fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      // No snapshot, no verdict: the row stays submitting until a later sync
      // can bind it; nothing is echoed or deleted on uncertainty.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'uncertain fallback',
          serverState: 'submitting',
          resubmittedAfterIdleRejection: true,
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    'holdQueuedPromptsLocally',
    'writeBlocked',
    'sessionId',
    'workspaceCwd',
  ] as const)(
    'does not submit an idle rejection across %s changes',
    async (changedOption) => {
      let rejectAdmission: (() => void) | undefined;
      sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
        (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
          new Promise((resolve) => {
            opts?.onAdmissionStarted?.();
            rejectAdmission = () =>
              resolve({ accepted: false, reason: 'session_idle' });
          }),
      );
      const harness = createHarness();
      try {
        await harness.render({ streamingState: 'responding' });
        await act(async () => {
          harness.result().enqueuePrompt('keep this follow-up');
        });
        await harness.render({
          streamingState: 'responding',
          [changedOption]:
            changedOption === 'sessionId'
              ? 'session-b'
              : changedOption === 'workspaceCwd'
                ? '/workspace-b'
                : true,
        });
        await act(async () => {
          rejectAdmission?.();
        });
        expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
        expect(harness.reportError).not.toHaveBeenCalled();
        if (changedOption === 'sessionId' || changedOption === 'workspaceCwd') {
          expect(harness.result().queuedPrompts).toEqual([]);
        } else {
          expect(harness.result().queuedPrompts).toEqual([
            expect.objectContaining({
              text: 'keep this follow-up',
              midTurnMessageId: undefined,
              midTurnState: undefined,
            }),
          ]);
        }
      } finally {
        await harness.dispose();
      }
    },
  );

  it('submits an explicit insert rejected because the session became idle', async () => {
    let rejectAdmission: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          rejectAdmission = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('held follow-up');
      });
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: false,
      });
      let insertion!: Promise<void>;
      act(() => {
        insertion = harness.result().insertQueuedPrompt(1);
      });
      await act(async () => {
        rejectAdmission?.();
        await insertion;
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'held follow-up',
        expect.objectContaining({ sessionId: 'session-a' }),
      );
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'held follow-up',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not append a delayed idle fallback after the session changes', async () => {
    let resolvePending: ((value: { pendingPrompts: [] }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('delayed fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      await harness.render({
        sessionId: 'session-b',
        streamingState: 'responding',
      });
      // A deferred snapshot is outstanding: without this the optional call
      // below would silently resolve nothing and the test would pin nothing.
      expect(resolvePending).toBeDefined();
      await act(async () => {
        resolvePending?.({ pendingPrompts: [] });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not redispatch a queued refresh for a session the user left', async () => {
    const parked = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Park the GET a started event dispatches; the flagged resubmission's
      // confirmation finds that flight older than its admission and waits it
      // out.
      sdkMock.actions.getPendingPrompts.mockImplementationOnce(
        () => parked.promise,
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'other turn',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('follow-up');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      const callsBeforeSwitch =
        sdkMock.actions.getPendingPrompts.mock.calls.length;
      // The user switches sessions while the parked flight is still out.
      sdkMock.ownerVersion += 1;
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'b-1',
            text: 'queued in B',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({
        sessionId: 'session-b',
        streamingState: 'idle',
        sessionHasActivePrompt: false,
      });
      await act(async () => {
        parked.resolve({ pendingPrompts: [] });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The waiting confirmation must not dispatch a fresh GET against the
      // abandoned session when the stale flight settles.
      const laterSessionACalls =
        sdkMock.actions.getPendingPrompts.mock.calls.filter(
          (call, index) =>
            index >= callsBeforeSwitch &&
            (call[0] as { sessionId?: string } | undefined)?.sessionId ===
              'session-a',
        );
      expect(laterSessionACalls).toEqual([]);
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'b-1',
          serverState: 'queued',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });
  it('does not redispatch a queued refresh after the connection drops', async () => {
    const parked = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Park the GET a started event dispatches; the flagged resubmission's
      // confirmation finds that flight older than its admission and waits it
      // out.
      sdkMock.actions.getPendingPrompts.mockImplementationOnce(
        () => parked.promise,
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'other turn',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('follow-up');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      const callsBeforeDrop =
        sdkMock.actions.getPendingPrompts.mock.calls.length;
      // The connection drops while the parked flight is still out.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        connected: false,
      });
      await act(async () => {
        parked.resolve({ pendingPrompts: [] });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The waiting confirmation must not dispatch a fresh GET against a
      // dead connection when the stale flight settles.
      expect(sdkMock.actions.getPendingPrompts.mock.calls.length).toBe(
        callsBeforeDrop,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('removes a delayed idle fallback cleared before its snapshot arrives', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const deleteRequest = deferred<{ removed: boolean }>();
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () => deleteRequest.promise,
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('cleared fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The confirming sync materializes a row for the cleared prompt; it
      // must be dropped before the DELETE, not only when the DELETE resolves.
      expect(harness.result().queuedPrompts).toEqual([]);
      // A refresh landing mid-removal must not resurrect the cleared row.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await act(async () => {
        deleteRequest.resolve({ removed: true });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared fallback the daemon starts before its delete lands', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const deleteRequest = deferred<{ removed: boolean }>();
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () => deleteRequest.promise,
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('cleared fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The confirming snapshot still lists the prompt queued, so the
      // cleared row's DELETE is licensed and dispatched.
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The daemon starts the prompt before the DELETE lands: the started
      // event must still echo the message, not be swallowed by the pending
      // removal marker.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'cleared fallback',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        deleteRequest.resolve({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.store.appendLocalUserMessage.mock.calls[0]?.[0]).toBe(
        'cleared fallback',
      );
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a delayed idle fallback that started before its snapshot', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('started fallback');
        await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'started fallback',
            },
          },
        ]);
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'started fallback',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not abort a cleared delayed fallback the snapshot reports running', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    const onComplete = vi.fn();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt('running fallback', undefined, undefined, onComplete);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'running fallback',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // The daemon already runs this prompt: removing it would abort a live
      // turn, so the cleared row is left to the started/completed events.
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(onComplete).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
      });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete a cleared fallback whose start its snapshot predates', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(() => Promise.resolve({ promptId: 'prompt-1' }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('cleared fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // A second message typed in the same window takes the same idle
      // fallback route; its unbound submitting row degrades the started
      // event's echo, so only the start marker records the start.
      await act(async () => {
        harness.result().enqueuePrompt('second fallback');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'cleared fallback',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        // Later snapshots report the prompt running: it really did start.
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        // The confirmation snapshot predates the start: it still lists the
        // prompt queued.
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The client already recorded the start: removing the prompt now
      // would abort the live turn, and the materialized row must not
      // resurrect the cleared draft either.
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'second fallback',
          serverState: 'submitting',
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete the queued twin the sync claimed for a displayed prompt', async () => {
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The first of two identical sends starts while the resubmission of
      // the second is still in flight: it echoes into the transcript, and
      // its event refresh splices the still-unbound row out for it.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      // The daemon then confirms the second send as its own queued prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSubmit?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The row vanished because the sync claimed it for the displayed
      // prompt, not because the user cleared it: the queued twin must
      // survive, and nothing may be deleted.
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'continue',
          serverPromptId: 'prompt-2',
          serverState: 'queued',
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete an explicit insert the sync claimed for a displayed twin', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(() =>
      Promise.resolve({ accepted: false, reason: 'session_idle' }),
    );
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        await Promise.resolve();
      });
      // An earlier identical send already started and echoed.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: false,
      });
      let insertion!: Promise<void>;
      await act(async () => {
        insertion = harness.result().insertQueuedPrompt(1);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        await insertion;
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The confirmation snapshot lists the displayed twin as running and
      // the resubmitted insert as its own queued prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSubmit?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The insert row vanished because the sync claimed it for the
      // displayed prompt, not because the user cleared it: the queued twin
      // must survive, and nothing may be deleted.
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'continue',
          serverPromptId: 'prompt-2',
          serverState: 'queued',
        }),
      ]);
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete an ordinary resend the sync leaves unbound beside its displayed twin', async () => {
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(() => Promise.resolve({ promptId: 'prompt-1' }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        canInjectMidTurnMedia: false,
      });
      // The first send is admitted as prompt-1 and echoed when it starts;
      // every ambient snapshot lists it running with its hydrated image.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([]);
      // The user sends the same image again while prompt-1 is still running;
      // its admission stays in flight...
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // ...and a refresh resolving in that window lists only the displayed
      // prompt-1: an attachment row is never claimed or content-bound to a
      // displayed prompt, so the byte-identical row stays unbound and waits
      // for its own admission to bind it by id.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          images: [image],
          serverState: 'submitting',
        }),
      ]);
      // The admission then resolves with its own prompt id: the row survived
      // and binds by that id, so nothing may be deleted and the prompt the
      // daemon admitted surfaces as itself.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'prompt-2',
          serverState: 'queued',
        }),
      ]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('reports a failed resend whose row the sync leaves unclaimed beside its displayed twin', async () => {
    const image = { data: 'aGVsbG8=', media_type: 'image/png' };
    let rejectSecond: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(() => Promise.resolve({ promptId: 'prompt-1' }))
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecond = reject;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
        canInjectMidTurnMedia: false,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The refresh leaves the attachment row unbound beside the displayed
      // twin while the resend is in flight.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          images: [image],
          serverState: 'submitting',
        }),
      ]);
      // The resend then fails: the row is gone without any user
      // cancellation, so the failure path still owns the draft.
      await act(async () => {
        rejectSecond?.(new Error('upload failed'));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([image]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not report a queue failure for an admitted submission the sync claimed', async () => {
    let rejectSubmit: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      (_text: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return new Promise((_resolve, reject) => {
          rejectSubmit = reject;
        });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        sessionHasActivePrompt: false,
        canQueryMidTurn: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('hello');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The daemon admitted and started the prompt: the started event echoes
      // it and the refresh claims the unbound row for its displayed twin.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'hello',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'hello',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([]);
      // The POST then dies on the wire: the admission already started, so
      // the failure path must not report a false queue failure for a
      // message that is on screen and running.
      await act(async () => {
        rejectSubmit?.(new Error('transport lost after admission'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('binds an originator-less snapshot prompt to a matching unbound row', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const followUp = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => followUp.promise,
        );
        harness.result().enqueuePrompt('orphan text');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      const orphanRows = harness.result().queuedPrompts;
      expect(orphanRows).toHaveLength(1);
      expect(orphanRows[0]).toEqual(
        expect.objectContaining({
          text: 'orphan text',
          serverState: 'submitting',
        }),
      );
      expect(orphanRows[0]?.serverPromptId).toBeUndefined();
      await act(async () => {
        // The daemon omits the originator when the submitter had no client
        // id, which is still possibly ours: the exact-text route fails open.
        followUp.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'orphan text',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'orphan text',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('removes a cleared idle fallback when an unrelated refresh overlaps its confirmation', async () => {
    const confirmation = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => confirmation.promise,
        );
        harness.result().enqueuePrompt('cleared fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // An unrelated started event dispatches its own refresh while the
      // confirmation snapshot is still in flight; the single-flight rule
      // makes it wait the confirmation out and re-dispatch after, and the
      // body's own refreshed snapshot is what licenses the DELETE.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        confirmation.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete a cleared fallback whose removal an action already owns', async () => {
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const deleteRequest = deferred<{ removed: boolean }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('contested fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // An unrelated refresh materializes a fresh row for the prompt the
      // daemon still holds queued, and the user deletes that row while the
      // resubmission is still in flight.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'contested fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const materialized = harness.result().queuedPrompts;
      expect(materialized).toEqual([
        expect.objectContaining({
          text: 'contested fallback',
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
      sdkMock.actions.removePendingPrompt.mockImplementationOnce(
        () => deleteRequest.promise,
      );
      await act(async () => {
        harness.result().removeQueuedPrompt(materialized[0]!.id);
        await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledTimes(1);
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'contested fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveSubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The delete action already owns this removal: the confirmation branch
      // must not fire a second DELETE for the same prompt.
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledTimes(1);
      expect(harness.reportError).not.toHaveBeenCalled();
      await act(async () => {
        deleteRequest.resolve({ removed: true });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a row whose owning action is settling when the confirmation drops rows', async () => {
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const actionRefresh = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    const branchDelete = deferred<{ removed: boolean }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('overlap fallback');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'overlap fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      const materialized = harness.result().queuedPrompts;
      expect(materialized).toHaveLength(1);
      // The user's delete resolves immediately, lifting the removal-set
      // entry while the action's own refresh is still in flight, so the row
      // stays stamped isRemoving without the set marking it.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => actionRefresh.promise,
        );
        harness.result().removeQueuedPrompt(materialized[0]!.id);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'prompt-1',
          isRemoving: true,
        }),
      ]);
      sdkMock.actions.removePendingPrompt.mockImplementationOnce(
        () => branchDelete.promise,
      );
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'overlap fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveSubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The owning action's DELETE settled and lifted the removal-set
      // entry, but the confirmation branch still must not fire a second
      // DELETE for the same prompt.
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledTimes(1);
      // The confirmation branch must not steal the mid-action row when it
      // drops rows ahead of its own DELETE.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'prompt-1',
          isRemoving: true,
        }),
      ]);
      const followUp = deferred<{ pendingPrompts: [] }>();
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => followUp.promise,
        );
        branchDelete.resolve({ removed: false });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        actionRefresh.resolve({ pendingPrompts: [] });
        followUp.resolve({ pendingPrompts: [] });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not bind an idle fallback that settled before its snapshot arrived', async () => {
    const confirmation = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => confirmation.promise,
        );
        harness.result().enqueuePrompt('settled race');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The prompt is removed by another client while the confirmation GET
      // is in flight; the stale snapshot still lists it as queued.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_completed',
            promptId: 'prompt-1',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              state: 'removed',
            },
          },
        ]);
        await Promise.resolve();
      });
      await act(async () => {
        confirmation.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'settled race',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // No phantom row may survive for a prompt that already settled: it
      // would answer Delete with a spurious failure toast and swallow the
      // draft on Edit.
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not bind an idle fallback that started during its confirmation snapshot', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const confirmation = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        content: Array<{ type: string; data: string; mimeType: string }>;
        queuedAt: number;
        state: 'queued';
        originatorClientId: string;
      }>;
    }>();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Two byte-identical image fallbacks: the sync cannot attribute either
      // queued prompt to either row by content, so both rows stay unbound
      // and only each body's id arm can bind them.
      const image = { data: 'aGVsbG8=', media_type: 'image/png' };
      const promptEntry = (promptId: string, state: 'queued' | 'running') => ({
        promptId,
        text: '[image]',
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        queuedAt: Date.now(),
        state,
        originatorClientId: CLIENT_ID,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => confirmation.promise,
        );
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The first prompt starts while the first body's confirmation GET is
      // parked.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The first body already stashed its payload under the id the daemon
      // returned, so the started event echoes immediately and correctly
      // attributed — no ambiguity remains for the text matcher to trip on.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      await act(async () => {
        // The parked snapshot predates the start: it still lists the prompt
        // as queued.
        confirmation.resolve({
          pendingPrompts: [promptEntry('prompt-1', 'queued')],
        });
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            promptEntry('prompt-1', 'running'),
            promptEntry('prompt-2', 'queued'),
          ],
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // The start marker wins over the stale snapshot: the first row echoes
      // under its running prompt instead of staying queued behind a stale
      // 'queued' stamp, whose Remove would abort the turn.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-1'),
      ).toBe(false);
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a started fallback whose prompt settled before its snapshot arrived', async () => {
    const confirmation = deferred<{
      pendingPrompts: Array<{
        promptId: string;
        text: string;
        queuedAt: number;
        state: 'queued';
      }>;
    }>();
    let resolveSubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const onComplete = vi.fn();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(
            'settled confirmation',
            undefined,
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // A refresh binds the row first, so the started event below finds it
      // already bound and registers only the completion callback: no
      // started, appended, or removed marker survives for the prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValueOnce({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'settled confirmation',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'settled confirmation',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The bound row echoed and left the queue; only the daemon-side
      // prompt remains, and only the callback tracks it.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([]);
      // The prompt settles while the confirmation GET below is parked; the
      // completed event consumes the callback and issues no refresh, so the
      // parked snapshot stays the body's only view of the prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () => confirmation.promise,
        );
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_completed',
            promptId: 'prompt-1',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              state: 'removed',
            },
          },
        ]);
        await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolveSubmit?.({ promptId: 'prompt-1' });
        await Promise.resolve();
      });
      // The stale snapshot still lists the settled prompt as queued; the
      // settle must win over it, or the body DELETEs a prompt the daemon
      // already removed.
      await act(async () => {
        confirmation.resolve({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'settled confirmation',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a cleared delayed fallback whose confirmation snapshot fails', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPending = reject;
            }),
        );
        harness.result().enqueuePrompt('uncertain clear');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // A snapshot that never arrived proves nothing about the prompt's state,
      // so the cleared row must not be removed server-side: the daemon may
      // already be running it, and removal would abort that turn.
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo a settled resubmission twice when its confirmation fails', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPending = reject;
            }),
        );
        harness.result().enqueuePrompt('probe message');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The daemon starts the prompt while the confirmation GET is in
      // flight: the started event echoes the message once.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'probe message',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      // The prompt then settles — clearing the echo guard — and the
      // confirmation GET fails.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        rejectPending?.(new Error('confirmation unavailable'));
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });
      // The settle wins over the failed snapshot: no second echo, no sticky
      // row.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops the local row after the daemon definitively rejects admission', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false });
      },
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('queue was full');
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.editor.focus).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops the local row when admission and reconciliation both fail', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockRejectedValue(
      new Error('reconciliation unavailable'),
    );
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
      expect(harness.result().queuedPrompts).toEqual([]);

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
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not complete a dropped failed admission from a later snapshot', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('recover me', undefined, undefined, onComplete);
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();

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
          .enqueuePrompt('deleted by peer', undefined, undefined, onComplete);
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
      expect(sdkMock.actions.removeAttachment).not.toHaveBeenCalled();
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

  it('does not explicitly insert a locally held Goal prompt while idle', async () => {
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('insert into active Goal');
      });

      const queuedPromptId = harness.result().queuedPrompts[0]?.id;
      // Positive control: without a held row to insert, both negatives below
      // would hold for a no-op call and the test would pin nothing.
      expect(queuedPromptId).toEqual(expect.any(Number));
      await act(async () => {
        await harness.result().insertQueuedPrompt(queuedPromptId!);
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('reconciles a committed explicit insert after its response is lost', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('explicitly inserted');
      });
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      const queuedPromptId = harness.result().queuedPrompts[0]?.id;
      expect(queuedPromptId).toEqual(expect.any(Number));
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
        const messageId =
          sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
        return {
          messages: [{ messageId, text: 'explicitly inserted' }],
          settledMessageIds: [],
          promotedMessageIds: [],
        };
      });
      await act(async () => {
        await harness.result().insertQueuedPrompt(queuedPromptId!);
      });

      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      expect(messageId).toEqual(expect.any(String));
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'explicitly inserted',
          midTurnMessageId: messageId,
          midTurnState: 'queued',
        }),
      ]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('returns an unreconciled explicit insert to the local hold', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockRejectedValueOnce(
      new Error('response lost'),
    );
    sdkMock.actions.getMidTurnMessages.mockResolvedValue(undefined);
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('do not lose me');
      });
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        await harness.result().insertQueuedPrompt(1);
      });
      // The daemon could not confirm the insert, so the row goes back to the
      // local Goal hold instead of lingering as a half-owned mid-turn row.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'do not lose me',
          isInserting: false,
        }),
      ]);
      expect(harness.result().queuedPrompts[0]?.midTurnState).toBeUndefined();
      expect(
        harness.result().queuedPrompts[0]?.midTurnMessageId,
      ).toBeUndefined();
      expect(harness.reportError).toHaveBeenCalled();

      await harness.render({
        sessionId: 'session-b',
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'do not lose me' }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('retains held prompts when a session learns its workspace while away', async () => {
    // The foreground variant below only covers a cwd that resolves while the
    // session is displayed. Resolving it while the user is on another session
    // leaves the stash under the old key, which nothing looks up again — the
    // typed text is gone for good, reload included.
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: undefined,
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('typed while away');
      });

      await harness.render({
        sessionId: 'session-b',
        workspaceCwd: '/workspace-b',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      expect(harness.result().queuedPrompts).toEqual([]);

      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-a',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'typed while away' }),
      ]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('hands a held prompt to the new owner key exactly once', async () => {
    // The relocation has to release the old key: if both keys keep the same
    // array, a later transition through the stale key re-transfers prompts that
    // were already handed off and the queue shows them twice.
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: undefined,
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('exactly once');
      });

      await harness.render({
        sessionId: 'session-b',
        workspaceCwd: '/workspace-b',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-a',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      expect(harness.result().queuedPrompts).toHaveLength(1);

      // Stop the Goal: the held prompt drains through the ordinary path.
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-a',
        streamingState: 'idle',
        holdQueuedPromptsLocally: false,
      });
      await act(async () => {
        harness.result().removeQueuedPrompt(1);
      });
      expect(harness.result().queuedPrompts).toEqual([]);

      await harness.render({
        sessionId: 'session-b',
        workspaceCwd: '/workspace-b',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-a',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });

      // The stash it came from must have been released, or the prompt the user
      // already dealt with comes back from the stale key.
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('retains held prompts when the same session learns a new workspace', async () => {
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-before',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('typed never-sent text');
      });

      await harness.render({
        sessionId: 'session-a',
        workspaceCwd: '/workspace-after',
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'typed never-sent text' }),
      ]);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore an in-flight admission across owner replacement', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('survive reattach', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'responding' });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.editor.restoreImages).not.toHaveBeenCalled();

      await act(async () => {
        resolveAdmission?.({ accepted: true });
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.editor.restoreImages).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not restore an accepted admission missing from the backend snapshot', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('accepted but absent', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts).toEqual([]);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'responding' });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.editor.restoreImages).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not preserve an ambiguous stable-id admission across reattachment', async () => {
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
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).toHaveBeenCalledOnce();
      expect(sdkMock.actions.getMidTurnMessages).toHaveBeenCalledTimes(2);

      sdkMock.ownerVersion += 1;
      await harness.render({ streamingState: 'responding' });

      expect(harness.result().queuedPrompts).toEqual([]);
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
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
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
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('cleans up a rejected stable-id admission after switching workspaces', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
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

      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();

      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });

      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not report a rejection after switching workspaces during reconciliation', async () => {
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ workspaceCwd: '/workspace-a' });
      await act(async () => {
        harness.result().enqueuePrompt('rejected in workspace-a');
      });
      sdkMock.actions.getMidTurnMessages.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      );
      await act(async () => {
        resolveAdmission?.({ accepted: false });
        await Promise.resolve();
      });
      expect(resolveSnapshot).toBeTypeOf('function');

      await harness.render({ workspaceCwd: '/workspace-b' });
      await act(async () => {
        resolveSnapshot?.({
          messages: [],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });

      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not report a transport failure after switching workspaces during reconciliation', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAdmission = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ workspaceCwd: '/workspace-a' });
      await act(async () => {
        harness.result().enqueuePrompt('failed in workspace-a');
      });
      sdkMock.actions.getMidTurnMessages.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      );
      await act(async () => {
        rejectAdmission?.(new Error('response lost'));
        await Promise.resolve();
      });
      expect(resolveSnapshot).toBeTypeOf('function');

      await harness.render({ workspaceCwd: '/workspace-b' });
      await act(async () => {
        resolveSnapshot?.({
          messages: [],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
        await Promise.resolve();
      });

      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops an accepted admission payload after switching workspaces', async () => {
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
        harness
          .result()
          .enqueuePrompt('accepted in workspace-a', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
        await Promise.resolve();
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      if (!messageId) throw new Error('missing stable message id');

      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-b',
      });
      await act(async () => {
        resolveAdmission?.({ accepted: true, messageId });
        await Promise.resolve();
      });

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [{ messageId, text: 'accepted in workspace-a' }],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({
        streamingState: 'responding',
        workspaceCwd: '/workspace-a',
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ midTurnMessageId: messageId }),
      ]);
      expect(harness.result().queuedPrompts[0]?.images).toBeUndefined();
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

  it('does not resubmit a query-capable insert accepted at turn settle', async () => {
    let resolveAdmission:
      | ((result: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    let admissionSignal: AbortSignal | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { messageId?: string; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
          admissionSignal = opts?.signal;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('query settle');
      });
      let insertion!: Promise<void>;
      act(() => {
        insertion = harness.result().insertQueuedPrompt(1);
      });
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: false,
      });
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [messageId!],
      });
      await act(async () => {
        resolveAdmission?.({ accepted: true, messageId });
        await insertion;
      });

      // An explicit insert is issued without an abort signal by design.
      expect(admissionSignal).toBeUndefined();
      expect(harness.reportError).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
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
        harness
          .result()
          .enqueuePrompt('note', undefined, undefined, onComplete);
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
      (
        _message: string,
        opts?: { messageId?: string; onAdmissionStarted?: () => void },
      ) => {
        rejectedId = opts?.messageId;
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('rejected', undefined, undefined, onComplete);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.editor.setText).not.toHaveBeenCalled();
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

  it('drops an ambiguous enqueue when the reconciliation snapshot is empty', async () => {
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
          .enqueuePrompt(
            'lost in transit',
            [{ data: 'aW1n', media_type: 'image/png' }],
            undefined,
            onComplete,
          );
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(harness.editor.setText).not.toHaveBeenCalled();
      expect(sdkMock.actions.removeAttachment).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(onComplete).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);

      // The failed local admission no longer owns a completion callback.
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
        harness
          .result()
          .enqueuePrompt('echoed', undefined, undefined, onComplete);
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

  it('settles after a pending legacy enqueue is accepted at idle', async () => {
    let admissionSignal: AbortSignal | undefined;
    let resolveAdmission:
      | ((value: { accepted: boolean; messageId?: string }) => void)
      | undefined;
    const admission = new Promise<{ accepted: boolean; messageId?: string }>(
      (resolve) => {
        resolveAdmission = resolve;
      },
    );
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (
        _message: string,
        opts?: { signal?: AbortSignal; messageId?: string },
      ) => {
        admissionSignal = opts?.signal;
        return admission;
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
      expect(admissionSignal?.aborted).toBe(false);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();

      await act(async () => {
        resolveAdmission?.({ accepted: true, messageId: 'mid-late' });
      });
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
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
        harness
          .result()
          .enqueuePrompt('promote me', undefined, undefined, onComplete);
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
        { promptId: messageId },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('attaches images as content blocks on the mid-turn push', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look at this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
        'look at this',
        expect.objectContaining({
          messageId: expect.any(String),
          content: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        }),
      );
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('uploads @ files and inserts them as session attachments', async () => {
    const harness = createHarness();
    const fileText = '@docs/notes.txt';
    const onAdmitted = vi.fn();
    let finishAdmission:
      | ((result: { accepted: true; messageId: string }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string) =>
        new Promise((resolve) => {
          finishAdmission = resolve;
        }),
    );
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt(
          `${fileText} explain:\n  key:\t\tvalue`,
          undefined,
          undefined,
          undefined,
          [
            {
              type: 'reference',
              start: 0,
              end: fileText.length,
              text: fileText,
              reference: {
                id: 'file:docs/notes.txt',
                kind: 'file',
                value: 'docs/notes.txt',
              },
            },
          ],
          onAdmitted,
        );
        await Promise.resolve();
      });

      expect(harness.workspaceFileActions.readFileBytes).toHaveBeenCalledWith(
        'docs/notes.txt',
        { offset: 0, maxBytes: 100 * 1024 },
      );
      expect(sdkMock.actions.uploadAttachment).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'notes.txt',
          mimeType: 'text/plain',
          data: expect.any(Blob),
        }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          sessionId: 'session-a',
        }),
      );
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
        'explain:\n  key:\t\tvalue',
        expect.objectContaining({
          messageId: expect.any(String),
          content: [
            {
              type: 'resource',
              attachmentId: 'notes.txt',
              mimeType: 'text/plain',
              size: 5,
            },
          ],
        }),
      );
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts[0]?.payloadCompleteness).toBe(
        'summary-only',
      );
      await act(async () => {
        finishAdmission?.({
          accepted: true,
          messageId:
            sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]
              ?.messageId ?? 'mid-file',
        });
        await Promise.resolve();
      });
      expect(onAdmitted).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('removes file attachments after deleting their mid-turn message', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-file-delete',
          text: 'delete this file',
          content: [
            {
              type: 'resource',
              attachmentId: 'attachment-1',
              mimeType: 'text/plain',
              size: 5,
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      const row = harness.result().queuedPrompts[0]!;
      await act(async () => {
        harness.result().removeQueuedPrompt(row.id);
        await Promise.resolve();
      });

      expect(sdkMock.actions.removeMidTurnMessage).toHaveBeenCalledWith(
        'm-file-delete',
        { sessionId: 'session-a' },
      );
      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith(
        'attachment-1',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('removes old-session file attachments when deletion settles after a session switch', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-file-delete-a',
          text: 'delete from A',
          content: [
            {
              type: 'resource',
              attachmentId: 'attachment-a',
              mimeType: 'text/plain',
              size: 5,
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    let finishRemoval: ((result: { removed: true }) => void) | undefined;
    sdkMock.actions.removeMidTurnMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a' });
      const row = harness.result().queuedPrompts[0]!;
      act(() => harness.result().removeQueuedPrompt(row.id));

      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({ sessionId: 'session-b' });
      await act(async () => {
        finishRemoval?.({ removed: true });
        await Promise.resolve();
      });

      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith(
        'attachment-a',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('uploads attached files and inserts them mid-turn', async () => {
    const harness = createHarness();
    const data = new Blob(['hello'], { type: 'text/plain' });
    const onAdmitted = vi.fn();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt(
          'explain this',
          undefined,
          [
            {
              name: 'notes.txt',
              media_type: 'text/plain',
              data,
              size: data.size,
            },
          ],
          undefined,
          undefined,
          onAdmitted,
        );
        await Promise.resolve();
      });

      expect(sdkMock.actions.uploadAttachment).toHaveBeenCalledWith(
        {
          name: 'notes.txt',
          data,
          text: undefined,
          mimeType: 'text/plain',
        },
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          sessionId: 'session-a',
        }),
      );
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
        'explain this',
        expect.objectContaining({
          messageId: expect.any(String),
          content: [
            {
              type: 'resource',
              attachmentId: 'notes.txt',
              mimeType: 'text/plain',
              size: 5,
            },
          ],
        }),
      );
      expect(onAdmitted).toHaveBeenCalledOnce();
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('restores an attached file when its mid-turn upload fails', async () => {
    const harness = createHarness();
    const file = {
      name: 'notes.txt',
      media_type: 'text/plain',
      data: new Blob(['hello'], { type: 'text/plain' }),
    };
    sdkMock.actions.uploadAttachment.mockRejectedValueOnce(
      new Error('upload failed'),
    );
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('explain this', undefined, [file]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith('explain this');
      expect(harness.editor.restoreFiles).toHaveBeenCalledWith([file]);
      expect(harness.reportError).toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps attached files on the ordinary queue without attachment support', async () => {
    const harness = createHarness();
    const file = {
      name: 'notes.txt',
      media_type: 'text/plain',
      data: new Blob(['hello'], { type: 'text/plain' }),
    };
    try {
      await harness.render({
        streamingState: 'responding',
        canInjectMidTurnMedia: false,
      });
      await act(async () => {
        harness.result().enqueuePrompt('explain this', undefined, [file]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.uploadAttachment).not.toHaveBeenCalled();
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'explain this',
        expect.objectContaining({ files: [file] }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('restores an @ file reference when its upload fails', async () => {
    const harness = createHarness();
    const fileText = '@docs/notes.txt';
    const onAdmitted = vi.fn();
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: fileText.length,
      text: fileText,
      reference: {
        id: 'file:docs/notes.txt',
        kind: 'file' as const,
        value: 'docs/notes.txt',
      },
    };
    sdkMock.actions.uploadAttachment.mockRejectedValueOnce(
      new Error('upload failed'),
    );
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(
            `${fileText} explain this`,
            undefined,
            undefined,
            undefined,
            [annotation],
            onAdmitted,
          );
        await Promise.resolve();
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith(
        `${fileText} explain this`,
      );
      expect(harness.editor.restoreInputAnnotations).toHaveBeenCalledWith([
        annotation,
      ]);
      expect(onAdmitted).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('keeps @ directory references on the ordinary pending path', async () => {
    const harness = createHarness();
    const directoryText = '@docs/';
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: directoryText.length,
      text: directoryText,
      reference: {
        id: 'file:docs',
        kind: 'file' as const,
        value: 'docs',
        metadata: { fileKind: 'directory' },
      },
    };
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(
            `${directoryText} summarize`,
            undefined,
            undefined,
            undefined,
            [annotation],
          );
        await Promise.resolve();
      });

      expect(harness.workspaceFileActions.readFileBytes).not.toHaveBeenCalled();
      expect(sdkMock.actions.uploadAttachment).not.toHaveBeenCalled();
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        `${directoryText} summarize`,
        expect.objectContaining({ inputAnnotations: [annotation] }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('removes uploaded media when mid-turn admission is rejected', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look at this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith('media-1', {
        sessionId: 'session-a',
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(harness.editor.restoreImages).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not enqueue uploaded media into a different session', async () => {
    let finishUpload:
      | ((reference: {
          type: 'image';
          attachmentId: string;
          mimeType: string;
          size: number;
        }) => void)
      | undefined;
    sdkMock.actions.uploadAttachment.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a' });
      act(() => {
        harness
          .result()
          .enqueuePrompt('look at this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await harness.render({ sessionId: 'session-b' });
      await act(async () => {
        finishUpload?.({
          type: 'image',
          attachmentId: 'media-a',
          mimeType: 'image/png',
          size: 3,
        });
        await Promise.resolve();
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith('media-a', {
        sessionId: 'session-a',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('injects an image-only message mid-turn', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aW1n', media_type: 'image/png' }]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          messageId: expect.any(String),
          content: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        }),
      );
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('restores media immediately when upload fails before admission', async () => {
    sdkMock.actions.uploadAttachment.mockRejectedValueOnce(
      new Error('upload failed'),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('keep this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith('keep this');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('removes successful uploads when another image fails', async () => {
    sdkMock.actions.uploadAttachment
      .mockResolvedValueOnce({
        type: 'image',
        attachmentId: 'uploaded-before-failure',
        mimeType: 'image/png',
        size: 3,
      })
      .mockRejectedValueOnce(new Error('second upload failed'));
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness.result().enqueuePrompt('keep this', [
          { data: 'aW1nMQ==', media_type: 'image/png' },
          { data: 'aW1nMg==', media_type: 'image/png' },
        ]);
        await Promise.resolve();
      });

      expect(sdkMock.actions.removeAttachment).toHaveBeenCalledWith(
        'uploaded-before-failure',
        { sessionId: 'session-a' },
      );
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith('keep this');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1nMQ==', media_type: 'image/png' },
        { data: 'aW1nMg==', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps the images on an accepted media row through reconciliation', async () => {
    // The daemon snapshot is text-only; the row rebuilt from it must still
    // carry the images so display and edit/restore don't lose them.
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: messageId ? [{ messageId, text: 'look at this' }] : [],
        settledMessageIds: [],
        promotedMessageIds: [],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look at this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'look at this',
        midTurnState: 'queued',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('restores images to the editor when editing a queued media row', async () => {
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: messageId ? [{ messageId, text: 'edit me' }] : [],
        settledMessageIds: [],
        promotedMessageIds: [],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('edit me', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row?.images).toEqual([{ data: 'aW1n', media_type: 'image/png' }]);

      await act(async () => {
        harness.result().editQueuedPrompt(row!.id);
      });
      await act(async () => {
        await Promise.resolve();
      });

      // The daemon entry is removed and the full payload (text + images) is
      // restored to the editor.
      expect(sdkMock.actions.removeMidTurnMessage).toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith('edit me');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps images when a media message is promoted into the pending-prompt FIFO', async () => {
    // Settle race: the turn ends while the POST is in flight, so the daemon
    // promotes the message instead of draining it. It then surfaces as a
    // pending-prompt (server) row — that row must still carry the images so
    // the queue shows them and editing restores them.
    sdkMock.actions.getMidTurnMessages.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: messageId ? [messageId] : [],
      };
    });
    sdkMock.actions.getPendingPrompts.mockImplementation(async () => {
      const messageId =
        sdkMock.actions.enqueueMidTurnMessage.mock.calls[0]?.[1]?.messageId;
      return {
        pendingPrompts: messageId
          ? [
              {
                promptId: messageId,
                text: 'promoted note',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ]
          : [],
      };
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('promoted note', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'promoted note',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('keeps promoted media available when the pending-prompt refresh fails', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      let messageId: string | undefined;
      sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
        (_message: string, opts?: { messageId?: string }) => {
          messageId = opts?.messageId;
          return Promise.resolve({ accepted: true, messageId });
        },
      );
      sdkMock.actions.getMidTurnMessages.mockImplementation(async () => ({
        messages: [],
        settledMessageIds: [],
        promotedMessageIds: messageId ? [messageId] : [],
      }));
      sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
        new Error('pending snapshot unavailable'),
      );

      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aW1n', media_type: 'image/png' }]);
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts).toEqual([]);

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: messageId,
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: messageId,
              text: '',
            },
          },
        ]);
      });

      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aW1n', mimeType: 'image/png' }],
        { promptId: messageId },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('restores images from the snapshot after a refresh (no in-memory admission)', async () => {
    // Page-refresh case: nothing was enqueued this mount, so there is no pending
    // admission to salvage from — the daemon snapshot's media blocks are the
    // only source and must rebuild the row's images.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-refresh',
          text: 'refreshed note',
          content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'refreshed note',
        midTurnState: 'queued',
        midTurnMessageId: 'm-refresh',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('degrades a refresh-rebuilt row when media hydration failed', async () => {
    // The SDK substitutes a placeholder text block for a attachment reference it
    // could not hydrate. The rebuilt row must surface the loss (summary-only)
    // instead of silently rendering as a complete, editable row.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-degraded',
          text: 'degraded note',
          content: [
            {
              type: 'text',
              text: '[Attachment is no longer available]',
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'degraded note',
        midTurnState: 'queued',
        midTurnMessageId: 'm-degraded',
        payloadCompleteness: 'summary-only',
      });
      expect(row?.images).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });

  it('restores images from pending-prompt content after a refresh', async () => {
    // Page-refresh case for a promoted message: nothing was enqueued this
    // mount, so there is no pending admission to salvage from — the daemon's
    // getPendingPrompts content field is the only source and must rebuild the
    // row's images.
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-refresh',
          text: 'refreshed prompt',
          content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'refreshed prompt',
        serverPromptId: 'p-refresh',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
      // A server row rebuilt WITH hydrated images is payload-complete — it
      // must not stay pinned to summary-only (which disables editing and
      // leaves delete-and-retype as the only way to change the message).
      expect(row?.payloadCompleteness).not.toBe('summary-only');

      // Editing proceeds through the pending-prompt removal instead of
      // early-returning, and restores text + images into the editor.
      sdkMock.actions.removePendingPrompt.mockResolvedValue({ removed: true });
      await act(async () => {
        void harness.result().editQueuedPrompt(row!.id);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'p-refresh',
        { sessionId: 'session-a' },
      );
      expect(harness.editor.setText).toHaveBeenCalledWith('refreshed prompt');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps file summaries from pending-prompt content after a refresh', async () => {
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-file-refresh',
          text: 'refreshed file prompt',
          content: [
            {
              type: 'resource',
              attachmentId: 'notes.txt',
              mimeType: 'text/plain',
              size: 5,
            },
          ],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(harness.result().queuedPrompts[0]).toMatchObject({
        text: 'refreshed file prompt',
        serverPromptId: 'p-file-refresh',
        files: [
          {
            name: 'notes.txt',
            media_type: 'text/plain',
            size: 5,
            attachmentId: 'notes.txt',
          },
        ],
        payloadCompleteness: 'summary-only',
      });
    } finally {
      await harness.dispose();
    }
  });

  it('keeps images on the next turn when the daemon lacks the media capability', async () => {
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        canInjectMidTurnMedia: false,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('with image', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'with image',
        expect.objectContaining({
          images: [{ data: 'aW1n', media_type: 'image/png' }],
        }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('keeps the whole message on the next turn when an image has no concrete mime type', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('odd image', [
            { data: 'aW1n', media_type: 'image/*' },
          ]);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledWith(
        'odd image',
        expect.objectContaining({
          images: [{ data: 'aW1n', media_type: 'image/*' }],
        }),
      );
    } finally {
      await harness.dispose();
    }
  });

  it('upgrades a degraded row once a later snapshot hydrates the media', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-degraded',
          text: 'degraded note',
          content: [
            {
              type: 'text',
              text: '[Attachment is no longer available]',
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      let row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        midTurnMessageId: 'm-degraded',
        payloadCompleteness: 'summary-only',
      });
      expect(row?.images).toBeUndefined();

      // The daemon still holds the media; the next reconciliation hydrates it,
      // so the provisional degradation must clear and the payload returns.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [
          {
            messageId: 'm-degraded',
            text: 'degraded note',
            content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }],
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({
        streamingState: 'responding',
        connected: false,
      });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        midTurnMessageId: 'm-degraded',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
      expect(row?.payloadCompleteness).not.toBe('summary-only');

      // The row is editable again: editing restores text + images.
      await act(async () => {
        void harness.result().editQueuedPrompt(row!.id);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.editor.setText).toHaveBeenCalledWith('degraded note');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('degrades a refresh-rebuilt row when media hydration only transiently failed', async () => {
    // A transient hydration failure (anything but 404/410) leaves the raw
    // reference block in the snapshot — image-shaped but without string
    // `data`. The rebuilt row must degrade to summary-only like the
    // placeholder case, so editing cannot silently discard attachments the
    // daemon still holds.
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-flaky',
          text: 'flaky note',
          content: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        text: 'flaky note',
        midTurnState: 'queued',
        midTurnMessageId: 'm-flaky',
        payloadCompleteness: 'summary-only',
      });
      expect(row?.images).toBeUndefined();

      // Editing stays blocked: no daemon-message removal, no draft restore.
      await act(async () => {
        void harness.result().editQueuedPrompt(row!.id);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(sdkMock.actions.removeMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('self-heals a transiently degraded row once every reference hydrates', async () => {
    sdkMock.actions.getMidTurnMessages.mockResolvedValue({
      messages: [
        {
          messageId: 'm-flaky',
          text: 'flaky note',
          content: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
        },
      ],
      settledMessageIds: [],
      promotedMessageIds: [],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        midTurnMessageId: 'm-flaky',
        payloadCompleteness: 'summary-only',
      });

      // A partially hydrated snapshot (one reference still unhydrated) must
      // NOT upgrade the row — upgrading on the hydrated subset would drop
      // the other attachment.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [
          {
            messageId: 'm-flaky',
            text: 'flaky note',
            content: [
              { type: 'image', data: 'aW1n', mimeType: 'image/png' },
              {
                type: 'image',
                attachmentId: 'media-2',
                mimeType: 'image/png',
                size: 3,
              },
            ],
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({
        streamingState: 'responding',
        connected: false,
      });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts[0]).toMatchObject({
        midTurnMessageId: 'm-flaky',
        payloadCompleteness: 'summary-only',
      });

      // Fully hydrated: the upgrade path restores the payload and editability.
      sdkMock.actions.getMidTurnMessages.mockResolvedValue({
        messages: [
          {
            messageId: 'm-flaky',
            text: 'flaky note',
            content: [
              { type: 'image', data: 'aW1n', mimeType: 'image/png' },
              { type: 'image', data: 'aW1nMg==', mimeType: 'image/png' },
            ],
          },
        ],
        settledMessageIds: [],
        promotedMessageIds: [],
      });
      await harness.render({
        streamingState: 'responding',
        connected: false,
      });
      await harness.render({ streamingState: 'responding', connected: true });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        midTurnMessageId: 'm-flaky',
        images: [
          { data: 'aW1n', media_type: 'image/png' },
          { data: 'aW1nMg==', media_type: 'image/png' },
        ],
      });
      expect(row?.payloadCompleteness).not.toBe('summary-only');

      // The row is editable again: editing restores text + images.
      await act(async () => {
        void harness.result().editQueuedPrompt(row!.id);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.editor.setText).toHaveBeenCalledWith('flaky note');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
        { data: 'aW1nMg==', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes text and images when a promoted media message starts', async () => {
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
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look at this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: messageId,
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: messageId,
              text: 'look at this',
            },
          },
        ]);
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'look at this',
        [{ data: 'aW1n', mimeType: 'image/png' }],
        { promptId: messageId },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes an image-only message when its promoted turn starts', async () => {
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
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aW1n', media_type: 'image/png' }]);
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: messageId,
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: messageId,
              text: '',
            },
          },
        ]);
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aW1n', mimeType: 'image/png' }],
        { promptId: messageId },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('restores the draft when the session changes before upload reaches the daemon', async () => {
    let finishUpload:
      | ((reference: {
          type: 'image';
          attachmentId: string;
          mimeType: string;
          size: number;
        }) => void)
      | undefined;
    sdkMock.actions.uploadAttachment.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({ sessionId: 'session-a' });
      act(() => {
        harness
          .result()
          .enqueuePrompt('keep this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      await harness.render({ sessionId: 'session-b' });
      await act(async () => {
        finishUpload?.({
          type: 'image',
          attachmentId: 'media-a',
          mimeType: 'image/png',
          size: 3,
        });
        await Promise.resolve();
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      // Nothing reached the daemon, so the draft comes back and the stale
      // admission is dropped instead of leaking into the other session.
      expect(sdkMock.actions.enqueueMidTurnMessage).not.toHaveBeenCalled();
      expect(harness.editor.setText).toHaveBeenCalledWith('keep this');
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
      expect(harness.reportError).toHaveBeenCalled();

      // Returning to session A must not materialize an unresolvable row.
      await harness.render({ sessionId: 'session-a' });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('clears summary-only when a refresh restores fully hydrated images into an existing row', async () => {
    // A pending prompt whose references transiently fail hydration rebuilds
    // as summary-only; once a later refresh hydrates them, the existing row
    // must regain its images AND its editability.
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-flaky',
          text: 'flaky prompt',
          content: [
            {
              type: 'image',
              attachmentId: 'media-1',
              mimeType: 'image/png',
              size: 3,
            },
          ],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      const degraded = harness.result().queuedPrompts[0];
      expect(degraded).toMatchObject({
        serverPromptId: 'p-flaky',
        payloadCompleteness: 'summary-only',
      });
      expect(degraded?.images).toBeUndefined();

      // The next refresh hydrates fully: the row regains images and the
      // summary-only flag clears.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'p-flaky',
            text: 'flaky prompt',
            content: [{ type: 'image', data: 'aW1n', mimeType: 'image/png' }],
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      await harness.render({ streamingState: 'idle', connected: false });
      await harness.render({ streamingState: 'idle', connected: true });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        serverPromptId: 'p-flaky',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
      expect(row?.payloadCompleteness).not.toBe('summary-only');

      // Editing proceeds instead of early-returning.
      sdkMock.actions.removePendingPrompt.mockResolvedValue({ removed: true });
      await act(async () => {
        void harness.result().editQueuedPrompt(row!.id);
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'p-flaky',
        { sessionId: 'session-a' },
      );
      expect(harness.editor.restoreImages).toHaveBeenCalledWith([
        { data: 'aW1n', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a partially hydrated pending-prompt row summary-only', async () => {
    // One attachment hydrated, one still an unhydrated reference: restoring
    // only the survivor and marking the row complete would let editing
    // silently discard the attachment the daemon still holds.
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-partial',
          text: 'look at both',
          content: [
            { type: 'image', data: 'aW1n', mimeType: 'image/png' },
            {
              type: 'image',
              attachmentId: 'media-2',
              mimeType: 'image/png',
              size: 3,
            },
          ],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      const row = harness.result().queuedPrompts[0];
      expect(row).toMatchObject({
        serverPromptId: 'p-partial',
        payloadCompleteness: 'summary-only',
        images: [{ data: 'aW1n', media_type: 'image/png' }],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('keeps an own-client summary-only row when its prompt starts', async () => {
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'p-summary-started',
          text: 'look at both',
          content: [
            { type: 'image', data: 'aW1n', mimeType: 'image/png' },
            {
              type: 'image',
              attachmentId: 'media-2',
              mimeType: 'image/png',
              size: 3,
            },
          ],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      expect(harness.result().queuedPrompts[0]?.payloadCompleteness).toBe(
        'summary-only',
      );

      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'p-summary-started',
              text: 'look at both',
            },
          },
        ]);
        await Promise.resolve();
      });

      expect(harness.result().queuedPrompts).toHaveLength(1);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('drops the pinned admission when the session changes after the enqueue was dispatched', async () => {
    // Upload complete, enqueue in flight, session switched: the abort
    // rejects the dispatched enqueue. The admission (with its base64 images)
    // must be dropped instead of staying pinned until reload and
    // materializing a stale row on return.
    let rejectEnqueue: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectEnqueue = reject;
      }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('leak this', [
            { data: 'aW1n', media_type: 'image/png' },
          ]);
      });
      // Let the upload settle so the enqueue is dispatched (enqueueStarted).
      await act(async () => {
        await Promise.resolve();
      });
      expect(sdkMock.actions.enqueueMidTurnMessage).toHaveBeenCalledTimes(1);

      await harness.render({
        sessionId: 'session-b',
        streamingState: 'responding',
      });
      await act(async () => {
        rejectEnqueue?.(new DOMException('Aborted', 'AbortError'));
        await Promise.resolve();
      });

      // Returning to session-a must not materialize the stale admission row.
      await harness.render({
        sessionId: 'session-a',
        streamingState: 'responding',
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('materializes a foreign queued prompt beside an image fallback', async () => {
    let rejectAdmission: (() => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) =>
        new Promise((resolve) => {
          opts?.onAdmissionStarted?.();
          rejectAdmission = () =>
            resolve({ accepted: false, reason: 'session_idle' });
        }),
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(() => {
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-0',
            text: 'someone else',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
          {
            promptId: 'prompt-1',
            text: 'queued image fallback',
            content: [
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      return Promise.resolve({ promptId: 'prompt-1' });
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('queued image fallback', [
            { data: 'aGVsbG8=', media_type: 'image/png' },
          ]);
      });
      await act(async () => {
        rejectAdmission?.();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // This row is an unbound attachment submission while the confirming
      // snapshot is applied, and that state deliberately suppresses
      // materializing anything else in the snapshot. Once the row is bound the
      // other client's prompt must still appear: the daemon is holding it for
      // this session, and this client is the only place it can be seen,
      // edited or cleared.
      const ids = harness
        .result()
        .queuedPrompts.map((row) => row.serverPromptId);
      expect(ids).toContain('prompt-0');
      expect(ids).toContain('prompt-1');
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('binds two identical image fallbacks by id instead of echoing one', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('dup', [
            { data: 'aGVsbG8=', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('dup', [
            { data: 'aGVsbG8=', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // Neither row can be told apart by rendered text, and an attachment row
      // is never materialized from the snapshot, so nothing binds by text. The
      // confirmation then has to bind by the id the daemon returned — otherwise
      // the second message is echoed as sent and its row deleted while the
      // daemon still holds it merely queued.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'dup',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
            {
              promptId: 'prompt-2',
              text: 'dup',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveFirst?.({ promptId: 'prompt-1' });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      const rows = harness.result().queuedPrompts;
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.serverPromptId).sort()).toEqual([
        'prompt-1',
        'prompt-2',
      ]);
      expect(rows.every((row) => row.serverState === 'queued')).toBe(true);
      expect(rows.every((row) => row.images?.length === 1)).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo a started image prompt under another row id', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'Zmlyc3Q=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'c2Vjb25k', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The second submit is admitted first and starts. Every image-only
      // prompt renders to the same placeholder, so the started event cannot
      // say which unbound row it belongs to: it must not guess, or the first
      // row's image is echoed under the second prompt's id and the message
      // that really started is never echoed at all.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-2',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        resolveSecond?.({ promptId: 'prompt-2' });
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The row whose prompt actually started echoes its own image; the other
      // stays queued for the daemon to run.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'c2Vjb25k', mimeType: 'image/png' }],
        { promptId: 'prompt-2' },
        undefined,
      );
      const rows = harness.result().queuedPrompts;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        serverPromptId: 'prompt-1',
        serverState: 'queued',
      });
      expect(rows[0]?.images).toEqual([
        { data: 'Zmlyc3Q=', media_type: 'image/png' },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes an image fallback whose started event lands after a lost snapshot', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockRejectedValueOnce(new Error('pending snapshot unavailable'))
          .mockImplementation(() => new Promise(() => {}));
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The confirmation never arrived and no later snapshot resolves, so the
      // row stays unbound: nothing binds it by text to a placeholder. The
      // echo below must come from the payload the submit body stashed under
      // the id the daemon returned.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverState: 'submitting',
          resubmittedAfterIdleRejection: true,
        }),
      ]);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // The daemon ran this message, so the user's own image must reach the
      // transcript exactly once, found through the id the row is bound to.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a cleared row hidden when a refresh lands during its removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    const removal = deferred<{ removed: boolean }>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () => removal.promise,
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('cleared fallback');
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      // Another client's prompt starts, and its handler ends in a refresh whose
      // snapshot still lists the cleared prompt as queued. The row the user
      // cleared must not come back for the rest of the DELETE round trip.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared fallback',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-9',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-9',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await act(async () => {
        removal.resolve({ removed: true });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback the snapshot reports running', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      // The running snapshot is itself an echo trigger: the body still holds
      // the real attachments, so the message reaches the transcript here —
      // before any started event arrives.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      // The daemon is running a message whose row the user already cleared, so
      // it belongs in the transcript — but the started event carries only the
      // rendered placeholder, which would put a literal "[image]" there and
      // lose the image. This body still holds the real attachments.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo a resubmitted message twice when its turn ends mid-confirmation', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('follow-up after server idle');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The daemon starts the prompt while the confirming snapshot is still in
      // flight, and the turn ends inside the same window: the started event
      // echoes once, and the terminal event then clears the displayed-id
      // dedupe that would have stopped a second echo.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'follow-up after server idle',
            },
          },
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The user clears the queue while the confirmation is still in flight,
      // so the body resumes with no local row and only the re-read echo flag
      // standing between it and a second append.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'follow-up after server idle',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The body resumes after the await: it must re-read the started
      // handler's echo flag rather than trust the one it consumed before the
      // await, or the same message lands in the transcript twice.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared annotated fallback with its reference chips', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    const fileText = '@docs/notes.txt';
    const text = `${fileText} explain this`;
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: fileText.length,
      text: fileText,
      reference: {
        id: 'file:docs/notes.txt',
        kind: 'file' as const,
        value: 'docs/notes.txt',
      },
    };
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt(text, undefined, undefined, undefined, [annotation]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The started event reproduces the text but not the annotations, so the
      // echo has to come from the payload the submit body stashed: without it
      // the reference chip is missing from a message the daemon received with
      // one.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: { sessionId: 'session-a', promptId: 'prompt-1', text },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        text,
        undefined,
        { promptId: 'prompt-1', inputAnnotations: [annotation] },
        undefined,
      );
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text,
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not let a same-text row steal a stashed echo', async () => {
    let resolveConfirm:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            // The second submission never resolves: its row stays unbound and
            // in flight, which is the state the started event must not guess
            // from.
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveConfirm = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt('summarize this', [
            { data: 'aGVsbG8=', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        harness.result().enqueuePrompt('summarize this');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The daemon starts the image message while its own confirmation is
      // still pending. A second, text-only submission of the same text is in
      // flight and unbound, so a rendered-text match would echo that one
      // instead: right text, missing image, wrong message.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'summarize this',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'summarize this',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      await act(async () => {
        resolveConfirm?.({ pendingPrompts: [] });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback whose started event beats the snapshot', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The session really was idle, so the daemon starts the prompt while the
      // confirming snapshot is still in flight. The row is already gone and the
      // event carries only the rendered placeholder, so the echo has to come
      // from the payload the submit body stashed under this prompt id.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // The late snapshot must not echo a second time, and must not delete a
      // prompt the daemon is already running.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback whose removal fails before the prompt starts', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    // A lost DELETE rather than a not-removed answer: this fixture goes on
    // to show the prompt starting, which `{ removed: false }` rules out —
    // that answer means the id is absent, or already removed and hidden.
    sdkMock.actions.removePendingPrompt.mockRejectedValueOnce(
      new Error('delete lost'),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          // The failure re-sync sees the daemon already running the prompt, so
          // it cannot materialize a row for the started event to bind to.
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The snapshot licensed the removal, but the DELETE failed, so the
      // daemon goes on to start a prompt this client no longer shows.
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // The echo must come from the stashed payload: the row is gone and the
      // event carries only the placeholder. The DELETE was lost, so the
      // client cannot tell whether the daemon ever received it, and the
      // prompt may well have started — as it does here. The request had
      // already failed before this event arrived, so nothing was parked for
      // a replay: the started handler finds the surviving stash and echoes
      // it.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback whose started event lands inside a failed removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The idle daemon starts the prompt while the DELETE is in flight, so
      // the started event lands inside the removal window and is parked. The
      // DELETE can still come back not-removed — a peer removed the id first,
      // and the doomed prompt runs on to settle — and the replay is what
      // echoes it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared text fallback whose started event lands inside a failed removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: 'cleared mid-removal',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness.result().enqueuePrompt('cleared mid-removal');
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'cleared mid-removal',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'cleared mid-removal',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // A text-only payload has no echo stash, so the replay comes from the
      // parked event's own text.
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'cleared mid-removal',
        undefined,
        { promptId: 'prompt-1' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes an image fallback whose deferred clear fails after the prompt starts', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          // The confirming snapshot fails, so the clear is parked until a
          // later snapshot can say what the daemon holds.
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValueOnce({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ],
          })
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The follow-up snapshot lists the prompt as queued, which licenses the
      // deferred removal; the daemon then starts it while the DELETE is in
      // flight, and the removal fails.
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback whose failed removal re-sync materializes a row', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    // A lost DELETE rather than a not-removed answer: only a request that
    // never arrived can leave the prompt queued for the re-sync to find.
    sdkMock.actions.removePendingPrompt.mockRejectedValueOnce(
      new Error('delete lost'),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          // The removal never reached the daemon, so the prompt is still
          // queued and the failure re-sync materializes a summary-only row
          // for it — the daemon's summary cannot reproduce the image.
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The started event resolves the materialized row by id, but that row
      // is summary-only and cannot be echoed — the stashed payload must
      // outrank it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared file fallback with its file chips', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    const file = { name: 'notes.txt', media_type: 'text/plain' };
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('', undefined, [file]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // A caption-less file message renders as nothing, so the started event
      // carries no text either: the echo has to come from the payload the
      // submit body stashed, or a message the daemon received with a file
      // chip never reaches the transcript.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        undefined,
        { promptId: 'prompt-1' },
        [{ name: 'notes.txt', mimeType: 'text/plain' }],
      );
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('completes a cleared fallback whose removal fails and the prompt runs', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt(
            '',
            [{ data: 'aGVsbG8=', media_type: 'image/png' }],
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The removal came back not-removed, so the daemon no longer holds
      // the prompt as removable and it runs on: its message was replayed
      // into the transcript and its completion callback must fire.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(onComplete).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('completes a cleared fallback whose deferred removal fails and the prompt runs', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValueOnce({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ],
          })
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt(
            '',
            [{ data: 'aGVsbG8=', media_type: 'image/png' }],
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(onComplete).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared image fallback whose turn errors inside a failed removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({ pendingPrompts: [] });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The daemon starts the prompt and the turn errors while the DELETE is
      // still in flight: the terminal event settles the prompt, but the echo
      // stash must survive until the removal's outcome is known.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
          {
            type: 'turn_error',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared text fallback whose started event a pending submission suppressed', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      // The second submission never settles, leaving an unbound submitting
      // row that suppresses the started event's raw-text echo.
      .mockImplementationOnce(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('first message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        harness.result().enqueuePrompt('second message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The started event carries the full text, but echoing it raw while an
      // unrelated submission is still unbound would risk stealing that row's
      // echo — so it is suppressed, and the park records the start for the
      // submit body to consume.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'first message',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first message',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'first message',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a cleared fallback whose parked start its own snapshot postdates', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('first message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        harness.result().enqueuePrompt('second message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The start parks before the confirming snapshot resolves. The
      // started handler's refresh waits the in-flight confirmation out
      // rather than superseding it, so this snapshot resolves 'refreshed'
      // and still lists the prompt 'queued' — what blocks the removal is
      // the parked-start marker, and the park's echo is consumed instead.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'first message',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first message',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'first message',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('completes a cleared fallback whose turn is cancelled inside a failed removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({ pendingPrompts: [] });
        harness
          .result()
          .enqueuePrompt(
            '',
            [{ data: 'aGVsbG8=', media_type: 'image/png' }],
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The prompt starts and its turn is cancelled while the DELETE is in
      // flight: a cancelled turn still counts as completed for a prompt the
      // daemon demonstrably started, so the failed removal's callback settle
      // fires immediately instead of registering into a void.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              stopReason: 'cancelled',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes nothing when a parked start still ends in a successful removal', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolvePending = resolve;
              }),
          )
          .mockResolvedValue({ pendingPrompts: [] });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The removal succeeded: the daemon confirmed the prompt is gone, so
      // the parked start stays dropped and nothing is replayed.
      await act(async () => {
        resolveRemoval?.({ removed: true });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes nothing when a deferred clear succeeds after a parked start', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValueOnce({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ],
          })
          .mockResolvedValue({ pendingPrompts: [] });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: true });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a cleared fallback a later snapshot reports running', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: 'cleared then started',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness.result().enqueuePrompt('cleared then started');
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The confirmation fails, and the next snapshot finds the prompt
      // already running: the deferred clear must drop the entry rather than
      // abort a live turn.
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not complete a deferred clear whose removed event beats the DELETE response', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValueOnce({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: '[image]',
                queuedAt: Date.now(),
                state: 'queued' as const,
              },
            ],
          })
          .mockResolvedValue({ pendingPrompts: [] });
        harness
          .result()
          .enqueuePrompt(
            '',
            [{ data: 'aGVsbG8=', media_type: 'image/png' }],
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      // The daemon publishes the removal event before the DELETE response
      // arrives; by then the callback must already be unregistered, or the
      // event's handler fires it for a message that never ran.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_completed',
            promptId: 'prompt-1',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              state: 'removed',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: true });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(onComplete).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared text fallback whose suppressed start is consumed at turn end', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('first message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        harness.result().enqueuePrompt('second message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The snapshot resolves first: the body has no park to consume yet and
      // nothing else to echo for a text-only payload, so it returns quietly.
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first message',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The started event arrives after the body returned and its raw-text
      // echo is suppressed by the unrelated in-flight submission, so the
      // start is parked with the body gone.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'first message',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'first message',
        undefined,
        { promptId: 'prompt-1' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('removes a cleared fallback once a later snapshot confirms it is queued', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPending = reject;
            }),
        );
        harness.result().enqueuePrompt('cleared then resurrected');
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The confirmation fails, and every later snapshot is the daemon telling
      // the truth: it still holds the message the user cleared.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'cleared then resurrected',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The confirmation proved nothing, so nothing was removed then. This
      // snapshot is the positive evidence: the user's clear is applied to it
      // instead of letting the cancelled message reappear in the queue and run.
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('re-syncs when a deferred clear fails to remove the prompt', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    // A rejected DELETE is the reachable way to fail a removal: the request
    // may never have arrived, so the daemon can still hold the message
    // queued. A resolved `{ removed: false }` cannot — it means the id is
    // absent, or a running prompt was already removed and is hidden from
    // every later snapshot.
    sdkMock.actions.removePendingPrompt.mockRejectedValue(
      new Error('delete lost'),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPending = reject;
            }),
        );
        harness.result().enqueuePrompt('cleared but kept');
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'cleared but kept',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The removal never reached the daemon, so it still holds the message:
      // the row has to be visible again instead of silently missing from the
      // queue until the daemon runs it.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          serverPromptId: 'prompt-1',
          serverState: 'queued',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not complete a prompt its deferred clear removed', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectPending = reject;
            }),
        );
        harness
          .result()
          .enqueuePrompt(
            'cleared with a callback',
            undefined,
            undefined,
            onComplete,
          );
        await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'cleared with a callback',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledOnce();
      // The daemon reports the removal it was asked for. The message never
      // ran, so its completion callback must not fire: a cancelled message
      // reporting completion is the opposite of what the caller asked.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_completed',
            promptId: 'prompt-1',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              state: 'removed',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(onComplete).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('completes a cleared fallback whose suppressed start was cancelled mid-confirmation', async () => {
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'running';
          }>;
        }) => void)
      | undefined;
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness
          .result()
          .enqueuePrompt('first message', undefined, undefined, onComplete);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        harness.result().enqueuePrompt('second message');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The start's raw echo is suppressed by the unrelated in-flight
      // submission, so it is parked; the cancelled turn then settles it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'first message',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              stopReason: 'cancelled',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      // The settle echoes the suppressed start; the cancelled turn of a
      // started prompt still counts as completed for the callback the body
      // settles when its confirming snapshot returns.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(onComplete).not.toHaveBeenCalled();
      await act(async () => {
        resolvePending?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'first message',
              queuedAt: Date.now(),
              state: 'running',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes the bound payload when the turn ends before the admission lands', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    // The admission response has not landed when the events below arrive.
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The start outruns the admission response: the row is unbound, the
      // placeholder matches nothing by content, and the raw-text branch is
      // suppressed by the in-flight row itself — so the start is parked.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // A refresh in the same window binds the row to the prompt id through
      // the fully hydrated content match.
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-1'),
      ).toBe(true);
      // The turn ends before the admission lands: the settle-time echo must
      // come from the bound row's payload, not the parked placeholder text.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_error',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not re-echo a parked start on a second terminal event', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('echo once');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // The row is gone, so the started event echoes the raw text and parks
      // the id as the already-started marker.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'echo once',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // A duplicate terminal delivery must not re-append the message.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_error',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('does not remove a cleared fallback whose start the stale snapshot predates', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveNext:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveNext = resolve;
              }),
          );
        harness.result().enqueuePrompt('stale clear');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The deferred clear is parked. The daemon then starts the prompt while
      // the follow-up snapshot is in flight: the client echoes the start, and
      // the snapshot the daemon answered before the start must not license a
      // DELETE that aborts the running turn.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'stale clear',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      await act(async () => {
        resolveNext?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'stale clear',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not re-materialize a cleared fallback whose parked start overrules the stale snapshot', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    let resolveNext:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementation(() => new Promise(() => {}));
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveNext = resolve;
              }),
          );
        harness.result().enqueuePrompt('stale clear');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // A different-text submission is in flight, so the started event's raw
      // echo is suppressed and the start only parks: the snapshot the daemon
      // answered before it must neither license a DELETE nor re-materialize
      // the message the user cancelled.
      await act(async () => {
        harness.result().enqueuePrompt('unrelated text');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'stale clear',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        // Later snapshots report the started prompt as running — the state
        // the daemon is actually in — so a phantom row materialized from
        // the stale snapshot would be retained, not cleaned up.
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'stale clear',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveNext?.({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'stale clear',
              queuedAt: Date.now(),
              state: 'queued',
            },
          ],
        });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      // The cancelled message must not reappear in the queue: only the
      // unrelated in-flight submission's own row survives.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'unrelated text',
          serverState: 'submitting',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a settled fallback whose bound row wins over a foreign in-flight submission', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      // The first admission lands only after its start and settle events.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      // The second admission never lands within the test.
      .mockImplementationOnce(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // A second image-only submission stays unbound with its admission in
      // flight: its blank row renders the same placeholder, so a text-match
      // guard cannot tell it apart from the first prompt's own — and it
      // predates the park below, so the settle cannot use the frontier to
      // rule it out.
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'c2Vjb25k', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      // The start outruns the admission: no stash exists yet, the unbound
      // row refuses the content-less event, and the raw-text branch is
      // suppressed by the row itself — so the start is parked, and the
      // follow-up refresh binds the row by content.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-1'),
      ).toBe(true);
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The first turn ends: the parked start must be echoed from the bound
      // row's payload, not skipped over the foreign in-flight row.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      // The late admission must not echo a second time.
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('settles the callback when a fallback whose confirmation failed later completes', async () => {
    const onComplete = vi.fn();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockRejectedValueOnce(new Error('pending snapshot unavailable'))
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: 'confirm later',
                queuedAt: Date.now(),
                state: 'queued' as const,
                originatorClientId: CLIENT_ID,
              },
            ],
          });
        harness
          .result()
          .enqueuePrompt('confirm later', undefined, undefined, onComplete);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The confirmation failed, so the row is still submitting; the next
      // snapshot binds it by content, and its completion must fire the
      // callback the body registered.
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared text fallback whose settle parks behind a younger same-text submission', async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                rejectPending = reject;
              }),
          )
          .mockResolvedValue({
            pendingPrompts: [
              {
                promptId: 'prompt-1',
                text: 'hello',
                queuedAt: Date.now(),
                state: 'running' as const,
              },
            ],
          });
        harness.result().enqueuePrompt('hello');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      // An unrelated unbound row is in flight, so the started event's raw
      // echo is suppressed and the start is parked.
      await act(async () => {
        harness.result().enqueuePrompt('unrelated');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        rejectPending?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'hello',
            },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // A same-text submission younger than the park cannot be the parked
      // prompt's own in-flight admission, so the settle must not defer to it.
      await act(async () => {
        harness.result().enqueuePrompt('hello');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_error',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 3; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        { promptId: 'prompt-1' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not claim an identical image submission for the displayed prompt it merely matches', async () => {
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The first prompt starts and is displayed with its image.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The user sends the identical image again; its admission is in flight
      // when a refresh's snapshot — taken before the second admission
      // registered — lists only the first prompt, whose content the second
      // row matches byte-for-byte.
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // A refresh resolving in this window lists only the displayed
      // prompt-1, whose content the second row matches byte-for-byte.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The second row must survive: it is a different message, and its body
      // binds it to the id the daemon returned for it.
      expect(
        harness
          .result()
          .queuedPrompts.filter((row) => row.serverPromptId !== 'prompt-1')
          .length,
      ).toBeGreaterThan(0);
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-2'),
      ).toBe(true);
      // And when the second prompt starts, the echo carries the image.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-2',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(2);
      expect(harness.store.appendLocalUserMessage).toHaveBeenLastCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-2' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not claim an identical annotated submission for the displayed prompt it merely matches', async () => {
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const fileText = '@docs/notes.txt';
    const text = `${fileText} explain this`;
    const annotation = {
      type: 'reference' as const,
      start: 0,
      end: fileText.length,
      text: fileText,
      reference: {
        id: 'file:docs/notes.txt',
        kind: 'file' as const,
        value: 'docs/notes.txt',
      },
    };
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text,
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness
          .result()
          .enqueuePrompt(text, undefined, undefined, undefined, [annotation]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The first prompt starts and is displayed with its reference chip.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: { sessionId: 'session-a', promptId: 'prompt-1', text },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The user sends the identical annotated message again; its admission
      // is in flight when a refresh's snapshot — taken before the second
      // admission registered — lists only the first prompt, whose rendered
      // text the second row matches exactly.
      await act(async () => {
        harness
          .result()
          .enqueuePrompt(text, undefined, undefined, undefined, [annotation]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The second row must survive unbound: it is a different message, and
      // its body binds it to the id the daemon returned for it.
      expect(
        harness
          .result()
          .queuedPrompts.filter((row) => row.serverPromptId !== 'prompt-1')
          .length,
      ).toBeGreaterThan(0);
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text,
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text,
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-2'),
      ).toBe(true);
      // And when the second prompt starts, the echo carries the reference
      // chip.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: { sessionId: 'session-a', promptId: 'prompt-2', text },
          },
        ]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(2);
      expect(harness.store.appendLocalUserMessage).toHaveBeenLastCalledWith(
        text,
        undefined,
        { promptId: 'prompt-2', inputAnnotations: [annotation] },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a settled resubmission whose body returned unbound behind an identical in-flight submission', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Two identical text-only resubmissions in flight at once.
      await act(async () => {
        harness.result().enqueuePrompt('same question');
        for (let i = 0; i < 4; i++) await Promise.resolve();
        harness.result().enqueuePrompt('same question');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The first body's confirmation snapshot fails, so it returns with its
      // row still unbound — no echo is owed from it anymore.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The daemon starts the first prompt while both rows are unbound: the
      // rendered text is ambiguous, so the started handler parks the echo.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'same question',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The settle is the last chance: the matching rows are not admissions
      // that will still echo — the first prompt's own body already returned.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'same question',
        undefined,
        { promptId: 'prompt-1' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it.each(['refused', 'failed'] as const)(
    'echoes the real payload when a cleared first-time image submission still runs and its removal is %s',
    async (mode) => {
      let resolveFirst: ((value: { promptId: string }) => void) | undefined;
      sdkMock.actions.submitPrompt
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementation(() => new Promise(() => {}));
      if (mode === 'refused') {
        sdkMock.actions.removePendingPrompt.mockResolvedValue({
          removed: false,
        });
      } else {
        // A rejected DELETE is the same "the prompt may still run" case for
        // the echo: the stash must survive it too.
        sdkMock.actions.removePendingPrompt.mockRejectedValue(
          new Error('delete lost'),
        );
      }
      const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
      const harness = createHarness();
      try {
        await harness.render({ streamingState: 'idle' });
        // An image-only submission whose admission is still in flight.
        await act(async () => {
          harness.result().enqueuePrompt('', [image]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
        // The user clears the queue before the admission lands: the row drops
        // locally, and the body can only hand the prompt to the daemon's
        // removal path once the id arrives.
        act(() => {
          harness.result().clearQueuedPrompts();
        });
        expect(harness.result().queuedPrompts).toEqual([]);
        // A turn is active by the time the admission resolves, and the
        // DELETE comes back not-removed — the daemon answers that only for
        // a prompt it no longer holds (absent, or already removed elsewhere
        // while the doomed prompt runs on), which the client cannot tell
        // from "still running", so the stash must survive it either way.
        await harness.render({
          streamingState: 'responding',
          sessionHasActivePrompt: true,
        });
        await act(async () => {
          resolveFirst?.({ promptId: 'prompt-1' });
          for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
          'prompt-1',
          { sessionId: 'session-a' },
        );
        // An unrelated submission is in flight, so the started event's raw
        // echo is suppressed and the start parks — the payload must come from
        // the body's stash, not from the event's '[image]' rendering.
        await act(async () => {
          sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
            (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
              opts?.onAdmissionStarted?.();
              return Promise.resolve({
                accepted: false,
                reason: 'session_idle',
              });
            },
          );
          harness.result().enqueuePrompt('unrelated');
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
        await act(async () => {
          sdkMock.publishPendingEvents([
            {
              type: 'pending_prompt_started',
              promptId: 'prompt-1',
              originatorClientId: CLIENT_ID,
              data: {
                sessionId: 'session-a',
                promptId: 'prompt-1',
                text: '[image]',
              },
            },
          ]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
          '',
          [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
          { promptId: 'prompt-1' },
          undefined,
        );
        // The settle must not echo the placeholder a second time.
        await act(async () => {
          sdkMock.publishPendingEvents([
            {
              type: 'turn_complete',
              promptId: 'prompt-1',
              data: { sessionId: 'session-a', promptId: 'prompt-1' },
            },
          ]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      } finally {
        await harness.dispose();
      }
    },
  );

  it('restores a claimed draft when the submission fails before admission starts', async () => {
    let rejectSecond: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecond = reject;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'same text',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness.result().enqueuePrompt('same text');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The identical resubmission is in flight when a sync whose snapshot
      // predates its admission claims the row for the displayed prompt.
      await act(async () => {
        harness.result().enqueuePrompt('same text');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      // Nothing reached the daemon, so the failure path still owns the
      // claimed row: the draft is restored and the failure reported.
      await act(async () => {
        rejectSecond?.(new Error('network lost'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.editor.setText).toHaveBeenCalledWith('same text');
      expect(harness.reportError).toHaveBeenCalledTimes(1);
      expect(harness.reportError).toHaveBeenCalledWith(
        expect.any(Error),
        'queue.queueFailed',
      );
    } finally {
      await harness.dispose();
    }
  });

  it.each(['refused', 'failed'] as const)(
    'completes a cleared first-time submission whose removal is %s and the prompt runs',
    async (mode) => {
      let resolveFirst: ((value: { promptId: string }) => void) | undefined;
      sdkMock.actions.submitPrompt
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementation(() => new Promise(() => {}));
      if (mode === 'refused') {
        sdkMock.actions.removePendingPrompt.mockResolvedValue({
          removed: false,
        });
      } else {
        sdkMock.actions.removePendingPrompt.mockRejectedValue(
          new Error('delete lost'),
        );
      }
      const onComplete = vi.fn();
      const harness = createHarness();
      try {
        await harness.render({ streamingState: 'idle' });
        await act(async () => {
          harness
            .result()
            .enqueuePrompt('first-time text', undefined, undefined, onComplete);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
        // The user clears the row mid-admission; the body can only hand the
        // prompt to the daemon's removal path once the id lands.
        act(() => {
          harness.result().clearQueuedPrompts();
        });
        await harness.render({
          streamingState: 'responding',
          sessionHasActivePrompt: true,
        });
        await act(async () => {
          resolveFirst?.({ promptId: 'prompt-1' });
          for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
          'prompt-1',
          { sessionId: 'session-a' },
        );
        // The removal fails, so the prompt really runs: the callback the
        // body captured must fire when the turn settles.
        await act(async () => {
          sdkMock.publishPendingEvents([
            {
              type: 'pending_prompt_started',
              promptId: 'prompt-1',
              originatorClientId: CLIENT_ID,
              data: {
                sessionId: 'session-a',
                promptId: 'prompt-1',
                text: 'first-time text',
              },
            },
          ]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
        await act(async () => {
          sdkMock.publishPendingEvents([
            {
              type: 'turn_complete',
              promptId: 'prompt-1',
              data: { sessionId: 'session-a', promptId: 'prompt-1' },
            },
          ]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(onComplete).toHaveBeenCalledTimes(1);
      } finally {
        await harness.dispose();
      }
    },
  );

  it('does not re-register a settled callback for a duplicate terminal event', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolvePending:
      | ((value: {
          pendingPrompts: Array<{
            promptId: string;
            text: string;
            queuedAt: number;
            state: 'queued';
          }>;
        }) => void)
      | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    const onComplete = vi.fn();
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePending = resolve;
            }),
        );
        harness.result().enqueuePrompt('', [image], undefined, onComplete);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The admission lands but the confirmation snapshot is still in
      // flight; the started event echoes from the stash and registers the
      // callback.
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The settle fires the registered callback; the fired branch is
      // deliberately not remembered as completed.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
      // The body's late confirmation finds the prompt settled and drops the
      // row; it must not re-register the already-fired callback.
      await act(async () => {
        resolvePending?.({ pendingPrompts: [] });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // A duplicate terminal event for the same prompt must not fire the
      // callback a second time.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_error',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });

  it('cleans up a payload-bearing resubmission whose confirmation never landed once it settles', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        harness.result().enqueuePrompt('describe this', [image]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The admission lands but the confirmation snapshot fails: the row
      // stays submitting (no snapshot, no verdict), still unbound.
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ serverState: 'submitting' }),
      ]);
      // The started event echoes the stashed payload — a text+image row has
      // no binding route, so nothing later will ever bind this row.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'describe this',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'describe this',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      // At settle the message is echoed and the prompt can never bind, so
      // the still-unbound row must not survive as a phantom.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a resubmission whose ambiguous start settled inside its confirmation', async () => {
    let rejectConfirmation: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectConfirmation = reject;
            }),
        );
        harness.result().enqueuePrompt('same text');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // An identical second resubmission is in flight, so the started
      // event's raw echo is suppressed and the start parks on ambiguity.
      await act(async () => {
        harness.result().enqueuePrompt('same text');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'same text',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The settle defers to the first body still in flight: its own row is
      // an unbound submission that renders the same text.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The body is the last echo path: its confirmation fails after the
      // settle, so it must consume the surviving park instead of dropping
      // the row in silence.
      await act(async () => {
        rejectConfirmation?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'same text',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
      // The settled prompt's row is gone; the second submission's row — a
      // different message whose body is still in flight — survives.
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'same text',
          serverState: 'submitting',
        }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo an empty bubble for a settled prompt that rendered as nothing', async () => {
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'responding' });
      // A files-only prompt from a client that declares no id renders as an
      // empty text: the started event cannot attribute it to any local row
      // or payload, so it parks with nothing to echo.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-foreign',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-foreign',
              text: '',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // At settle there is still no payload source: silence beats an empty
      // user bubble for a message this client never sent.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-foreign',
            data: { sessionId: 'session-a', promptId: 'prompt-foreign' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('does not delete a running prompt whose echoed bound row already dropped', async () => {
    let resolveAdmission: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().enqueuePrompt('hello');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The daemon queues the prompt before the admission response lands,
      // and a refresh binds the still-unbound row by its exact text.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'hello',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((row) => row.serverPromptId === 'prompt-1'),
      ).toBe(true);
      // The prompt starts: the bound row echoes and is dropped, leaving the
      // body with no row — but the prompt is running, so the late admission
      // must not read the gap as a user cancellation.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'hello',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.result().queuedPrompts).toEqual([]);
      await act(async () => {
        resolveAdmission?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes nothing when a cleared first-time submission is removed after it started', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    let resolveDelete: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The user clears the row mid-admission; the body can only hand the
      // prompt to the daemon's removal path once the id lands.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
      // The daemon starts the prompt while the DELETE is in flight. The
      // removal is still undecided, so the start must park like every
      // sibling removal path — not echo a message the user cancelled.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The removal succeeds — the daemon aborted the turn it had just
      // started — and the cancelled message stays out of the transcript.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_completed',
            promptId: 'prompt-1',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              state: 'removed' as const,
            },
          },
        ]);
        resolveDelete?.({ removed: true });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.result().queuedPrompts).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it('does not bind an identical image re-send to the displayed twin its stash echoed', async () => {
    let rejectAConfirmation: ((error: Error) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-a' })
      .mockImplementation(() => new Promise(() => {}));
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Submission A: cleared while its confirmation is in flight, so the
      // row drops locally with no DELETE and the body records the deferred
      // clear — but its payload stays stashed under the daemon's id.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectAConfirmation = reject;
            }),
        );
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        rejectAConfirmation?.(new Error('pending snapshot unavailable'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // Submission B: an identical image re-send whose admission is still in
      // flight.
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // A's start echoes from the stash — B's unbound row cannot suppress an
      // id-keyed payload — which marks prompt-a displayed.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-a',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-a',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // A later snapshot lists only prompt-a, running, with the identical
      // bytes: B's row matches it by content, but the twin is displayed and
      // B's own body still holds the authoritative id — so B stays unbound
      // for its body to bind, and its Remove can never aim at A's turn.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-a',
              text: '[image]',
              content: [
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      const rows = harness.result().queuedPrompts;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.serverPromptId).toBeUndefined();
      expect(rows[0]).toEqual(
        expect.objectContaining({ serverState: 'submitting' }),
      );
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('cancels a returned-unbound submission the user clears after its confirmation failed', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt.mockResolvedValueOnce({
      promptId: 'prompt-1',
    });
    sdkMock.actions.removePendingPrompt.mockClear();
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // The admission lands but the confirmation snapshot fails: the body
      // returns with the row still unbound, holding the only record of the
      // daemon id the row was admitted under.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        harness.result().enqueuePrompt('doomed message');
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({
          text: 'doomed message',
          serverState: 'submitting',
        }),
      ]);
      // The daemon still lists the prompt queued, and nothing but the clear
      // itself asks for that snapshot: no event arrives, no other submission
      // is in flight. The row has no serverPromptId, so the clear path alone
      // would drop it locally and leave the daemon holding a message nobody
      // will ever cancel.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'doomed message',
            queuedAt: Date.now(),
            state: 'queued' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.removePendingPrompt).toHaveBeenCalledWith(
        'prompt-1',
        { sessionId: 'session-a' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared returned-unbound fallback whose settle a files submission shadows', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-x' })
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // A text-only fallback whose confirmation fails: the body returns
      // with the row unbound and records the id.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockRejectedValueOnce(
          new Error('pending snapshot unavailable'),
        );
        harness.result().enqueuePrompt('explain this');
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The user clears the queue; the clear hands the id to the deferred
      // clear but must not forget that this body already returned.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      // An unrelated files-bearing submission with the same rendered text
      // stalls in flight.
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('explain this', undefined, [
            { name: 'notes.md', media_type: 'text/markdown' },
          ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // prompt-x starts: the files row refuses the content-less event and
      // suppresses the raw echo, so the start parks.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-x',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-x',
              text: 'explain this',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // At settle the shadowing row is not an in-flight admission — prompt-x's
      // own body returned long ago — so the last-chance echo must fire.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-x',
            data: { sessionId: 'session-a', promptId: 'prompt-x' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'explain this',
        undefined,
        { promptId: 'prompt-x' },
      );
    } finally {
      await harness.dispose();
    }
  });

  it('keeps a freshly bound row when a pre-admission flight resolves after it', async () => {
    let resolveAdmission: ((value: { promptId: string }) => void) | undefined;
    let resolveStaleFlight:
      | ((value: { pendingPrompts: [] }) => void)
      | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().enqueuePrompt('bound late');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // A refresh dispatched BEFORE the admission resolves parks on a
      // deferred GET: its snapshot cannot possibly list the prompt.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStaleFlight = resolve;
            }),
        );
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The session turns busy, the admission lands, and the body binds the
      // row by the daemon's id; its tail refresh waits the stale flight out.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        resolveAdmission?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      const boundRow = harness
        .result()
        .queuedPrompts.find((row) => row.serverPromptId === 'prompt-1');
      expect(boundRow).toBeDefined();
      // The stale flight resolves with a snapshot that predates the
      // admission: it must not drop the row the body just bound — the
      // binding postdates the flight's dispatch, so the snapshot cannot
      // say anything about it. The waiter's fresh snapshot does list the
      // prompt, as the daemon would once the admission landed.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'bound late',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveStaleFlight?.({ pendingPrompts: [] });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The ORIGINAL row must survive — a drop-and-rematerialize would
      // rebuild it summary-only under a new local id, losing the payload
      // the body bound it with.
      expect(
        harness
          .result()
          .queuedPrompts.some(
            (row) =>
              row.id === boundRow!.id && row.serverPromptId === 'prompt-1',
          ),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a claimed first-time resend from the body stash when its twin is displayed', async () => {
    let resolveSecond: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      // The first 'continue' is admitted at idle: the body's tail echoes it
      // and drops the row, so prompt-1 is displayed with no local row left.
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      expect(harness.result().queuedPrompts).toEqual([]);
      // The user sends 'continue' again; while its admission is in flight a
      // sync whose snapshot lists the displayed twin claims and splices the
      // row.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      // The second admission lands on a row the sync already consumed: the
      // claim arm holds the prompt's only payload copy, and the refresh
      // materializes prompt-2 as a summary-only row the started event
      // cannot echo. A turn is active by now, so the body cannot take the
      // idle tail echo either.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-2',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveSecond?.({ promptId: 'prompt-2' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-2',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(2);
      expect(harness.store.appendLocalUserMessage).toHaveBeenLastCalledWith(
        'continue',
        undefined,
        { promptId: 'prompt-2' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a claimed idle-fallback resend whose row a stale sync consumed', async () => {
    // The daemon has already settled but the activity mirror still shows a
    // prompt, so the insert is refused with session_idle and the fallback
    // resubmits. While that admission is in flight a sync whose snapshot
    // lists the displayed twin claims and splices the row, so the body's
    // claim arm holds the message's only payload copy.
    const rejectInsert = deferred<void>();
    sdkMock.actions.enqueueMidTurnMessage.mockImplementationOnce(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return new Promise((resolve) => {
          rejectInsert.resolve();
          resolve({ accepted: false, reason: 'session_idle' });
        });
      },
    );
    let resolveResubmit: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResubmit = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-twin',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-twin',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(1);
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await rejectInsert.promise;
      await act(async () => {
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      const resubmitted = harness
        .result()
        .queuedPrompts.find(
          (p) => p.text === 'continue' && p.serverState === 'submitting',
        );
      expect(resubmitted?.resubmittedAfterIdleRejection).toBe(true);
      // A sync whose snapshot lists only the displayed twin claims the
      // identical unbound row and splices it.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-twin',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(
        harness
          .result()
          .queuedPrompts.some((p) => p.resubmittedAfterIdleRejection === true),
      ).toBe(false);
      // The body's confirming refresh lists the admitted prompt too, and the
      // row it materializes cannot echo: the started event's only source is
      // the payload this body still holds.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-twin',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'running' as const,
              originatorClientId: CLIENT_ID,
            },
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        resolveResubmit?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledTimes(2);
      expect(harness.store.appendLocalUserMessage).toHaveBeenLastCalledWith(
        'continue',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo an image placeholder for a cleared submission whose start parked', async () => {
    let rejectAdmission: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise<{ promptId: string }>((_resolve, reject) => {
          rejectAdmission = reject;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The daemon starts the prompt while its admission is still in flight.
      // The event carries only the placeholder rendering, an attachment row
      // cannot match a content-less event, and this client's own unbound
      // submission suppresses the raw-text echo — so the handler parks it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The user clears the queue: the row is dropped locally and the
      // admission is aborted, so the body returns without stashing a payload
      // or consuming the park.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      expect(harness.result().queuedPrompts).toEqual([]);
      await act(async () => {
        rejectAdmission?.(new Error('aborted'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The turn ends and the settle-time consume finds the parked
      // placeholder with no payload source left. A literal '[image]' bubble
      // is not the user's message, and the image is gone with the row: the
      // consume stays silent, as it does for an empty rendering.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a cleared fallback once when its settle followed the raw start', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-1' })
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const confirmation = deferred<{ pendingPrompts: [] }>();
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockReturnValueOnce(
          confirmation.promise,
        );
        harness.result().enqueuePrompt('cleared text');
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The user clears the still-unbound row while the confirming snapshot
      // is in flight, so the started event finds no in-flight submission to
      // defer to and echoes the rendered text itself.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'cleared text',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The settle skips its own echo because the message is already
      // displayed. Clearing that marker used to leave the park behind as a
      // bare "already started" record; it now drops the park with it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The body is still in flight. A surviving park is what it reads as an
      // echo it owes, so the settle dropping it is what keeps this at one.
      await act(async () => {
        confirmation.resolve({ pendingPrompts: [] });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The surviving echo is the started event's own raw text: the row was
      // cleared, so no payload source outlived it.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'cleared text',
        undefined,
        { promptId: 'prompt-1' },
      );
      expect(harness.result().queuedPrompts).toEqual([]);
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });

  it.each(['refused', 'failed'] as const)(
    'echoes a queued prompt whose delete is %s after it started',
    async (mode) => {
      let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
      let rejectRemoval: ((error: Error) => void) | undefined;
      sdkMock.actions.removePendingPrompt.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveRemoval = resolve;
            rejectRemoval = reject;
          }),
      );
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'queued text',
            queuedAt: Date.now(),
            state: 'queued' as const,
          },
        ],
      });
      const harness = createHarness();
      try {
        await harness.render({
          streamingState: 'responding',
          sessionHasActivePrompt: true,
        });
        const row = harness.result().queuedPrompts[0]!;
        expect(row.serverPromptId).toBe('prompt-1');
        expect(row.serverState).toBe('queued');
        // The user deletes the bound row and a peer removes the same id
        // first, so the doomed prompt runs on and its start parks behind this
        // flight instead of echoing.
        act(() => {
          harness.result().removeQueuedPrompt(row.id);
        });
        await act(async () => {
          sdkMock.publishPendingEvents([
            {
              type: 'pending_prompt_started',
              promptId: 'prompt-1',
              originatorClientId: CLIENT_ID,
              data: {
                sessionId: 'session-a',
                promptId: 'prompt-1',
                text: 'queued text',
              },
            },
          ]);
          for (let i = 0; i < 6; i++) await Promise.resolve();
        });
        expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
        // The DELETE comes back not-removed — the id is absent, or a peer
        // already removed it while the prompt ran on — so the parked start is
        // owed its echo instead of being retained with no consumer.
        await act(async () => {
          if (mode === 'refused') resolveRemoval?.({ removed: false });
          else rejectRemoval?.(new Error('delete lost'));
          for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
        expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
          'queued text',
          undefined,
          { promptId: 'prompt-1' },
        );
        expect(harness.reportError).toHaveBeenCalledOnce();
      } finally {
        await harness.dispose();
      }
    },
  );

  it('does not echo the daemon placeholder when a failed delete parked it', async () => {
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: '[image]',
          // What a real snapshot carries when the media could not be
          // hydrated: a loss placeholder instead of image blocks, so the row
          // rebuilds summary-only with no images to echo.
          content: [
            { type: 'text', text: '[Attachment is no longer available]' },
          ],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const row = harness.result().queuedPrompts[0]!;
      expect(row.serverPromptId).toBe('prompt-1');
      act(() => {
        harness.result().removeQueuedPrompt(row.id);
      });
      // The replay consults the stash, a payload-complete bound row, and the
      // parked rendering. This row rebuilt summary-only because its media
      // hydrated to a loss placeholder, so the first two are out — the one
      // independently refused by `appendLocalQueuedPrompt` — and the third
      // is the daemon's placeholder for an image this client no longer
      // holds.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The failure arm ran, and a literal '[image]' bubble is not the
      // user's message.
      expect(harness.reportError).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('echoes a cleared queued prompt whose delete lost after it started', async () => {
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'queued text',
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      expect(harness.result().queuedPrompts[0]?.serverPromptId).toBe(
        'prompt-1',
      );
      // The user clears the queue and a peer removes the same id first, so
      // the doomed prompt runs on and its start parks behind this flight.
      act(() => {
        harness.result().clearQueuedPrompts();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'queued text',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The clear did not take — the id is absent, or a peer already
      // removed it while the prompt ran on — so the parked start is owed its
      // echo instead of being retained with no consumer.
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'queued text',
        undefined,
        { promptId: 'prompt-1' },
      );
      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });
  it('does not echo a co-client prompt that started inside our failed delete', async () => {
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'someone else',
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const row = harness.result().queuedPrompts[0]!;
      expect(row.serverPromptId).toBe('prompt-1');
      act(() => {
        harness.result().removeQueuedPrompt(row.id);
      });
      // The prompt this client is deleting was another client's: the
      // originator check runs before the removal guard parks anything, so
      // this start is refused a park and no replay can echo it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The failure arm ran, and the message belongs to the client that sent
      // it: this transcript gets it from the daemon's own stream, not from a
      // local echo that would duplicate it.
      expect(harness.reportError).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('does not splice an unreleased held row the sync matched to a displayed prompt', async () => {
    const firstLink = deferred<{ promptId: string }>();
    sdkMock.actions.submitPrompt
      .mockResolvedValueOnce({ promptId: 'prompt-0' })
      .mockImplementationOnce(() => firstLink.promise)
      .mockResolvedValue({ promptId: 'prompt-2' });
    const harness = createHarness();
    try {
      // An earlier send of the same text ran and echoed, so the daemon's id
      // is in the displayed set while that prompt is still listed.
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().enqueuePrompt('second');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('first');
        harness.result().enqueuePrompt('second');
      });
      expect(harness.result().queuedPrompts).toHaveLength(2);
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The hold lifts: the drain stamps both rows `submitting`, marks both
      // unreleased, POSTs the first link, and dispatches its own reconcile
      // refresh — which is the sync that sees the second row stamped but not
      // yet handed to a body.
      sdkMock.actions.getPendingPrompts.mockResolvedValue({
        pendingPrompts: [
          {
            promptId: 'prompt-0',
            text: 'second',
            queuedAt: Date.now(),
            state: 'running' as const,
            originatorClientId: CLIENT_ID,
          },
        ],
      });
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: false,
      });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(
        vi.mocked(sdkMock.actions.submitPrompt).mock.calls.map((c) => c[0]),
      ).toEqual(['second', 'first']);
      expect(harness.result().queuedPrompts).toEqual([
        expect.objectContaining({ text: 'first', serverState: 'submitting' }),
        expect.objectContaining({ text: 'second', serverState: 'submitting' }),
      ]);
      // The second link must still find its row: a splice here reads as a
      // user cancellation, so the message would never be POSTed, never
      // restored to the editor, and never reported.
      await act(async () => {
        firstLink.resolve({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(
        vi.mocked(sdkMock.actions.submitPrompt).mock.calls.map((c) => c[0]),
      ).toEqual(['second', 'first', 'second']);
      expect(harness.reportError).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('echoes a resubmission whose start found only a summary-only row', async () => {
    let resolveFirst: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => new Promise(() => {}));
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      await act(async () => {
        harness.result().enqueuePrompt('continue');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // A foreign start brings a snapshot that lists both daemon prompts.
      // Neither local row can be told apart by text, so the sync binds
      // neither and materializes a summary-only row for each.
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
            {
              promptId: 'prompt-2',
              text: 'continue',
              queuedAt: Date.now(),
              state: 'queued' as const,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.result().queuedPrompts).toHaveLength(4);
      // The first prompt starts before its body has resolved: the handler's
      // only source is the summary-only row the sync materialized, which
      // cannot echo, so the start parks rather than leaving nothing behind.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The body reads that park as its own admission and echoes the payload
      // it still holds — the one source that can reproduce the message.
      await act(async () => {
        resolveFirst?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The turn ending must not add a second copy of it.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'continue',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });
  it('echoes an attachment payload whose admission failed after its start parked', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let rejectAdmission: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      (
        _text: string,
        opts?: {
          onAdmissionStarted?: () => void;
        },
      ): Promise<{ promptId: string }> =>
        new Promise((_resolve, reject) => {
          opts?.onAdmissionStarted?.();
          rejectAdmission = reject;
        }),
    );
    const image = { data: 'aGVsbG8=', media_type: 'image/png' } as const;
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('', [image]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // The daemon renders this message as its placeholder, so the row it
      // could belong to is uncountable and the echo degrades to silence.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      // The admission then fails after the daemon had already started it.
      // That body holds the only copy of the payload, and the settle's last
      // chance refuses the placeholder it would be left with.
      await act(async () => {
        rejectAdmission?.(new Error('transport gone'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The message is in the transcript, so the transport failure is not a
      // queue failure and must not be reported as one beside it.
      expect(harness.reportError).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('leaves a suppressed start silent when two in-flight rows render alike', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let rejectFailing: ((error: Error) => void) | undefined;
    const surviving = deferred<{ promptId: string }>();
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        (_text: string, opts?: { onAdmissionStarted?: () => void }) => {
          opts?.onAdmissionStarted?.();
          return new Promise((_resolve, reject) => {
            rejectFailing = reject;
          });
        },
      )
      .mockImplementationOnce(
        (
          _text: string,
          opts?: { onAdmissionStarted?: () => void },
        ): Promise<{ promptId: string }> => {
          opts?.onAdmissionStarted?.();
          return surviving.promise;
        },
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      // Two attachment messages with the same caption: the daemon renders
      // both as that caption, so neither row can be told apart by a started
      // event, and neither POST has reported which id belongs to it.
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('continue', [
            { data: 'QUFB', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('continue', [
            { data: 'QkJC', media_type: 'image/png' },
          ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        rejectFailing?.(new Error('transport gone'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // Echoing either row's image for prompt-1 would be a guess about which
      // message the daemon ran: silence beats a wrong-payload echo. The
      // surviving row keeps its own payload for its own id.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        surviving.resolve({ promptId: 'prompt-2' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-2',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-2',
              text: 'continue',
            },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'continue',
        [{ data: 'QkJC', mimeType: 'image/png' }],
        { promptId: 'prompt-2' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });
  it('echoes a deleted prompt from the payload-complete row its removal kept', async () => {
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'look at this',
          content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const row = harness.result().queuedPrompts[0]!;
      expect(row.serverPromptId).toBe('prompt-1');
      expect(row.payloadCompleteness).not.toBe('summary-only');
      act(() => {
        harness.result().removeQueuedPrompt(row.id);
      });
      // A peer removed the id first, so the prompt the daemon went on to run
      // parks its start behind this flight instead of echoing.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'look at this',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The row the failure arm keeps is the payload's only copy: the parked
      // rendering is a caption with no image, and there is no stash for a row
      // this client never submitted.
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'look at this',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });

  it('does not echo a payload whose admission never reached the daemon', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let rejectAdmission: ((error: Error) => void) | undefined;
    // Deliberately never calls `onAdmissionStarted`: an attachment upload
    // that fails rejects before the POST, so nothing reached the daemon.
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdmission = reject;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('', [{ data: 'aGVsbG8=', media_type: 'image/png' }]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // A start with no originator id fails open as possibly ours, renders
      // like this row, and names it as the only candidate.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-9',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-9',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        rejectAdmission?.(new Error('upload failed'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // That park belongs to a prompt this client never sent: echoing our
      // payload under its id would both invent a message and suppress the
      // real one. The failure is reported, so this arm ran to its end rather
      // than returning early on a row that was already gone.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });

  it('echoes a drained attachment row its unreleased twin rendered alike', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        (_text: string, opts?: { onAdmissionStarted?: () => void }) => {
          opts?.onAdmissionStarted?.();
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        },
      )
      .mockResolvedValue({ promptId: 'prompt-2' });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: true,
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look', [{ data: 'QUFB', media_type: 'image/png' }]);
        harness
          .result()
          .enqueuePrompt('look', [{ data: 'QkJC', media_type: 'image/png' }]);
      });
      expect(harness.result().queuedPrompts).toHaveLength(2);
      expect(sdkMock.actions.submitPrompt).not.toHaveBeenCalled();
      // The hold lifts: the drain stamps both rows `submitting`, marks both
      // unreleased, and POSTs the first link only — the second waits for it.
      await harness.render({
        streamingState: 'idle',
        holdQueuedPromptsLocally: false,
      });
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledOnce();
      // The released row's start renders like both, but only a row that was
      // actually POSTed can own it: the unreleased twin must not turn a
      // unique candidate into an ambiguity.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'look',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        rejectFirst?.(new Error('transport gone'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // Each message keeps its own image: the released row's payload goes to
      // the id its own start parked, and the unreleased twin is POSTed next
      // and echoed under the id the daemon gives it.
      expect(
        harness.store.appendLocalUserMessage.mock.calls.map((call) => [
          call[2],
          call[1],
        ]),
      ).toEqual([
        [{ promptId: 'prompt-1' }, [{ data: 'QUFB', mimeType: 'image/png' }]],
        [{ promptId: 'prompt-2' }, [{ data: 'QkJC', mimeType: 'image/png' }]],
      ]);
    } finally {
      await harness.dispose();
    }
  });
  it('does not hand a text row park to the attachment body that failed beside it', async () => {
    sdkMock.actions.enqueueMidTurnMessage.mockImplementation(
      (_message: string, opts?: { onAdmissionStarted?: () => void }) => {
        opts?.onAdmissionStarted?.();
        return Promise.resolve({ accepted: false, reason: 'session_idle' });
      },
    );
    let rejectAttachment: ((error: Error) => void) | undefined;
    sdkMock.actions.submitPrompt
      .mockImplementationOnce(
        (_text: string, opts?: { onAdmissionStarted?: () => void }) => {
          opts?.onAdmissionStarted?.();
          return new Promise(() => {});
        },
      )
      .mockImplementationOnce(
        (_text: string, opts?: { onAdmissionStarted?: () => void }) => {
          opts?.onAdmissionStarted?.();
          return new Promise((_resolve, reject) => {
            rejectAttachment = reject;
          });
        },
      );
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        harness.result().enqueuePrompt('look');
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        harness
          .result()
          .enqueuePrompt('look', [{ data: 'QUFB', media_type: 'image/png' }]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(2);
      // The rendering matches both in-flight rows: the text row through the
      // matcher, the attachment row through the caption. Neither can be
      // ruled out, so the event parks without naming a candidate.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'look',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      await act(async () => {
        rejectAttachment?.(new Error('transport gone'));
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      // The failing body must not claim that park: prompt-1 may be the text
      // row's message, and echoing the attachment row's image under it would
      // put a picture in the transcript that the daemon never received. The
      // settle defers to the text row's body, still in flight, so nothing
      // echoes here at all.
      expect(harness.store.appendLocalUserMessage).not.toHaveBeenCalled();
      expect(harness.reportError).toHaveBeenCalledOnce();
    } finally {
      await harness.dispose();
    }
  });
  it('does not re-echo a bound row whose settle beat its own admission', async () => {
    let resolveAdmission: ((value: { promptId: string }) => void) | undefined;
    sdkMock.actions.submitPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    const harness = createHarness();
    try {
      await harness.render({ streamingState: 'idle' });
      await act(async () => {
        harness.result().enqueuePrompt('hello');
        for (let i = 0; i < 4; i++) await Promise.resolve();
      });
      expect(sdkMock.actions.submitPrompt).toHaveBeenCalledTimes(1);
      // A refresh binds the still-unbound row by its exact text before the
      // admission response lands.
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      await act(async () => {
        sdkMock.actions.getPendingPrompts.mockResolvedValue({
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'hello',
              queuedAt: Date.now(),
              state: 'queued' as const,
              originatorClientId: CLIENT_ID,
            },
          ],
        });
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-other',
            originatorClientId: 'client-other',
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-other',
              text: 'someone else',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      // The prompt starts and the bound row echoes it. That route records the
      // echo in the displayed marker alone — no park, because the row is
      // bound, and no `appendedBeforeResponse` entry, because the marker is
      // only written for an unbound row.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: 'hello',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The turn ends before the admission response lands, and the settle
      // clears the displayed marker that was the echo's only record.
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { sessionId: 'session-a', promptId: 'prompt-1' },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      // The body reads the completion as a licence to echo, and the dedupe
      // that would have refused it is gone.
      await act(async () => {
        resolveAdmission?.({ promptId: 'prompt-1' });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        { promptId: 'prompt-1' },
        undefined,
      );
      expect(sdkMock.actions.removePendingPrompt).not.toHaveBeenCalled();
    } finally {
      await harness.dispose();
    }
  });
  it('echoes a hydrated image row without the daemon placeholder as a caption', async () => {
    let resolveRemoval: ((value: { removed: boolean }) => void) | undefined;
    sdkMock.actions.removePendingPrompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    sdkMock.actions.getPendingPrompts.mockResolvedValue({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: '[image]',
          content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
          queuedAt: Date.now(),
          state: 'queued' as const,
        },
      ],
    });
    const harness = createHarness();
    try {
      await harness.render({
        streamingState: 'responding',
        sessionHasActivePrompt: true,
      });
      const row = harness.result().queuedPrompts[0]!;
      expect(row.serverPromptId).toBe('prompt-1');
      // The media hydrated, so the row is payload-complete and the replay can
      // source it — and its text is the daemon's rendering of an image-only
      // message, not a caption the user typed.
      expect(row.payloadCompleteness).not.toBe('summary-only');
      expect(row.text).toBe('[image]');
      act(() => {
        harness.result().removeQueuedPrompt(row.id);
      });
      await act(async () => {
        sdkMock.publishPendingEvents([
          {
            type: 'pending_prompt_started',
            promptId: 'prompt-1',
            originatorClientId: CLIENT_ID,
            data: {
              sessionId: 'session-a',
              promptId: 'prompt-1',
              text: '[image]',
            },
          },
        ]);
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await act(async () => {
        resolveRemoval?.({ removed: false });
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledOnce();
      expect(harness.store.appendLocalUserMessage).toHaveBeenCalledWith(
        '',
        [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        { promptId: 'prompt-1' },
        undefined,
      );
    } finally {
      await harness.dispose();
    }
  });
});
