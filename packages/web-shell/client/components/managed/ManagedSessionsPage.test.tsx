// @vitest-environment jsdom

import { act, useContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isShellResultDisplay } from '@qwen-code/sdk/daemon';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { getManagedClientId } from './managed-session-storage';
import * as pendingStorage from './managed-pending-storage';
import { I18nProvider } from '../../i18n';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedAgentSessionEvent,
  ManagedAgentSessionTranscript,
  ManagedContextCompressionOperation,
  ManagedTask,
} from './managed-agent-provider';
import type { EditorHandle } from '../../hooks/useComposerCore';
import { getComposerDraftStorageKey } from '../../hooks/useComposerCore';
import { getSlashCommandCompletionResult } from '../../completions/slashCompletion';
import { createInputAnnotationsFromComposerTags } from '../../utils/composerTag';
import type { ComponentProps } from 'react';
import {
  ToolDetailsContext,
  type ToolDetailsLoader,
} from '../messages/tools/ToolDetailsContext';

const mocks = vi.hoisted(() => ({
  useWorkspace: vi.fn(),
  restoreEditorDraft: vi.fn<() => string>(),
  commitAccepted: vi.fn(),
  loadToolDetails: undefined as ToolDetailsLoader | undefined,
  clearEditor: vi.fn(),
  editorProps: undefined as
    | ComponentProps<(typeof import('../ChatEditor'))['ChatEditor']>
    | undefined,
  client: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getTranscript: vi.fn(),
    subscribeEvents: vi.fn(),
    createSession: vi.fn(),
    submitPrompt: vi.fn(),
    cancel: vi.fn(),
    queryCancelOperation: vi.fn(),
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: mocks.useWorkspace,
  // The shared approval card asks whether a tool is an agent launch.
  isAgentTool: () => false,
}));
vi.mock('../MessageList', () => ({
  MessageList: ({
    messages,
    hasOlderHistory,
    onLoadOlderHistory,
    onToolResultOpen,
    pendingApproval,
    welcomeHeader,
  }: {
    messages: unknown[];
    hasOlderHistory: boolean;
    onLoadOlderHistory: () => Promise<void>;
    onToolResultOpen?: (itemId: string) => void;
    pendingApproval?: unknown;
    welcomeHeader?: ReactNode;
  }) => {
    mocks.loadToolDetails = useContext(ToolDetailsContext);
    return (
      <>
        {welcomeHeader}
        <button onClick={() => onToolResultOpen?.('item-1')}>
          Open tool output
        </button>
        <pre data-testid="messages">{JSON.stringify(messages)}</pre>
        {/* The real MessageList keys its folding off this prop, so the mock has
          to expose it for the join between the two to be observed. */}
        <pre data-testid="message-list-pending-approval">
          {JSON.stringify(pendingApproval ?? null)}
        </pre>
        {hasOlderHistory && (
          <button onClick={() => void onLoadOlderHistory()}>
            Older history
          </button>
        )}
      </>
    );
  },
}));

vi.mock('../ChatEditor', async () => {
  const { forwardRef, useImperativeHandle, useRef, useState } = await import(
    'react'
  );
  return {
    ChatEditor: forwardRef<
      EditorHandle,
      ComponentProps<(typeof import('../ChatEditor'))['ChatEditor']>
    >((props, ref) => {
      mocks.editorProps = props;
      const [value, setValue] = useState(
        () => props.composerInput?.text ?? mocks.restoreEditorDraft(),
      );
      const input = useRef<HTMLTextAreaElement>(null);
      const update = (text: string) => {
        setValue(text);
        props.onInputTextChange?.(text);
      };
      useImperativeHandle(
        ref,
        () =>
          ({
            setText: update,
            clearText: () => update(''),
            clear: () => {
              mocks.clearEditor();
              update('');
            },
            getText: () => input.current?.value ?? '',
            focus: () => input.current?.focus(),
          }) as EditorHandle,
      );
      return (
        <form
          data-managed-composer-scope={props.composerScopeKey}
          onSubmit={(event) => {
            event.preventDefault();
            const accepted = props.onSubmit(value, undefined, undefined, () => {
              mocks.commitAccepted();
              update('');
            });
            if (accepted !== false) update('');
          }}
        >
          <textarea
            ref={input}
            aria-label={props.placeholderText}
            value={value}
            disabled={props.disabled}
            onChange={(event) => update(event.target.value)}
          />
          <button
            type="submit"
            disabled={props.disabled || props.isPreparing || !value.trim()}
          >
            Send
          </button>
          {props.isRunning && (
            <button
              type="button"
              disabled={!props.onCancel || props.isPreparing}
              onClick={props.onCancel}
            >
              Stop managed task
            </button>
          )}
        </form>
      );
    }),
  };
});

import { ManagedSessionsPage } from './ManagedSessionsPage';
import { artifact, result } from './managed-tool-result.test-fixtures';
import { task, taskOperation } from './managed-task.test-fixtures';

function summary(
  sessionId = 's1',
  extra: Partial<ManagedAgentSessionSummary> = {},
): ManagedAgentSessionSummary {
  return {
    sessionId,
    activeTurnId: 'p1',
    title: `Task ${sessionId}`,
    createdAt: 10,
    updatedAt: 20,
    admittedAt: 10,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: true, canCancel: false },
    ...extra,
  };
}

function event(id: number, text: string): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type: 'assistant_delta',
    sessionId: 's1',
    turnId: 'p1',
    data: { text },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const pendingAction = {
  actionId: 'tool_approval_1',
  sessionId: 's1',
  turnId: 'p1',
  functionCallId: 'call-1',
  toolName: 'write_file',
  inputRevision: 1,
  policyRevision: 'hosted-tool-approval/1',
  expiresAt: Date.now() + 600_000,
  options: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
  ],
};

describe('ManagedSessionsPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  let provider: ManagedAgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restoreEditorDraft.mockReturnValue('');
    provider = {
      storageKey: 'http://managed-test',
      canCancel: true,
      ...mocks.client,
    };
    sessionStorage.clear();
    localStorage.clear();
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary()],
    });
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id),
    );
    mocks.client.getTranscript.mockResolvedValue({
      events: [
        event(1, 'Persisted answer'),
        { ...event(2, ''), type: 'completed' },
      ],
      lastEventId: 2,
    });
    mocks.client.subscribeEvents.mockImplementation(async function* (
      _id: string,
      opts: { signal: AbortSignal },
    ) {
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) resolve();
        else
          opts.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      yield* [];
    });
    mocks.client.createSession.mockResolvedValue({
      sessionId: 'created',
      turnId: 'p-new',
    });
    mocks.client.submitPrompt.mockResolvedValue({
      sessionId: 's1',
      turnId: 'p-next',
    });
    mocks.client.cancel.mockResolvedValue({
      sessionId: 's1',
      turnId: 'p1',
      operationId: 'cancel-1',
    });
    mocks.client.queryCancelOperation.mockResolvedValue({
      sessionId: 's1',
      operationId: 'cancel-1',
      type: 'cancel',
      status: 'running',
      replayed: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(
    sessionId?: string,
    language: 'en' | 'zh-CN' = 'en',
    managedAgentProvider: ManagedAgentProvider | null = provider,
    navigationTarget?: HTMLElement | null,
    interactive = true,
    extraProps: Partial<ComponentProps<typeof ManagedSessionsPage>> = {},
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language={language}>
          <ManagedSessionsPage
            sessionId={sessionId}
            onSelectSession={onSelect}
            managedAgentProvider={managedAgentProvider ?? undefined}
            navigationTarget={navigationTarget}
            interactive={interactive}
            {...extraProps}
          />
        </I18nProvider>,
      );
      await flush();
    });
  }

  it('opens only the host Session without catalog, creation, cancellation or daemon calls', async () => {
    provider = { ...provider, canCancel: false };
    mocks.client.listSessions.mockRejectedValue(new Error('catalog forbidden'));
    mocks.client.createSession.mockRejectedValue(
      new Error('creation forbidden'),
    );
    await render('s1', 'en', provider, undefined, true, {
      hostSessionOnly: true,
    });
    expect(
      container.querySelector('[data-testid="messages"]')?.textContent,
    ).toContain('Persisted answer');
    expect(mocks.client.getSession).toHaveBeenCalledWith(
      's1',
      expect.any(Object),
    );
    expect(mocks.client.getTranscript).toHaveBeenCalledWith(
      's1',
      expect.any(Object),
    );
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's1',
      expect.any(Object),
    );
    expect(container.querySelector('nav')).toBeNull();
    expect(container.textContent).not.toContain('New session');
    expect(mocks.editorProps?.disabled).toBe(false);
    await act(async () => {
      mocks.editorProps!.onSubmit(
        'host follow-up',
        undefined,
        undefined,
        () => {},
      );
      await flush();
    });
    expect(mocks.client.submitPrompt).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ text: 'host follow-up' }),
      expect.any(Object),
    );
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.cancel).not.toHaveBeenCalled();
    expect(mocks.useWorkspace).not.toHaveBeenCalled();
  });

  it('waits for an explicit host ID and clears the old conversation when it is removed', async () => {
    const host = { hostSessionOnly: true };
    await render(undefined, 'en', provider, undefined, true, host);
    expect(
      container.querySelector('[data-managed-host-waiting]'),
    ).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(mocks.client.getSession).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
    await render('s1', 'en', provider, undefined, true, host);
    const streamSignal = mocks.client.subscribeEvents.mock.calls[0][1]
      .signal as AbortSignal;
    expect(container.textContent).toContain('Persisted answer');
    await render(undefined, 'en', provider, undefined, true, host);
    expect(streamSignal.aborted).toBe(true);
    expect(container.textContent).not.toContain('Persisted answer');
    expect(container.querySelector('form')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
  });

  it('tears down the old host scope and ignores its late transcript', async () => {
    let resolveOld!: (value: ManagedAgentSessionTranscript) => void;
    mocks.client.getTranscript.mockImplementationOnce(
      () =>
        new Promise<ManagedAgentSessionTranscript>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render('s1', 'en', provider, undefined, true, {
      hostSessionOnly: true,
    });
    const oldSignal = mocks.client.getSession.mock.calls[0][1]
      .signal as AbortSignal;
    const next = { ...provider, storageKey: 'tenant-b:actor-b' };
    await render('s2', 'en', next, undefined, true, { hostSessionOnly: true });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {
      resolveOld({ events: [event(1, 'Private old scope')], lastEventId: 1 });
      await flush();
    });
    expect(container.textContent).not.toContain('Private old scope');
    expect(mocks.editorProps?.composerScopeKey).toContain(
      'tenant-b:actor-b:s2',
    );
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
    expect(mocks.client.createSession).not.toHaveBeenCalled();
  });

  it('uses the host capability to keep a single-turn session read-only', async () => {
    sessionStorage.setItem(
      `qwen-managed-turn-cancel:${JSON.stringify([provider.storageKey, 's1'])}`,
      JSON.stringify({
        sessionId: 's1',
        turnId: 'p1',
        idempotencyKey: 'old-cancel',
      }),
    );
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        agentId: 'qwen-code',
        phase: 'runtime_starting',
        capabilities: { canSend: false, canCancel: true },
        workspace: { workspaceId: 'host-workspace', cwdRelative: '.' },
        runtimeReady: false,
        runtimeState: 'unknown',
      }),
    );
    await render(
      's1',
      'en',
      { ...provider, canCancel: false },
      undefined,
      true,
      { hostSessionOnly: true },
    );
    expect(container.textContent).toContain('Persisted answer');
    expect(mocks.editorProps?.disabled).toBe(true);
    expect(mocks.editorProps?.isRunning).toBe(false);
    expect(mocks.editorProps?.onCancel).toBeUndefined();
    expect(mocks.editorProps?.currentModel).toBe('');
    expect(mocks.editorProps?.visibleToolbarActions).not.toContain('model');
    expect(container.textContent).not.toContain('The model is fixed');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      mocks.editorProps!.onSubmit('blocked', undefined, undefined, () => {});
      await flush();
    });
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.client.cancel).not.toHaveBeenCalled();
    expect(mocks.client.queryCancelOperation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'refreshes a preparing empty worktree session until ready (home: %s) and keeps attachments unavailable during preparation',
    async (home) => {
      vi.useFakeTimers();
      const worktree = {
        id: 'worktree-a',
        sessionId: 's1',
        workspaceId: 'ws-a',
        state: 'preparing' as const,
        branch: 'worktree-managed-a',
        baseCommit: 'a'.repeat(40),
        cwdRelative: '.qwen-managed-session-worktrees/a',
        operationId: 'op-a',
        revision: 1,
      };
      let current = summary('s1', {
        phase: 'created',
        activeTurnId: undefined,
        worktree,
        workspace: {
          workspaceId: 'ws-a',
          cwdRelative: worktree.cwdRelative,
          state: 'changing',
        },
        capabilities: {
          canSend: false,
          canCancel: false,
          inputAttachments: true,
          workspaceTurns: true,
        },
      });
      mocks.client.getSession.mockImplementation(async () => current);
      mocks.client.getTranscript.mockResolvedValue({
        events: [],
        lastEventId: 0,
      });
      await render('s1', 'en', provider, home ? null : undefined);
      expect(container.textContent).toContain('Preparing worktree');
      if (home) {
        expect(container.textContent).not.toContain(worktree.branch);
        expect(container.textContent).not.toContain('Base commit');
      }
      expect(mocks.editorProps!.attachmentsEnabled).toBe(false);
      expect(mocks.editorProps!.fileReferenceActions).toBeUndefined();
      current = {
        ...current,
        worktree: { ...worktree, state: 'ready', revision: 2 },
        workspace: { ...current.workspace!, state: 'ready' },
        capabilities: {
          canSend: true,
          canCancel: false,
          inputAttachments: true,
          workspaceTurns: true,
        },
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
      });
      if (home) {
        expect(container.querySelector('[data-managed-worktree]')).toBeNull();
        expect(container.textContent).not.toContain(worktree.branch);
      } else {
        expect(container.textContent).toContain('Worktree ready');
        expect(container.textContent).toContain(worktree.branch);
      }
      expect(mocks.editorProps!.attachmentsEnabled).toBe(true);
      expect(mocks.client.getTranscript).toHaveBeenCalledOnce();
    },
  );

  it.each(['blocked', 'failed'] as const)(
    'keeps %s worktree attention visible in Home without branch details',
    async (state) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          capabilities: { canSend: false, canCancel: false },
          worktree: {
            id: 'worktree-a',
            sessionId: 's1',
            workspaceId: 'ws-a',
            state,
            branch: 'worktree-managed-a',
            baseCommit: 'a'.repeat(40),
            cwdRelative: '.qwen-managed-worktrees/a',
            operationId: 'operation-a',
            revision: 1,
            errorCode: 'worktree_identity_conflict',
          },
        }),
      );
      await render('s1', 'en', provider, null);
      const status = container.querySelector(
        `[data-managed-worktree="${state}"]`,
      )!;
      expect(status.textContent).toContain(
        state === 'blocked'
          ? 'Worktree needs attention'
          : 'Worktree preparation failed',
      );
      expect(status.textContent).toContain('worktree_identity_conflict');
      expect(status.textContent).not.toContain('worktree-managed-a');
      expect(status.textContent).not.toContain('Base commit');
      expect(mocks.editorProps!.disabled).toBe(true);
    },
  );

  it('leaves MCP management to Plugins and refreshes the selected composer catalog on return', async () => {
    const query = vi.fn();
    const list = vi.fn(async (id: string) => ({
      object: 'agent.mcp_catalog' as const,
      session_id: id,
      servers: [],
    }));
    provider = {
      ...provider,
      renameSession: vi.fn(),
      mcpManagement: { query, submit: vi.fn(), operation: vi.fn() },
      mcp: { list },
    };
    const current = summary('s1', {
      workspace: { workspaceId: 'project', cwdRelative: '.' },
      capabilities: {
        canSend: true,
        canCancel: false,
        canRename: true,
        workspaceTurns: true,
      },
    });
    mocks.client.getSession.mockResolvedValue(current);
    mocks.client.listSessions.mockResolvedValue({ sessions: [current] });
    mocks.restoreEditorDraft.mockReturnValue('Keep this MCP draft');
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    const hasManageMcp = () =>
      [...document.querySelectorAll('button, [role="menuitem"]')].some(
        (item) => item.textContent === 'Manage MCP',
      );
    try {
      await render('s1', 'en', provider, slot);
      expect(hasManageMcp()).toBe(false);
      await act(async () => {
        slot
          .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
      });
      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      expect(hasManageMcp()).toBe(false);
      expect(
        [...document.querySelectorAll('[role="menuitem"]')].some(
          (item) => item.textContent === 'Rename',
        ),
      ).toBe(true);
      const before = mocks.editorProps!.fileReferenceActions!;
      await before.loadMcpStatus!();
      await render('s1', 'en', provider, slot, false);
      await expect(before.loadMcpStatus!()).rejects.toThrow(
        'MCP Session changed',
      );
      await render('s1', 'en', provider, slot);
      const after = mocks.editorProps!.fileReferenceActions!;
      expect(after.scopeKey).not.toBe(before.scopeKey);
      await after.loadMcpStatus!();
      expect(list.mock.calls.map(([id]) => id)).toEqual(['s1', 's1']);
      expect(container.querySelector('textarea')?.value).toBe(
        'Keep this MCP draft',
      );
      await render('s1');
      expect(hasManageMcp()).toBe(false);
      expect(query).not.toHaveBeenCalled();
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    } finally {
      slot.remove();
    }
  });

  it.each([false, true])(
    'keeps the selected unarchived session out of archived navigation (workspaceBinding=%s)',
    async (withWorkspaceBinding) => {
      const active = summary('s1', {
        lifecycleStatus: 'active',
        title: 'Unarchived selected session',
      });
      const archived = summary('s2', {
        lifecycleStatus: 'archived',
        title: 'Archived session',
      });
      provider = {
        ...provider,
        lifecycle: {
          submit: vi.fn(),
          unarchive: vi.fn(),
          query: vi.fn(),
        },
      };
      mocks.client.getSession.mockResolvedValue(active);
      mocks.client.listSessions.mockImplementation(
        async (options: { archiveState?: string }) => ({
          sessions: options.archiveState === 'archived' ? [archived] : [active],
        }),
      );
      if (withWorkspaceBinding) {
        provider.workspaceBinding = {
          agentId: 'agent',
          list: vi.fn().mockResolvedValue({ data: [], supported: true }),
          get: vi.fn(),
          createEmpty: vi.fn(),
        };
      }
      const slot = document.createElement('aside');
      container.appendChild(slot);
      await render(
        's1',
        'en',
        provider,
        withWorkspaceBinding ? slot : undefined,
      );
      const nav = (withWorkspaceBinding ? slot : container).querySelector(
        'nav[aria-label="Managed sessions"]',
      )!;
      expect(nav.textContent).toContain(active.title);
      expect(nav.textContent).not.toContain(archived.title);
      const archiveSlot = document.createElement('aside');
      container.appendChild(archiveSlot);
      if (withWorkspaceBinding) {
        expect(nav.querySelector('[aria-pressed]')).toBeNull();
        expect(mocks.client.listSessions).toHaveBeenCalledOnce();
        await render('s1', 'en', provider, slot, true, {
          archivedNavigationTarget: archiveSlot,
        });
      } else {
        await act(async () => {
          [...nav.querySelectorAll('button')]
            .find((button) => button.textContent === 'Archived')!
            .click();
          await flush();
        });
      }
      expect(
        mocks.client.listSessions.mock.calls.map(
          ([options]) => options.archiveState,
        ),
      ).toEqual(['unarchived', 'archived']);
      if (withWorkspaceBinding) {
        expect(archiveSlot.textContent).toContain(archived.title);
        expect(archiveSlot.textContent).not.toContain(active.title);
        expect(nav.textContent).toContain(active.title);
        expect(nav.textContent).not.toContain(archived.title);
      } else {
        expect(nav.textContent).toContain(archived.title);
        expect(nav.textContent).not.toContain(active.title);
      }
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it('restores the active list when returning home from standalone archived history', async () => {
    provider = {
      ...provider,
      lifecycle: { submit: vi.fn(), unarchive: vi.fn(), query: vi.fn() },
    };
    mocks.client.listSessions.mockImplementation(
      async ({ archiveState }: { archiveState?: string }) => ({
        sessions: [
          summary(archiveState === 'archived' ? 'archived' : 'active', {
            lifecycleStatus:
              archiveState === 'archived' ? 'archived' : 'active',
          }),
        ],
      }),
    );
    await render();
    await click('Archived');
    expect(container.querySelector('nav')?.textContent).toContain(
      'Task archived',
    );
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    try {
      await render(undefined, 'en', provider, slot);
      expect(slot.textContent).toContain('Task active');
      expect(slot.textContent).not.toContain('Task archived');
    } finally {
      slot.remove();
    }
  });

  it.each(['closed', 'archived'])(
    'keeps %s history read only when native recovery is ready',
    async (lifecycleStatus) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          lifecycleStatus,
          capabilities: { canSend: false, canCancel: false },
          recovery: {
            state: 'ready',
            reasonCode: 'native_settled',
            nextTurnAllowed: true,
            actions: {
              recheck: false,
              cancel: false,
              continueInNewSession: false,
            },
          },
        }),
      );

      await render('s1');
      expect(container.textContent).toContain('Persisted answer');
      expect(container.querySelector('textarea')?.disabled).toBe(true);
      await act(async () => {
        await mocks.editorProps!.onSubmit('Another turn');
        await flush();
      });
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      expect(mocks.client.createSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['en', 'billing'],
    ['zh-CN', '余额'],
  ] as const)(
    'explains a payment failure in %s without submitting another prompt',
    async (language, guidance) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          phase: 'failed',
          failure: {
            code: 'model_payment_required',
            message: 'model_payment_required',
          },
        }),
      );
      await render('s1', language);
      expect(container.textContent).toContain('HTTP 402');
      expect(container.textContent).toContain(guidance);
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    },
  );

  it('preserves an unknown failure message rather than showing a translation key', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        phase: 'failed',
        failure: {
          code: 'custom_failure',
          message: 'A product-specific failure',
        },
      }),
    );
    await render('s1');
    expect(container.textContent).toContain('A product-specific failure');
    expect(container.textContent).not.toContain(
      'managed.failure.custom_failure',
    );
  });

  it('uses the shared rename dialog and synchronizes the confirmed title without submitting the composer', async () => {
    let resolve!: (value: { displayName: string }) => void;
    const renameSession = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    provider = { ...provider, renameSession };
    const canRename = (title: string) =>
      summary('s1', {
        title,
        capabilities: { canSend: true, canCancel: false, canRename: true },
      });
    mocks.client.getSession.mockResolvedValue(canRename('Original'));
    let oldList!: (value: { sessions: ManagedAgentSessionSummary[] }) => void;
    mocks.client.listSessions
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            oldList = done;
          }),
      )
      .mockResolvedValue({ sessions: [canRename('Stored name')] });
    await render('s1');
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Rename')!
        .click();
    });
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Rename"]',
    )!;
    expect(input.value).toBe('Original');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '  Requested name  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
    });
    expect(renameSession).toHaveBeenCalledWith(
      's1',
      'Requested name',
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(container.textContent).toContain('Original');
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    mocks.client.getSession.mockResolvedValue(canRename('Stored name'));
    await act(async () => {
      resolve({ displayName: 'Stored name' });
      await flush();
    });
    await act(async () => {
      oldList({ sessions: [canRename('Original')] });
      await flush();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('nav')?.textContent).toContain(
      'Stored name',
    );
    expect(container.textContent).not.toContain('Original');
    expect(mocks.client.getTranscript).toHaveBeenCalledOnce();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('renames a background Session from its sidebar menu without selecting it or accepting an old poll', async () => {
    vi.useFakeTimers();
    const selected = summary('s1', {
      capabilities: { canSend: true, canCancel: false, canRename: true },
    });
    const other = summary('s2', {
      title: 'Background session',
      phase: 'agent_running',
      capabilities: { canSend: false, canCancel: true, canRename: true },
    });
    const renamed = { ...other, title: 'Renamed background session' };
    const renameSession = vi
      .fn()
      .mockResolvedValue({ displayName: renamed.title });
    provider = { ...provider, renameSession };
    mocks.restoreEditorDraft.mockReturnValue('Keep this draft');
    mocks.client.listSessions.mockResolvedValue({
      sessions: [selected, other],
    });
    let oldPoll!: (value: ManagedAgentSessionSummary) => void;
    let oldSignal: AbortSignal | undefined;
    mocks.client.getSession.mockImplementation(
      (id: string, options: { signal: AbortSignal }) => {
        if (id === other.sessionId) {
          oldSignal = options.signal;
          return new Promise((resolve) => {
            oldPoll = resolve;
          });
        }
        return Promise.resolve(selected);
      },
    );
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    try {
      await render('s1', 'en', provider, slot);
      expect(
        [...container.querySelectorAll('button')].some(
          (button) => button.textContent === 'Rename',
        ),
      ).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await flush();
      });
      expect(oldSignal?.aborted).toBe(false);
      await act(async () => {
        slot
          .querySelector<HTMLButtonElement>(
            '[data-managed-session-id="s2"] button[aria-haspopup="menu"]',
          )!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
      });
      const rename = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent === 'Rename');
      expect(rename).toBeDefined();
      await act(async () => rename!.click());
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Rename"]',
      )!;
      expect(input.value).toBe(other.title);
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, renamed.title);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      mocks.client.listSessions.mockResolvedValue({
        sessions: [selected, renamed],
      });
      await act(async () => {
        input.form!.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await flush();
      });
      expect(renameSession).toHaveBeenCalledWith(
        's2',
        renamed.title,
        expect.anything(),
      );
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => {
        oldPoll({ ...other, updatedAt: 100 });
        await flush();
      });
      expect(
        slot.querySelector('[data-managed-session-id="s2"]')?.textContent,
      ).toContain(renamed.title);
      expect(container.textContent).toContain(selected.title);
      expect(container.textContent).not.toContain(renamed.title);
      expect(container.querySelector('textarea')?.value).toBe(
        'Keep this draft',
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    } finally {
      slot.remove();
    }
  });

  it.each(['permission', 'provider', 'interactivity'] as const)(
    'hides sidebar Rename without %s',
    async (missing) => {
      const session = summary('s1', {
        capabilities: {
          canSend: true,
          canCancel: false,
          canRename: missing !== 'permission',
        },
      });
      provider = {
        ...provider,
        ...(missing === 'provider' ? {} : { renameSession: vi.fn() }),
        exportSnapshot: vi.fn(),
      };
      mocks.client.getSession.mockResolvedValue(session);
      mocks.client.listSessions.mockResolvedValue({ sessions: [session] });
      const slot = document.createElement('aside');
      document.body.appendChild(slot);
      try {
        await render('s1', 'en', provider, slot, missing !== 'interactivity');
        const trigger = slot.querySelector<HTMLButtonElement>(
          'button[aria-haspopup="menu"]',
        );
        expect(trigger).not.toBeNull();
        await act(async () => {
          trigger!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
        });
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        expect(
          [...document.querySelectorAll('[role="menuitem"]')].some(
            (item) => item.textContent === 'Rename',
          ),
        ).toBe(false);
      } finally {
        slot.remove();
      }
    },
  );

  it('searches the confirmed session title while the catalog still has its previous title', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', { title: 'Confirmed name' }),
    );
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary('s1', { title: 'Previous name' })],
    });
    await render('s1', 'en', provider, undefined, true, {
      navigationSearch: 'Confirmed name',
    });
    expect(container.querySelector('nav')?.textContent).toContain(
      'Confirmed name',
    );
  });

  it('queries complete history from the shared sidebar search without duplicate controls', async () => {
    provider = { ...provider, titleSearch: true };
    mocks.client.listSessions.mockImplementation(
      async ({ titleQuery }: { titleQuery?: string }) => ({
        sessions: [
          titleQuery
            ? summary('remote', { title: 'Remote history' })
            : summary('recent', { title: 'Recent task' }),
        ],
      }),
    );
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    try {
      await render(undefined, 'en', provider, slot, true, {
        navigationSearch: 'Remote history',
      });
      expect(mocks.client.listSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ titleQuery: 'Remote history' }),
      );
      expect(slot.querySelector('nav')).not.toBeNull();
      expect(slot.textContent).toContain('Remote history');
      expect(slot.textContent).not.toContain('Recent task');
      expect(slot.querySelector('input')).toBeNull();
      expect(slot.textContent).not.toContain('Managed sessions');
      expect(slot.textContent).not.toContain('Refresh');

      await render(undefined, 'en', provider, slot, true, {
        navigationSearch: '',
      });
      expect(
        mocks.client.listSessions.mock.calls.at(-1)?.[0],
      ).not.toHaveProperty('titleQuery');
      expect(slot.textContent).toContain('Recent task');
    } finally {
      slot.remove();
    }
  });

  it('does not expose rename when permission or interactivity is missing', async () => {
    provider = { ...provider, renameSession: vi.fn() };
    await render('s1');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Rename',
      ),
    ).toBe(false);
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: true, canCancel: false, canRename: true },
      }),
    );
    await render('s1', 'en', provider, null, false);
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'Rename',
      ),
    ).toBe(false);
  });

  it('opens shared workspace creation above an existing conversation and keeps its session when canceled', async () => {
    provider.workspaceBinding = {
      agentId: 'agent-a',
      list: vi.fn().mockResolvedValue({
        data: [],
        supported: true,
        canCreateWorkspace: true,
      }),
      get: vi.fn(),
      createEmpty: vi.fn(),
      createWorkspace: vi.fn(),
    };
    const onWorkspaceCreationOpenChange = vi.fn();
    const extra = {
      workspaceCreationOpen: true,
      onWorkspaceCreationOpenChange,
      onOpenLocalWorkspace: vi.fn(),
    };
    await render('s1', 'en', provider, undefined, false, extra);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Persisted answer');
    const close = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((item) => item.textContent === 'Close');
    expect(close).toBeDefined();
    await act(async () => close!.click());
    expect(onWorkspaceCreationOpenChange).toHaveBeenCalledWith(false);
    await render('s1', 'en', provider, undefined, false, {
      ...extra,
      workspaceCreationOpen: false,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Persisted answer');
    expect(onSelect).not.toHaveBeenCalled();
    expect(provider.workspaceBinding.createWorkspace).not.toHaveBeenCalled();
  });

  it('reports a resolved legacy session as unbound without clearing a workspace draft', async () => {
    const reportWorkspace = vi.fn();
    await render(undefined, 'en', provider, undefined, true, {
      onSessionWorkspaceChange: reportWorkspace,
      workspaceId: 'draft-workspace',
    });
    expect(reportWorkspace).not.toHaveBeenCalled();
    await render('legacy', 'en', provider, undefined, true, {
      onSessionWorkspaceChange: reportWorkspace,
    });
    expect(reportWorkspace).toHaveBeenLastCalledWith(null);
    reportWorkspace.mockClear();
    mocks.client.getSession.mockRejectedValue(new Error('unavailable'));
    await render('different', 'en', provider, undefined, true, {
      onSessionWorkspaceChange: reportWorkspace,
    });
    expect(reportWorkspace).not.toHaveBeenCalled();
  });

  it('binds tool detail reads to the selected Session and distinguishes recorded empty output from missing output', async () => {
    const get = vi.fn().mockResolvedValue({
      input: { command: 'true' },
      output: '',
      truncated: false,
    });
    provider = { ...provider, toolDetails: { get } };
    await render('s1');
    expect(get).not.toHaveBeenCalled();
    const first = mocks.loadToolDetails;
    expect(first).toBeDefined();
    const abort = new AbortController();
    expect(await first!('p1:item-1', abort.signal)).toEqual({
      args: { command: 'true' },
      rawOutput: '',
    });
    expect(get).toHaveBeenLastCalledWith('s1', 'item-1', {
      clientId: getManagedClientId(provider.storageKey),
      signal: abort.signal,
    });
    get.mockResolvedValue({ input: null, output: null, truncated: false });
    await render('s2');
    const second = mocks.loadToolDetails;
    expect(second).not.toBe(first);
    expect(await second!('p2:item-2', abort.signal)).toEqual({
      args: undefined,
      rawOutput: undefined,
    });
    expect(get).toHaveBeenLastCalledWith('s2', 'item-2', {
      clientId: getManagedClientId(provider.storageKey),
      signal: abort.signal,
    });
  });

  it('passes saved structured Shell results to the shared daemon renderer', async () => {
    const shellResult = {
      type: 'shell_result',
      version: 1,
      text: 'saved display text',
      output: 'saved stdout',
      directory: '/workspace/project',
      exitCode: 7,
      signal: null,
      pid: 123,
      error: 'saved failure',
      outcome: 'failed',
      notices: ['saved notice'],
      truncated: true,
      outputFiles: ['/tmp/saved.log'],
    };
    const get = vi.fn().mockResolvedValue({
      input: { command: 'exit 7' },
      output: 'legacy text',
      truncated: true,
      shellResult,
    });
    provider = { ...provider, toolDetails: { get } };
    await render('s1');
    expect(get).not.toHaveBeenCalled();
    const detail = await mocks.loadToolDetails!(
      'p1:item-1',
      new AbortController().signal,
    );
    expect(detail.args).toEqual({ command: 'exit 7' });
    expect(detail.rawOutput).toBe(shellResult);
    expect(isShellResultDisplay(detail.rawOutput)).toBe(true);
  });

  it('connects the Session Skill catalog to the composer without enabling other Workspace features', async () => {
    const skills = [{ name: 'review', description: 'Pinned review.' }];
    const list = vi.fn().mockResolvedValue({ skills });
    provider = { ...provider, skills: { list } };
    await render('s1');
    expect(mocks.editorProps?.visibleToolbarActions).toContain('addMenu');
    expect(mocks.editorProps?.workspaceFeaturesEnabled).toBe(false);
    expect(list).not.toHaveBeenCalled();
    await act(async () => mocks.editorProps?.onSkillsOpenChange?.(true));
    expect(list).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ clientId: expect.any(String) }),
    );
    expect(mocks.editorProps?.skills).toEqual(skills);
    expect(mocks.editorProps?.skillsLoaded).toBe(true);
    const completion = getSlashCommandCompletionResult(
      '/rev',
      4,
      mocks.editorProps?.commands ?? [],
    );
    expect(completion?.items).toMatchObject([
      { label: '/review', apply: '/review ' },
    ]);
    expect(completion?.items[0]?.autoSubmit).not.toBe(true);
  });

  it('connects MCP independently of file attachments without enabling daemon features', async () => {
    const list = vi.fn().mockResolvedValue({
      object: 'agent.mcp_catalog',
      session_id: 's1',
      servers: [],
    });
    provider = { ...provider, mcp: { list } };
    await render('s1');
    expect(mocks.editorProps?.visibleToolbarActions).toContain('addMenu');
    expect(mocks.editorProps?.workspaceFeaturesEnabled).toBe(false);
    expect(list).not.toHaveBeenCalled();
    await expect(
      mocks.editorProps!.fileReferenceActions!.loadMcpStatus!(),
    ).resolves.toEqual({ servers: [] });
    expect(list).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ clientId: expect.any(String) }),
    );
  });

  it('invalidates the composer MCP cache scope when the selected Session changes without file actions', async () => {
    const list = vi.fn(async (sessionId: string) => ({
      object: 'agent.mcp_catalog' as const,
      session_id: sessionId,
      servers: [],
    }));
    provider = { ...provider, mcp: { list } };
    await render('s1');
    const first = mocks.editorProps!.fileReferenceActions!;
    expect(first.scopeKey).toBeTruthy();
    await first.loadMcpStatus!();

    await render('s1');
    expect(mocks.editorProps!.fileReferenceActions!.scopeKey).toBe(
      first.scopeKey,
    );

    await render('s2');
    const second = mocks.editorProps!.fileReferenceActions!;
    expect(second.scopeKey).not.toBe(first.scopeKey);
    await second.loadMcpStatus!();
    expect(list.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      's1',
      's2',
    ]);
  });

  it('keeps Workspace file references available alongside MCP and the pinned Skill catalog', async () => {
    const skills = [{ name: 'review', description: 'Pinned review.' }];
    const list = vi.fn().mockResolvedValue({ skills });
    const query = vi.fn().mockResolvedValue({
      scopeRevision: 'registered',
      directory: '.',
      entries: [],
      truncated: false,
    });
    provider = {
      ...provider,
      skills: { list },
      mcp: {
        list: vi.fn().mockResolvedValue({ session_id: 's1', servers: [] }),
      },
      workspaceFiles: { query, read: vi.fn() },
    };
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: {
          canSend: true,
          canCancel: false,
          inputAttachments: true,
          workspaceTurns: true,
        },
        workspace: { workspaceId: 'ws', cwdRelative: '.' },
      }),
    );
    await render('s1');
    expect(mocks.editorProps?.fileReferenceActions).toBeDefined();
    expect(
      mocks.editorProps?.fileReferenceActions?.loadMcpStatus,
    ).toBeDefined();
    expect(mocks.editorProps?.persistFileReferences).toBe(true);
    expect(mocks.editorProps?.workspaceFeaturesEnabled).toBe(false);
    expect(mocks.editorProps?.visibleToolbarActions).toContain('addMenu');
    await act(async () => mocks.editorProps?.onSkillsOpenChange?.(true));
    expect(mocks.editorProps?.skills).toEqual(skills);
    expect(mocks.editorProps?.fileReferenceActions).toBeDefined();
    expect(query).toHaveBeenCalledWith(
      { sessionId: 's1', directory: '.', query: '' },
      expect.objectContaining({ clientId: expect.any(String) }),
    );
  });

  it('keeps prepared upload path context in the durable Turn input without a text attachment', async () => {
    provider = {
      ...provider,
      workspaceFiles: {
        query: vi.fn(async () => ({
          scopeRevision: 'registered',
          directory: '.',
          entries: [],
          truncated: false,
          maxUploadBytes: 8 * 1024 * 1024,
        })),
        read: vi.fn(),
        upload: vi.fn(async (request, data) => ({
          scopeRevision: 'registered',
          uploadId: request.uploadId,
          path: request.path,
          sizeBytes: data.size,
          sha256: 'a'.repeat(64),
        })),
      },
    };
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: {
          canSend: true,
          canCancel: false,
          inputAttachments: true,
          workspaceTurns: true,
        },
        workspace: { workspaceId: 'ws', cwdRelative: '.' },
      }),
    );
    await render('s1');
    const target = mocks.editorProps!.fileUploadTarget!;
    const result = await target.client!.uploadWorkspaceFile({
      path: '报告.bin',
      data: new Blob(['binary']),
    });
    const tag = target.createReference(result.path);
    const text = tag.serialized!;
    await act(async () => {
      mocks.editorProps!.onSubmit(text, undefined, undefined, vi.fn(), {
        inputAnnotations: createInputAnnotationsFromComposerTags(text, [tag]),
      });
      await flush();
    });
    expect(mocks.client.submitPrompt).toHaveBeenCalledOnce();
    expect(mocks.client.submitPrompt.mock.calls[0][1]).toMatchObject({
      text,
      input: [
        {
          type: 'input_text',
          text: expect.stringContaining(
            'Uploaded Workspace files (paths relative to the working directory):',
          ),
        },
      ],
    });
    expect(provider.workspaceFiles!.read).not.toHaveBeenCalled();
  });

  it.each(['default', 'auto-edit', 'yolo'] as const)(
    'shows persisted policy as fixed even on an unbound Session (%s)',
    async (approvalMode) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', { approvalMode }),
      );
      await render('s1');
      expect(mocks.editorProps?.currentMode).toBe(approvalMode);
      expect(mocks.editorProps?.availableModes).toEqual([approvalMode]);
      expect(mocks.editorProps?.modeControlsDisabled).toBe(true);
      expect(mocks.editorProps?.onSelectMode).toBeUndefined();
      expect(mocks.editorProps?.visibleToolbarActions).toEqual([
        'approvalMode',
        'contextUsage',
      ]);
      expect(container.textContent).toContain(
        'This session does not support changing its approval policy',
      );
      await render('s1', 'en', provider, undefined, false);
      expect(mocks.editorProps?.visibleToolbarActions).toEqual([]);
    },
  );

  it('does not claim an approval policy when older Session metadata omits it', async () => {
    await render('s1');
    expect(mocks.editorProps?.currentMode).toBe('');
    expect(mocks.editorProps?.availableModes).toEqual([]);
    expect(mocks.editorProps?.visibleToolbarActions).toEqual(['contextUsage']);
    expect(container.textContent).not.toContain(
      'This session does not support changing its approval policy',
    );
  });

  it('retains attachment support while refreshing and applies an explicit revocation', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: {
          canSend: true,
          canCancel: false,
          inputAttachments: true,
        },
      }),
    );
    await render('s1');
    const composer = container.querySelector('form');
    expect(mocks.editorProps?.attachmentsEnabled).toBe(true);
    let resolveSummary!: (value: ManagedAgentSessionSummary) => void;
    mocks.client.getSession.mockImplementation(
      () => new Promise((resolve) => (resolveSummary = resolve)),
    );
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Refresh')!
        .click();
      await flush();
    });
    expect(container.querySelector('form')).toBe(composer);
    expect(mocks.editorProps?.attachmentsEnabled).toBe(true);
    await act(async () => {
      resolveSummary(summary('s1'));
      await flush();
    });
    expect(mocks.editorProps?.attachmentsEnabled).toBe(false);
  });

  it.each(['session', 'provider'] as const)(
    'does not carry attachment support into a different %s while loading',
    async (change) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          capabilities: {
            canSend: true,
            canCancel: false,
            inputAttachments: true,
          },
        }),
      );
      await render('s1');
      expect(mocks.editorProps?.attachmentsEnabled).toBe(true);
      mocks.client.getSession.mockImplementation(() => new Promise(() => {}));
      await render(
        change === 'session' ? 's2' : 's1',
        'en',
        change === 'provider'
          ? { ...provider, storageKey: 'other-provider' }
          : provider,
      );
      expect(mocks.editorProps?.attachmentsEnabled).toBe(false);
    },
  );

  it('shows the actual model and context in the fixed composer and retains them after refresh', async () => {
    const observation = {
      modelId: 'actual-old-revision',
      inputTokens: 250,
      contextWindowSize: 1000,
      observedAt: 12,
    };
    mocks.client.getSession.mockResolvedValue(
      summary('s1', { agentId: 'agent-a', modelContext: observation }),
    );
    await render('s1');
    expect(mocks.editorProps?.currentModel).toBe('actual-old-revision');
    expect(mocks.editorProps?.availableModels).toEqual([
      { id: 'actual-old-revision', label: 'actual-old-revision' },
    ]);
    expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
    expect(mocks.editorProps?.onSelectModel).toBeUndefined();
    expect(mocks.editorProps?.tokenCount).toBe(250);
    expect(mocks.editorProps?.contextWindow).toBe(1000);
    expect(mocks.editorProps?.contextUsageKnown).toBe(true);
    expect(mocks.editorProps?.contextUsageAlwaysVisible).toBe(true);
    expect(mocks.editorProps?.onOpenContextUsage).toBeUndefined();
    expect(mocks.editorProps?.contextUsageControls).toBeUndefined();
    expect(container.textContent).toContain('The model is fixed for this task');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render('s1');
    expect(mocks.editorProps?.currentModel).toBe('actual-old-revision');
    expect(mocks.editorProps?.tokenCount).toBe(250);
  });

  it('uses Agent identity without claiming the current preset label is an older Session model', async () => {
    provider.workspaceBinding = {
      agentId: 'agent-a',
      modelPresets: [{ agentId: 'agent-a', label: 'today-new-model' }],
      list: vi.fn(),
      get: vi.fn(),
      createEmpty: vi.fn(),
    };
    mocks.client.getSession.mockResolvedValue(
      summary('s1', { agentId: 'agent-a' }),
    );
    await render('s1');
    expect(mocks.editorProps?.currentModel).toBe('agent-a');
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    expect(mocks.editorProps?.tokenCount).toBe(0);
    expect(container.textContent).not.toContain('today-new-model');
  });

  function switchableSession(extra: Partial<ManagedAgentSessionSummary> = {}) {
    return summary('s1', {
      agentId: 'agent-a',
      workspace: {
        workspaceId: 'ws',
        cwdRelative: '.',
        contextRevision: 1,
        state: 'ready',
      },
      capabilities: {
        canSend: true,
        canCancel: false,
        workspaceTurns: true,
        modelChange: true,
      },
      modelContext: {
        modelId: 'A',
        inputTokens: 250,
        contextWindowSize: 1000,
        observedAt: 12,
      },
      ...extra,
    });
  }
  function modelApi(current: () => ManagedAgentSessionSummary) {
    provider.modelChange = {
      queryOptions: vi.fn(async () => ({
        supported: true,
        modelSelection: current().modelSelection ?? { revision: 0 },
        models: [
          { modelId: 'A', label: 'Published A' },
          { modelId: 'B', label: 'Published B' },
        ],
      })),
      submit: vi.fn(),
    };
    mocks.client.getSession.mockImplementation(async () => current());
  }

  it('compresses without a Turn, preserves the draft, and excludes same-frame composer and settings changes', async () => {
    let session = switchableSession({
      compactionRevision: 0,
      approvalMode: 'default',
      approvalRevision: 0,
      planModeSupported: true,
      capabilities: {
        canSend: true,
        canCancel: false,
        workspaceTurns: true,
        modelChange: true,
        approvalModeChange: true,
        contextCompression: true,
      },
    });
    modelApi(() => session);
    provider.approvalChange = {
      queryOptions: vi.fn(async () => ({
        supported: true,
        approvalMode: 'default',
        approvalRevision: 0,
        availableApprovalModes: ['default', 'yolo'],
        planModeSupported: true,
      })),
      submit: vi.fn(),
    };
    let finish!: (value: ManagedContextCompressionOperation) => void;
    provider.contextCompression = {
      submit: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      query: vi.fn(),
    };
    await render('s1');
    await input('Keep my draft');
    const before = mocks.editorProps!;
    expect(before.contextUsageControls?.canCompress).toBe(true);
    await act(async () => {
      void before.contextUsageControls!.compress();
      before.onSubmit('Keep my draft', undefined, undefined, vi.fn());
      before.onSelectModel!('B');
      before.onSelectMode!('yolo');
      before.onTogglePlan!();
      await flush();
    });
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    expect(provider.approvalChange.submit).not.toHaveBeenCalled();
    expect(mocks.editorProps?.disabled).toBe(true);
    expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
    expect(mocks.editorProps?.modeControlsDisabled).toBe(true);
    expect(mocks.editorProps?.planControlsDisabled).toBe(true);
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Change directory',
      ),
    ).toBeUndefined();
    session = { ...session, compactionRevision: 9, modelContext: undefined };
    await act(async () => {
      finish({
        sessionId: 's1',
        operationId: 'op',
        type: 'context_compression',
        status: 'completed',
        expectedCompactionRevision: 0,
        compactionRevision: 9,
        outcome: 'compressed',
        replayed: false,
      });
      await flush();
    });
    expect(mocks.editorProps?.contextUsageControls?.result).toEqual({
      kind: 'compressed',
    });
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    expect(mocks.editorProps?.tokenCount).toBe(0);
    expect(container.querySelector('textarea')?.value).toBe('Keep my draft');
    expect(mocks.commitAccepted).not.toHaveBeenCalled();
    expect(mocks.editorProps?.disabled).toBe(false);
  });

  it('does not race a model change that began in the same render frame', async () => {
    const session = switchableSession({
      capabilities: {
        canSend: true,
        canCancel: false,
        workspaceTurns: true,
        modelChange: true,
        contextCompression: true,
      },
    });
    modelApi(() => session);
    vi.mocked(provider.modelChange!.submit).mockImplementation(
      () => new Promise(() => {}),
    );
    provider.contextCompression = { submit: vi.fn(), query: vi.fn() };
    await render('s1');
    const before = mocks.editorProps!;
    await act(async () => {
      before.onSelectModel!('B');
      await before.contextUsageControls!.compress();
    });
    expect(provider.modelChange!.submit).toHaveBeenCalledOnce();
    expect(provider.contextCompression.submit).not.toHaveBeenCalled();
  });

  it('observes another tab compression and blocks sends before the first operation query returns', async () => {
    const session = switchableSession({
      compactionRevision: 0,
      contextCompressionOperationId: 'other-tab-op',
      capabilities: {
        canSend: true,
        canCancel: false,
        workspaceTurns: true,
        contextCompression: true,
      },
    });
    mocks.client.getSession.mockResolvedValue(session);
    provider.contextCompression = {
      submit: vi.fn(),
      query: vi.fn(() => new Promise(() => {})),
    };
    await render('s1');
    expect(provider.contextCompression.query).toHaveBeenCalledWith(
      's1',
      'other-tab-op',
      expect.anything(),
    );
    expect(mocks.editorProps?.disabled).toBe(true);
    await act(async () => {
      mocks.editorProps!.onSubmit('A prompt', undefined, undefined, vi.fn());
    });
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    expect(provider.contextCompression.submit).not.toHaveBeenCalled();
  });

  it('keeps one composer and its draft when permission rules rerender', async () => {
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id, {
        approvalMode: 'default',
        approvalRevision: 0,
        capabilities: {
          canSend: true,
          canCancel: false,
          approvalModeChange: true,
        },
      }),
    );
    provider.approvalChange = {
      queryOptions: vi.fn(async () => ({
        supported: true,
        approvalMode: 'default',
        approvalRevision: 0,
        availableApprovalModes: ['default'],
        permissionRulesSupported: true,
        permissionRules: { allow: ['Read'], ask: [], deny: [] },
      })),
      submit: vi.fn(),
    };

    await render('s1');
    const composer = container.querySelector('textarea');
    await input('Keep the permission draft');
    for (let i = 0; i < 3; i++) await render('s1');

    expect(
      container.querySelectorAll('[data-managed-composer-scope]'),
    ).toHaveLength(1);
    expect(container.querySelector('textarea')).toBe(composer);
    expect(composer?.value).toBe('Keep the permission draft');

    await render('s2');
    expect(
      container.querySelectorAll('[data-managed-composer-scope]'),
    ).toHaveLength(1);
    expect(container.querySelector('textarea')).not.toBe(composer);
  });

  it.each(['qwen-code', `agent_${'a'.repeat(32)}`])(
    'switches approval for %s after readback while preserving the draft and excluding same-frame send and model changes',
    async (agentId) => {
      let session = switchableSession({
        agentId,
        approvalMode: 'default',
        initialApprovalMode: 'default',
        approvalRevision: 0,
        capabilities: {
          canSend: true,
          canCancel: false,
          workspaceTurns: true,
          modelChange: true,
          approvalModeChange: true,
        },
      });
      modelApi(() => session);
      let acknowledge!: (value: {
        sessionId: string;
        approvalMode: 'yolo';
        approvalRevision: number;
        replayed: boolean;
      }) => void;
      provider.approvalChange = {
        queryOptions: vi.fn(async () => ({
          supported: true,
          approvalMode: session.approvalMode!,
          approvalRevision: session.approvalRevision!,
          availableApprovalModes: ['default', 'auto-edit', 'yolo'],
        })),
        submit: vi.fn(
          () =>
            new Promise((resolve) => {
              acknowledge = resolve;
            }),
        ),
      };
      await render('s1');
      await input('Keep the approval draft');
      expect(mocks.editorProps?.modeControlsDisabled).toBe(false);
      expect(mocks.editorProps?.availableModes).toEqual([
        'default',
        'auto-edit',
        'yolo',
      ]);
      const send = mocks.editorProps!.onSubmit;
      const model = mocks.editorProps!.onSelectModel!;
      await act(async () => {
        mocks.editorProps!.onSelectMode!('yolo');
        send('Keep the approval draft', undefined, undefined, vi.fn());
        model('B');
        await flush();
      });
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      expect(provider.modelChange!.submit).not.toHaveBeenCalled();
      expect(mocks.editorProps?.currentMode).toBe('default');
      expect(mocks.editorProps?.modeControlsDisabled).toBe(true);
      expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
      session = { ...session, approvalMode: 'yolo', approvalRevision: 1 };
      await act(async () => {
        acknowledge({
          sessionId: 's1',
          approvalMode: 'yolo',
          approvalRevision: 1,
          replayed: false,
        });
        await flush();
      });
      expect(mocks.editorProps?.currentMode).toBe('yolo');
      expect(mocks.editorProps?.modeControlsDisabled).toBe(false);
      expect(container.querySelector('textarea')?.value).toBe(
        'Keep the approval draft',
      );
      expect(mocks.commitAccepted).not.toHaveBeenCalled();
    },
  );

  it('changes approval during a live Turn without enabling Plan or changing the draft', async () => {
    let session = switchableSession({
      approvalMode: 'default',
      approvalRevision: 0,
      phase: 'agent_running',
      planModeSupported: true,
      capabilities: {
        canSend: true,
        canCancel: true,
        workspaceTurns: true,
        approvalModeChange: true,
      },
    });
    mocks.client.getSession.mockImplementation(async () => session);
    provider.approvalChange = {
      queryOptions: vi.fn(async () => ({
        supported: true,
        liveSupported: true,
        approvalMode: session.approvalMode!,
        approvalRevision: session.approvalRevision!,
        availableApprovalModes: ['default', 'auto-edit', 'yolo'],
        planModeSupported: true,
      })),
      submit: vi.fn(async () => {
        session = { ...session, approvalMode: 'yolo', approvalRevision: 1 };
        return {
          sessionId: 's1',
          approvalMode: 'yolo',
          approvalRevision: 1,
          replayed: false,
        };
      }),
    };
    await render('s1');
    await input('Keep my next message');
    expect(mocks.editorProps?.modeControlsDisabled).toBe(false);
    expect(mocks.editorProps?.planControlsDisabled).toBe(true);
    await act(async () => {
      mocks.editorProps!.onTogglePlan!();
    });
    expect(provider.approvalChange.submit).not.toHaveBeenCalled();
    await act(async () => {
      mocks.editorProps!.onSelectMode!('yolo');
      await flush();
    });
    expect(provider.approvalChange.submit).toHaveBeenCalledOnce();
    expect(mocks.editorProps?.currentMode).toBe('yolo');
    expect(container.querySelector('textarea')?.value).toBe(
      'Keep my next message',
    );
    expect(container.textContent).not.toContain(
      'subsequent tool calls in this turn',
    );
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it.each(['agent_running', 'cancelling'] as const)(
    'refuses approval callbacks during a %s Turn',
    async (phase) => {
      const session = switchableSession({
        approvalMode: 'default',
        approvalRevision: 0,
        phase,
        capabilities: {
          canSend: true,
          canCancel: true,
          workspaceTurns: true,
          approvalModeChange: true,
        },
      });
      mocks.client.getSession.mockResolvedValue(session);
      provider.approvalChange = {
        queryOptions: vi.fn().mockResolvedValue({
          supported: true,
          approvalMode: 'default',
          approvalRevision: 0,
          availableApprovalModes: ['default', 'auto-edit', 'yolo'],
        }),
        submit: vi.fn(),
      };
      await render('s1');
      expect(mocks.editorProps?.modeControlsDisabled).toBe(true);
      await act(async () => {
        mocks.editorProps!.onSelectMode!('yolo');
      });
      expect(provider.approvalChange.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    JSON.stringify({ storage: 'indexeddb', pendingId: 'missing' }),
    '{',
  ])(
    'requires explicit discard before sending after a pending record cannot be restored (%s)',
    async (stored) => {
      const key = `qwen-managed-pending:${provider.storageKey}:${getManagedClientId(provider.storageKey)}`;
      sessionStorage.setItem(key, stored);
      await render('s1');
      expect(container.textContent).toContain(
        'may already have been submitted',
      );
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      vi.spyOn(pendingStorage, 'saveManagedPending').mockResolvedValueOnce(
        false,
      );
      await act(async () => {
        const discard = [...container.querySelectorAll('button')].find(
          (item) => item.textContent === 'Discard this request',
        );
        discard!.click();
        await flush();
      });
      expect(container.textContent).toContain(
        'Could not discard this request.',
      );
      expect(sessionStorage.getItem(key)).toBe(stored);
      await act(async () => {
        mocks.editorProps!.onSubmit(
          'blocked request',
          undefined,
          undefined,
          vi.fn(),
        );
        await flush();
      });
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      await act(async () => {
        const discard = [...container.querySelectorAll('button')].find(
          (item) => item.textContent === 'Discard this request',
        );
        discard!.click();
        await flush();
      });
      expect(sessionStorage.getItem(key)).toBeNull();
      expect(container.textContent).not.toContain(
        'Could not discard this request.',
      );
      expect(container.textContent).not.toContain(
        'may already have been submitted',
      );
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      await act(async () => {
        mocks.editorProps!.onSubmit(
          'new explicit request',
          undefined,
          undefined,
          vi.fn(),
        );
        await flush();
      });
      expect(mocks.client.submitPrompt).toHaveBeenCalledOnce();
    },
  );

  it('keeps submissions serialized while the frozen request is being persisted', async () => {
    await render('s1');
    let acknowledge!: (saved: boolean) => void;
    const save = vi
      .spyOn(pendingStorage, 'saveManagedPending')
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            acknowledge = resolve;
          }),
      );
    const send = mocks.editorProps!.onSubmit;
    await act(async () => {
      send('first draft', undefined, undefined, vi.fn());
      await flush();
      send('second draft', undefined, undefined, vi.fn());
      await flush();
    });
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    await act(async () => {
      acknowledge(true);
      await flush();
    });
    expect(mocks.client.submitPrompt).toHaveBeenCalledOnce();
    expect(mocks.client.submitPrompt.mock.calls[0]?.[1]).toMatchObject({
      text: 'first draft',
    });
    save.mockRestore();
  });

  it('switches only after admission and readback, preserves the draft and blocks a same-frame send', async () => {
    let session = switchableSession();
    modelApi(() => session);
    let acknowledge!: (value: {
      sessionId: string;
      modelSelection: { modelId: string; revision: number };
      replayed: boolean;
    }) => void;
    vi.mocked(provider.modelChange!.submit).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    await render('s1');
    await input('Keep my draft');
    expect(mocks.editorProps?.modelControlsDisabled).toBe(false);
    expect(mocks.editorProps?.availableModels).toEqual([
      { id: 'A', label: 'Published A' },
      { id: 'B', label: 'Published B' },
    ]);
    const submit = mocks.editorProps!.onSubmit;
    await act(async () => {
      mocks.editorProps!.onSelectModel!('B');
      submit('Keep my draft', undefined, undefined, vi.fn());
      await flush();
    });
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.editorProps?.currentModel).toBe('A');
    expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
    session = {
      ...session,
      modelSelection: { modelId: 'B', revision: 1 },
      modelContext: undefined,
    };
    await act(async () => {
      acknowledge({
        sessionId: 's1',
        modelSelection: { modelId: 'B', revision: 1 },
        replayed: false,
      });
      await flush();
    });
    expect(mocks.editorProps?.currentModel).toBe('B');
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    expect(mocks.editorProps?.contextWindow).toBe(0);
    expect(container.querySelector('textarea')?.value).toBe('Keep my draft');
    expect(mocks.commitAccepted).not.toHaveBeenCalled();
    expect(mocks.editorProps?.modelControlsDisabled).toBe(false);
  });

  it.each(['agent_running', 'cancelling'] as const)(
    'locks model selection during a %s Turn including callback races',
    async (phase) => {
      const session = switchableSession({
        phase,
        capabilities: {
          canSend: false,
          canCancel: true,
          workspaceTurns: true,
          modelChange: true,
        },
      });
      modelApi(() => session);
      await render('s1');
      expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
      await act(async () => {
        mocks.editorProps?.onSelectModel?.('B');
      });
      expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    },
  );

  it('blocks a model change when a prompt is admitted in the same frame', async () => {
    const session = switchableSession();
    modelApi(() => session);
    let admit!: (value: { sessionId: string; turnId: string }) => void;
    mocks.client.submitPrompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
    );
    await render('s1');
    await act(async () => {
      mocks.editorProps!.onSubmit(
        'Current draft',
        undefined,
        undefined,
        vi.fn(),
      );
      mocks.editorProps!.onSelectModel!('B');
      await flush();
    });
    expect(mocks.client.submitPrompt).toHaveBeenCalledOnce();
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
    await act(async () => {
      admit({ sessionId: 's1', turnId: 'next' });
      await flush();
    });
  });

  it('locks model selection while an approval or prompt admission is unconfirmed', async () => {
    const session = switchableSession();
    modelApi(() => session);
    provider.actions = {
      listPending: vi.fn().mockResolvedValue([pendingAction]),
      respond: vi.fn(),
    };
    mocks.client.getSession.mockResolvedValue({
      ...session,
      capabilities: { ...session.capabilities, actions: true },
    });
    await render('s1');
    expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
    await act(async () => {
      mocks.editorProps?.onSelectModel?.('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
  });

  it('holds a lost switch response for exact-key confirmation and hides old usage under another selected model', async () => {
    let session = switchableSession({
      modelSelection: { modelId: 'B', revision: 1 },
    });
    modelApi(() => session);
    vi.mocked(provider.modelChange!.submit)
      .mockRejectedValueOnce(new TypeError('lost ACK'))
      .mockImplementation(async () => {
        session = {
          ...session,
          modelSelection: { modelId: 'A', revision: 2 },
          modelContext: undefined,
        };
        return {
          sessionId: 's1',
          modelSelection: session.modelSelection!,
          replayed: true,
        };
      });
    await render('s1');
    expect(mocks.editorProps?.currentModel).toBe('B');
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    await act(async () => {
      mocks.editorProps?.onSelectModel?.('A');
      await flush();
    });
    expect(container.textContent).toContain(
      'The model change is not confirmed',
    );
    expect(mocks.editorProps?.disabled).toBe(true);
    session = {
      ...session,
      capabilities: { ...session.capabilities, modelChange: false },
    };
    await act(async () => root.unmount());
    root = createRoot(container);
    await render('s1');
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continue confirming',
    )!;
    await act(async () => {
      confirm.click();
      await flush();
    });
    const calls = vi.mocked(provider.modelChange!.submit).mock.calls;
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[1][2].idempotencyKey).toBe(calls[0][2].idempotencyKey);
    expect(mocks.editorProps?.currentModel).toBe('A');
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    expect(mocks.editorProps?.disabled).toBe(false);
  });

  it('never exposes server model choices or mutates an existing Session while Managed is hidden', async () => {
    const session = switchableSession();
    modelApi(() => session);
    await render('s1', 'en', provider, undefined, false);
    expect(provider.modelChange!.queryOptions).not.toHaveBeenCalled();
    expect(mocks.editorProps?.visibleToolbarActions).toEqual([]);
    expect(mocks.editorProps?.modelControlsDisabled).toBe(true);
    await act(async () => {
      mocks.editorProps?.onSelectModel?.('B');
    });
    expect(provider.modelChange!.submit).not.toHaveBeenCalled();
  });

  it('keeps observed zero distinct from unknown and never carries an observation into another Session', async () => {
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id, {
        agentId: `agent-${id}`,
        ...(id === 's1'
          ? {
              modelContext: {
                modelId: 'first-model',
                inputTokens: 0,
                contextWindowSize: 1000,
                observedAt: 12,
              },
            }
          : {}),
      }),
    );
    await render('s1');
    expect(mocks.editorProps?.contextUsageKnown).toBe(true);
    expect(mocks.editorProps?.tokenCount).toBe(0);
    await render('s2');
    expect(mocks.editorProps?.currentModel).toBe('agent-s2');
    expect(mocks.editorProps?.contextUsageKnown).toBe(false);
    expect(mocks.editorProps?.contextWindow).toBe(0);
    await render('s2', 'en', provider, undefined, false);
    expect(mocks.editorProps?.visibleToolbarActions).toEqual([]);
  });

  it('moves history into the shell slot without remounting conversation or losing its draft when the slot disappears', async () => {
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    try {
      await render('s1', 'en', provider, slot);
      expect(
        slot.querySelector('nav[aria-label="Managed sessions"]'),
      ).not.toBeNull();
      expect(container.querySelector('nav')).toBeNull();
      expect(container.textContent).not.toContain('New managed task');
      expect(container.textContent).toContain('Persisted answer');
      const input = container.querySelector('textarea')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setter.call(input, 'Managed draft');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await render('s1', 'en', provider, null, false);
      expect(input.disabled).toBe(true);
      expect(input.value).toBe('Managed draft');
      await render('s1', 'en', provider, slot);
      expect(input.disabled).toBe(false);
      expect(container.querySelector('textarea')).toBe(input);
      expect(input.value).toBe('Managed draft');
      expect(mocks.client.listSessions).toHaveBeenCalledTimes(1);
      expect(mocks.client.getTranscript).toHaveBeenCalledTimes(1);
      expect(slot.textContent).toContain('Task s1');
    } finally {
      slot.remove();
    }
  });

  it('shows shared workspace history while Local is active and keeps workspace and session pagination separate', async () => {
    const first = summary('s1', {
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    });
    const second = summary('s2', {
      workspace: { workspaceId: 'ws-b', cwdRelative: '.' },
    });
    mocks.client.getSession.mockResolvedValue(first);
    mocks.client.listSessions
      .mockResolvedValueOnce({ sessions: [first], nextCursor: 'sessions-next' })
      .mockResolvedValueOnce({ sessions: [second] });
    const listWorkspaces = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            workspaceId: 'ws-a',
            displayName: 'Project A',
            state: 'active',
            canCreateSession: true,
          },
        ],
        nextCursor: 'workspaces-next',
        supported: true,
      })
      .mockResolvedValue({
        data: [
          {
            workspaceId: 'ws-b',
            displayName: 'Project B',
            state: 'active',
            canCreateSession: true,
          },
        ],
        supported: true,
      });
    provider.workspaceBinding = {
      agentId: 'agent',
      list: listWorkspaces,
      get: vi.fn(),
      createEmpty: vi.fn(),
    };
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    const selectWorkspace = vi.fn();
    const reportWorkspace = vi.fn();
    const openSession = vi.fn();
    try {
      await render('s1', 'en', provider, slot, false, {
        navigationActive: false,
        onSelectWorkspace: selectWorkspace,
        onSessionWorkspaceChange: reportWorkspace,
        onOpenSession: openSession,
      });
      expect(slot.querySelector('[aria-current]')).toBeNull();
      expect(reportWorkspace).toHaveBeenCalledWith('ws-a');
      expect(mocks.client.listSessions).toHaveBeenCalledOnce();
      await act(async () =>
        slot
          .querySelector<HTMLButtonElement>(
            '[aria-label="Load more Workspace"]',
          )!
          .click(),
      );
      expect(listWorkspaces).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'workspaces-next' }),
      );
      expect(mocks.client.listSessions).toHaveBeenCalledOnce();
      await act(async () =>
        slot
          .querySelector<HTMLButtonElement>(
            '[aria-label="New session: Project B"]',
          )!
          .click(),
      );
      expect(selectWorkspace).toHaveBeenCalledWith('ws-b');
      await act(async () =>
        slot
          .querySelector<HTMLButtonElement>(
            '[aria-label="Load more Managed sessions"]',
          )!
          .click(),
      );
      expect(mocks.client.listSessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'sessions-next' }),
      );
      await act(async () =>
        slot
          .querySelector<HTMLElement>('[data-managed-session-id="s2"]')!
          .click(),
      );
      expect(openSession).toHaveBeenCalledWith('s2', 'ws-b');
      expect(onSelect).not.toHaveBeenCalled();
      await render('s1', 'en', provider, slot, false, {
        navigationActive: false,
        navigationSearch: 's2',
      });
      expect(slot.querySelector('[data-managed-workspace="ws-a"]')).toBeNull();
      expect(
        slot.querySelector('[data-managed-workspace="ws-b"]')?.textContent,
      ).toContain('Task s2');
      expect(mocks.client.listSessions).toHaveBeenCalledTimes(2);
    } finally {
      slot.remove();
    }
  });

  it.each([
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)(
    'retains selected status after switching and clears a background %s task without losing paged rows',
    async (phase, statusLabel) => {
      vi.useFakeTimers();
      const bound = { workspaceId: 'ws-a', cwdRelative: '.' };
      let first = summary('s1', { phase: 'tool_running', workspace: bound });
      const second = summary('s2', { workspace: bound });
      const paged = summary('s3', { workspace: bound });
      mocks.client.getSession.mockImplementation(async (id: string) =>
        id === 's1' ? first : second,
      );
      mocks.client.listSessions
        .mockResolvedValueOnce({
          sessions: [{ ...first, phase: 'admitted', updatedAt: 19 }, second],
          nextCursor: 'next',
        })
        .mockResolvedValue({ sessions: [paged] });
      provider.workspaceBinding = {
        agentId: 'agent',
        list: vi.fn().mockResolvedValue({
          data: [
            {
              workspaceId: 'ws-a',
              displayName: 'Project',
              state: 'active',
              canCreateSession: true,
            },
          ],
          supported: true,
        }),
        get: vi.fn(),
        createEmpty: vi.fn(),
      };
      const slot = document.createElement('aside');
      document.body.appendChild(slot);
      const row = (id: string) =>
        slot.querySelector(`[data-managed-session-id="${id}"]`)!;
      try {
        await render('s1', 'en', provider, slot);
        await act(async () => {
          row('s1').dispatchEvent(new Event('pointerover', { bubbles: true }));
          await vi.advanceTimersByTimeAsync(300);
        });
        const details = () =>
          document.querySelector('[data-web-shell-session-details-content]')!;
        expect(details().textContent).toContain('Executing tool');
        await render('s2', 'en', provider, slot);
        expect(details().textContent).toContain('Executing tool');
        expect(
          row('s1').querySelector('[data-web-shell-session-running]'),
        ).not.toBeNull();
        await act(async () =>
          slot
            .querySelector<HTMLButtonElement>(
              '[aria-label="Load more Managed sessions"]',
            )!
            .click(),
        );
        first = { ...first, phase, updatedAt: 30 };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
          await flush();
        });
        expect(
          row('s1').querySelector('[data-web-shell-session-running]'),
        ).toBeNull();
        expect(details().textContent).toContain(statusLabel);
        expect(row('s3')).not.toBeNull();
        expect(mocks.client.listSessions).toHaveBeenCalledTimes(2);
        const firstReads = mocks.client.getSession.mock.calls.filter(
          ([id]) => id === 's1',
        ).length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
          await flush();
        });
        expect(
          mocks.client.getSession.mock.calls.filter(([id]) => id === 's1'),
        ).toHaveLength(firstReads);
        expect(
          mocks.client.getSession.mock.calls.some(([id]) => id === 's3'),
        ).toBe(false);
      } finally {
        slot.remove();
      }
    },
  );

  it('discards an old background read when that session becomes selected', async () => {
    vi.useFakeTimers();
    const active = summary('s1', { phase: 'agent_running' });
    const complete = { ...active, phase: 'completed' as const, updatedAt: 30 };
    mocks.client.listSessions.mockResolvedValue({
      sessions: [active, summary('s2')],
    });
    let resolve!: (value: ManagedAgentSessionSummary) => void;
    let oldSignal: AbortSignal | undefined;
    mocks.client.getSession.mockImplementation(
      (id: string, options: { signal: AbortSignal }) => {
        if (id === 's1') {
          oldSignal = options.signal;
          return new Promise((done) => {
            resolve = done;
          });
        }
        return Promise.resolve(summary(id));
      },
    );
    await render('s2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(oldSignal?.aborted).toBe(false);
    mocks.client.getSession.mockImplementation(async (id: string) =>
      id === 's1' ? complete : summary(id),
    );
    await render('s1');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      resolve(active);
      await flush();
    });
    const nav = container.querySelector('nav')!;
    expect(nav.textContent).toContain('Task s1Completed');
    expect(nav.textContent).not.toContain('Thinking / responding');
  });

  it.each([19, 20])(
    'keeps a confirmed background phase when a late catalog has timestamp %s',
    async (updatedAt) => {
      vi.useFakeTimers();
      const bound = { workspaceId: 'ws-a', cwdRelative: '.' };
      let first = summary('s1', { phase: 'agent_running', workspace: bound });
      const second = summary('s2', { workspace: bound });
      let resolveList!: (value: {
        sessions: ManagedAgentSessionSummary[];
        nextCursor?: string;
      }) => void;
      mocks.client.listSessions
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveList = resolve;
            }),
        )
        .mockResolvedValue({
          sessions: [{ ...first, phase: 'created', updatedAt }],
        });
      mocks.client.getSession.mockImplementation(async (id: string) =>
        id === 's1' ? first : second,
      );
      provider.workspaceBinding = {
        agentId: 'agent',
        list: vi.fn().mockResolvedValue({
          data: [
            {
              workspaceId: 'ws-a',
              displayName: 'Project',
              state: 'active',
              canCreateSession: true,
            },
          ],
          supported: true,
        }),
        get: vi.fn(),
        createEmpty: vi.fn(),
      };
      const slot = document.createElement('aside');
      document.body.appendChild(slot);
      const row = () => slot.querySelector('[data-managed-session-id="s1"]')!;
      try {
        await render('s1', 'en', provider, slot);
        expect(
          row().querySelector('[data-web-shell-session-running]'),
        ).not.toBeNull();
        await render('s2', 'en', provider, slot);
        await act(async () => {
          resolveList({
            sessions: [{ ...first, phase: 'created', updatedAt }, second],
            nextCursor: 'older',
          });
          await flush();
        });
        expect(
          row().querySelector('[data-web-shell-session-running]'),
        ).not.toBeNull();
        await act(async () =>
          slot
            .querySelector<HTMLButtonElement>(
              '[aria-label="Load more Managed sessions"]',
            )!
            .click(),
        );
        expect(
          row().querySelector('[data-web-shell-session-running]'),
        ).not.toBeNull();
        first = { ...first, phase: 'completed', updatedAt: 30 };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
          await flush();
        });
        expect(
          row().querySelector('[data-web-shell-session-running]'),
        ).toBeNull();
      } finally {
        slot.remove();
      }
    },
  );

  it.each([false, true])(
    'keeps hidden flat navigation separate from results with a dedicated open callback (%s)',
    async (dedicatedOpen) => {
      const slot = document.createElement('aside');
      document.body.appendChild(slot);
      const openSession = vi.fn();
      try {
        await render('s1', 'en', provider, slot, false, {
          navigationActive: false,
          onOpenSession: dedicatedOpen ? openSession : undefined,
        });
        expect(slot.querySelector('[aria-current]')).toBeNull();
        await act(async () =>
          slot
            .querySelector<HTMLElement>('[data-managed-session-id="s1"]')!
            .click(),
        );
        expect(
          dedicatedOpen ? openSession : onSelect,
        ).toHaveBeenCalledExactlyOnceWith('s1');
        expect(dedicatedOpen ? onSelect : openSession).not.toHaveBeenCalled();
        expect(mocks.client.listSessions).toHaveBeenCalledOnce();
      } finally {
        slot.remove();
      }
    },
  );

  it('refreshes shared workspace navigation after an empty workspace is created without creating a session', async () => {
    const original = {
      workspaceId: 'ws-a',
      displayName: 'Project A',
      state: 'active',
      canCreateSession: true,
    };
    const created = {
      ...original,
      workspaceId: 'ws-new',
      displayName: 'New project',
    };
    const workspaces = [original];
    const listWorkspaces = vi.fn(async () => ({
      data: [...workspaces],
      defaultWorkspace: original,
      supported: true,
      canCreateWorkspace: true,
    }));
    const createWorkspace = vi.fn(async () => {
      workspaces.push(created);
      return created;
    });
    provider.workspaceBinding = {
      agentId: 'agent',
      list: listWorkspaces,
      get: vi.fn(),
      createEmpty: vi.fn(),
      createWorkspace,
    };
    mocks.client.listSessions.mockResolvedValue({ sessions: [] });
    const slot = document.createElement('aside');
    document.body.appendChild(slot);
    const selectWorkspace = vi.fn();
    const reportWorkspace = vi.fn();
    const openSession = vi.fn();
    try {
      await render(undefined, 'en', provider, slot, true, {
        onSelectWorkspace: selectWorkspace,
        onSessionWorkspaceChange: reportWorkspace,
        onOpenSession: openSession,
      });
      expect(
        slot.querySelector('[data-managed-workspace="ws-new"]'),
      ).toBeNull();
      await act(async () =>
        [...container.querySelectorAll('button')]
          .find((item) => item.textContent === 'New workspace')!
          .click(),
      );
      await act(async () => {
        const input = document.querySelector<HTMLInputElement>(
          '#managed-new-workspace-name',
        )!;
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, 'New project');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () =>
        [...document.querySelectorAll('button')]
          .find((item) => item.textContent === 'Create workspace')!
          .click(),
      );
      expect(createWorkspace).toHaveBeenCalledOnce();
      expect(
        slot.querySelector('[data-managed-workspace="ws-new"]')?.textContent,
      ).toContain('New project');
      expect(provider.workspaceBinding.createEmpty).not.toHaveBeenCalled();
      expect(mocks.client.createSession).not.toHaveBeenCalled();
      expect(mocks.client.listSessions).toHaveBeenCalledOnce();
      expect(reportWorkspace).toHaveBeenCalledWith('ws-new');
      expect(selectWorkspace).not.toHaveBeenCalled();
      expect(openSession).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      slot.remove();
    }
  });

  it.each(['create', 'submit', 'workspace-create'] as const)(
    'records a background %s result without issuing a user navigation callback',
    async (operation) => {
      let complete!: (result: { sessionId: string; turnId: string }) => void;
      const accepted = new Promise<{ sessionId: string; turnId: string }>(
        (resolve) => {
          complete = resolve;
        },
      );
      const initialSession = operation === 'submit' ? 's1' : undefined;
      const createdSession = initialSession ?? 'created';
      const openSession = vi.fn();
      if (operation === 'workspace-create') {
        const workspace = {
          workspaceId: 'ws-a',
          displayName: 'A',
          state: 'active',
          canCreateSession: true,
        };
        provider.workspaceBinding = {
          agentId: 'agent',
          list: vi.fn().mockResolvedValue({
            data: [workspace],
            defaultWorkspace: workspace,
            supported: true,
          }),
          get: vi.fn().mockResolvedValue(workspace),
          createEmpty: vi.fn(),
          createSession: vi.fn().mockReturnValue(accepted),
        };
        mocks.client.getSession.mockImplementation(async (id: string) =>
          summary(id, {
            agentId: 'agent',
            workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
          }),
        );
      } else {
        (operation === 'submit'
          ? mocks.client.submitPrompt
          : mocks.client.createSession
        ).mockReturnValueOnce(accepted);
      }
      await render(initialSession, 'en', provider, undefined, true, {
        onOpenSession: openSession,
      });
      await input('Complete in the background');
      await click('Send');
      await render(initialSession, 'en', provider, undefined, false, {
        onOpenSession: openSession,
      });
      await act(async () => {
        complete({ sessionId: createdSession, turnId: 'next-turn' });
        await flush();
      });
      if (operation === 'workspace-create')
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(
          createdSession,
          'ws-a',
        );
      else expect(onSelect).toHaveBeenCalledExactlyOnceWith(createdSession);
      expect(openSession).not.toHaveBeenCalled();
    },
  );

  it.each(['agent_running', 'failed'] as const)(
    'uses the standard composer stop action with Managed cancel authority in phase %s',
    async (phase) => {
      mocks.client.getSession.mockImplementation(async () =>
        summary('s1', {
          phase,
          capabilities: { canSend: false, canCancel: true },
        }),
      );
      await render('s1', 'en', provider, null);
      const stop = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Stop managed task',
      );
      expect(stop?.disabled).toBe(false);
      await act(async () => {
        stop!.click();
        await flush();
      });
      expect(mocks.client.cancel).toHaveBeenCalledWith(
        's1',
        'p1',
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    },
  );

  it('handles Escape only for the visible Managed conversation after composition and other controls', async () => {
    mocks.client.getSession.mockImplementation(async () =>
      summary('s1', {
        phase: 'agent_running',
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    await render('s1', 'en', provider, null);
    const input = container.querySelector('textarea')!;
    const escape = async (
      options: KeyboardEventInit = {},
      target: HTMLElement = input,
    ) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
        await flush();
      });
    await escape({ isComposing: true });
    expect(mocks.client.cancel).not.toHaveBeenCalled();
    await render('s1', 'en', provider, null, false);
    await escape({}, document.body);
    expect(mocks.client.cancel).not.toHaveBeenCalled();
    await render('s1', 'en', provider, null);
    await escape({}, document.body);
    expect(mocks.client.cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'reads child approvals with the panel closed and preserves the parent draft with lifecycle support %s',
    async (lifecycleEnabled) => {
      const childId = 'child-1';
      const childTask: ManagedTask = {
        ...task,
        childSessionId: childId,
        approvalMode: 'default',
      };
      mocks.client.getSession.mockImplementation(async (id: string) =>
        summary(id, {
          capabilities:
            id === 's1'
              ? {
                  canSend: true,
                  canCancel: false,
                  tasks: true,
                  actions: true,
                  childAgents: true,
                  ...(lifecycleEnabled ? { sessionClose: true } : {}),
                }
              : { canSend: false, canCancel: false },
        }),
      );
      mocks.client.getTranscript.mockImplementation(async (id: string) => ({
        events: [
          {
            ...event(1, id === childId ? 'Child result' : 'Parent answer'),
            sessionId: id,
          },
          { ...event(2, ''), sessionId: id, type: 'completed' },
        ],
        lastEventId: 2,
      }));
      const childAction = { ...pendingAction, sessionId: childId };
      const listPending = vi.fn().mockResolvedValue([childAction]);
      const respond = vi.fn().mockResolvedValue(undefined);
      const lifecycle = {
        submit: vi.fn(),
        unarchive: vi.fn(),
        query: vi.fn(),
      };
      provider = {
        ...provider,
        ...(lifecycleEnabled ? { lifecycle } : {}),
        actions: { listPending, respond },
        tasks: {
          list: vi.fn().mockResolvedValue({
            data: [childTask],
            hasMore: false,
            activeChildCount: 1,
          }),
          get: vi.fn().mockResolvedValue(childTask),
          listEvents: vi.fn().mockResolvedValue({ data: [], hasMore: false }),
        },
      };
      await render('s1');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(listPending).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ includeChildren: true }),
      );
      expect(container.textContent).toContain('Child Agent approval');
      const composer = container.querySelector('textarea')!;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      await act(async () => {
        setter.call(composer, 'Keep the parent draft');
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const click = async (text: string) =>
        act(async () => {
          [...document.querySelectorAll('button')]
            .find((button) => button.textContent === text)!
            .click();
          await flush();
        });
      await click('Session tasks');
      await click('Child Agent · 01234567');
      await click('View child Session');
      expect(mocks.client.getTranscript).toHaveBeenCalledWith(
        childId,
        expect.anything(),
      );
      const childDialog = [
        ...document.querySelectorAll('[role="dialog"]'),
      ].find((dialog) =>
        dialog.textContent?.includes('Back to parent Session'),
      )!;
      expect(childDialog.textContent).toContain('Child result');
      expect(childDialog.querySelector('textarea')).toBeNull();
      expect(container.querySelector('textarea')).toBe(composer);
      await click('Back to parent Session');
      await click('Close tasks');
      expect(container.querySelector('textarea')).toBe(composer);
      expect(composer.value).toBe('Keep the parent draft');
      expect(container.textContent).toContain('Parent answer');
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      expect(lifecycle.submit).not.toHaveBeenCalled();
    },
  );

  it('opens child tasks without losing drafts or history and leaves sending available during uncertain cancellation', async () => {
    mocks.client.getSession.mockImplementation(async () =>
      summary('s1', {
        capabilities: { canSend: true, canCancel: false, tasks: true },
      }),
    );
    provider = {
      ...provider,
      tasks: {
        list: vi.fn().mockResolvedValue({ data: [task], hasMore: false }),
        get: vi.fn().mockResolvedValue(task),
        listEvents: vi
          .fn()
          .mockResolvedValue({ data: [], hasMore: false, nextCursor: 'floor' }),
        cancel: {
          submit: vi.fn().mockRejectedValue(new TypeError('lost response')),
          query: vi.fn(),
        },
      },
    };
    await render('s1');
    const composer = container.querySelector('textarea')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      valueSetter.call(composer, 'draft remains');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const transcriptReads = mocks.client.getTranscript.mock.calls.length;
    const click = async (text: string) =>
      act(async () => {
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent === text)!
          .click();
      });
    await click('Session tasks');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render('s1', 'en', provider, undefined, false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(composer.value).toBe('draft remains');
    await render('s1');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click('Request cancellation');
    await click('Confirm cancellation');
    expect(document.body.textContent).toContain(
      'Cancellation result is unconfirmed.',
    );
    await click('Close tasks');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(composer.value).toBe('draft remains');
    expect(composer.disabled).toBe(false);
    const send = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Send',
    )!;
    expect(send.disabled).toBe(false);
    expect(container.textContent).toContain('Persisted answer');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(transcriptReads);
    expect(container.textContent).toContain(
      'Cancellation result is unconfirmed.',
    );
    expect(document.activeElement?.textContent).toBe('Session tasks');
  });

  it.each([false, true])(
    'publishes cancellation settlement before delayed panel refreshes (detail=%s)',
    async (detail) => {
      mocks.client.getSession.mockImplementation(async () =>
        summary('s1', {
          capabilities: { canSend: true, canCancel: false, tasks: true },
        }),
      );
      const settled: ManagedTask = {
        ...task,
        state: 'cancelled',
        settledAt: 5,
        actionCapabilities: [],
      };
      let slow = false;
      let release!: (value: { data: ManagedTask[]; hasMore: boolean }) => void;
      provider = {
        ...provider,
        tasks: {
          list: vi.fn().mockImplementation(() =>
            slow
              ? new Promise((resolve) => {
                  release = resolve;
                })
              : Promise.resolve({ data: [task], hasMore: false }),
          ),
          get: vi.fn().mockImplementation(async () => (slow ? settled : task)),
          listEvents: vi.fn().mockResolvedValue({
            data: [],
            hasMore: false,
            nextCursor: 'floor',
          }),
          cancel: {
            submit: vi.fn().mockResolvedValue(taskOperation),
            query: vi.fn(),
          },
        },
      };
      await render('s1');
      const click = async (text: string) =>
        act(async () => {
          [...document.querySelectorAll('button')]
            .find((button) => button.textContent === text)!
            .click();
          await flush();
        });
      await click('Session tasks');
      if (detail) {
        await click('Child Agent · 01234567');
        expect(document.body.textContent).toContain('Back to tasks');
      }
      await click('Request cancellation');
      slow = true;
      await click('Confirm cancellation');
      expect(document.body.textContent).toContain('Cancelled');
      expect(
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Request cancellation',
        ),
      ).toBe(false);
      expect(provider.tasks!.cancel!.submit).toHaveBeenCalledOnce();
      expect(document.body.textContent).not.toContain(
        'Cancellation request failed.',
      );
      // A delayed stale page must not restore the old action either.
      await act(async () => {
        release({ data: [task], hasMore: false });
        await flush();
      });
      if (detail) await click('Back to tasks');
      expect(document.body.textContent).toContain('Cancelled');
      expect(
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent === 'Request cancellation',
        ),
      ).toBe(false);
    },
  );

  it('does not query tasks or show an entry when the server lacks its capability', async () => {
    provider = {
      ...provider,
      tasks: { list: vi.fn(), get: vi.fn(), listEvents: vi.fn() },
    };
    await render('s1');
    expect(container.textContent).not.toContain('Session tasks');
    expect(container.textContent).not.toContain('Resume task cancellation');
    expect(provider.tasks!.list).not.toHaveBeenCalled();
  });

  it('resumes known task cancellation even when the task capability is no longer true', async () => {
    sessionStorage.setItem(
      `qwen-managed-task-cancel:${JSON.stringify([provider.storageKey, 's1'])}`,
      JSON.stringify({
        [task.taskId]: {
          sessionId: 's1',
          taskId: task.taskId,
          idempotencyKey: 'original',
          operationId: taskOperation.operationId,
        },
      }),
    );
    provider = {
      ...provider,
      tasks: {
        list: vi.fn(),
        get: vi
          .fn()
          .mockResolvedValue({ ...task, state: 'cancelled', settledAt: 5 }),
        listEvents: vi.fn(),
        cancel: {
          submit: vi.fn(),
          query: vi.fn().mockResolvedValue(taskOperation),
        },
      },
    };
    await render('s1');
    expect(provider.tasks!.cancel!.query).toHaveBeenCalledOnce();
    expect(provider.tasks!.cancel!.submit).not.toHaveBeenCalled();
  });

  it('keeps the Workspace directory read-only even when an older backend advertises cwd changes', async () => {
    const capabilities = {
      canSend: true,
      canCancel: false,
      cwdChange: true,
      workspaceTurns: true,
    };
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        workspace: {
          workspaceId: 'ws',
          cwdRelative: 'services/api',
          contextRevision: 1,
          state: 'ready',
        },
        capabilities,
      }),
    );
    mocks.restoreEditorDraft.mockReturnValue('Keep this draft');
    await render('s1');
    expect(container.textContent).toContain('services/api');
    expect(container.textContent).not.toContain('Change directory');
    expect(
      document.querySelector('[data-testid="managed-cwd-control"]'),
    ).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('Keep this draft');
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('keeps the shown approval while a reload has not returned the Session yet', async () => {
    let hold = false;
    let release: (() => void) | undefined;
    mocks.client.getSession.mockImplementation(async (id: string) => {
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return summary(id, {
        phase: 'agent_running',
        capabilities: { canSend: false, canCancel: true, actions: true },
      });
    });
    const listPending = vi.fn().mockResolvedValue([pendingAction]);
    provider = { ...provider, actions: { listPending, respond: vi.fn() } };

    await render('s1');
    await act(async () => flush());
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).not.toBeNull();

    hold = true;
    const refresh = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Refresh',
    );
    await act(async () => {
      refresh!.click();
      await flush();
    });
    // The reload has not returned the Session summary, so the capability is
    // unknown: the card stays and nothing is read yet.
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).not.toBeNull();
    expect(listPending).toHaveBeenCalledTimes(1);

    hold = false;
    await act(async () => {
      release?.();
      await flush();
    });
  });

  it('shows a pending Hosted approval and answers it with the chosen option', async () => {
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id, {
        phase: 'agent_running',
        capabilities: { canSend: false, canCancel: true, actions: true },
      }),
    );
    const action = pendingAction;
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([action])
      .mockResolvedValue([]);
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    provider = { ...provider, actions: { listPending, respond } };

    await render('s1');
    await act(async () => flush());

    const card = container.querySelector('[data-testid="managed-approval"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Tool arguments are unavailable');
    // The caveat sits beside the panel, so the panel has to be told about it:
    // the description a screen-reader user hears must reach it.
    const dialog = card!.querySelector('[role="alertdialog"]')!;
    const caveatId = card!
      .querySelector('p[role="status"]')!
      .getAttribute('id') as string;
    expect(caveatId).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toContain(caveatId);
    // The transcript row that carries the tool call keeps the approval card
    // reachable: MessageList folds turns by this prop.
    expect(
      container.querySelector('[data-testid="message-list-pending-approval"]')
        ?.textContent,
    ).toContain('tool_approval_1');
    const allow = Array.from(card!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Yes, allow once'),
    );
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.click();
      await flush();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Retry the same option',
    );
    const retry = Array.from(
      container.querySelectorAll('[data-testid="managed-approval"] button'),
    ).find((button) => button.textContent?.includes('Yes, allow once'));
    await act(async () => {
      (retry as HTMLButtonElement).click();
      await flush();
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledWith(action, 'allow', {
      clientId: expect.any(String),
      idempotencyKey: 'tool_approval_1:allow',
    });
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).toBeNull();
    // The answered Action left, so the warning that described it leaves too.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="message-list-pending-approval"]')
        ?.textContent,
    ).toBe('null');
  });

  it.each([
    ['write_file', { file_path: 'notes.md', content: 'approval-write-body' }],
    [
      'edit',
      {
        file_path: 'notes.md',
        old_string: 'approval-old-body',
        new_string: 'approval-new-body',
      },
    ],
  ])(
    'shows available %s arguments inside the approval card',
    async (toolName, input) => {
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          capabilities: { canSend: false, canCancel: false, actions: true },
        }),
      );
      mocks.client.getTranscript.mockResolvedValue({
        events: [
          {
            ...event(1, ''),
            type: 'tool_requested',
            data: { itemId: 'item-1', toolCallId: 'call-1', toolName, input },
          },
        ],
        lastEventId: 1,
      });
      provider = {
        ...provider,
        actions: {
          listPending: vi
            .fn()
            .mockResolvedValue([{ ...pendingAction, toolName }]),
          respond: vi.fn(),
        },
      };

      await render('s1');
      const card = container.querySelector('[data-testid="managed-approval"]')!;
      const shownInput = card.querySelector('pre')?.textContent ?? '';
      for (const value of Object.values(input)) {
        expect(shownInput).toContain(value);
      }
      expect(card.textContent).not.toContain('Tool arguments are unavailable');
      // Without the caveat there is no extra description to point at, and no
      // ARIA IDREF is left dangling.
      const describedBy =
        card
          .querySelector('[role="alertdialog"]')!
          .getAttribute('aria-describedby') ?? '';
      const referenced = describedBy.split(' ').filter(Boolean);
      expect(referenced.length).toBeGreaterThan(0);
      for (const id of referenced) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    },
  );

  it.each([
    ['en', false, 'Input preview: 9000 bytes.'],
    ['en', true, 'Input preview truncated. Full input: 9000 bytes.'],
    ['zh-CN', false, '输入预览：9000 字节。'],
    ['zh-CN', true, '输入预览已截断，完整输入共 9000 字节。'],
  ] as const)(
    'shows a literal Action preview and accessible notice (%s, truncated=%s)',
    async (language, truncated, notice) => {
      // Leading space: the card must not trim the preview it renders.
      const text = ' {"toolName":"run_shell_command","input":{"command":"<b>😀';
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          capabilities: { canSend: false, canCancel: false, actions: true },
        }),
      );
      provider = {
        ...provider,
        actions: {
          listPending: vi.fn().mockResolvedValue([
            {
              ...pendingAction,
              toolName: 'run_shell_command',
              inputPreview: { text, truncated, byteLength: 9000 },
            },
          ]),
          respond: vi.fn(),
        },
      };
      await render('s1', language);
      const card = container.querySelector('[data-testid="managed-approval"]')!;
      expect(card.querySelector('pre')?.textContent).toBe(text);
      expect(card.querySelector('pre b')).toBeNull();
      expect(card.textContent).toContain(notice);
      expect(card.textContent).not.toContain('Tool arguments are unavailable');
      const status = card.querySelector('p[role="status"]')!;
      expect(status.textContent).toBe(notice);
      expect(
        card
          .querySelector('[role="alertdialog"]')!
          .getAttribute('aria-describedby')
          ?.split(' '),
      ).toContain(status.id);
      expect(document.getElementById(status.id)).toBe(status);
    },
  );

  it('offers a direct retry when pending approvals could not be loaded', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    const listPending = vi
      .fn()
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(503, 'unavailable', 'Busy'),
      )
      .mockResolvedValue([pendingAction]);
    const respond = vi.fn();
    provider = { ...provider, actions: { listPending, respond } };
    await render('s1');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Pending approvals could not be loaded',
    );
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).toBeNull();
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry loading approvals',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
      await flush();
    });
    expect(listPending).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  it('names a failed background re-read as a refresh while the loaded card stays', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    mocks.client.getTranscript.mockResolvedValue({
      events: [event(1, 'Persisted answer')],
      lastEventId: 1,
    });
    // The transcript reports an approval change, which re-reads the list. The
    // report is held back until the first read has landed, so the re-read is
    // what is being observed rather than the initial load.
    let report: (() => void) | undefined;
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => (report = resolve));
      yield {
        ...event(2, ''),
        type: 'action_updated',
        data: { actionId: 'tool_approval_1', state: 'requested' },
      };
    });
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pendingAction])
      // A Session deleted while the tab is open: the re-read can never succeed.
      .mockRejectedValue(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      );
    provider = { ...provider, actions: { listPending, respond: vi.fn() } };

    await render('s1');
    await act(async () => flush());
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(listPending).toHaveBeenCalledTimes(1);

    await act(async () => {
      report?.();
      await flush();
    });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    // The approvals were loaded and one is on screen; only the refresh failed.
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).not.toBeNull();
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Pending approvals could not be refreshed');
    expect(alert).not.toContain('could not be loaded');
  });

  it('explains that a reader cannot answer a role-based approval', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    const respond = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
    provider = {
      ...provider,
      actions: {
        listPending: vi.fn().mockResolvedValue([pendingAction]),
        respond,
      },
    };
    await render('s1');
    const allow = () =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Yes, allow once'),
      ) as HTMLButtonElement;
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Only the Session's owner or a Workspace operator can answer this approval.",
    );
    // The refusal is final for this viewer, so the card stops offering the
    // answer instead of sending one 403 per click.
    expect(allow().disabled).toBe(true);
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('re-probes a role-based refusal through the check-again affordance', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    const respond = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
    provider = {
      ...provider,
      actions: {
        listPending: vi.fn().mockResolvedValue([pendingAction]),
        respond,
      },
    };
    await render('s1');
    const allow = () =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Yes, allow once'),
      ) as HTMLButtonElement;
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(allow().disabled).toBe(true);
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert?.textContent).toContain(
      "Only the Session's owner or a Workspace operator can answer this approval.",
    );
    // The latched refusal got its own re-probe affordance, rendered with no
    // `loadError` in play, so a grant raised while the page is open can stick.
    const again = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Retry loading approvals'),
    ) as HTMLButtonElement;
    expect(again).toBeTruthy();
    await act(async () => {
      again.click();
      await flush();
    });
    expect(allow().disabled).toBe(false);
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('keeps the next approval of the same Session unanswerable after a role-based refusal', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    const second = {
      ...pendingAction,
      actionId: 'tool_approval_2',
      functionCallId: 'call-2',
    };
    // A transcript report of an approval change is what re-reads the list;
    // hold it back until the first read has landed.
    let report: (() => void) | undefined;
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => (report = resolve));
      yield {
        ...event(3, ''),
        type: 'action_updated',
        data: { actionId: 'tool_approval_2', state: 'requested' },
      };
    });
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pendingAction])
      .mockResolvedValue([second]);
    const respond = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
    provider = { ...provider, actions: { listPending, respond } };

    await render('s1');
    await act(async () => flush());
    expect(listPending).toHaveBeenCalledTimes(1);
    const allow = () =>
      Array.from(
        container.querySelectorAll('[data-testid="managed-approval"] button'),
      ).find((button) =>
        button.textContent?.includes('Yes, allow once'),
      ) as HTMLButtonElement;
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Only the Session's owner or a Workspace operator can answer this approval.",
    );
    expect(allow().disabled).toBe(true);

    // The refused Action left and the next one arrived: the refusal is a fact
    // about the viewer and the Session, so the new card is just as dead
    // instead of offering one more guaranteed 403.
    await act(async () => {
      report?.();
      await flush();
    });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    expect(
      container.querySelector('[data-testid="message-list-pending-approval"]')
        ?.textContent,
    ).toContain('tool_approval_2');
    expect(allow().disabled).toBe(true);
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(respond).toHaveBeenCalledTimes(1);
    // The per-Action alert left with the Action it described, but a dead card
    // with no stated reason is indistinguishable from a stuck one — and the
    // disabled options also drop out of sequential focus navigation — so the
    // latch keeps the reason on screen. It is a status line, not a second
    // alert, because it restates what the viewer was already told.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('[role="status"]')).map(
        (node) => node.textContent,
      ),
    ).toContain(
      "Only the Session's owner or a Workspace operator can answer this approval.",
    );
    // On screen is not enough: the reason is a sibling of the dialog, and a
    // polite region that mounts with its text already in place announces
    // nothing, so the dialog's own description is what carries the cause to a
    // screen-reader user. Widening it must not drop the arguments caveat.
    const card = container.querySelector('[data-testid="managed-approval"]')!;
    const described = (
      card
        .querySelector('[role="alertdialog"]')!
        .getAttribute('aria-describedby') ?? ''
    )
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' | ');
    expect(described).toContain(
      "Only the Session's owner or a Workspace operator can answer this approval.",
    );
    expect(described).toContain('Tool arguments are unavailable');
  });

  it('stops explaining a role-based refusal once the Session has no approval left', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    // A transcript report of an approval change is what re-reads the list;
    // hold it back until the first read has landed.
    let report: (() => void) | undefined;
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => (report = resolve));
      yield {
        ...event(3, ''),
        type: 'action_updated',
        data: { actionId: 'tool_approval_1', state: 'resolved' },
      };
    });
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pendingAction])
      .mockResolvedValue([]);
    const respond = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
    provider = { ...provider, actions: { listPending, respond } };
    const refusal =
      "Only the Session's owner or a Workspace operator can answer this approval.";

    await render('s1');
    await act(async () => flush());
    const allow = () =>
      Array.from(
        container.querySelectorAll('[data-testid="managed-approval"] button'),
      ).find((button) =>
        button.textContent?.includes('Yes, allow once'),
      ) as HTMLButtonElement;
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(container.textContent).toContain(refusal);

    // The refused Action leaves and nothing replaces it. The latch outlives it,
    // but the reason describes a card, so it leaves with the last one instead
    // of explaining an approval that is not on screen.
    await act(async () => {
      report?.();
      await flush();
    });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(refusal);
  });

  it('keeps a coded but retryable answer failure answerable', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: false, canCancel: false, actions: true },
      }),
    );
    // Every HTTP failure the Managed client builds carries a string code, so
    // carrying a code is not what marks a refusal final: only the
    // role-based refusal is.
    const respond = vi
      .fn()
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(503, 'unavailable', 'Busy'),
      )
      .mockResolvedValue(undefined);
    provider = {
      ...provider,
      actions: {
        listPending: vi.fn().mockResolvedValue([pendingAction]),
        respond,
      },
    };
    await render('s1');
    const allow = () =>
      Array.from(
        container.querySelectorAll('[data-testid="managed-approval"] button'),
      ).find((button) =>
        button.textContent?.includes('Yes, allow once'),
      ) as HTMLButtonElement;
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The approval answer could not be confirmed. Retry the same option or refresh to check its status.',
    );
    expect(allow().disabled).toBe(false);
    await act(async () => {
      allow().click();
      await flush();
    });
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it('does not read approvals for a Session without the actions capability', async () => {
    const listPending = vi.fn().mockResolvedValue([]);
    provider = {
      ...provider,
      actions: { listPending, respond: vi.fn() },
    };

    await render('s1');

    expect(listPending).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="managed-approval"]'),
    ).toBeNull();
  });

  it('gates result transport on the server capability and can discover output without its event', async () => {
    const listArtifacts = vi.fn().mockResolvedValue({
      data: [{ artifact, access: { can_read_content: false } }],
      nextCursor: null,
      hasMore: false,
    });
    provider = {
      ...provider,
      toolResults: {
        canDownload: false,
        getResult: vi.fn(),
        listArtifacts,
        getArtifact: vi
          .fn()
          .mockResolvedValue({ artifact, access: { can_read_content: false } }),
        readRange: vi.fn(),
        downloadArtifact: vi.fn(),
      },
    };
    await render('s1');
    expect(
      [...container.querySelectorAll('button')].some(
        (node) => node.textContent === 'Outputs',
      ),
    ).toBe(false);
    expect(listArtifacts).not.toHaveBeenCalled();
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: true, canCancel: false, artifacts: true },
      }),
    );
    await render(undefined);
    await render('s1');
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Outputs',
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.click();
      await flush();
    });
    expect(listArtifacts).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 50, signal: expect.any(AbortSignal) }),
    );
    expect(provider.toolResults!.readRange).not.toHaveBeenCalled();
  });

  it('uses an explicit Java provider without daemon Managed capabilities', async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [summary('java-session')],
    });
    const provider: ManagedAgentProvider = {
      storageKey: 'https://java.example/agent',
      canCancel: true,
      listSessions,
      getSession: vi.fn(),
      getTranscript: vi.fn(),
      createSession: vi.fn(),
      submitPrompt: vi.fn(),
      cancel: vi.fn(),
      queryCancelOperation: vi.fn(),
      async *subscribeEvents() {
        yield* [];
      },
    };

    await render(undefined, 'en', provider);

    expect(container.textContent).toContain('Task java-session');
    expect(listSessions.mock.calls[0][0]).not.toHaveProperty('workspaceCwd');
    expect(mocks.useWorkspace).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
  });

  it('shows an existing empty bound Session without execution controls', async () => {
    const bound = summary('bound', {
      activeTurnId: undefined,
      phase: 'created',
      runtimeReady: false,
      runtimeState: 'unknown',
      workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
      capabilities: { canSend: false, canCancel: false },
    });
    mocks.client.getSession.mockResolvedValue(bound);
    mocks.client.getTranscript.mockResolvedValue({
      events: [],
      lastEventId: 0,
    });
    await render('bound');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('ws-a');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('services/api');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('You cannot send messages in this Session');
    expect(container.querySelector('[data-managed-progress]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('Preparing environment');
  });

  it('omits the bound Workspace metadata row in the home layout', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('bound', {
        workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
      }),
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    try {
      await render('bound', 'en', provider, target);
      expect(
        container.querySelector('[data-managed-workspace-binding]'),
      ).toBeNull();
    } finally {
      target.remove();
    }
  });

  it('keeps the labeled Workspace lines in the standalone layout', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('bound', {
        workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
      }),
    );
    await render('bound');
    const binding = container.querySelector('[data-managed-workspace-binding]');
    expect(binding?.textContent).toContain('Bound Workspace');
    expect(binding?.textContent).toContain('Relative directory');
    expect(binding?.textContent).toContain('ws-a');
    expect(binding?.textContent).toContain('services/api');
    expect(binding?.querySelector('summary')).toBeNull();
  });

  it('lets the creator send a later Turn to a bound Session', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('bound', {
        activeTurnId: undefined,
        workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
        capabilities: { canSend: true, canCancel: false, workspaceTurns: true },
      }),
    );
    mocks.client.submitPrompt.mockResolvedValue({
      sessionId: 'bound',
      turnId: 'p2',
    });
    await render('bound');

    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('ws-a');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).not.toContain('You cannot send messages in this Session');
    expect(container.querySelector('textarea')).not.toBeNull();
    await input('Run it again');
    await click('Send');

    expect(mocks.client.submitPrompt).toHaveBeenCalledWith(
      'bound',
      { text: 'Run it again' },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it.each([true, false])(
    'lets the creator cancel a running bound Turn when workspaceTurns is %s',
    async (workspaceTurns) => {
      mocks.client.getSession.mockResolvedValue(
        summary('bound', {
          phase: 'tool_running',
          workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
          capabilities: {
            canSend: false,
            canCancel: true,
            ...(workspaceTurns ? { workspaceTurns: true } : {}),
          },
        }),
      );
      await render('bound');

      // Without workspaceTurns the composer stays hidden, but Cancel does not.
      expect(container.querySelector('textarea') !== null).toBe(workspaceTurns);
      await click('Cancel turn');

      expect(mocks.client.cancel).toHaveBeenCalledWith(
        'bound',
        'p1',
        expect.objectContaining({ clientId: expect.any(String) }),
      );
    },
  );

  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  async function input(text: string) {
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('opens durable history without creating or restoring a Runtime and subscribes after its watermark', async () => {
    await render('s1');
    expect(container.textContent).toContain('Persisted answer');
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 2 }),
    );
    expect(mocks.client.getTranscript).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 100 }),
    );
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'shows the standard welcome only for an empty conversation (empty=%s)',
    async (empty) => {
      if (empty)
        mocks.client.getTranscript.mockResolvedValue({
          events: [],
          lastEventId: 0,
        });
      await render('s1');
      expect(container.textContent?.includes('Welcome to')).toBe(empty);
    },
  );

  it('renders Chinese Managed labels and states without English fallback overriding them', async () => {
    await render('s1', 'zh-CN');
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe(
      '托管会话',
    );
    expect(
      container.querySelector('textarea')?.getAttribute('aria-label'),
    ).toBe('向托管 Agent 发送消息');
    expect(container.textContent).toContain('新建托管任务');
    expect(container.textContent).toContain('执行环境: 已就绪');
    expect(container.textContent).toContain('已完成');
    expect(container.textContent).not.toContain('Completed');
  });

  it('keeps creation payload, correlation and idempotency key on an uncertain retry', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Do the work');
    await click('Send');
    expect(container.textContent).toContain('not confirmed as submitted');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await click('Retry the same request');
    const [first, retry] = mocks.client.createSession.mock.calls;
    expect(first?.[0]).toEqual({
      text: 'Do the work',
    });
    expect(retry?.[0]).toEqual(first?.[0]);
    expect(retry?.[1].idempotencyKey).toBe(first?.[1].idempotencyKey);
    expect(retry?.[1].clientId).toBe(first?.[1].clientId);
    expect(onSelect).toHaveBeenLastCalledWith('created');
  });

  it('keeps an uncertain create with its original page when viewing another session', async () => {
    mocks.client.createSession.mockRejectedValueOnce(new TypeError('Network failed'));
    await render();
    await input('CHECK_CREATE');
    await click('Send');
    const original = mocks.client.createSession.mock.calls[0];

    await render('s1');
    expect(container.textContent).not.toContain('not confirmed as submitted');
    expect(container.textContent).not.toContain('Retry the same request');
    expect(container.textContent).toContain('Another conversation has an unconfirmed request');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(mocks.client.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    await click('Open the original conversation');
    expect(onSelect).toHaveBeenLastCalledWith(undefined);

    await render();
    await click('Retry the same request');
    expect(mocks.client.createSession.mock.calls[1]).toEqual(original);
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('discards a permanently failing pending prompt and restores the draft', async () => {
    mocks.client.createSession.mockRejectedValue(
      new TypeError('Network failed'),
    );
    await render();
    await input('Do the work');
    await click('Send');
    expect(container.textContent).toContain('not confirmed as submitted');
    const textarea = () => container.querySelector('textarea');
    expect(textarea()?.disabled).toBe(true);
    expect(container.querySelectorAll('p[role="alert"]')).toHaveLength(1);

    // Without an escape the composer stays wedged on the retry loop forever.
    const discard = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Discard this request',
    );
    expect(discard).toBeDefined();
    discard!.focus();
    await act(async () => {
      discard!.click();
      await flush();
    });
    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
    expect(textarea()?.disabled).toBe(false);
    expect(textarea()?.value).toBe('Do the work');
    expect(mocks.client.createSession).toHaveBeenCalledTimes(1);
    // The failed attempt's own alert is dismissed with it...
    expect(container.querySelectorAll('p[role="alert"]')).toHaveLength(0);
    // ...a create that committed server-side before the unconfirmed failure
    // re-surfaces in the session list...
    expect(mocks.client.listSessions).toHaveBeenCalledTimes(2);
    // ...and focus lands on the composer now holding the restored draft.
    expect(document.activeElement).toBe(textarea());

    // The persisted pending prompt is gone too: a real remount does not
    // return it.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
  });

  it('sends the edited draft under a fresh idempotency key after a discard', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Do the work');
    await click('Send');
    expect(container.textContent).toContain('not confirmed as submitted');
    const originalKey =
      mocks.client.createSession.mock.calls[0]?.[1].idempotencyKey;

    await click('Discard this request');
    await input('Do the other work');
    await click('Send');

    expect(mocks.client.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.client.createSession.mock.calls[1]?.[0]).toEqual({
      text: 'Do the other work',
    });
    expect(
      mocks.client.createSession.mock.calls[1]?.[1].idempotencyKey,
    ).not.toBe(originalKey);
  });

  it('offers the discard escape only in the session that owns the pending prompt', async () => {
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary('s1'), summary('s2')],
    });
    mocks.client.submitPrompt.mockRejectedValue(
      new TypeError('Network failed'),
    );
    await render('s1');
    await input('For session A only');
    await click('Send');
    expect(container.textContent).toContain('not confirmed as submitted');

    await click('Task s2Completed');
    await render('s2');
    // The pending belongs to s1: a foreign session only offers a redirect to
    // the owning conversation, never the retry/discard escape (the draft that
    // would be restored lives over there).
    expect(container.textContent).toContain(
      'Another conversation has an unconfirmed request',
    );
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.textContent === 'Open the original conversation',
      ),
    ).toBe(true);
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.textContent === 'Discard this request',
      ),
    ).toBe(false);

    // The escape stays reachable from the owning session.
    await click('Task s1Completed');
    await render('s1');
    await click('Discard this request');
    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
    expect(container.querySelector('textarea')?.value).toBe(
      'For session A only',
    );
  });

  function seedPending(record: {
    idempotencyKey: string;
    text: string;
    draftText?: string;
    sessionId?: string;
  }) {
    const clientId = getManagedClientId(provider.storageKey);
    sessionStorage.setItem(
      `qwen-managed-pending:${provider.storageKey}:${clientId}`,
      JSON.stringify(record),
    );
  }

  it('preserves another session draft when opening the owner of a restored pending prompt', async () => {
    seedPending({
      idempotencyKey: 'restored-a',
      sessionId: 's1',
      text: 'For session A',
    });
    mocks.restoreEditorDraft.mockReturnValue('Saved draft for session B');
    await render('s2');
    expect(container.querySelector('textarea')?.value).toBe(
      'Saved draft for session B',
    );
    await click('Open the original conversation');
    // Redirecting only navigates to the owning session; it does not resubmit
    // from the foreign session, and the foreign draft stays intact.
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe(
      'Saved draft for session B',
    );
    expect(onSelect).toHaveBeenLastCalledWith('s1');
  });

  it.each(['  For session A  ', 'A newer different draft'])(
    'leaves both drafts untouched when opening the pending owner from a foreign session: %s',
    async (storedDraft) => {
      seedPending({
        idempotencyKey: 'restored-a',
        sessionId: 's1',
        text: 'For session A',
        draftText: '  For session A  ',
      });
      const ownerKey = getComposerDraftStorageKey(
        undefined,
        `managed:${provider.storageKey}:s1`,
      )!;
      const foreignKey = getComposerDraftStorageKey(
        undefined,
        `managed:${provider.storageKey}:s2`,
      )!;
      localStorage.setItem(ownerKey, storedDraft);
      localStorage.setItem(foreignKey, 'Saved draft for session B');
      mocks.restoreEditorDraft.mockReturnValue('Saved draft for session B');
      await render('s2');

      await click('Open the original conversation');

      // A redirect is not a retry: nothing is submitted and neither draft is
      // cleared; the owner's draft is only reconciled when it retries there.
      expect(localStorage.getItem(ownerKey)).toBe(storedDraft);
      expect(localStorage.getItem(foreignKey)).toBe(
        'Saved draft for session B',
      );
      expect(container.querySelector('textarea')?.value).toBe(
        'Saved draft for session B',
      );
      expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenLastCalledWith('s1');
    },
  );

  it('clears accepted input after the owning editor remounts during an uncertain retry', async () => {
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary('s1'), summary('s2')],
    });
    mocks.client.submitPrompt.mockRejectedValueOnce(
      new TypeError('Lost response'),
    );
    await render('s1');
    await input('For session A');
    const originalEditor = container.querySelector('textarea');
    await click('Send');
    await render('s2');
    await render('s1');
    expect(container.querySelector('textarea')).not.toBe(originalEditor);
    expect(container.querySelector('textarea')?.value).toBe('For session A');

    await click('Retry the same request');

    expect(mocks.client.submitPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.client.submitPrompt.mock.calls[1]).toEqual(
      mocks.client.submitPrompt.mock.calls[0],
    );
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Send',
      )?.disabled,
    ).toBe(true);
    expect(onSelect).toHaveBeenLastCalledWith('s1');
    expect(mocks.clearEditor).toHaveBeenCalledOnce();
  });

  it('preserves the visible foreign draft when opening the owner of a live retained commit', async () => {
    mocks.client.submitPrompt.mockRejectedValueOnce(
      new TypeError('Lost response'),
    );
    await render('s1');
    await input('For session A');
    await click('Send');
    mocks.restoreEditorDraft.mockReturnValue('Saved draft for session B');
    await render('s2');

    await click('Open the original conversation');

    // Only the original send was submitted; the redirect does not retry, and
    // the foreign draft stays visible.
    expect(mocks.client.submitPrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('textarea')?.value).toBe(
      'Saved draft for session B',
    );
    expect(onSelect).toHaveBeenLastCalledWith('s1');
    expect(mocks.commitAccepted).not.toHaveBeenCalled();
  });

  it('clears the owning editor after a restored pending prompt is accepted', async () => {
    seedPending({
      idempotencyKey: 'restored-a',
      sessionId: 's1',
      text: 'For session A',
    });
    await render('s1');
    expect(container.querySelector('textarea')?.value).toBe('For session A');
    await click('Retry the same request');
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(onSelect).toHaveBeenLastCalledWith('s1');
  });

  async function focusAndClickDiscard() {
    const discard = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Discard this request',
    );
    expect(discard).toBeDefined();
    discard!.focus();
    await act(async () => {
      discard!.click();
      await flush();
    });
  }

  it('restores the draft from storage when a remounted pending prompt is discarded', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Keep this prompt');
    await click('Send');
    expect(container.textContent).toContain('not confirmed as submitted');

    // A real remount empties the text state: the composer is fed from the
    // persisted pending record alone.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');

    await click('Discard this request');
    // The restore is the only way the draft survives the discard now.
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
  });

  it('moves focus to the session list when a discard has no composer to focus', async () => {
    const bindingProvider = {
      ...provider,
      workspaceBinding: {
        agentId: 'agent-a',
        list: vi.fn().mockResolvedValue({ data: [], supported: true }),
        get: vi.fn(),
        createEmpty: vi.fn(),
      },
    } as unknown as ManagedAgentProvider;
    seedPending({ idempotencyKey: 'key-1', text: 'Bind this draft' });
    await render(undefined, 'en', bindingProvider);
    // The workspace-binding creator replaces the composer form entirely.
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('not confirmed as submitted');

    await focusAndClickDiscard();

    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container.querySelector('nav'));
  });

  it('moves focus to the session list when a discard leaves the composer disabled', async () => {
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id, { capabilities: { canSend: false, canCancel: false } }),
    );
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Session draft',
      sessionId: 's1',
    });
    await render('s1');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(container.textContent).toContain('not confirmed as submitted');

    await focusAndClickDiscard();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(container.querySelector('nav'));
  });

  it('moves focus to the composer once a discard’s loading window ends', async () => {
    let releaseSummary!: (value: ManagedAgentSessionSummary) => void;
    mocks.client.getSession.mockImplementationOnce(
      () =>
        new Promise<ManagedAgentSessionSummary>((resolve) => {
          releaseSummary = resolve;
        }),
    );
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Restore me',
      sessionId: 's1',
    });
    await render('s1');
    // The summary is still loading: the composer is disabled on the pending
    // record alone, so the discard can only park focus on the session list.
    expect(container.querySelector('textarea')?.disabled).toBe(true);

    await focusAndClickDiscard();
    expect(document.activeElement).toBe(container.querySelector('nav'));

    await act(async () => {
      releaseSummary(summary('s1'));
      await flush();
    });
    // The composer became focusable holding the restored draft: the latch
    // was still armed, so focus lands there now.
    expect(container.querySelector('textarea')?.value).toBe('Restore me');
    expect(document.activeElement).toBe(container.querySelector('textarea'));
  });

  it('does not steal another session’s composer when a discard’s loading window ends', async () => {
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary('s1'), summary('s2')],
    });
    mocks.client.getSession.mockImplementation(
      (_id: string) => new Promise<ManagedAgentSessionSummary>(() => {}),
    );
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Session draft',
      sessionId: 's1',
    });
    await render('s1');
    // s1's summary never lands: the discard can only park focus on the list.
    await focusAndClickDiscard();
    expect(document.activeElement).toBe(container.querySelector('nav'));

    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id),
    );
    await click('Task s2Completed');
    await render('s2');
    // The latch was armed by s1's discard: s2's composer becoming focusable
    // must not pull focus into a session the user navigated to.
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(document.activeElement).not.toBe(
      container.querySelector('textarea'),
    );
  });

  it('leaves focus alone when the user moved on during a discard’s loading window', async () => {
    let releaseSummary!: (value: ManagedAgentSessionSummary) => void;
    mocks.client.getSession.mockImplementationOnce(
      () =>
        new Promise<ManagedAgentSessionSummary>((resolve) => {
          releaseSummary = resolve;
        }),
    );
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Session draft',
      sessionId: 's1',
    });
    await render('s1');
    await focusAndClickDiscard();
    expect(document.activeElement).toBe(container.querySelector('nav'));

    // The user moves on to another control while the summary is still
    // loading.
    const refresh = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Refresh',
    );
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh!.focus();
      await flush();
    });

    await act(async () => {
      releaseSummary(summary('s1'));
      await flush();
    });
    // The composer is focusable again, but the latch died with the user's
    // own focus move: it must not be stolen back.
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(document.activeElement).toBe(refresh);
  });

  it('moves focus to the composer when a later summary lifts the send gate', async () => {
    let releaseStream!: () => void;
    mocks.client.getSession.mockImplementationOnce(async (id: string) =>
      summary(id, { capabilities: { canSend: false, canCancel: false } }),
    );
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      yield* [];
    });
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Session draft',
      sessionId: 's1',
    });
    await render('s1');
    // The summary says the session cannot send: the discard parks focus on
    // the session list, with the latch armed for as long as the gate can
    // still lift.
    await focusAndClickDiscard();
    expect(document.activeElement).toBe(container.querySelector('nav'));

    // The stream's clean pass delivers the summary that lifts the gate.
    await act(async () => {
      releaseStream();
      await flush();
    });
    expect(container.querySelector('textarea')?.value).toBe('Session draft');
    expect(document.activeElement).toBe(container.querySelector('textarea'));
  });

  it('announces the discard where the composer cannot take focus', async () => {
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id, { capabilities: { canSend: false, canCancel: false } }),
    );
    seedPending({
      idempotencyKey: 'key-1',
      text: 'Session draft',
      sessionId: 's1',
    });
    await render('s1');

    await focusAndClickDiscard();

    // The unconfirmed row unmounted with the click; the persistent visually
    // hidden status region still announces the outcome.
    expect(container.textContent).not.toContain(
      'not confirmed as submitted',
    );
    expect(
      Array.from(
        container.querySelectorAll('[role="status"], [aria-live]'),
      ).map((node) => node.textContent),
    ).toContain('Request discarded. The draft is back in the composer.');
  });

  it('gates sending and cancels the captured Prompt without treating acceptance as terminal', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        phase: 'tool_running',
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    await render('s1');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await click('Cancel turn');
    expect(mocks.client.cancel).toHaveBeenCalledWith(
      's1',
      'p1',
      expect.objectContaining({ clientId: expect.any(String) }),
    );
    expect(container.textContent).toContain('Executing tool');
    expect(container.textContent).not.toContain('Cancelled');
  });

  it('shows submission and loading feedback before the first model event', async () => {
    let accept!: (value: { sessionId: string; turnId: string }) => void;
    mocks.client.createSession.mockImplementationOnce(
      () => new Promise((resolve) => (accept = resolve)),
    );
    await render();
    await input('Inspect the workspace');
    await click('Send');
    expect(
      container.querySelector('[data-managed-progress] span[role="status"]')
        ?.textContent,
    ).toBe('Submitting…');

    let load!: (value: ManagedAgentSessionTranscript) => void;
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        phase: 'admitted',
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    mocks.client.getTranscript.mockImplementationOnce(
      () => new Promise((resolve) => (load = resolve)),
    );
    await act(async () => {
      accept({ sessionId: 's1', turnId: 'p1' });
      await flush();
    });
    await render('s1');
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toBe('Loading…');
    await act(async () => {
      load({
        events: [
          {
            ...event(1, ''),
            type: 'accepted',
            data: { prompt: [{ type: 'text', text: 'Inspect the workspace' }] },
          },
          { ...event(2, ''), type: 'agent_started' },
        ],
        lastEventId: 2,
      });
      await flush();
    });
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toContain('Accepted');
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toContain('This turn is running');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(mocks.client.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'keeps elapsed progress during silent intervals and removes it on %s',
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          admittedAt: 8000,
          phase: 'agent_running',
          capabilities: { canSend: false, canCancel: true },
        }),
      );
      mocks.client.getTranscript.mockResolvedValue({
        events: [],
        lastEventId: 0,
      });
      await render('s1', 'zh-CN');
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('已用时 2 秒');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('已用时 7 秒');
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('本轮执行中');
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          phase,
          runtimeState: 'starting',
          runtimeReady: false,
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(container.querySelector('[data-managed-progress]')).toBeNull();
      expect(container.querySelector('textarea')?.disabled).toBe(false);
    },
  );

  it('preserves an uncertain attempt across a remount and restores its text after a definitive rejection', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Keep this prompt');
    await click('Send');
    const originalKey =
      mocks.client.createSession.mock.calls[0]?.[1].idempotencyKey;
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.client.createSession.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(400, 'invalid_request', 'Invalid request'),
    );
    await render();
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');
    await click('Retry the same request');
    expect(mocks.client.createSession.mock.calls[1]?.[1].idempotencyKey).toBe(
      originalKey,
    );
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });

  it('renders the unavailable fallback and no fetching when no provider is supplied', async () => {
    await render('s1', 'en', null);
    expect(container.textContent).toContain('unavailable');
    expect(mocks.useWorkspace).not.toHaveBeenCalled();
    expect(mocks.client.getSession).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejected'] as const)(
    'does not apply an old submission to the new selection when it is %s',
    async (outcome) => {
      mocks.client.listSessions.mockResolvedValue({
        sessions: [summary('s1'), summary('s2')],
      });
      let resolveSubmission!: (value: {
        sessionId: string;
        turnId: string;
      }) => void;
      let rejectSubmission!: (error: Error) => void;
      mocks.client.submitPrompt.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveSubmission = resolve;
            rejectSubmission = reject;
          }),
      );
      await render('s1');
      await input('Old session prompt');
      await click('Send');
      await click('Task s2Completed');
      await render('s2');
      expect(container.querySelector('[data-managed-progress]')).toBeNull();
      await act(async () => {
        if (outcome === 'accepted')
          resolveSubmission({ sessionId: 's1', turnId: 'p2' });
        else
          rejectSubmission(
            new JavaManagedAgentHttpError(
              400,
              'invalid_request',
              'Old session rejection',
            ),
          );
        await flush();
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('s2');
      expect(container.querySelector('textarea')?.value).toBe('');
      expect(container.textContent).not.toContain('Old session rejection');
      expect(container.textContent).toContain('Task s2');
    },
  );

  it('updates late Runtime failure after a completed turn through detail polling', async () => {
    vi.useFakeTimers();
    mocks.client.getSession.mockResolvedValue(
      summary('s1', { runtimeState: 'starting', runtimeReady: false }),
    );
    await render('s1');
    expect(container.textContent).toContain('Environment: Preparing');
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        updatedAt: 30,
        runtimeState: 'failed',
        runtimeReady: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(container.textContent).toContain('Environment: Preparation failed');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('Persisted answer');
  });

  it('prepends older transcript pages without losing current messages', async () => {
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(3, 'Recent')],
        olderCursor: '3',
        lastEventId: 3,
      })
      .mockResolvedValue({
        events: [
          {
            ...event(1, ''),
            type: 'accepted',
            data: { prompt: [{ type: 'text', text: 'Original question' }] },
          },
          event(2, 'Earlier '),
        ],
        lastEventId: 3,
      });
    await render('s1');
    await click('Older history');
    expect(container.textContent).toContain('Original question');
    expect(container.textContent).toContain('Earlier Recent');
    expect(mocks.client.getTranscript).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ before: '3', limit: 100 }),
    );
  });

  it('ignores delayed snapshot responses after selection switches', async () => {
    let resolveFirst!: (value: ManagedAgentSessionTranscript) => void;
    mocks.client.getTranscript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await render('s1');
    mocks.client.getTranscript.mockResolvedValue({
      events: [{ ...event(1, 'Second answer'), sessionId: 's2' }],
      lastEventId: 1,
    });
    await render('s2');
    await act(async () => {
      resolveFirst({
        events: [event(1, 'Stale first answer')],
        lastEventId: 1,
      });
      await flush();
    });
    expect(container.textContent).toContain('Second answer');
    expect(container.textContent).not.toContain('Stale first answer');
  });

  it('retries a transient initial history failure before subscribing without resubmitting a prompt', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript.mockRejectedValueOnce(
      new TypeError('Temporary history failure'),
    );
    await render('s1');
    expect(container.textContent).toContain('Temporary history failure');
    expect(mocks.client.subscribeEvents).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(container.textContent).toContain('Persisted answer');
    expect(container.textContent).not.toContain('Temporary history failure');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 2 }),
    );
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('aborts a waiting initial snapshot retry when the selection changes', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript.mockRejectedValueOnce(
      new TypeError('Temporary history failure'),
    );
    await render('s1');
    await render('s2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(mocks.client.getTranscript.mock.calls.map(([id]) => id)).toEqual([
      's1',
      's2',
    ]);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's2',
      expect.objectContaining({ lastEventId: 2 }),
    );
  });

  it('backs off when gap recovery fails instead of repeatedly requesting the same missing range', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(1, 'Before gap')],
        lastEventId: 1,
      })
      .mockRejectedValueOnce(new TypeError('Recovery temporarily unavailable'))
      .mockResolvedValue({
        events: [event(1, 'Restored history')],
        lastEventId: 1,
      });
    const gapStream = async function* () {
      yield { ...event(2, ''), type: 'stream_gap' };
    };
    mocks.client.subscribeEvents
      .mockImplementationOnce(gapStream)
      .mockImplementationOnce(gapStream);
    await render('s1');
    expect(container.textContent).toContain('Recovery temporarily unavailable');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
      await flush();
    });
    expect(mocks.client.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(container.textContent).toContain('Restored history');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(3);
  });

  it('prefers the terminal stop reason over a later transient error and keeps it after the transient clears', async () => {
    // Pin the poller's first-rung failure delay to its maximum so the
    // recovering read lands after both positional alert checks.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    vi.useFakeTimers();
    try {
      mocks.client.getSession
        .mockResolvedValueOnce(summary('s1'))
        .mockRejectedValueOnce(
          new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
        )
        .mockResolvedValue(summary('s1'));
      mocks.client.subscribeEvents
        .mockImplementationOnce(async function* () {
          yield event(3, 'still streaming');
          await new Promise((resolve) => setTimeout(resolve, 3_500));
          throw new JavaManagedAgentHttpError(
            502,
            'bad_gateway',
            'Bad gateway',
          );
        })
        .mockImplementationOnce(async function* (
          _id: string,
          opts: { signal: AbortSignal },
        ) {
          yield event(4, 'resumed after the stop');
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) resolve();
            else
              opts.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
        });
      await render('s1');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
        await flush();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Not found',
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
        await flush();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Not found',
      );
      expect(
        container.querySelector('[data-testid="messages"]')?.textContent,
      ).toContain('resumed after the stop');
    } finally {
      random.mockRestore();
    }
  });

  it.each([false, true])(
    'announces a list failure once when interactive is %s',
    async (interactive) => {
      mocks.client.listSessions.mockRejectedValue(
        new Error('History unavailable'),
      );
      await render('s1', 'en', provider, undefined, interactive);
      expect(
        [...container.querySelectorAll('[role="alert"]')].map(
          (element) => element.textContent,
        ),
      ).toEqual(['History unavailable']);
    },
  );

  it.each(['History unavailable', 'Not found'])(
    'keeps distinct detail errors alongside an inactive navigation alert: %s',
    async (detailError) => {
      mocks.client.listSessions.mockRejectedValue(
        new Error('History unavailable'),
      );
      mocks.client.getSession.mockRejectedValue(
        new JavaManagedAgentHttpError(404, 'session_not_found', detailError),
      );
      await render('s1', 'en', provider, undefined, false);
      expect(
        [...container.querySelectorAll('[role="alert"]')]
          .map((element) => element.textContent)
          .sort(),
      ).toEqual([...new Set(['History unavailable', detailError])].sort());
    },
  );

  it('shows a fresh action error alongside a sticky terminal stop', async () => {
    vi.useFakeTimers();
    mocks.client.getSession
      .mockResolvedValueOnce(summary('s1'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      )
      .mockResolvedValue(summary('s1'));
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not found',
    );
    mocks.client.submitPrompt.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(409, 'turn_active', 'Turn already active'),
    );
    await input('Is anything there?');
    await click('Send');
    await act(async () => {
      await flush();
    });
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(alerts).toEqual(['Not found', 'Turn already active']);
    const actionAlert = container.querySelectorAll('[role="alert"]')[1];
    // The session leg heals on the next poll rung: the sticky stop leaves,
    // and the still-standing action error must keep its node — index
    // reconciliation would keep node 0 and rewrite its text, re-announcing
    // an already-announced alert.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      await flush();
    });
    expect(
      [...container.querySelectorAll('[role="alert"]')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['Turn already active']);
    expect(container.querySelector('[role="alert"]')).toBe(actionAlert);
  });

  it('shows a failed older-page fetch alongside a sticky terminal stop', async () => {
    vi.useFakeTimers();
    mocks.client.getSession
      .mockResolvedValueOnce(summary('s1'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      )
      .mockResolvedValue(summary('s1'));
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(1, 'Persisted answer')],
        olderCursor: '1',
        lastEventId: 1,
      })
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(500, 'internal', 'History unavailable'),
      );
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not found',
    );
    await click('Older history');
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(alerts).toContain('Not found');
    expect(alerts).toContain('History unavailable');
  });

  it('renders one alert when the action error repeats the standing verdict', async () => {
    vi.useFakeTimers();
    mocks.client.getSession
      .mockResolvedValueOnce(summary('s1'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      )
      .mockResolvedValue(summary('s1'));
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not found',
    );
    // The same server condition fails the page action: the message must
    // not be announced twice.
    mocks.client.submitPrompt.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
    );
    await input('Is anything there?');
    await click('Send');
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(alerts).toEqual(['Not found']);
    // When the poller's next read heals the session leg, the suppressed
    // duplicate is not re-mounted as a brand-new assertive region: the
    // message already on screen keeps its DOM node. The recovery read
    // lands at one poll rung (at most 3000+5999ms) after the 404.
    const standingAlert = container.querySelector('[role="alert"]');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
      await flush();
    });
    const healed = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(healed).toEqual(['Not found']);
    expect(container.querySelector('[role="alert"]')).toBe(standingAlert);
  });

  it('renders one alert when the failed older-page fetch repeats the standing verdict', async () => {
    vi.useFakeTimers();
    mocks.client.getSession
      .mockResolvedValueOnce(summary('s1'))
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      )
      .mockResolvedValue(summary('s1'));
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(1, 'Persisted answer')],
        olderCursor: '1',
        lastEventId: 1,
      })
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      );
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Not found',
    );
    // The failed page fetch carries the same message the verdict already
    // shows: it must not be announced twice.
    await click('Older history');
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(alerts).toEqual(['Not found']);
  });

  it('renders one alert when the action error repeats the standing stream failure', async () => {
    vi.useFakeTimers();
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      yield event(3, 'still streaming');
      throw new JavaManagedAgentHttpError(502, 'bad_gateway', 'Bad gateway');
    });
    await render('s1');
    await act(async () => {
      await flush();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Bad gateway',
    );
    // The user's Send fails with the same message the stream leg already
    // shows: it must not be announced twice.
    mocks.client.submitPrompt.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(502, 'bad_gateway', 'Bad gateway'),
    );
    await input('Is anything there?');
    await click('Send');
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (el) => el.textContent,
    );
    expect(alerts).toEqual(['Bad gateway']);
  });

  it('merges a gapped stream with a durable snapshot and keeps paged history', async () => {
    vi.useFakeTimers();
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(3, 'Recent')],
        olderCursor: '3',
        lastEventId: 3,
      })
      .mockResolvedValueOnce({
        events: [
          {
            ...event(1, ''),
            type: 'accepted',
            data: { prompt: [{ type: 'text', text: 'Original question' }] },
          },
          event(2, 'Earlier '),
        ],
        olderCursor: '1',
        lastEventId: 3,
      })
      // The gap resync's snapshot window sits right above the paged page,
      // and older events still exist below it.
      .mockResolvedValue({
        events: [event(3, 'Recent'), event(4, ' New')],
        olderCursor: '3',
        lastEventId: 4,
      });
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      await gapGate;
      yield { ...event(3, ''), type: 'stream_gap' };
    });
    await render('s1');
    await click('Older history');
    expect(container.textContent).toContain('Original question');
    await act(async () => {
      deliverGap();
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    // The paged page survives the gap resync; wholesale replacement would
    // drop it.
    expect(container.textContent).toContain('Original question');
    expect(container.textContent).toContain('Earlier');
    expect(container.textContent).toContain('Recent New');
    expect(
      [...document.body.querySelectorAll('button')].some(
        (n) => n.textContent === 'Older history',
      ),
    ).toBe(true);
  });

  it('deduplicates replay and merges a gapped stream with a durable snapshot', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript
      .mockResolvedValueOnce({ events: [event(1, 'First')], lastEventId: 1 })
      .mockResolvedValue({
        events: [event(1, 'First'), event(2, ' second'), event(3, ' restored')],
        lastEventId: 3,
      });
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      yield event(1, 'First');
      yield event(2, ' second');
      yield { ...event(3, ''), type: 'stream_gap' };
    });
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    const rendered =
      container.querySelector('[data-testid="messages"]')?.textContent ?? '';
    expect(rendered).toContain('First second restored');
    // Count/sensitive: an append-instead-of-replace snapshot yields
    // `First secondFirst second restored` and still satisfies a plain
    // toContain — so does a replayed prefix with the gap guard removed.
    expect(rendered.split('First second').length - 1).toBe(1);
    expect(container.textContent).not.toContain('FirstFirst');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.client.getTranscript.mock.calls) {
      expect(options.limit).toBe(100);
    }
    expect(mocks.client.subscribeEvents).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 3 }),
    );
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });
  it('keeps an open output panel mounted while refreshing the session', async () => {
    const ready = summary('s1', {
      capabilities: { canSend: true, canCancel: false, artifacts: true },
    });
    mocks.client.getSession.mockResolvedValue(ready);
    const listArtifacts = vi.fn().mockResolvedValue({
      data: [{ artifact, access: { can_read_content: true } }],
      hasMore: false,
      nextCursor: null,
    });
    const readRange = vi
      .fn()
      .mockResolvedValue(new TextEncoder().encode('hello'));
    provider = {
      ...provider,
      toolResults: {
        canDownload: false,
        getResult: vi.fn(),
        listArtifacts,
        getArtifact: vi
          .fn()
          .mockResolvedValue({ artifact, access: { can_read_content: true } }),
        readRange,
        downloadArtifact: vi.fn(),
      },
    };
    await render('s1');
    const click = async (label: string) => {
      const button = [...document.body.querySelectorAll('button')].find(
        (n) => n.textContent === label,
      );
      expect(button).toBeTruthy();
      await act(async () => {
        button!.click();
        await flush();
      });
    };
    await click('Outputs');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    let complete!: (value: ManagedAgentSessionSummary) => void;
    mocks.client.getSession.mockImplementationOnce(
      () =>
        new Promise<ManagedAgentSessionSummary>((resolve) => {
          complete = resolve;
        }),
    );
    await click('Refresh');
    const during = document.body.querySelector('[role="dialog"]') !== null;
    await act(async () => {
      complete(ready);
      await flush();
    });
    expect(during).toBe(true);
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(readRange).toHaveBeenCalledTimes(1);
    mocks.client.getSession.mockResolvedValueOnce(summary('s1'));
    await click('Refresh');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    mocks.client.getSession.mockImplementationOnce(
      () =>
        new Promise<ManagedAgentSessionSummary>((resolve) => {
          complete = resolve;
        }),
    );
    await click('Refresh');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      complete(ready);
      await flush();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
  it('forwards a message tool-result selection to its exact item', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        capabilities: { canSend: true, canCancel: false, artifacts: true },
      }),
    );
    const getResult = vi.fn().mockResolvedValue({
      result: { ...result, session_id: 's1', artifacts: [] },
      access: { can_read_content: false },
    });
    provider = {
      ...provider,
      toolResults: {
        canDownload: false,
        getResult,
        getArtifact: vi.fn(),
        listArtifacts: vi.fn(),
        readRange: vi.fn(),
        downloadArtifact: vi.fn(),
      },
    };
    await render('s1');
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((n) => n.textContent === 'Open tool output')!
        .click();
      await flush();
    });
    expect(getResult).toHaveBeenCalledWith(
      's1',
      'item-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
