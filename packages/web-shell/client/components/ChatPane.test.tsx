// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
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
let sendPromptResolve: (() => void) | undefined;
let sendPromptReject: ((e: unknown) => void) | undefined;
let sendPromptAdmit: (() => void) | undefined;
const sendPrompt = vi.fn(async () => ({}) as any);
const submitPermission = vi.fn(async () => {});
const cancel = vi.fn(async () => {});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useActions: () => ({ sendPrompt, submitPermission, cancel }),
  useConnection: () => connectionState,
  useStreamingState: () => streamingStateValue,
  useTranscriptBlocks: () => [],
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
  ChatEditor: (props: any) => {
    latestOnSubmit = props.onSubmit;
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
        <span data-testid="pane-running">{String(props.isRunning)}</span>
        <span data-testid="pane-dialogopen">{String(props.dialogOpen)}</span>
      </div>
    );
  },
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
  sendPrompt.mockReset();
  // Each sendPrompt returns a promise the test controls, so we can assert the
  // draft is committed on admission (onAdmitted) rather than on turn completion
  // (promise resolution). `sendPromptAdmit` captures the options.onAdmitted hook.
  sendPromptAdmit = undefined;
  sendPrompt.mockImplementation(
    (_text?: string, options?: { onAdmitted?: () => void }) =>
      new Promise<unknown>((resolve, reject) => {
        sendPromptAdmit = options?.onAdmitted;
        sendPromptResolve = () => resolve({});
        sendPromptReject = (e) => reject(e);
      }),
  );
  submitPermission.mockClear();
  cancel.mockClear();
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

  it('sends a prompt to its own session on submit', () => {
    render();
    act(() =>
      testid('pane-submit')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect((sendPrompt.mock.calls[0] as unknown[])[0]).toBe('hello there');
  });

  it('commits the draft on admission, without waiting for the turn to finish', async () => {
    render();
    const commit = vi.fn();
    let returned: boolean | undefined;
    act(() => {
      returned = latestOnSubmit!('hi', undefined, commit);
    });
    // Returns false (keep the draft) and does NOT commit before admission.
    expect(returned).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    // The daemon admits the prompt (onAdmitted). The draft clears now, even
    // though the turn promise is still pending — a long response must not strand
    // the sent text in the composer until the turn ends.
    await act(async () => {
      sendPromptAdmit!();
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    // The turn finishing later must NOT commit again — guards against regressing
    // to committing on promise resolution (turn end) instead of admission.
    await act(async () => {
      sendPromptResolve!();
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not commit (preserves the draft) when the prompt is rejected', async () => {
    render();
    const commit = vi.fn();
    act(() => {
      latestOnSubmit!('hi', undefined, commit);
    });
    await act(async () => {
      sendPromptReject!(new Error('session busy'));
      await Promise.resolve();
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps the draft cleared and still reports the error when the turn fails after admission', async () => {
    const onError = vi.fn();
    render({ onError });
    const commit = vi.fn();
    act(() => {
      latestOnSubmit!('hi', undefined, commit);
    });
    // Admission clears the draft.
    await act(async () => {
      sendPromptAdmit!();
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    // The turn then fails mid-flight: the draft stays cleared (no second commit)
    // and the failure is still surfaced to onError.
    await act(async () => {
      sendPromptReject!(new Error('turn crashed'));
      await Promise.resolve();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
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
  });

  it('routes send failures to the onError prop', async () => {
    const onError = vi.fn();
    render({ onError });
    act(() => {
      latestOnSubmit!('hi', undefined, vi.fn());
    });
    await act(async () => {
      sendPromptReject!(new Error('disconnected'));
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalled();
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
});
