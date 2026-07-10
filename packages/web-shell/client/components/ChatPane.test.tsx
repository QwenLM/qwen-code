// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let connectionState: any;
let streamingStateValue: string;
let pendingPermission: any;
let latestOnSubmit:
  | ((text: string, images?: unknown, commit?: () => void) => boolean)
  | undefined;
let latestChatEditorProps: any;
let latestFollowupAccept: ((suggestion: string) => void) | undefined;
const clearFollowup = vi.fn();
const transcriptDispatch = vi.fn();
const sendPrompt = vi.fn(async () => ({}) as any);
const submitPermission = vi.fn(async () => {});
const cancel = vi.fn(async () => {});
const setApprovalMode = vi.fn(async (mode: string) => ({ mode }));
const setModel = vi.fn(async () => ({}) as any);
const enqueuePrompt = vi.fn(() => true);
const removeQueuedPrompt = vi.fn();
const insertQueuedPrompt = vi.fn();
const editQueuedPrompt = vi.fn();
const editLastQueuedPrompt = vi.fn(() => false);
const clearQueuedPrompts = vi.fn(() => false);
let queuedPromptsMock: any[] = [];
let queuedTextsMock: string[] = [];

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useActions: () => ({
    sendPrompt,
    submitPermission,
    cancel,
    setApprovalMode,
    setModel,
  }),
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
  useTranscriptStore: () => ({
    dispatch: transcriptDispatch,
  }),
}));

vi.mock('../hooks/useQueuedPrompts', () => ({
  useQueuedPrompts: () => ({
    queuedPrompts: queuedPromptsMock,
    queuedTexts: queuedTextsMock,
    enqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  }),
}));

let messagesState: any[];
vi.mock('../hooks/useMessages', () => ({
  useMessages: () => messagesState,
}));

vi.mock('../adapters/transcriptAdapter', () => ({
  extractPendingPermission: () => pendingPermission,
}));

vi.mock('./MessageList', () => ({
  MessageList: (props: any) => (
    <div
      data-testid="pane-messages"
      data-approval={props.pendingApproval ? 'yes' : 'no'}
    >
      {props.messages.length}
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
    />
  ),
}));
vi.mock('./ChatEditor', () => ({
  ChatEditor: forwardRef(function MockChatEditor(props: any, ref: any) {
    latestOnSubmit = props.onSubmit;
    latestChatEditorProps = props;
    useImperativeHandle(ref, () => ({
      insertText: vi.fn(),
    }));
    return (
      <div>
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
    <div data-testid="pane-queue">{String(props.prompts.length)}</div>
  ),
}));
vi.mock('./messages/ToolApproval', () => ({
  ToolApproval: (props: any) => (
    <button
      data-testid="tool-approval"
      data-keyboard-active={String(props.keyboardActive)}
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
      onClick={() => props.onConfirm(props.request.id, 'opt')}
    >
      ask
    </button>
  ),
}));

const { ChatPane } = await import('./ChatPane');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  connectionState = {
    sessionId: 'sess-1',
    displayName: 'Refactor core',
    workspaceCwd: '/w',
    loadingTranscript: false,
    catchingUp: false,
  };
  streamingStateValue = 'idle';
  pendingPermission = null;
  messagesState = [{ id: 'm1', role: 'user', content: 'hi' }];
  latestOnSubmit = undefined;
  latestChatEditorProps = undefined;
  latestFollowupAccept = undefined;
  queuedPromptsMock = [];
  queuedTextsMock = [];
  sendPrompt.mockReset();
  sendPrompt.mockResolvedValue({} as any);
  clearFollowup.mockClear();
  submitPermission.mockClear();
  cancel.mockClear();
  setApprovalMode.mockClear();
  setModel.mockClear();
  enqueuePrompt.mockClear();
  enqueuePrompt.mockReturnValue(true);
  removeQueuedPrompt.mockClear();
  insertQueuedPrompt.mockClear();
  editQueuedPrompt.mockClear();
  editLastQueuedPrompt.mockClear();
  clearQueuedPrompts.mockClear();
  transcriptDispatch.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: Record<string, unknown> = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <ChatPane {...props} />
      </I18nProvider>,
    ),
  );
}

function testid(id: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${id}"]`);
}

describe('ChatPane', () => {
  it('renders the session transcript and header label', () => {
    render({ title: 'Refactor core' });
    expect(testid('pane-messages')?.textContent).toBe('1');
    expect(container!.textContent).toContain('Refactor core');
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
    expect(sendPrompt).toHaveBeenCalledWith('hello there', {});
    expect(clearFollowup).toHaveBeenCalledTimes(1);
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('accepts an idle prompt so the editor commits the draft immediately', () => {
    render();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('hi');
    });
    expect(returned).toBe(true);
  });

  it('queues a prompt while the pane is already running', () => {
    streamingStateValue = 'responding';
    render();
    const commit = vi.fn();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('queued next', undefined, commit);
    });
    expect(returned).toBe(true);
    expect(enqueuePrompt).toHaveBeenCalledWith('queued next', undefined);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('preserves the draft when the busy queue rejects the prompt', () => {
    streamingStateValue = 'responding';
    enqueuePrompt.mockReturnValueOnce(false);
    render();
    const commit = vi.fn();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('hi', undefined, commit);
    });
    expect(returned).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  it('reports an idle prompt failure to the pane error handler', async () => {
    const onError = vi.fn();
    sendPrompt.mockRejectedValueOnce(new Error('disconnected'));
    render({ onError });
    await act(async () => {
      latestOnSubmit!('hi');
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to send prompt',
    );
  });

  it('keeps pane approvals click-only (no global keyboard shortcuts)', () => {
    pendingPermission = { id: 'perm-1', toolName: 'write_file', rawInput: {} };
    render();
    expect(testid('tool-approval')?.getAttribute('data-keyboard-active')).toBe(
      'false',
    );
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
    // AskUserQuestion is not a tool approval, so MessageList gets no inline one.
    expect(testid('pane-messages')?.getAttribute('data-approval')).toBe('no');
  });

  it('invokes onClose from the header close button', () => {
    const onClose = vi.fn();
    render({ onClose });
    const closeBtn = container!.querySelector('header button');
    act(() =>
      closeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
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
      returned = latestOnSubmit!('   ', undefined, vi.fn());
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

  it('passes follow-up suggestions to the pane editor', () => {
    render();
    expect(testid('pane-followup')?.textContent).toBe('next idea');
    expect(latestChatEditorProps.onAcceptFollowup).toBeTypeOf('function');
    expect(latestChatEditorProps.onDismissFollowup).toBeTypeOf('function');
    expect(latestFollowupAccept).toBeTypeOf('function');
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

  it('enables the interactive composer controls (approval mode, model, voice)', () => {
    render();
    expect(testid('pane-toolbar')?.textContent).toBe(
      JSON.stringify(['approvalMode', 'model', 'voice']),
    );
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
});
