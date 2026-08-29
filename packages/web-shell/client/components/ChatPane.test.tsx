// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import {
  WebShellCustomizationProvider,
  type WebShellComposerToolbarRenderInfo,
  type WebShellCustomization,
} from '../customization';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalogController = vi.hoisted(() => ({
  invalidateWorkspace: vi.fn(),
  sessionCreated: vi.fn(),
  promptAdmitted: vi.fn(),
  promptAdmissionUncertain: vi.fn(),
  renamed: vi.fn(),
  turnCompleted: vi.fn(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let connectionState: any;
let streamingStateValue: string;
let pendingPermission: any;
let sessionHasActivePromptValue: boolean;
let queuedPromptStreamingState: string | undefined;
let queuedPromptSessionHasActivePrompt: boolean | undefined;
let latestOnSubmit:
  | ((
      text: string,
      images?: unknown,
      files?: unknown,
      commitAccepted?: () => void,
      metadata?: unknown,
    ) => boolean)
  | undefined;
let latestChatEditorProps: any;
let renderRealChatEditor: boolean;
let latestFollowupAccept: ((suggestion: string) => void) | undefined;
let latestMonitorDetailsOnOpen:
  | ((tool: {
      callId: string;
      toolName: string;
      status: 'completed';
    }) => Promise<boolean>)
  | undefined;
let sendPromptAdmit: (() => void) | undefined;
const clearFollowup = vi.fn();
const insertText = vi.fn();
const transcriptDispatch = vi.fn();
const appendLocalUserMessage = vi.fn();
const sendPrompt = vi.fn(async () => ({}) as any);
const submitPermission = vi.fn(async () => true);
const cancel = vi.fn(async () => {});
const setApprovalMode = vi.fn(async (mode: string) => ({ mode }));
const setModel = vi.fn(async () => ({}) as any);
const loadArtifacts = vi.fn(async () => ({ artifacts: [] }));
const getTasks = vi.fn();
const getGoal = vi.fn();
const controlGoal = vi.fn();
const readAttachment = vi.fn();
const getContextUsage = vi.fn();
const daemonActions = {
  sendPrompt,
  submitPermission,
  cancel,
  setApprovalMode,
  setModel,
  loadArtifacts,
  getTasks,
  getGoal,
  controlGoal,
  readAttachment,
  getContextUsage,
};
const enqueuePrompt = vi.fn(() => true);
const removeQueuedPrompt = vi.fn();
const editQueuedPrompt = vi.fn();
const editLastQueuedPrompt = vi.fn(() => false);
const clearQueuedPrompts = vi.fn(() => false);
let queuedPromptsMock: any[] = [];
let queuedTextsMock: string[] = [];
let ownerVersion = 0;

const latestComposerCoreOptions = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useActions: () => daemonActions,
  useConnection: () => connectionState,
  useDaemonFollowupSuggestion: (options: any) => {
    latestFollowupAccept = options?.onAccept;
    return {
      followupState: { suggestion: 'next idea', isVisible: true },
      onAcceptFollowup: vi.fn(),
      onDismissFollowup: vi.fn(),
      clear: clearFollowup,
    };
  },
  useStreamingState: () => streamingStateValue,
  useTranscriptBlocks: () => [],
  useTranscriptHistory: () => ({
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: false,
    loadMore: vi.fn(),
    release: vi.fn(),
  }),
  useTranscriptStore: () => ({
    dispatch: transcriptDispatch,
    appendLocalUserMessage,
  }),
  usePromptStatus: () => 'idle',
  useOptionalWorkspace: () => undefined,
  useWorkspaceActions: () => ({}),
  useWorkspace: () => ({
    capabilities: connectionState.capabilities,
    client: {},
    workspaceCwd: '/primary',
  }),
  useWorkspaceEventSignals: () => ({ artifactsVersion: 0 }),
  useDaemonSessionOwnerGuard: () => ({
    capture: () => {
      const captured = ownerVersion;
      return { isCurrent: () => ownerVersion === captured };
    },
  }),
}));

vi.mock('../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => catalogController,
  useSessionHasActivePrompt: () => sessionHasActivePromptValue,
}));

vi.mock('../hooks/useQueuedPrompts', () => ({
  useQueuedPrompts: (args: {
    streamingState: string;
    sessionHasActivePrompt?: boolean;
  }) => {
    queuedPromptStreamingState = args.streamingState;
    queuedPromptSessionHasActivePrompt = args.sessionHasActivePrompt;
    return {
      queuedPrompts: queuedPromptsMock,
      queuedTexts: queuedTextsMock,
      enqueuePrompt,
      removeQueuedPrompt,
      editQueuedPrompt,
      editLastQueuedPrompt,
      clearQueuedPrompts,
    };
  },
}));

let messagesState: any[];
vi.mock('../hooks/useMessages', () => ({
  useMessages: () => messagesState,
  useMessagesFromBlocks: () => messagesState,
}));

vi.mock('../hooks/useAnimationFrameTranscriptBlocks', () => ({
  useAnimationFrameTranscriptSnapshot: () => ({ blocks: [] }),
}));

vi.mock('../adapters/transcriptAdapter', () => ({
  extractPendingPermission: () => pendingPermission,
}));

vi.mock('../monitorDetailsContext', async () => {
  const React = await import('react');
  return {
    MonitorDetailsProvider: (props: {
      onOpen: typeof latestMonitorDetailsOnOpen;
      children: React.ReactNode;
    }) => {
      latestMonitorDetailsOnOpen = props.onOpen;
      return React.createElement(React.Fragment, null, props.children);
    },
  };
});

vi.mock('./MessageList', () => ({
  MessageList: (props: any) => (
    <div
      data-testid="pane-messages"
      data-approval={props.pendingApproval ? 'yes' : 'no'}
    >
      {props.messages.length}
      <button
        data-testid="pane-open-turn-output"
        type="button"
        onClick={() =>
          props.onTurnOutputOpen?.({
            id: 'artifact:turn-artifact',
            kind: 'artifact',
            title: 'Turn artifact',
            turnId: 'turn-1',
            artifactId: 'turn-artifact',
            artifact: { id: 'turn-artifact', title: 'Turn artifact' },
            workspaceCwd: '/w',
          })
        }
      />
      <button
        data-testid="pane-open-attachment"
        type="button"
        onClick={() =>
          props.onAttachmentPreview?.({
            name: 'data.json',
            attachmentId: 'attachment-1',
          })
        }
      />
    </div>
  ),
}));
vi.mock('./StreamingStatus', () => ({
  StreamingStatus: (props: any) => (
    <div
      data-testid="pane-streaming"
      data-started-at={
        props.startedAt === undefined ? 'none' : String(props.startedAt)
      }
      data-show-phrase={String(props.showPhrase)}
      data-has-active-prompt={String(props.hasActivePrompt === true)}
    />
  ),
}));
vi.mock('../hooks/useComposerCore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hooks/useComposerCore')>();
  return {
    ...actual,
    useComposerCore: (...args: Parameters<typeof actual.useComposerCore>) => {
      latestComposerCoreOptions.current = args[0] as Record<string, unknown>;
      const noop = vi.fn();
      const fallback: ProxyHandler<object> = {
        get(target, property) {
          return Reflect.has(target, property)
            ? Reflect.get(target, property)
            : noop;
        },
      };
      return new Proxy(
        {
          containerRef: { current: null },
          viewRef: { current: null },
          handle: new Proxy({ hasAttachments: () => false }, fallback),
          searchState: new Proxy(
            {
              searchMode: false,
              searchInputRef: { current: null },
              searchUiRef: { current: null },
            },
            fallback,
          ),
          imageTransferHandlers: {},
          pastedImages: [],
          composerTags: [],
          hasAttachments: false,
          hasContent: false,
          canSubmit: false,
          pendingImageBatchCount: 0,
          imageDragActive: false,
          mobileComposer: null,
          shellMode: false,
          currentMode: 'default',
          showShortcutHints: false,
          disabled: false,
          followupState: { isVisible: false, suggestion: '' },
          slashMenu: null,
          atMenu: null,
        },
        fallback,
      );
    },
  };
});

vi.mock('./ChatEditor', () => ({
  ChatEditor: forwardRef(function MockChatEditor(props: any, ref: any) {
    latestOnSubmit = props.onSubmit;
    latestChatEditorProps = props;
    useImperativeHandle(ref, () => ({
      insertText,
    }));
    if (renderRealChatEditor) {
      return <RealChatEditor {...props} visibleToolbarActions={[]} />;
    }
    return (
      <div data-web-shell-composer>
        <button
          data-testid="pane-submit"
          onClick={() => props.onSubmit('hello there')}
        >
          send
        </button>
        <button data-testid="pane-cancel" onClick={props.onCancel}>
          cancel
        </button>
        <button
          data-testid="pane-pick-mode"
          onClick={() => props.onSelectMode?.('yolo')}
        >
          mode
        </button>
        <button
          data-testid="pane-pick-badmode"
          onClick={() => props.onSelectMode?.('totally-bogus')}
        >
          badmode
        </button>
        <button
          data-testid="pane-pick-model"
          onClick={() => props.onSelectModel?.('gpt-x')}
        >
          model
        </button>
        <span data-testid="pane-running">{String(props.isRunning)}</span>
        <span data-testid="pane-dialogopen">{String(props.dialogOpen)}</span>
        <span data-testid="pane-toolbar">
          {JSON.stringify(props.visibleToolbarActions ?? null)}
        </span>
        <span data-testid="pane-commands">
          {String((props.commands ?? []).length)}
        </span>
        <span data-testid="pane-mode">{String(props.currentMode)}</span>
        <span data-testid="pane-model">{String(props.currentModel)}</span>
        <span data-testid="pane-models">
          {JSON.stringify(props.availableModels ?? null)}
        </span>
        <span data-testid="pane-queued-messages">
          {JSON.stringify(props.queuedMessages ?? null)}
        </span>
        <span data-testid="pane-followup">
          {String(props.followupState?.suggestion ?? '')}
        </span>
      </div>
    );
  }),
}));
vi.mock('./QueuedPromptDisplay', () => ({
  QueuedPromptDisplay: (props: any) => (
    <div
      data-testid="pane-queue"
      data-can-mutate-mid-turn={String(props.canMutateMidTurn)}
      data-can-insert-mid-turn={String(props.canInsertMidTurn)}
    >
      {String(props.prompts.length)}
    </div>
  ),
}));
vi.mock('./messages/ToolApproval', () => ({
  ToolApproval: (props: any) => (
    <button
      data-testid="tool-approval"
      data-keyboard-active={String(props.keyboardActive)}
      data-plan-todos={JSON.stringify(
        props.planTodos?.map((todo: any) => todo.id) ?? [],
      )}
      onClick={() => props.onConfirm(props.request.id, 'proceed')}
    >
      approve
    </button>
  ),
}));
vi.mock('./messages/AskUserQuestion', () => ({
  AskUserQuestion: (props: any) => (
    <button
      data-testid="ask-approval"
      data-keyboard-active={String(props.keyboardActive)}
      onClick={() => props.onConfirm(props.request.id, 'opt')}
    >
      ask
    </button>
  ),
}));

const RealChatEditor = (
  await vi.importActual<typeof import('./ChatEditor')>('./ChatEditor')
).ChatEditor;
const { ChatPane } = await import('./ChatPane');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const EMPTY_CUSTOMIZATION: WebShellCustomization = {};

beforeEach(() => {
  connectionState = {
    status: 'connected',
    sessionId: 'sess-1',
    displayName: 'Refactor core',
    workspaceCwd: '/w',
    loadingTranscript: false,
    catchingUp: false,
    // A loaded session normally carries a Goal snapshot; tests that exercise
    // the hydration window set it back to undefined.
    goalState: { v: 2, activity: 'idle', goal: null },
  };
  streamingStateValue = 'idle';
  pendingPermission = null;
  messagesState = [{ id: 'm1', role: 'user', content: 'hi' }];
  latestOnSubmit = undefined;
  latestChatEditorProps = undefined;
  renderRealChatEditor = false;
  sessionHasActivePromptValue = false;
  queuedPromptStreamingState = undefined;
  queuedPromptSessionHasActivePrompt = undefined;
  latestComposerCoreOptions.current = null;
  latestFollowupAccept = undefined;
  latestMonitorDetailsOnOpen = undefined;
  sendPromptAdmit = undefined;
  queuedPromptsMock = [];
  queuedTextsMock = [];
  ownerVersion = 0;
  sendPrompt.mockReset();
  loadArtifacts.mockReset();
  loadArtifacts.mockResolvedValue({ artifacts: [] });
  getTasks.mockReset();
  getGoal.mockReset();
  controlGoal.mockReset();
  readAttachment.mockReset();
  readAttachment.mockResolvedValue({
    data: 'eyJoaSI6IuS9oOWlvSJ9',
    mimeType: 'application/json',
  });
  getContextUsage.mockReset();
  getContextUsage.mockResolvedValue({
    usage: { totalTokens: 1200, contextWindowSize: 8192 },
  });
  sendPrompt.mockImplementation(async (_text: string, options?: any) => {
    sendPromptAdmit = options?.onAdmitted;
    return {} as any;
  });
  clearFollowup.mockClear();
  insertText.mockClear();
  submitPermission.mockClear();
  cancel.mockClear();
  setApprovalMode.mockClear();
  setModel.mockClear();
  enqueuePrompt.mockClear();
  enqueuePrompt.mockReturnValue(true);
  removeQueuedPrompt.mockClear();
  editQueuedPrompt.mockClear();
  editLastQueuedPrompt.mockClear();
  clearQueuedPrompts.mockClear();
  transcriptDispatch.mockClear();
  appendLocalUserMessage.mockClear();
  catalogController.invalidateWorkspace.mockClear();
  catalogController.promptAdmitted.mockClear();
  catalogController.promptAdmissionUncertain.mockClear();
  catalogController.turnCompleted.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(
  props: Record<string, unknown> = {},
  customization: WebShellCustomization = EMPTY_CUSTOMIZATION,
): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <WebShellCustomizationProvider value={customization}>
        <I18nProvider language="en">
          <ChatPane {...props} />
        </I18nProvider>
      </WebShellCustomizationProvider>,
    ),
  );
}

function rerender(
  props: Record<string, unknown> = {},
  customization: WebShellCustomization = EMPTY_CUSTOMIZATION,
): void {
  act(() =>
    root!.render(
      <WebShellCustomizationProvider value={customization}>
        <I18nProvider language="en">
          <ChatPane {...props} />
        </I18nProvider>
      </WebShellCustomizationProvider>,
    ),
  );
}

function testid(id: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${id}"]`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe('ChatPane', () => {
  it.each([
    [
      'images',
      [{ data: 'image-data', media_type: 'image/png' }],
      undefined,
      undefined,
    ],
    ['files', undefined, [{ name: 'notes.txt' }], undefined],
    [
      'input annotations',
      undefined,
      undefined,
      {
        inputAnnotations: [
          {
            start: 15,
            end: 22,
            text: '@notes',
            type: 'file',
            data: { path: 'notes.txt' },
          },
        ],
      },
    ],
  ])(
    'rejects /goal with %s and preserves the draft',
    (_kind, images, files, metadata) => {
      const onError = vi.fn();
      render({ onError });
      let returned: boolean | undefined;

      act(() => {
        returned = latestOnSubmit!(
          '/goal set inspect the attachment',
          images,
          files,
          undefined,
          metadata,
        );
      });

      expect(returned).toBe(false);
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        'Remove attachments before using /goal.',
      );
      expect(controlGoal).not.toHaveBeenCalled();
      expect(transcriptDispatch).not.toHaveBeenCalled();
    },
  );

  it('lets the host slash handler intercept /goal before the control plane', () => {
    // The prop contract says the host handler runs before Web Shell handles a
    // slash command; the main composer honours that for /goal, so the pane has
    // to as well or an override silently applies on one surface only.
    const onSlashCommand = vi.fn(() => true);
    render({ onSlashCommand, onOpenGoals: vi.fn() });
    let returned: boolean | undefined;

    act(() => {
      returned = latestOnSubmit!('/goal pause');
    });

    expect(returned).toBe(true);
    expect(onSlashCommand).toHaveBeenCalled();
    expect(getGoal).not.toHaveBeenCalled();
    expect(controlGoal).not.toHaveBeenCalled();
  });

  it('does not swallow a bare /goal when the pane has no goals view', () => {
    // The side-task pane passes no `onOpenGoals`; consuming the text there
    // opens nothing and shows nothing.
    const onError = vi.fn();
    render({ onError });
    let returned: boolean | undefined;

    act(() => {
      returned = latestOnSubmit!('/goal');
    });

    expect(returned).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'The goals view is not available on this surface.',
    );
  });

  it('reports an objective-less /goal set without consuming it', () => {
    const onError = vi.fn();
    render({ onError, onOpenGoals: vi.fn() });
    let returned: boolean | undefined;

    act(() => {
      returned = latestOnSubmit!('/goal set');
    });

    expect(returned).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      '/goal set requires an objective.',
    );
    expect(controlGoal).not.toHaveBeenCalled();
  });

  it('offers Insert only while a turn is running', () => {
    // `insertQueuedPrompt` no-ops at idle, so the affordance has to disappear
    // with it rather than render a button that does nothing.
    queuedPromptsMock = [{ id: 1, text: 'held while the Goal runs' } as never];
    connectionState.goalState = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: 'ship it',
        status: 'active',
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    streamingStateValue = 'idle';
    render();

    expect(testid('pane-queue')?.dataset['canInsertMidTurn']).toBe('false');

    act(() => {
      sessionHasActivePromptValue = true;
      rerender();
    });

    expect(testid('pane-queue')?.dataset['canInsertMidTurn']).toBe('true');

    act(() => {
      sessionHasActivePromptValue = false;
      streamingStateValue = 'responding';
      rerender();
    });

    expect(testid('pane-queue')?.dataset['canInsertMidTurn']).toBe('true');
  });

  it('preserves a /goal command the pane connection cannot deliver', () => {
    // App.tsx applies the broken-connection guard before any slash handling and
    // keeps the text in the composer. Without the same ordering here the branch
    // consumes the text, writes a transcript entry, and only then fails inside
    // `requireSessionForAction` — the typed control is gone.
    const onError = vi.fn();
    connectionState = { ...connectionState, status: 'error' };
    render({ onError });
    let returned: boolean | undefined;

    act(() => {
      returned = latestOnSubmit!('/goal pause');
    });

    expect(returned).toBe(false);
    expect(controlGoal).not.toHaveBeenCalled();
    expect(getGoal).not.toHaveBeenCalled();
    expect(appendLocalUserMessage).not.toHaveBeenCalled();
  });

  it('keeps goal controls locked when the goal is replaced mid-control', async () => {
    const goalA = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const goalB = {
      ...goalA,
      goal: {
        ...goalA.goal,
        goalId: 'goal-b',
        revision: 1,
        objective: 'replaced by another client',
        updatedAt: 2,
      },
    };
    const pendingControl = deferred<{ snapshot: typeof goalA }>();
    connectionState.goalState = goalA;
    getGoal.mockResolvedValue({ snapshot: goalA });
    controlGoal.mockReturnValueOnce(pendingControl.promise);
    render();

    const pause = container!.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());
    await vi.waitFor(() => expect(controlGoal).toHaveBeenCalledOnce());

    // Another client replaces the goal while the pause is still in flight.
    act(() => {
      connectionState = { ...connectionState, goalState: goalB };
      rerender();
    });
    const pauseAfterReplace = container!.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    expect(pauseAfterReplace?.disabled).toBe(true);
    act(() => pauseAfterReplace?.click());
    expect(controlGoal).toHaveBeenCalledOnce();

    await act(async () => pendingControl.resolve({ snapshot: goalB }));
    expect(
      container!.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(false);
  });

  it('locks goal controls while the current snapshot refresh is in flight', async () => {
    const current = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    connectionState.goalState = current;
    let resolveGoal:
      | ((value: { snapshot: typeof current }) => void)
      | undefined;
    getGoal.mockReturnValue(
      new Promise((resolve) => {
        resolveGoal = resolve;
      }),
    );
    controlGoal.mockResolvedValue({ snapshot: current });
    render();

    const pause = container!.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());

    expect(pause.disabled).toBe(true);
    act(() => pause.click());
    expect(getGoal).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveGoal?.({ snapshot: current });
    });
    expect(controlGoal).toHaveBeenCalledTimes(1);
  });

  it('builds the control request from the freshly fetched Goal', async () => {
    // `expectedGoalId`/`expectedRevision` must come from the getGoal round trip,
    // not from the possibly-stale snapshot in connection state, or every
    // control races the daemon's CAS.
    const stale = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const fresh = {
      ...stale,
      goal: { ...stale.goal, revision: 9 },
    };
    connectionState.goalState = stale;
    getGoal.mockResolvedValue({ snapshot: fresh });
    controlGoal.mockResolvedValue({ snapshot: fresh });
    render({ onOpenGoals: vi.fn() });

    act(() => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
        )!
        .click();
    });
    await vi.waitFor(() => expect(controlGoal).toHaveBeenCalledTimes(1));

    expect(controlGoal).toHaveBeenCalledWith({
      action: 'pause',
      expectedGoalId: 'goal-1',
      expectedRevision: 9,
    });

    // `/goal set` maps to a versioned replace against the same fresh snapshot.
    act(() => {
      latestOnSubmit!('/goal set ship the other thing');
    });
    await vi.waitFor(() => expect(controlGoal).toHaveBeenCalledTimes(2));
    expect(controlGoal).toHaveBeenLastCalledWith({
      action: 'replace',
      objective: 'ship the other thing',
      expectedGoalId: 'goal-1',
      expectedRevision: 9,
    });
    expect(appendLocalUserMessage).toHaveBeenCalledWith(
      '/goal set ship the other thing',
    );
  });

  it('closes the pane Goal edit dialog when its session changes', async () => {
    // Left open, the dialog re-syncs its textarea from the new session's
    // objective and the user edits that Goal believing it is the old one.
    const goalA = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 5,
        objective: 'session A objective',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    connectionState.goalState = goalA;
    getGoal.mockResolvedValue({ snapshot: goalA });
    render();

    act(() => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
        )!
        .click();
    });
    expect(document.querySelector('textarea')).not.toBeNull();

    act(() => {
      connectionState = {
        ...connectionState,
        goalState: {
          ...goalA,
          goal: { ...goalA.goal, goalId: 'goal-b', objective: 'goal B' },
        },
      };
      rerender();
    });

    expect(document.querySelector('textarea')).toBeNull();
  });

  it('does not dispatch a Goal control after the pane session changes during refresh', async () => {
    const current = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const pendingGoal = deferred<{ snapshot: typeof current }>();
    const onError = vi.fn();
    connectionState.goalState = current;
    getGoal.mockReturnValueOnce(pendingGoal.promise);
    render({ onError });

    const pause = container!.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());
    act(() => {
      ownerVersion += 1;
      connectionState = { ...connectionState, sessionId: 'sess-2' };
      rerender({ onError });
    });
    await act(async () => pendingGoal.resolve({ snapshot: current }));

    expect(controlGoal).not.toHaveBeenCalled();
    // The operation was dropped on purpose; reporting it would show a failure
    // toast for a control the user's own session switch cancelled.
    expect(onError).not.toHaveBeenCalled();
  });

  it('releases Goal control busy state after a same-session reattach', async () => {
    const current = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const pendingControl = deferred<{ snapshot: typeof current }>();
    connectionState.goalState = current;
    getGoal.mockResolvedValue({ snapshot: current });
    controlGoal.mockReturnValueOnce(pendingControl.promise);
    render();

    const pause = container!.querySelector<HTMLButtonElement>(
      '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
    );
    if (!pause) throw new Error('pause control was not rendered');
    act(() => pause.click());
    await vi.waitFor(() => expect(controlGoal).toHaveBeenCalledOnce());
    act(() => {
      ownerVersion += 1;
      rerender();
    });
    await act(async () => pendingControl.resolve({ snapshot: current }));

    expect(
      container!.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Pause goal"]',
      )?.disabled,
    ).toBe(false);
  });

  it('reports an edit failure after the edited Goal disappears', async () => {
    const current = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 5,
        objective: 'ship it',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const pendingGoal = deferred<{
      snapshot: { v: 2; activity: 'idle'; goal: null };
    }>();
    const onError = vi.fn();
    connectionState.goalState = current;
    getGoal.mockReturnValueOnce(pendingGoal.promise);
    render({ onError });

    act(() => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
        )
        ?.click();
    });
    const save = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('save control was not rendered');
    act(() => save.click());
    act(() => {
      connectionState = {
        ...connectionState,
        goalState: { v: 2, activity: 'idle', goal: null },
      };
      rerender({ onError });
    });
    await act(async () =>
      pendingGoal.resolve({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
    );

    expect(onError).toHaveBeenCalledWith(
      // The guard that produces this message is the only protection the
      // pause/resume/clear flows have against dereferencing a null goal, so
      // pin the message rather than "some Error".
      expect.objectContaining({ message: 'The goal is no longer available.' }),
      'Failed to edit the goal',
    );
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale Goal edit %s after the pane session changes',
    async (outcome) => {
      const goalA = {
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: 'goal-a',
          revision: 5,
          objective: 'session A objective',
          status: 'active' as const,
          evidenceCursor: { recordId: 'record-a' },
          turnCount: 1,
          activeTimeMs: 10,
          createdAt: 1,
          updatedAt: 1,
        },
      };
      const goalB = {
        ...goalA,
        goal: {
          ...goalA.goal,
          goalId: 'goal-b',
          revision: 1,
          objective: 'session B objective',
        },
      };
      let resolveEdit!: (value: { snapshot: typeof goalA }) => void;
      let rejectEdit!: (error: Error) => void;
      const edit = new Promise<{ snapshot: typeof goalA }>(
        (resolve, reject) => {
          resolveEdit = resolve;
          rejectEdit = reject;
        },
      );
      connectionState.goalState = goalA;
      getGoal.mockResolvedValue({ snapshot: goalA });
      controlGoal.mockReturnValueOnce(edit);
      render();

      const editA = container!.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
      );
      if (!editA) throw new Error('session A edit control was not rendered');
      act(() => editA.click());
      const saveA = [
        ...document.querySelectorAll<HTMLButtonElement>('button'),
      ].find((button) => button.textContent === 'Save');
      if (!saveA) throw new Error('session A save control was not rendered');
      act(() => saveA.click());
      await vi.waitFor(() => expect(controlGoal).toHaveBeenCalledTimes(1));

      act(() => {
        ownerVersion += 1;
        connectionState = {
          ...connectionState,
          sessionId: 'sess-2',
          goalState: goalB,
        };
        rerender();
      });
      const editB = container!.querySelector<HTMLButtonElement>(
        '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
      );
      if (!editB) throw new Error('session B edit control was not rendered');
      expect(editB.disabled).toBe(false);
      act(() => editB.click());
      expect(document.querySelector('textarea')).not.toBeNull();

      await act(async () => {
        if (outcome === 'resolve') resolveEdit({ snapshot: goalA });
        else rejectEdit(new Error('session A edit failed'));
        await Promise.resolve();
      });

      expect(document.querySelector('textarea')).not.toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('rejects a Goal edit when the same session replaces the goal', async () => {
    const goalA = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-a',
        revision: 5,
        objective: 'goal A',
        status: 'active' as const,
        evidenceCursor: { recordId: 'record-a' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const goalB = {
      ...goalA,
      goal: { ...goalA.goal, goalId: 'goal-b', objective: 'goal B' },
    };
    const pendingGoal = deferred<{ snapshot: typeof goalB }>();
    const onError = vi.fn();
    connectionState.goalState = goalA;
    getGoal.mockReturnValueOnce(pendingGoal.promise);
    render({ onError });

    act(() => {
      container!
        .querySelector<HTMLButtonElement>(
          '[data-testid="goal-status-strip"] button[aria-label="Edit goal"]',
        )
        ?.click();
    });
    const save = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Save');
    if (!save) throw new Error('save control was not rendered');
    act(() => save.click());
    act(() => {
      connectionState = { ...connectionState, goalState: goalB };
      rerender({ onError });
    });
    await act(async () => pendingGoal.resolve({ snapshot: goalB }));

    expect(controlGoal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to edit the goal',
    );
  });

  it('opens a pane monitor in the shared right panel', async () => {
    connectionState.capabilities = {
      features: ['session_monitor_tool_correlation'],
    };
    const monitor = {
      kind: 'monitor',
      id: 'monitor-1',
      label: 'monitor-label',
      description: 'watch pane logs',
      status: 'running',
      startTime: 1,
      runtimeMs: 10,
      command: 'tail -f pane.log',
      eventCount: 1,
      droppedLines: 0,
      toolUseId: 'monitor-call',
    };
    getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'sess-1',
      now: 11,
      tasks: [monitor],
    });
    const onOpenMonitor = vi.fn();

    render({ onOpenMonitor });

    let opened = false;
    await act(async () => {
      opened =
        (await latestMonitorDetailsOnOpen?.({
          callId: 'monitor-call',
          toolName: 'monitor',
          status: 'completed',
        })) ?? false;
    });

    expect(opened).toBe(true);
    expect(getTasks).toHaveBeenCalledOnce();
    expect(onOpenMonitor).toHaveBeenCalledWith(
      monitor,
      'sess-1',
      daemonActions,
    );
  });

  it('does not open a monitor returned for another pane session', async () => {
    connectionState.capabilities = {
      features: ['session_monitor_tool_correlation'],
    };
    getTasks.mockResolvedValue({
      v: 1,
      sessionId: 'other-session',
      now: 11,
      tasks: [],
    });
    const onOpenMonitor = vi.fn();

    render({ onOpenMonitor });

    let opened = true;
    await act(async () => {
      opened =
        (await latestMonitorDetailsOnOpen?.({
          callId: 'monitor-call',
          toolName: 'monitor',
          status: 'completed',
        })) ?? false;
    });

    expect(opened).toBe(false);
    expect(onOpenMonitor).not.toHaveBeenCalled();
  });

  it('renders the custom composer footer directly after the pane editor', () => {
    const footerProps: WebShellComposerToolbarRenderInfo[] = [];
    const ComposerFooter = (props: WebShellComposerToolbarRenderInfo) => {
      footerProps.push(props);
      return <div data-testid="pane-composer-footer">pane footer</div>;
    };

    render({}, { renderComposerFooter: ComposerFooter });

    const composer = container!.querySelector('[data-web-shell-composer]');
    const footer = testid('pane-composer-footer');
    expect(composer?.nextElementSibling).toBe(footer);
    expect(footer?.parentElement).toBe(composer?.parentElement);
    expect(footerProps.at(-1)).toEqual({
      disabled: false,
      isRunning: false,
      currentMode: 'default',
      currentModel: '',
      sessionName: 'Refactor core',
    });
  });

  it('updates the custom composer footer with pane-scoped state', () => {
    const footerProps: WebShellComposerToolbarRenderInfo[] = [];
    const ComposerFooter = (props: WebShellComposerToolbarRenderInfo) => {
      footerProps.push(props);
      return <div data-testid="pane-composer-footer" />;
    };
    const customization = { renderComposerFooter: ComposerFooter };
    render({}, customization);

    streamingStateValue = 'responding';
    connectionState.catchingUp = true;
    connectionState.currentMode = 'plan';
    connectionState.currentModel = 'qwen-next';
    connectionState.displayName = 'Pane Two';
    rerender({}, customization);

    expect(footerProps.at(-1)).toEqual({
      disabled: false,
      isRunning: true,
      currentMode: 'plan',
      currentModel: 'qwen-next',
      sessionName: 'Pane Two',
    });

    connectionState.catchingUp = false;
    pendingPermission = {
      id: 'perm-1',
      toolName: 'write_file',
      rawInput: {},
    };
    rerender({}, customization);

    expect(latestChatEditorProps.disabled).toBe(true);
    expect(footerProps.at(-1)?.disabled).toBe(true);
  });

  it('hides the pane composer while an approval is pending', () => {
    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    render();
    expect(testid('pane-approval')).not.toBeNull();
    // The streaming status and the editor share the approval-hidden wrapper,
    // so neither lingers below the dialog.
    expect(testid('pane-streaming')?.parentElement?.className).toContain(
      'composerHidden',
    );
    expect(
      container!.querySelector('[data-web-shell-composer]')?.parentElement
        ?.className,
    ).toContain('composerHidden');
  });

  it('restores the pane composer after the approval resolves', () => {
    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    render();
    expect(
      container!.querySelector('[data-web-shell-composer]')?.parentElement
        ?.className,
    ).toContain('composerHidden');

    pendingPermission = null;
    rerender();
    expect(testid('pane-approval')).toBeNull();
    expect(
      container!.querySelector('[data-web-shell-composer]')?.parentElement
        ?.className,
    ).not.toContain('composerHidden');
  });

  it('adds no composer footer DOM when omitted or returning null', () => {
    render();
    const composer = container!.querySelector('[data-web-shell-composer]');
    const children = Array.from(composer?.parentElement?.children ?? []);
    expect(composer?.nextElementSibling).toBeNull();
    expect(latestChatEditorProps.disabled).toBe(false);

    rerender({}, { renderComposerFooter: () => null });

    const nullComposer = container!.querySelector('[data-web-shell-composer]');
    expect(nullComposer?.nextElementSibling).toBeNull();
    expect(
      Array.from(nullComposer?.parentElement?.children ?? []),
    ).toHaveLength(children.length);
  });

  it('renders the session transcript and header label', () => {
    render({ title: 'Refactor core' });
    expect(testid('pane-messages')?.textContent).toBe('1');
    expect(container!.textContent).toContain('Refactor core');
  });

  it('omits its frame header when embedded in another panel', () => {
    render({ title: 'Side task', embedded: true });
    expect(container!.querySelector('header')).toBeNull();
    expect(testid('pane-messages')).not.toBeNull();
  });

  it('adds no workspace toolbar chip on a single-workspace daemon', () => {
    render({ title: 'Refactor core', workspaceCwd: '/w' });
    expect(latestChatEditorProps.visibleToolbarActions).toContain('addMenu');
    expect(latestChatEditorProps.visibleToolbarActions).not.toContain(
      'workspace',
    );
    expect(latestChatEditorProps.workspaceName).toBeUndefined();
  });

  it('does not thread host at mention props onto ChatEditor', () => {
    render(
      { title: 'Refactor core' },
      {
        atProviders: [
          {
            id: 'tables',
            label: 'Tables',
            async search() {
              return [];
            },
          },
        ],
        builtinAtProviders: { exclude: ['extensions'] },
      },
    );
    expect(latestChatEditorProps.atProviders).toBeUndefined();
    expect(latestChatEditorProps.builtinAtProviders).toBeUndefined();
  });

  it('shows the pane workspace as a toolbar chip on a multi-workspace daemon', () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/work/web-shell',
      workspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
        {
          id: 'w1',
          cwd: '/work/api',
          displayName: 'Payments API',
          primary: false,
          trusted: true,
        },
      ],
    };
    // The split view hands each pane its own workspace explicitly.
    render({ title: 'Add pagination', workspaceCwd: '/work/api' });
    expect(latestChatEditorProps.visibleToolbarActions).toContain('workspace');
    expect(latestChatEditorProps.workspaceName).toBe('Payments API');
    expect(latestChatEditorProps.workspaceTitle).toBe('/work/api');
    // The chip carries the pane's stable accent color (api is the 2nd workspace
    // → the 2nd palette color) so it stays distinct when it collapses to an icon.
    expect(latestChatEditorProps.workspaceColor).toBe('green');
  });

  it('binds split Voice to the connected secondary workspace and revision', () => {
    connectionState.workspaceCwd = '/work/api';
    connectionState.capabilities = {
      features: ['workspace_qualified_voice'],
      workspaceCwd: '/work/web-shell',
      workspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
        { id: 'w1', cwd: '/work/api', primary: false, trusted: true },
      ],
    };

    render({
      workspaceCwd: '/work/api',
      voiceUserRevision: 3,
      voiceWorkspaceRevisions: {
        '["workspace-qualified","id","w1","/work/api"]': 5,
      },
    });

    expect(latestChatEditorProps.voiceTarget).toMatchObject({
      route: 'workspace-qualified',
      cwd: '/work/api',
      selector: { kind: 'id', value: 'w1' },
      sessionId: 'sess-1',
      streamPath: 'workspaces/w1/voice/stream',
    });
    expect(latestChatEditorProps.voiceStatusRevision).toEqual({
      user: 3,
      workspace: 5,
    });
  });

  it('binds split Voice to the legacy primary workspace without a workspace list', () => {
    connectionState.capabilities = {
      features: ['voice_transcribe'],
      workspaceCwd: '/w',
    };

    render({ workspaceCwd: '/w' });

    expect(latestChatEditorProps.voiceTarget).toMatchObject({
      route: 'legacy-primary',
      cwd: '/w',
      sessionId: 'sess-1',
      streamPath: 'voice/stream',
    });
  });

  it('keeps an active split Voice owner stable while approval is pending', () => {
    connectionState.capabilities = {
      features: ['voice_transcribe'],
      workspaceCwd: '/w',
    };
    render({ workspaceCwd: '/w' });
    const voiceTarget = latestChatEditorProps.voiceTarget;
    const voiceStatusRevision = latestChatEditorProps.voiceStatusRevision;
    expect(voiceTarget).toBeDefined();

    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    rerender({ workspaceCwd: '/w' });

    expect(latestChatEditorProps.dialogOpen).toBe(true);
    expect(latestChatEditorProps.disabled).toBe(true);
    expect(latestChatEditorProps.voiceTarget).toBe(voiceTarget);
    expect(latestChatEditorProps.voiceStatusRevision).toBe(voiceStatusRevision);
  });

  it('uses the merged registered workspace list for split Voice', () => {
    connectionState.workspaceCwd = '/work/locked';
    connectionState.capabilities = {
      features: ['workspace_qualified_voice'],
      workspaceCwd: '/work/web-shell',
      workspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
      ],
    };

    render({
      workspaceCwd: '/work/locked',
      voiceWorkspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
        {
          id: 'locked',
          cwd: '/work/locked',
          primary: false,
          trusted: true,
        },
      ],
    });

    expect(latestChatEditorProps.voiceTarget).toMatchObject({
      route: 'workspace-qualified',
      cwd: '/work/locked',
      selector: { kind: 'id', value: 'locked' },
      streamPath: 'workspaces/locked/voice/stream',
    });
  });

  it('fails closed on split workspace mismatch and while hidden', () => {
    connectionState.workspaceCwd = '/work/api';
    connectionState.capabilities = {
      features: ['workspace_qualified_voice'],
      workspaceCwd: '/work/web-shell',
      workspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
        { id: 'w1', cwd: '/work/api', primary: false, trusted: true },
      ],
    };

    render({ workspaceCwd: '/work/other' });
    expect(latestChatEditorProps.voiceTarget).toBeUndefined();

    rerender({ workspaceCwd: '/work/api', hidden: true });
    expect(latestChatEditorProps.voiceTarget).toBeUndefined();
  });

  it('surfaces the workspace in the pane header on a multi-workspace daemon', () => {
    connectionState.capabilities = {
      features: [],
      workspaceCwd: '/work/web-shell',
      workspaces: [
        { id: 'w0', cwd: '/work/web-shell', primary: true, trusted: true },
        {
          id: 'w1',
          cwd: '/work/api',
          displayName: 'Payments API',
          primary: false,
          trusted: true,
        },
      ],
    };
    render({ title: 'Add pagination', workspaceCwd: '/work/api' });
    // The header tag (always visible at the top, unlike the composer chip that
    // collapses on a narrow split) names the workspace and carries its full cwd
    // in a hover tooltip.
    const tag = container!.querySelector('[data-web-shell-pane-workspace]');
    expect(tag).not.toBeNull();
    expect(tag!.textContent).toContain('Payments API');
    expect(tag!.getAttribute('title')).toBe('/work/api');
  });

  it('omits the header workspace tag on a single-workspace daemon', () => {
    render({ title: 'Refactor core', workspaceCwd: '/w' });
    expect(
      container!.querySelector('[data-web-shell-pane-workspace]'),
    ).toBeNull();
  });

  it('reports loaded pane artifacts to the outer panel owner', async () => {
    const onPaneArtifactsChange = vi.fn();
    connectionState.capabilities = { features: ['session_artifacts'] };
    const artifact = {
      id: 'artifact-1',
      title: 'Report',
      kind: 'html',
      storage: 'workspace',
      workspacePath: 'reports/a.html',
      updatedAt: '2026-07-10T00:00:00Z',
    };
    loadArtifacts.mockResolvedValueOnce({ artifacts: [artifact] });

    render({ onPaneArtifactsChange });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onPaneArtifactsChange).toHaveBeenLastCalledWith('sess-1', [
      artifact,
    ]);
  });

  it('stamps its session identity on turn-output open requests', () => {
    const onRightPanelOpen = vi.fn();
    render({ onRightPanelOpen });

    act(() => {
      testid('pane-open-turn-output')?.click();
    });

    expect(onRightPanelOpen).toHaveBeenCalledWith({
      id: 'artifact:turn-artifact',
      kind: 'artifact',
      title: 'Turn artifact',
      turnId: 'turn-1',
      artifactId: 'turn-artifact',
      artifact: { id: 'turn-artifact', title: 'Turn artifact' },
      workspaceCwd: '/w',
      sourceSessionId: 'sess-1',
    });
  });

  it('reads daemon attachments through the pane session before previewing', async () => {
    const onRightPanelOpen = vi.fn();
    render({ onRightPanelOpen });

    await act(async () => {
      testid('pane-open-attachment')?.click();
      await Promise.resolve();
    });

    expect(readAttachment).toHaveBeenCalledWith('attachment-1');
    expect(onRightPanelOpen).toHaveBeenCalledWith({
      id: 'attachment:attachment-1',
      kind: 'attachment',
      title: 'data.json',
      turnId: 'sess-1',
      mimeType: 'application/json',
      data: expect.any(Blob),
      workspaceCwd: '/w',
      sourceSessionId: 'sess-1',
    });
  });

  it('suppresses the rotating loading phrase in its compact status', () => {
    render();
    expect(testid('pane-streaming')?.getAttribute('data-show-phrase')).toBe(
      'false',
    );
  });

  it('sends an idle prompt directly so the pane enters loading immediately', () => {
    render();
    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('hello there', {
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
    expect(clearFollowup).not.toHaveBeenCalled();
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('sends an idle prompt while the Goal state is still hydrating', () => {
    connectionState = { ...connectionState, goalState: undefined };
    render();

    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('inserts a hydrating prompt while the session is active', () => {
    connectionState = { ...connectionState, goalState: undefined };
    streamingStateValue = 'responding';
    render();

    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).toHaveBeenCalled();
    expect(queuedPromptStreamingState).toBe('responding');
    expect(queuedPromptSessionHasActivePrompt).toBe(false);
  });

  it('inserts a prompt before the first stream event reaches the pane', () => {
    sessionHasActivePromptValue = true;
    render();

    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).toHaveBeenCalled();
    expect(queuedPromptStreamingState).toBe('idle');
    expect(queuedPromptSessionHasActivePrompt).toBe(true);

    sendPrompt.mockClear();
    enqueuePrompt.mockClear();
    act(() => {
      sessionHasActivePromptValue = false;
      rerender();
    });
    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(queuedPromptStreamingState).toBe('idle');
    expect(queuedPromptSessionHasActivePrompt).toBe(false);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('sends an idle prompt when an active Goal is known', () => {
    connectionState.goalState = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: 'ship it',
        status: 'active',
        evidenceCursor: { recordId: 'record-1' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    render();

    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(enqueuePrompt).not.toHaveBeenCalled();

    sendPrompt.mockClear();
    let accepted: boolean | undefined;
    act(() => {
      accepted = latestOnSubmit!('/deploy production');
    });
    expect(accepted).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it.each(['idle', 'responding'] as const)(
    'blocks a forwarded slash command while Goal state is hydrating (%s)',
    (streamingState) => {
      streamingStateValue = streamingState;
      connectionState = { ...connectionState, goalState: undefined };
      render();

      let accepted: boolean | undefined;
      act(() => {
        accepted = latestOnSubmit!('/deploy production');
      });

      expect(accepted).toBe(false);
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(enqueuePrompt).not.toHaveBeenCalled();
    },
  );

  it('lets the host handle a slash command', () => {
    const onSlashCommand = vi.fn(() => true);
    render({ onSlashCommand });
    let returned: boolean | undefined;

    act(() => {
      returned = latestOnSubmit!('/deploy production');
    });

    expect(returned).toBe(true);
    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'deploy',
      args: 'production',
      input: '/deploy production',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('forwards a slash command the host does not handle', () => {
    const onSlashCommand = vi.fn();
    render({ onSlashCommand });

    act(() => {
      latestOnSubmit!('/deploy staging');
    });

    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('/deploy staging', {
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
  });

  it('queues a forwarded slash command while the pane is running', () => {
    streamingStateValue = 'responding';
    const onSlashCommand = vi.fn();
    render({ onSlashCommand });

    act(() => {
      latestOnSubmit!('/deploy staging');
    });

    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).toHaveBeenCalledWith(
      '/deploy staging',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  it('lets the host handle a slash command while the pane is disconnected', () => {
    connectionState.status = 'disconnected';
    const onSlashCommand = vi.fn(() => true);
    render({ onSlashCommand });

    act(() => {
      latestOnSubmit!('/deploy staging');
    });

    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('reports a host slash command error and continues default handling', () => {
    const error = new Error('host handler exploded');
    const onSlashCommand = vi.fn(() => {
      throw error;
    });
    const onError = vi.fn();
    render({ onSlashCommand, onError });

    act(() => {
      latestOnSubmit!('/deploy staging');
    });

    expect(onError).toHaveBeenCalledWith(
      error,
      'onSlashCommand callback failed',
    );
    expect(sendPrompt).toHaveBeenCalledWith('/deploy staging', {
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
  });

  it('does not treat an absolute path as a slash command', () => {
    const onSlashCommand = vi.fn(() => true);
    render({ onSlashCommand });

    act(() => {
      latestOnSubmit!('/usr/local/bin/tool');
    });

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('/usr/local/bin/tool', {
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
  });

  it('commits an idle prompt only after daemon admission', () => {
    render();
    const commit = vi.fn();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('hi', undefined, undefined, commit);
    });
    expect(returned).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    act(() => sendPromptAdmit!());
    expect(catalogController.promptAdmitted).toHaveBeenCalledWith(
      '/w',
      'sess-1',
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(clearFollowup).toHaveBeenCalledTimes(1);
  });

  it('does not attribute prompt admission across a workspace mismatch', () => {
    connectionState.workspaceCwd = '/other';
    render({ workspaceCwd: '/w' });

    act(() => {
      latestOnSubmit!('hi');
      sendPromptAdmit!();
    });

    expect(catalogController.promptAdmitted).not.toHaveBeenCalled();
  });

  it('does not update a catalog without an owning workspace', () => {
    connectionState.workspaceCwd = undefined;
    render();

    act(() => {
      latestOnSubmit!('hi');
      sendPromptAdmit!();
    });

    expect(catalogController.promptAdmitted).not.toHaveBeenCalled();

    streamingStateValue = 'responding';
    rerender();
    act(() => {
      latestOnSubmit!('queued next');
    });
    expect(catalogController.invalidateWorkspace).not.toHaveBeenCalled();

    streamingStateValue = 'idle';
    rerender();
    expect(catalogController.turnCompleted).not.toHaveBeenCalled();
  });

  it('forwards images with an idle prompt', () => {
    const images = [{ data: 'image-data', media_type: 'image/png' }];
    render();
    act(() => {
      latestOnSubmit!('with image', images);
    });
    expect(sendPrompt).toHaveBeenCalledWith('with image', {
      images,
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
  });

  it('submits image-only prompts and preserves first-text naming eligibility', () => {
    const images = [{ data: 'image-data', media_type: 'image/png' }];
    const onFirstPromptAdmitted = vi.fn();
    render({ onFirstPromptAdmitted });

    act(() => {
      latestOnSubmit!('', images);
    });
    expect(sendPrompt).toHaveBeenCalledWith('', {
      images,
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
    act(() => sendPromptAdmit!());
    expect(onFirstPromptAdmitted).not.toHaveBeenCalled();

    act(() => {
      latestOnSubmit!('name this task');
    });
    act(() => sendPromptAdmit!());
    expect(onFirstPromptAdmitted).toHaveBeenCalledOnce();
    expect(onFirstPromptAdmitted).toHaveBeenCalledWith('name this task');
  });

  it('forwards composer annotations with an idle prompt', () => {
    const inputAnnotations = [
      {
        start: 6,
        end: 14,
        text: '@.husky/',
        type: 'file',
        data: { path: '.husky/' },
      },
    ];
    render();
    act(() => {
      latestOnSubmit!('check @.husky/', undefined, undefined, undefined, {
        inputAnnotations,
      });
    });
    expect(sendPrompt).toHaveBeenCalledWith('check @.husky/', {
      inputAnnotations,
      onAdmissionStarted: expect.any(Function),
      onAdmitted: expect.any(Function),
    });
  });

  it('queues a prompt while the pane is already running', () => {
    streamingStateValue = 'responding';
    render();
    const commit = vi.fn();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('queued next', undefined, undefined, commit);
    });
    expect(returned).toBe(true);
    expect(enqueuePrompt).toHaveBeenCalledWith(
      'queued next',
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(catalogController.invalidateWorkspace).toHaveBeenCalledWith('/w');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('names a side task when its first text prompt is admitted from the queue', () => {
    streamingStateValue = 'responding';
    const onFirstPromptAdmitted = vi.fn();
    render({ onFirstPromptAdmitted });

    act(() => {
      latestOnSubmit!('name this queued task');
    });

    const onAdmitted = enqueuePrompt.mock.calls[0]?.[5] as
      | (() => void)
      | undefined;
    expect(onAdmitted).toEqual(expect.any(Function));
    act(() => onAdmitted?.());
    expect(onFirstPromptAdmitted).toHaveBeenCalledOnce();
    expect(onFirstPromptAdmitted).toHaveBeenCalledWith('name this queued task');
  });

  it('resynchronizes the owning catalog when a pane turn completes', () => {
    streamingStateValue = 'responding';
    render();

    streamingStateValue = 'idle';
    rerender();

    expect(catalogController.turnCompleted).toHaveBeenCalledWith(
      '/w',
      'sess-1',
    );
  });

  it('does not duplicate turn completion owned by the outer session', () => {
    streamingStateValue = 'responding';
    render({ reportCatalogTurnCompletion: false });

    streamingStateValue = 'idle';
    rerender({ reportCatalogTurnCompletion: false });

    expect(catalogController.turnCompleted).not.toHaveBeenCalled();
  });

  it('does not attribute a completed pane turn to a different workspace', () => {
    streamingStateValue = 'responding';
    render();

    connectionState.workspaceCwd = '/other';
    streamingStateValue = 'idle';
    rerender();

    expect(catalogController.turnCompleted).not.toHaveBeenCalled();
  });

  it('captures a pane identity that becomes available mid-turn', () => {
    connectionState.sessionId = undefined;
    streamingStateValue = 'responding';
    render();

    connectionState.sessionId = 'sess-late';
    rerender();
    streamingStateValue = 'idle';
    rerender();

    expect(catalogController.turnCompleted).toHaveBeenCalledWith(
      '/w',
      'sess-late',
    );
  });

  it('captures a pane workspace that becomes available mid-turn', () => {
    connectionState.workspaceCwd = undefined;
    streamingStateValue = 'responding';
    render();

    connectionState.workspaceCwd = '/secondary';
    rerender();
    streamingStateValue = 'idle';
    rerender();

    expect(catalogController.turnCompleted).toHaveBeenCalledTimes(1);
    expect(catalogController.turnCompleted).toHaveBeenCalledWith(
      '/secondary',
      'sess-1',
    );
    expect(catalogController.turnCompleted).not.toHaveBeenCalledWith(
      '/primary',
      'sess-1',
    );
  });

  it('forwards composer annotations with a queued prompt', () => {
    streamingStateValue = 'responding';
    const inputAnnotations = [
      {
        start: 6,
        end: 14,
        text: '@.husky/',
        type: 'file',
        data: { path: '.husky/' },
      },
    ];
    render();
    act(() => {
      latestOnSubmit!('queue @.husky/', undefined, undefined, undefined, {
        inputAnnotations,
      });
    });
    expect(enqueuePrompt).toHaveBeenCalledWith(
      'queue @.husky/',
      undefined,
      undefined,
      undefined,
      inputAnnotations,
      expect.any(Function),
    );
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('forwards images with a queued prompt', () => {
    streamingStateValue = 'responding';
    const images = [{ data: 'image-data', media_type: 'image/png' }];
    render();
    act(() => {
      latestOnSubmit!('queued image', images);
    });
    expect(enqueuePrompt).toHaveBeenCalledWith(
      'queued image',
      images,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  it('queues an image-only prompt while the pane is already running', () => {
    streamingStateValue = 'responding';
    const images = [{ data: 'image-data', media_type: 'image/bmp' }];
    render();

    act(() => {
      latestOnSubmit!('', images);
    });

    expect(enqueuePrompt).toHaveBeenCalledWith('', images, undefined);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('submits while disconnected when a session exists', () => {
    connectionState.status = 'disconnected';
    render();
    act(() => {
      latestOnSubmit!('hi');
    });

    expect(sendPrompt).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ onAdmitted: expect.any(Function) }),
    );
  });

  it('does not submit without a session while disconnected', () => {
    connectionState.status = 'disconnected';
    connectionState.sessionId = undefined;
    render();

    act(() => {
      latestOnSubmit!('hi');
    });

    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('locks the pane when idle prompt admission outcome is unknown', async () => {
    const onError = vi.fn();
    const onImageIngestionNotice = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendPrompt.mockImplementationOnce(async (_text, options) => {
      options?.onAdmissionStarted?.();
      throw new Error('disconnected');
    });
    render({ onError, onImageIngestionNotice });
    const commit = vi.fn();
    await act(async () => {
      latestOnSubmit!('hi', undefined, undefined, commit);
      await Promise.resolve();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(clearFollowup).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onImageIngestionNotice).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('uncertain'),
    );
    const notice = testid('pane-prompt-admission-unknown');
    expect(notice).not.toBeNull();
    expect(latestChatEditorProps.disabled).toBe(true);
    expect(catalogController.promptAdmissionUncertain).toHaveBeenCalledWith(
      '/w',
    );
    expect(catalogController.promptAdmitted).not.toHaveBeenCalled();
    act(() => latestOnSubmit!('do not retry'));
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    act(() => {
      notice?.querySelectorAll('button').item(0).click();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(latestChatEditorProps.disabled).toBe(true);

    confirm.mockReturnValue(true);
    act(() => {
      notice?.querySelectorAll('button').item(0).click();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(latestChatEditorProps.disabled).toBe(false);
    expect(testid('pane-prompt-admission-unknown')).not.toBeNull();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
    warn.mockRestore();
  });

  it('keeps an unknown admission locked across an unrelated stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendPrompt.mockImplementationOnce(async (_text, options) => {
      options?.onAdmissionStarted?.();
      throw new Error('response lost');
    });
    render();

    await act(async () => {
      latestOnSubmit!('hi');
      await Promise.resolve();
    });
    expect(testid('pane-prompt-admission-unknown')).not.toBeNull();

    streamingStateValue = 'responding';
    rerender();

    expect(testid('pane-prompt-admission-unknown')).not.toBeNull();
    expect(latestChatEditorProps.disabled).toBe(true);
    warn.mockRestore();
  });

  it('does not mark a turn error unknown after admission', async () => {
    const onError = vi.fn();
    let rejectTurn!: (error: unknown) => void;
    sendPrompt.mockImplementationOnce((_text, options) => {
      options?.onAdmissionStarted?.();
      sendPromptAdmit = options?.onAdmitted;
      return new Promise((_resolve, reject) => {
        rejectTurn = reject;
      });
    });
    render({ onError });
    const commit = vi.fn();

    act(() => {
      latestOnSubmit!('hi', undefined, undefined, commit);
      sendPromptAdmit?.();
    });
    await act(async () => {
      rejectTurn(new Error('turn failed'));
      await Promise.resolve();
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(testid('pane-prompt-admission-unknown')).toBeNull();
    expect(latestChatEditorProps.disabled).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'turn failed' }),
      'Failed to send prompt',
    );
  });

  it('discards an unknown local payload without hiding its marker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendPrompt.mockImplementationOnce(async (_text, options) => {
      options?.onAdmissionStarted?.();
      throw new Error('disconnected');
    });
    render();
    const commit = vi.fn();
    await act(async () => {
      latestOnSubmit!('hi', undefined, undefined, commit);
      await Promise.resolve();
    });

    act(() => {
      testid('pane-prompt-admission-unknown')
        ?.querySelectorAll('button')
        .item(1)
        .click();
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(latestChatEditorProps.disabled).toBe(false);
    expect(testid('pane-prompt-admission-unknown')).not.toBeNull();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps the pane editable after a definite 413 rejection', async () => {
    const onError = vi.fn();
    sendPrompt.mockRejectedValueOnce(
      new DaemonHttpError(413, undefined, 'Too large'),
    );
    render({ onError });

    await act(async () => {
      latestOnSubmit!('hi');
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.any(DaemonHttpError),
      'Failed to send prompt',
    );
    expect(latestChatEditorProps.disabled).toBe(false);
  });

  it('keeps pane approvals click-only (no global keyboard shortcuts)', () => {
    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    render();
    expect(testid('tool-approval')?.getAttribute('data-keyboard-active')).toBe(
      'false',
    );
  });

  it('passes this pane workflow to its exit-plan approval', () => {
    messagesState = [
      {
        id: 'plan-update',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-call-1',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              entries: [
                {
                  content: 'Prepare',
                  status: 'completed',
                  _meta: { qwenTodo: { id: 'prepare' } },
                },
                {
                  content: 'Ship',
                  status: 'pending',
                  _meta: {
                    qwenTodo: { id: 'ship', blockedBy: ['prepare'] },
                  },
                },
              ],
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
      {
        id: 'plan-update-newer',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-call-2',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              entries: [
                {
                  content: 'Ship v2',
                  status: 'pending',
                  _meta: { qwenTodo: { id: 'ship-v2' } },
                },
              ],
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    messagesState.push({
      id: 'revision',
      role: 'user',
      content: 'Revise the wording',
    });
    pendingPermission = {
      id: 'perm-plan',
      toolKind: 'switch_mode',
      toolName: 'exit_plan_mode',
      todoPlan: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
      rawInput: {},
    };

    render({ sessionWorkflowEnabled: true });

    expect(testid('tool-approval')?.getAttribute('data-plan-todos')).toBe(
      '["prepare","ship"]',
    );
  });

  it('keeps the exit-plan approval text-only when Session Workflow is off', () => {
    messagesState = [
      {
        id: 'plan-update',
        role: 'tool_group',
        tools: [
          {
            callId: 'todo-call-1',
            toolName: 'todo_write',
            status: 'completed',
            rawOutput: {
              entries: [{ content: 'Ship', status: 'pending' }],
              plan: { id: 'plan-1' },
            },
          },
        ],
      },
    ];
    pendingPermission = {
      id: 'perm-plan',
      toolKind: 'switch_mode',
      toolName: 'exit_plan_mode',
      todoPlan: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
      rawInput: {},
    };

    render();

    expect(testid('tool-approval')?.getAttribute('data-plan-todos')).toBe('[]');
  });

  it('reflects streaming state on the composer', () => {
    streamingStateValue = 'responding';
    render();
    expect(testid('pane-running')?.textContent).toBe('true');
  });

  it('renders a tool approval and resolves it via submitPermission', () => {
    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    render();
    expect(testid('tool-approval')).not.toBeNull();
    expect(testid('pane-messages')?.getAttribute('data-approval')).toBe('yes');
    expect(testid('pane-dialogopen')?.textContent).toBe('true');
    act(() =>
      testid('tool-approval')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(submitPermission).toHaveBeenCalledWith(
      'perm-1',
      'proceed',
      undefined,
    );
  });

  it('routes an AskUserQuestion permission to the AskUserQuestion overlay', () => {
    pendingPermission = {
      id: 'ask-1',
      rawInput: { questions: [{ question: 'pick', options: [] }] },
    };
    render();
    expect(testid('ask-approval')).not.toBeNull();
    // Like the tool-approval path, a pane's question must not auto-grab focus —
    // several panes can show at once and stealing focus would yank it from the
    // pane the user is in.
    expect(testid('ask-approval')?.getAttribute('data-keyboard-active')).toBe(
      'false',
    );
    // AskUserQuestion is not a tool approval, so MessageList gets no inline one.
    expect(testid('pane-messages')?.getAttribute('data-approval')).toBe('no');
  });

  it('invokes onClose from the header close button', () => {
    const onClose = vi.fn();
    render({ onClose });
    const closeBtn = container!.querySelector('[data-testid="pane-close"]');
    act(() =>
      closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders no maximize toggle without onToggleMaximize', () => {
    render({ onClose: () => {} });
    expect(container!.querySelector('[aria-label="Maximize pane"]')).toBeNull();
    expect(container!.querySelector('[aria-label="Restore pane"]')).toBeNull();
  });

  it('invokes onToggleMaximize from the header maximize button', () => {
    const onToggleMaximize = vi.fn();
    render({ onToggleMaximize });
    const maximizeBtn = container!.querySelector(
      '[aria-label="Maximize pane"]',
    );
    expect(maximizeBtn).not.toBeNull();
    // A toggle button always exposes its pressed state; not maximized here.
    expect(maximizeBtn!.getAttribute('aria-pressed')).toBe('false');
    act(() =>
      maximizeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('shows the restore affordance while maximized', () => {
    render({ onToggleMaximize: () => {}, isMaximized: true });
    const restoreBtn = container!.querySelector('[aria-label="Restore pane"]');
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn!.getAttribute('aria-pressed')).toBe('true');
    // The label flips to "restore" — no stale "maximize" affordance remains.
    expect(container!.querySelector('[aria-label="Maximize pane"]')).toBeNull();
  });

  it('renders host header actions scoped to the pane session', () => {
    const renderHeaderActions = vi.fn(
      (info: { sessionId: string; workspaceCwd?: string }) => (
        <button type="button" data-testid="host-pane-action">
          {info.sessionId}:{info.workspaceCwd ?? ''}
        </button>
      ),
    );
    render({
      title: 'Refactor core',
      workspaceCwd: '/work/api',
      renderHeaderActions,
    });
    expect(renderHeaderActions).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      workspaceCwd: '/work/api',
      sessionActions: daemonActions,
    });
    expect(testid('host-pane-action')?.textContent).toBe('sess-1:/work/api');
    expect(testid('pane-header-actions')).not.toBeNull();
  });

  it('cancels the active turn via the composer cancel action', () => {
    render();
    act(() =>
      testid('pane-cancel')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not send a whitespace-only prompt', () => {
    render();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('   ', undefined, undefined, vi.fn());
    });
    expect(returned).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('passes queued prompts and queue editing controls to the pane editor', () => {
    queuedPromptsMock = [{ id: 1, text: 'queued next' }];
    queuedTextsMock = ['queued next'];
    render();
    expect(testid('pane-queue')?.textContent).toBe('1');
    expect(testid('pane-queued-messages')?.textContent).toBe(
      JSON.stringify(['queued next']),
    );
    expect(latestChatEditorProps.onPopQueuedMessages()).toBe(false);
    expect(latestChatEditorProps.onClearQueuedMessages()).toBe(false);
    expect(editLastQueuedPrompt).toHaveBeenCalledTimes(1);
    expect(clearQueuedPrompts).toHaveBeenCalledTimes(1);
  });

  it('enables mid-turn queue mutations only when advertised', () => {
    queuedPromptsMock = [{ id: 1, text: 'queued next' }];
    connectionState.capabilities = {
      features: ['session_mid_turn_message_mutation'],
    };
    render();

    expect(testid('pane-queue')?.dataset.canMutateMidTurn).toBe('true');
  });

  it('disables mid-turn queue mutations when not advertised', () => {
    queuedPromptsMock = [{ id: 1, text: 'queued next' }];
    render();
    expect(testid('pane-queue')?.dataset.canMutateMidTurn).toBe('false');
  });

  it('passes follow-up suggestions to the pane editor', () => {
    render();
    expect(testid('pane-followup')?.textContent).toBe('next idea');
    expect(latestChatEditorProps.onAcceptFollowup).toBeTypeOf('function');
    expect(latestChatEditorProps.onDismissFollowup).toBeTypeOf('function');
    expect(latestFollowupAccept).toBeTypeOf('function');
    act(() => latestFollowupAccept!('test suggestion'));
    expect(insertText).toHaveBeenCalledWith('test suggestion');
  });

  it('surfaces a connection-loss banner when the pane connection drops', () => {
    connectionState.error = 'socket closed';
    render();
    expect(container!.textContent).toContain('Connection lost');
    expect(container!.textContent).toContain('socket closed');
  });

  it('shows no connection banner when the connection is healthy', () => {
    render();
    expect(container!.textContent).not.toContain('Connection lost');
  });

  it('anchors the streaming timer to the active turn (last user message time)', () => {
    streamingStateValue = 'responding';
    messagesState = [
      { id: 'u1', role: 'user', content: 'first', timestamp: 1000 },
      { id: 'a1', role: 'assistant', content: '…', timestamp: 1500 },
      { id: 'u2', role: 'user', content: 'second', timestamp: 2000 },
    ];
    render();
    // The most recent user turn (2000), not "now" or an earlier one.
    expect(testid('pane-streaming')?.getAttribute('data-started-at')).toBe(
      '2000',
    );
  });

  it('passes no explicit start time while idle', () => {
    streamingStateValue = 'idle';
    render();
    expect(testid('pane-streaming')?.getAttribute('data-started-at')).toBe(
      'none',
    );
  });

  it('enables the interactive composer controls', () => {
    connectionState.tokenCount = 1200;
    connectionState.contextWindow = 8192;
    render();
    expect(testid('pane-toolbar')?.textContent).toBe(
      JSON.stringify([
        'addMenu',
        'approvalMode',
        'contextUsage',
        'model',
        'voice',
      ]),
    );
    expect(latestChatEditorProps.tokenCount).toBe(1200);
    expect(latestChatEditorProps.contextWindow).toBe(8192);
    expect(latestChatEditorProps.onShowContextUsage).toEqual(
      expect.any(Function),
    );
  });

  it('shows context usage for this pane session', async () => {
    render();

    await act(async () => {
      latestChatEditorProps.onShowContextUsage();
    });

    expect(appendLocalUserMessage).toHaveBeenCalledWith('/context');
    expect(getContextUsage).toHaveBeenCalledWith({ detail: false });
    expect(transcriptDispatch).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'status',
        clearActiveText: false,
        text: expect.stringContaining('web-shell:context-usage:v1:'),
      }),
    ]);
  });

  it("lists the pane session's own commands in the slash menu", () => {
    connectionState.commands = [
      { name: 'clear', description: 'Clear', source: 'builtin-command' },
      { name: 'compress', description: 'Compress', source: 'builtin-command' },
    ];
    render();
    // Local commands are merged with daemon commands; 'clear' is deduplicated,
    // 'compress' is daemon-only — so the count is localCount + 1.
    const count = Number(testid('pane-commands')?.textContent);
    expect(count).toBeGreaterThan(30);
  });

  it("passes the pane session's skills to the add menu", () => {
    connectionState.skills = ['review'];
    connectionState.commands = [
      {
        name: 'review',
        description: 'Review code',
        argumentHint: '[path]',
        source: 'skill',
      },
    ];
    render();

    expect(latestChatEditorProps.skills).toEqual([
      {
        name: 'review',
        description: 'Review changed code for bugs, security, and quality',
        argumentHint: '[path]',
      },
    ]);
  });

  it('hides internal composer models and labels the rest', () => {
    connectionState.models = [
      { id: 'coder-model(qwen-oauth)', label: 'Coder' },
      { id: 'qwen-max', label: 'qwen-max' },
    ];
    render();
    const models = JSON.parse(testid('pane-models')!.textContent!);
    expect(models.map((m: { id: string }) => m.id)).toEqual(['qwen-max']);
  });

  it("drives THIS pane's approval mode when one is picked", () => {
    render();
    act(() =>
      testid('pane-pick-mode')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(setApprovalMode).toHaveBeenCalledWith('yolo');
  });

  it("switches THIS pane's model when one is picked", () => {
    render();
    act(() =>
      testid('pane-pick-model')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(setModel).toHaveBeenCalledWith('gpt-x');
  });

  it("reflects the pane session's current mode and model", () => {
    connectionState.currentMode = 'auto-edit';
    connectionState.currentModel = 'qwen-max';
    render();
    expect(testid('pane-mode')?.textContent).toBe('auto-edit');
    expect(testid('pane-model')?.textContent).toBe('qwen-max');
  });

  it('falls back to the default mode and empty model when unset', () => {
    render();
    expect(testid('pane-mode')?.textContent).toBe('default');
    expect(testid('pane-model')?.textContent).toBe('');
  });

  it('reports a failed model switch to onError', async () => {
    const onError = vi.fn();
    setModel.mockRejectedValueOnce(new Error('switch failed'));
    render({ onError });
    await act(async () => {
      testid('pane-pick-model')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalled();
  });

  it('reports a failed approval mode switch to onError', async () => {
    const onError = vi.fn();
    setApprovalMode.mockRejectedValueOnce(new Error('mode switch failed'));
    render({ onError });
    await act(async () => {
      testid('pane-pick-mode')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalled();
  });

  it('rejects an invalid approval mode without calling the daemon', () => {
    const onError = vi.fn();
    render({ onError });
    act(() =>
      testid('pane-pick-badmode')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(setApprovalMode).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('auto-approves a pending tool call when the pane switches to yolo', async () => {
    pendingPermission = {
      id: 'perm-yolo',
      toolName: 'write_file',
      toolKind: 'edit',
      options: [{ id: 'allow-1', label: 'Allow once', kind: 'allow_once' }],
      rawInput: {},
    };
    render();
    await act(async () => {
      testid('pane-pick-mode')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setApprovalMode).toHaveBeenCalledWith('yolo');
    expect(submitPermission).toHaveBeenCalledWith('perm-yolo', 'allow-1');
  });

  it('resolves host at mention providers through a pane ChatEditor', () => {
    renderRealChatEditor = true;
    const atProviders = [
      {
        id: 'tables',
        label: 'Tables',
        async search() {
          return [];
        },
      },
    ];
    const builtinAtProviders = { exclude: ['extensions'] as const };

    render({}, { atProviders, builtinAtProviders });

    expect(latestComposerCoreOptions.current?.atProviders).toBe(atProviders);
    expect(latestComposerCoreOptions.current?.builtinAtProviders).toBe(
      builtinAtProviders,
    );
  });
});

describe('ChatPane daemon keep-alive (#9487)', () => {
  it('passes the daemon active-prompt flag to the indicator and composer', () => {
    streamingStateValue = 'idle';
    sessionHasActivePromptValue = true;
    render({ onError: vi.fn() });

    const status = testid('pane-streaming');
    expect(status).not.toBeNull();
    expect(status!.getAttribute('data-has-active-prompt')).toBe('true');
    // The stop/cancel affordance stays available during the silent gap:
    // the daemon still has an active prompt, so cancel genuinely works.
    expect(testid('pane-running')!.textContent).toBe('true');
  });

  it('keeps the pane idle without a daemon active prompt', () => {
    streamingStateValue = 'idle';
    sessionHasActivePromptValue = false;
    render({ onError: vi.fn() });

    const status = testid('pane-streaming');
    expect(status!.getAttribute('data-has-active-prompt')).toBe('false');
    expect(testid('pane-running')!.textContent).toBe('false');
  });
});
