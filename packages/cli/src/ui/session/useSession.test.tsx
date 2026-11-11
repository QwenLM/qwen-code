/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  type Config,
  type PastedContent,
  type QueuedCommand,
} from '@qwen-code/core';
import type {
  SessionHandle,
  SessionState,
  SessionSettings,
  SessionUpdate,
} from '../../session/session.js';
import { createSessionMessageChannel } from '../../session/sessionMessageChannel.js';
import { createSessionUiBinding } from './prepareSessionUi.js';
import { useSession } from './useSession.js';
import { createSessionConfig } from './sessionConfig.js';
import { usePermissionModeIndicator } from '../hooks/usePermissionModeIndicator.js';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { StreamingState } from '../types.js';
import { createPermissionQueueStore } from '../permissions/permissionQueueStore.js';
import { PermissionQueueProvider } from '../permissions/PermissionQueueContext.js';

function fixture(kind?: 'local') {
  const channel = createSessionMessageChannel({
    pendingAssistantText: '',
    activityStatus: 'idle',
  });
  const state: SessionState = {
    model: 'local-test',
    permissionMode: 'default',
    title: null,
    models: [],
    modeChoices: [],
    approvals: [],
    initialMessages: { pendingAssistantText: '', activityStatus: 'idle' },
    access: { status: 'connected', sessionId: 'local', error: null },
    pendingHistory: null,
    historyAvailable: false,
  };
  const changes = new Set<(change: SessionUpdate) => void>();
  const release = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const restore = vi.fn(async (_input: unknown) => {});
  const submitMessage = vi.fn<SessionHandle['submitMessage']>(
    async (message) => {
      channel.applyEvent({ type: 'input_prepared', message });
      channel.applyEvent({ type: 'send_started', messageId: message.id });
      channel.applyEvent({ type: 'send_finished', messageId: message.id });
    },
  );
  const session = {
    observe: channel.observe,
    getState: () => state,
    start,
    restore,
    release,
    submitMessage,
    observeUpdates: (listener: (change: SessionUpdate) => void) => {
      changes.add(listener);
      listener({ type: 'snapshot', state, reason: 'observe' });
      return () => {
        changes.delete(listener);
      };
    },
    describeOperationError: (_operation: string, message: string) => message,
  } as unknown as SessionHandle;
  const binding = createSessionUiBinding(session, kind);
  const config = {
    getModel: () => 'config-model',
    getModelRequestIdentity: () => 'account',
    getModelProviderManager: () => ({
      getModel: async () => undefined,
      getModelConfig: () => undefined,
    }),
    getPermissionMode: () => 'default',
    getSessionId: () => 'local',
  } as unknown as Config;
  return {
    state,
    channel,
    changes,
    binding,
    config,
    start,
    restore,
    release,
    submitMessage,
  };
}

describe('semantic session UI', () => {
  it.each([undefined, 'local'] as const)(
    'writes committed history only when the UI owns its destination (%s)',
    async (kind) => {
      const h = fixture(kind);
      const history = vi.fn();
      const rendered = await renderHook(() =>
        useSession({
          enabled: true,
          config: h.config,
          binding: h.binding,
          addHistoryItem: history,
        }),
      );
      try {
        await rendered.waitUntilReady();
        await act(async () => {
          for (const listener of h.changes)
            listener({
              type: 'history',
              kind: 'append',
              record: { type: 'gemini', text: 'already committed' },
            });
        });
        expect(history).toHaveBeenCalledTimes(kind === 'local' ? 0 : 1);
        await act(async () => {
          for (const listener of h.changes)
            listener({
              type: 'history',
              kind: 'pending',
              records: [{ type: 'gemini', text: 'still streaming' }],
            });
        });
        expect(rendered.result.current.pendingHistoryItems).toContainEqual({
          type: 'gemini',
          text: 'still streaming',
        });
      } finally {
        rendered.unmount();
      }
    },
  );

  it.each([undefined, 'local'] as const)(
    'uses supplied execution facts without inferring a model turn from busy UI (%s)',
    async (kind) => {
      const h = fixture(kind);
      const thought = { subject: 'Current thought' };
      Object.assign(h.state, {
        activity: {
          status: 'responding',
          isModelTurnActive: false,
          isResponding: true,
          thought,
        },
      });
      const rendered = await renderHook(() =>
        useSession({
          enabled: true,
          config: h.config,
          binding: h.binding,
          addHistoryItem: vi.fn(),
        }),
      );
      try {
        await rendered.waitUntilReady();
        expect(h.start).toHaveBeenCalledTimes(kind === 'local' ? 0 : 1);
        expect(rendered.result.current.streamingState).toBe(
          StreamingState.Responding,
        );
        expect(rendered.result.current.isModelTurnActive).toBe(false);
        expect(rendered.result.current.thought).toBe(thought);
        // A guard reads the handle even before the next observation/render.
        Object.assign(h.state.activity!, { isResponding: false });
        expect(rendered.result.current.getIsResponding()).toBe(false);
        Object.assign(h.state, {
          activity: {
            status: 'waiting_for_confirmation',
            isModelTurnActive: true,
            isResponding: true,
            thought: null,
          },
        });
        await act(async () => {
          for (const listener of h.changes)
            listener({ type: 'snapshot', state: h.state, reason: 'observe' });
        });
        expect(rendered.result.current.streamingState).toBe(
          StreamingState.WaitingForConfirmation,
        );
        expect(rendered.result.current.isModelTurnActive).toBe(true);
        expect(rendered.result.current.thought).toBeNull();
      } finally {
        rendered.unmount();
        await h.binding.dispose();
      }
    },
  );
  it.each(['next', ''])(
    'returns native model save failure for %s without publishing an optimistic model',
    async (model) => {
      const h = fixture('local');
      const select = vi.fn<SessionHandle['setModel']>(async () => false);
      h.binding.session.setModel = select;
      const rendered = await renderHook(() =>
        useSession({
          enabled: true,
          binding: h.binding,
          config: h.config,
          addHistoryItem: vi.fn(),
        }),
      );
      try {
        await rendered.waitUntilReady();
        await act(async () => {
          await expect(
            rendered.result.current.sessionHandle!.setModel(
              model,
              undefined,
              undefined,
              { sessionOnly: false },
            ),
          ).resolves.toBe(false);
        });
        expect(select).toHaveBeenCalledExactlyOnceWith(
          model,
          undefined,
          undefined,
          { sessionOnly: false },
        );
        expect(rendered.result.current.currentModel).toBe('local-test');
      } finally {
        rendered.unmount();
        await h.binding.dispose();
      }
    },
  );
  it('does not invent proxied approvals or pending rows for a native snapshot', async () => {
    const h = fixture('local');
    const store = createPermissionQueueStore();
    const present = vi.spyOn(store, 'presentProxied');
    const rendered = await renderHook(
      () =>
        useSession({
          enabled: true,
          binding: h.binding,
          config: h.config,
          addHistoryItem: vi.fn(),
        }),
      {
        wrapper: ({ children }) => (
          <PermissionQueueProvider store={store}>
            {children}
          </PermissionQueueProvider>
        ),
      },
    );
    try {
      await rendered.waitUntilReady();
      const approval = {
        id: 'native-tool',
        callId: 'native-tool',
        name: 'Read',
        description: 'Read file',
        prompt: { reason: 'Read file', skippable: true },
      };
      await act(async () => {
        for (const listener of h.changes)
          listener({
            type: 'snapshot',
            state: { ...h.state, approvals: [approval] },
            reason: 'restore',
          });
      });
      expect(present).not.toHaveBeenCalled();
      expect(rendered.result.current.pendingHistoryItems).toEqual([]);
      expect(store.size).toBe(0);
    } finally {
      rendered.unmount();
      await h.binding.dispose();
    }
  });
  it('preserves local paste and queue context without preparing images a second time', async () => {
    const h = fixture('local');
    const pastedContents: Record<number, PastedContent> = {
      1: {
        id: 1,
        type: 'image',
        content: '',
        sourcePath: '/unread/local-image.png',
      },
    };
    const queuedCommands: QueuedCommand[] = [
      {
        prompt: 'read [Image #1]',
        commandMode: 'prompt',
        uuid: 'original-queued-id',
      },
    ];
    const options = {
      pastedContents,
      queuedCommands,
      commandMode: 'prompt' as const,
      suppressWorkflowKeyword: true,
    };
    const rendered = await renderHook(() =>
      useSession({
        enabled: true,
        binding: h.binding,
        config: h.config,
        addHistoryItem: vi.fn(),
      }),
    );
    try {
      await rendered.waitUntilReady();
      await act(async () =>
        rendered.result.current.submitQuery('read [Image #1]', options),
      );
      expect(h.submitMessage).toHaveBeenCalledExactlyOnceWith(
        {
          id: 'original-queued-id',
          text: 'read [Image #1]',
          content: [{ type: 'text', text: 'read [Image #1]' }],
        },
        expect.objectContaining(options),
      );
      expect(h.submitMessage.mock.calls[0][1]?.pastedContents).toBe(
        pastedContents,
      );
      expect(h.submitMessage.mock.calls[0][1]?.queuedCommands).toBe(
        queuedCommands,
      );
    } finally {
      rendered.unmount();
      await h.binding.dispose();
    }
  });

  it('preserves local caller message identity, timestamp and explicit content blocks', async () => {
    const h = fixture('local');
    const contentBlocks = [{ type: 'text' as const, text: 'explicit input' }];
    const rendered = await renderHook(() =>
      useSession({
        enabled: true,
        binding: h.binding,
        config: h.config,
        addHistoryItem: vi.fn(),
      }),
    );
    try {
      await rendered.waitUntilReady();
      await act(async () =>
        rendered.result.current.submitQuery('original', {
          userMessage: {
            uuid: 'original-id',
            timestamp: '2026-11-02T12:00:00Z',
          },
          contentBlocks,
        }),
      );
      expect(h.submitMessage).toHaveBeenCalledWith(
        { id: 'original-id', text: 'explicit input', content: contentBlocks },
        expect.objectContaining({ timestamp: '2026-11-02T12:00:00Z' }),
      );
    } finally {
      rendered.unmount();
      await h.binding.dispose();
    }
  });

  it('does not emit a second permission-mode event for locally owned configuration', async () => {
    const h = fixture('local');
    const emit = vi.spyOn(coreEvents, 'emitPermissionModeChanged');
    const rendered = await renderHook(() =>
      useSession({
        enabled: true,
        binding: h.binding,
        config: h.config,
        addHistoryItem: vi.fn(),
      }),
    );
    try {
      await rendered.waitUntilReady();
      await act(async () => {
        for (const listener of h.changes)
          listener({
            type: 'snapshot',
            reason: 'observe',
            state: { ...h.state, permissionMode: 'yolo' },
          });
      });
      expect(rendered.result.current.currentPermissionMode).toBe('yolo');
      expect(emit).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      await h.binding.dispose();
      emit.mockRestore();
    }
  });
  it('owns only the proxied approvals that this UI creates', async () => {
    const h = fixture();
    const store = createPermissionQueueStore();
    const respond = vi.fn(async () => {});
    h.binding.session.respondToApproval = respond;
    const approval = {
      id: 'remote-tool',
      callId: 'remote-tool',
      name: 'Read',
      input: { path: 'first' },
      description: 'Read file',
      prompt: { reason: 'Read file', skippable: true },
    };
    const rendered = await renderHook(
      () =>
        useSession({
          enabled: true,
          binding: h.binding,
          config: h.config,
          addHistoryItem: vi.fn(),
        }),
      {
        wrapper: ({ children }) => (
          <PermissionQueueProvider store={store}>
            {children}
          </PermissionQueueProvider>
        ),
      },
    );
    const emit = async (update: SessionUpdate) =>
      act(async () => {
        for (const listener of h.changes) listener(update);
      });
    try {
      await rendered.waitUntilReady();
      await emit({ type: 'approval', approval, replace: false });
      const original = store.getById(approval.id);
      expect(store.getSnapshot()).toEqual([original]);
      await emit({
        type: 'snapshot',
        state: { ...h.state, approvals: [approval] },
        reason: 'observe',
      });
      expect(store.getSnapshot()).toEqual([original]);
      await emit({
        type: 'approval',
        approval: { ...approval, input: { path: 'second' } },
        replace: true,
      });
      expect(store.getSnapshot()).toHaveLength(1);
      expect(store.getById(approval.id)?.input).toEqual({ path: 'second' });
      await act(async () => store.getById(approval.id)!.approve());
      expect(respond).toHaveBeenCalledOnce();
      expect(store.size).toBe(0);

      await emit({ type: 'approval', approval, replace: false });
      await emit({ type: 'snapshot', state: h.state, reason: 'observe' });
      expect(store.size).toBe(0);
      await emit({ type: 'approval', approval, replace: false });
      await emit({ type: 'approvals_cleared' });
      expect(store.size).toBe(0);
      await emit({ type: 'approval', approval, replace: false });
      await act(async () => rendered.unmount());
      expect(store.size).toBe(0);
      expect(respond).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
    } finally {
      await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });
  it('reads an existing approval without replacing or removing its local queue entry', async () => {
    const h = fixture();
    const store = createPermissionQueueStore();
    const approve = vi.fn();
    const dismiss = store.presentProxied(
      {
        toolUseId: 'local-tool',
        toolName: 'Read',
        input: { path: 'file' },
        reason: {
          message: 'Read file',
          attribution: { type: 'other', reason: 'test' },
        },
        skippable: true,
      },
      { approve, reject: vi.fn(), abort: vi.fn() },
    );
    const original = store.getById('local-tool');
    const state: SessionState = {
      ...h.state,
      approvals: [
        {
          id: 'local-tool',
          callId: 'local-tool',
          name: 'Read',
          description: 'Read file',
          prompt: { reason: 'Read file', skippable: true },
        },
      ],
    };
    h.binding.session.getState = () => state;
    const rendered = await renderHook(
      () =>
        useSession({
          enabled: true,
          binding: h.binding,
          config: h.config,
          addHistoryItem: vi.fn(),
        }),
      {
        wrapper: ({ children }) => (
          <PermissionQueueProvider store={store}>
            {children}
          </PermissionQueueProvider>
        ),
      },
    );
    try {
      await rendered.waitUntilReady();
      await act(async () => {
        for (const listener of h.changes)
          listener({ type: 'snapshot', state, reason: 'observe' });
      });
      expect(store.getSnapshot()).toEqual([original]);
      expect(rendered.result.current.streamingState).toBe(
        StreamingState.WaitingForConfirmation,
      );
      await act(async () => rendered.unmount());
      expect(store.getSnapshot()).toEqual([original]);
      original!.approve();
      expect(approve).toHaveBeenCalledOnce();
    } finally {
      await act(async () => rendered.unmount());
      dismiss();
      await h.binding.dispose();
    }
  });
  it('keeps optimistic settings and rollback in the UI operation handle', async () => {
    const h = fixture();
    let reject!: (error: Error) => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.binding.session.setModel = apply;
    const rendered = await renderHook(() =>
      useSession({
        enabled: true,
        binding: h.binding,
        config: h.config,
        addHistoryItem: vi.fn(),
      }),
    );
    await rendered.waitUntilReady();
    let pending!: ReturnType<SessionHandle['setModel']>;
    try {
      await act(async () => {
        pending = rendered.result.current.sessionHandle!.setModel('selected');
      });
      expect(rendered.result.current.currentModel).toBe('selected');
      expect(rendered.result.current.sessionHandle!.getState().model).toBe(
        'local-test',
      );
      await act(async () => {
        reject(new Error('rejected'));
        await expect(pending).rejects.toThrow('rejected');
      });
      expect(rendered.result.current.currentModel).toBe('local-test');
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
      await h.binding.dispose();
    }
  });
  it('follows programmatic model changes from the live config', async () => {
    const h = fixture();
    let liveModel = 'local-test';
    (h.config as unknown as { getModel: () => string }).getModel = () =>
      liveModel;
    const rendered = await renderHook(() =>
      useSession({
        enabled: true,
        binding: h.binding,
        config: h.config,
        addHistoryItem: vi.fn(),
      }),
    );
    try {
      await rendered.waitUntilReady();
      expect(rendered.result.current.currentModel).toBe('local-test');

      liveModel = 'switched-model';
      await act(async () => {
        coreEvents.emitModelChanged(h.config.getSessionId(), 'switched-model');
      });
      expect(rendered.result.current.currentModel).toBe('switched-model');
    } finally {
      rendered.unmount();
      await h.binding.dispose();
    }
  });
  it.each(['accepted', 'rejected'] as const)(
    'keeps uiConfig permission updates and indicator rollback with one %s request',
    async (outcome) => {
      const h = fixture();
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const setPermissionMode = vi.fn(
        () =>
          new Promise<void>((ok, fail) => {
            resolve = ok;
            reject = fail;
          }),
      );
      h.binding.session.setPermissionMode = setPermissionMode;
      const configBinding = {
        current: {
          session: h.binding.session,
          settings: {
            model: 'local-test',
            permissionMode: 'default',
          } as SessionSettings,
        },
      };
      const reportError = vi.fn();
      const view = createSessionConfig(h.config, configBinding, reportError);
      const rendered = await renderHook(() => {
        const ui = useSession({
          enabled: true,
          binding: h.binding,
          config: h.config,
          addHistoryItem: vi.fn(),
        });
        configBinding.current = {
          session: ui.sessionHandle!,
          settings: {
            model: ui.currentModel,
            permissionMode: ui.currentPermissionMode,
          },
        };
        const indicator = usePermissionModeIndicator({ config: view });
        return { ui, indicator };
      });
      try {
        await rendered.waitUntilReady();
        expect(rendered.result.current.indicator).toBe('default');
        await act(async () => {
          view.setPermissionMode('yolo');
        });
        expect(setPermissionMode).toHaveBeenCalledExactlyOnceWith('yolo');
        expect(rendered.result.current.ui.currentPermissionMode).toBe('yolo');
        expect(rendered.result.current.indicator).toBe('yolo');
        expect(view.getPermissionMode()).toBe('yolo');
        await act(async () => {
          if (outcome === 'rejected') reject(new Error('permission rejected'));
          else resolve();
        });
        if (outcome === 'rejected') {
          await waitFor(() =>
            expect(reportError).toHaveBeenCalledExactlyOnceWith(
              'Failed to set permission mode: permission rejected',
            ),
          );
          expect(rendered.result.current.ui.currentPermissionMode).toBe(
            'default',
          );
          expect(rendered.result.current.indicator).toBe('default');
          expect(view.getPermissionMode()).toBe('default');
        } else {
          expect(reportError).not.toHaveBeenCalled();
          expect(rendered.result.current.indicator).toBe('yolo');
        }
        expect(setPermissionMode).toHaveBeenCalledOnce();
      } finally {
        rendered.unmount();
        await h.binding.dispose();
      }
    },
  );

  it('forwards submission metadata through the UI operation handle', async () => {
    const h = fixture();
    let rendered!: Awaited<
      ReturnType<typeof renderHook<ReturnType<typeof useSession>, void>>
    >;
    try {
      await act(async () => {
        rendered = await renderHook(() =>
          useSession({
            enabled: true,
            binding: h.binding,
            config: h.config,
            addHistoryItem: vi.fn(),
          }),
        );
        await rendered.waitUntilReady();
      });
      const message = {
        id: 'existing-uuid',
        text: 'retry',
        content: [{ type: 'text', text: 'retry' }],
      };
      const options = {
        timestamp: '2026-10-29T02:00:00.000Z',
        hideFromDisplay: true,
      };
      await act(async () => {
        await rendered.result.current.sessionHandle!.submitMessage(
          message,
          options,
        );
      });
      expect(h.submitMessage).toHaveBeenCalledExactlyOnceWith(message, options);
      expect(h.submitMessage.mock.calls[0]![0]).toBe(message);
    } finally {
      await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });

  it('does not touch a supplied binding while inactive', async () => {
    const h = fixture();
    const history = vi.fn();
    const rendered = await renderHook(() =>
      useSession({
        enabled: false,
        binding: h.binding,
        config: h.config,
        addHistoryItem: history,
      }),
    );
    try {
      await rendered.waitUntilReady();
      await rendered.result.current.submitQuery('ignored');
      rendered.result.current.cancelOngoingRequest();
      rendered.result.current.releaseSession();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.submitMessage).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(rendered.result.current.sessionHandle).toBeUndefined();
    } finally {
      await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });
  it('renders a session implementation with no product role or protocol methods', async () => {
    const h = fixture();
    const history = vi.fn();
    let rendered!: Awaited<
      ReturnType<typeof renderHook<ReturnType<typeof useSession>, void>>
    >;
    try {
      await act(async () => {
        rendered = await renderHook(() =>
          useSession({
            enabled: true,
            binding: h.binding,
            config: h.config,
            addHistoryItem: history,
          }),
        );
        await rendered.waitUntilReady();
      });
      expect(h.start).toHaveBeenCalledOnce();
      await act(async () => rendered.result.current.submitQuery('hello'));
      expect(h.submitMessage).toHaveBeenCalledOnce();
      expect(history).toHaveBeenCalledWith({ type: 'user', text: 'hello' });
      await act(async () =>
        h.channel.applyEvent({
          type: 'assistant_message',
          content: { text: 'answer', thinkingTexts: [] },
          endsTurn: true,
          source: { delivery: 'live', hasDisplayHistory: false },
        }),
      );
      await waitFor(() =>
        expect(history).toHaveBeenCalledWith({
          type: 'gemini',
          text: 'answer',
        }),
      );
      await act(async () => rendered.unmount());
      expect(h.changes.size).toBe(0);
      expect(h.release).not.toHaveBeenCalled();
      await h.binding.dispose();
      expect(h.release).toHaveBeenCalledOnce();
    } finally {
      if (rendered) await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });
  it('restores through the same semantic session while leaving its input opaque', async () => {
    const h = fixture();
    const first = { initial: true };
    const next = { differentProviderShape: ['value'] };
    let rendered!: Awaited<
      ReturnType<typeof renderHook<ReturnType<typeof useSession>, unknown>>
    >;
    try {
      await act(async () => {
        rendered = await renderHook<ReturnType<typeof useSession>, unknown>(
          (input: unknown) =>
            useSession({
              enabled: true,
              binding: h.binding,
              config: h.config,
              restoreData: input,
              addHistoryItem: vi.fn(),
            }),
          { initialProps: first },
        );
        await rendered.waitUntilReady();
      });
      expect(h.restore).not.toHaveBeenCalled();
      await act(async () => rendered.rerender(next));
      expect(h.restore).toHaveBeenCalledExactlyOnceWith(next);
      expect(h.start).toHaveBeenCalledTimes(2);
    } finally {
      if (rendered) await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });
  it('keeps a disabled entry inert even if a binding is supplied', async () => {
    const h = fixture();
    let rendered!: Awaited<
      ReturnType<typeof renderHook<ReturnType<typeof useSession>, void>>
    >;
    try {
      await act(async () => {
        rendered = await renderHook(() =>
          useSession({
            enabled: false,
            binding: h.binding,
            config: h.config,
            addHistoryItem: vi.fn(),
          }),
        );
        await rendered.waitUntilReady();
      });
      await rendered.result.current.submitQuery('ignored');
      rendered.result.current.cancelOngoingRequest();
      rendered.result.current.releaseSession();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.submitMessage).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(rendered.result.current.getIsResponding()).toBe(false);
      expect(rendered.result.current.streamingState).toBe(StreamingState.Idle);
      expect(rendered.result.current.currentModel).toBe('config-model');
    } finally {
      if (rendered) await act(async () => rendered.unmount());
      await h.binding.dispose();
    }
  });
});
