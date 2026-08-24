// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { PermissionRequest } from '../adapters/types';
import { EmbeddedWebShell } from './EmbeddedWebShell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const childProps = vi.hoisted(() => ({
  chatEditor: undefined as Record<string, unknown> | undefined,
  messageList: undefined as Record<string, unknown> | undefined,
}));

vi.mock('./ChatEditor', () => ({
  ChatEditor: (props: Record<string, unknown>) => {
    childProps.chatEditor = props;
    return (
      <div data-testid="controlled-composer">
        <button
          type="button"
          onClick={() =>
            (
              props['onSubmit'] as (
                text: string,
                images: unknown[],
                files: unknown[],
                commit: () => void,
                metadata: unknown,
              ) => void
            )(
              'ship it',
              [{ data: 'a', media_type: 'image/png' }],
              [{ name: 'notes.txt', media_type: 'text/plain', text: 'hi' }],
              vi.fn(),
              { inputAnnotations: [{ type: 'text', text: 'annotation' }] },
            )
          }
        >
          Submit fixture
        </button>
        <button
          type="button"
          onClick={() => (props['onCancel'] as () => void)()}
        >
          Cancel fixture
        </button>
        <button
          type="button"
          onClick={() =>
            (props['onSelectModel'] as (id: string) => void)('qwen-next')
          }
        >
          Model fixture
        </button>
        <button
          type="button"
          onClick={() =>
            (props['onSelectMode'] as (id: string) => void)('yolo')
          }
        >
          Mode fixture
        </button>
      </div>
    );
  },
}));

vi.mock('./MessageList', () => ({
  MessageList: (props: Record<string, unknown>) => {
    childProps.messageList = props;
    return <div data-testid="controlled-transcript">Transcript fixture</div>;
  },
}));

vi.mock('./messages/ToolApproval', () => ({
  ToolApproval: (props: {
    request: PermissionRequest;
    onConfirm: (requestId: string, optionId: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => props.onConfirm(props.request.id, 'proceed_once')}
    >
      Permission fixture
    </button>
  ),
}));

vi.mock('./messages/AskUserQuestion', () => ({
  AskUserQuestion: (props: {
    request: PermissionRequest;
    onConfirm: (
      requestId: string,
      optionId: string,
      answers: Record<string, string>,
    ) => Promise<boolean>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void props.onConfirm(props.request.id, 'proceed_once', {
          '0': 'Keep current',
        })
      }
    >
      Question fixture
    </button>
  ),
}));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(node: ReactNode): {
  container: HTMLElement;
  rerender: (next: ReactNode) => void;
} {
  const container = document.createElement('div');
  container.style.height = '640px';
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return {
    container,
    rerender(next) {
      act(() => root.render(next));
    },
  };
}

function click(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button).not.toBeUndefined();
  act(() => button?.click());
}

function block(id: string): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text: `message-${id}`,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as DaemonTranscriptBlock;
}

function permission(id: string, kind = 'bash'): PermissionRequest {
  return {
    id,
    kind,
    title: 'Run command',
    content: [],
    rawInput: {},
    options: [
      { id: 'proceed_once', label: 'Allow once', kind: 'allow_once' },
      { id: 'cancel', label: 'Reject', kind: 'reject_once' },
    ],
  };
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  childProps.chatEditor = undefined;
  childProps.messageList = undefined;
  vi.restoreAllMocks();
});

describe('EmbeddedWebShell controlled host contract', () => {
  it('renders host transcript state and switches sessions from controlled history', () => {
    const onHistoryOpenChange = vi.fn();
    const onSessionSelect = vi.fn();
    const { container } = render(
      <EmbeddedWebShell
        blocks={[block('session-a')]}
        sessionId="session-a"
        sessionTitle="Current session"
        sessions={[
          { id: 'session-a', title: 'Current session', messageCount: 3 },
          { id: 'session-b', title: 'Previous session', messageCount: 7 },
        ]}
        historyOpen
        isResponding
        onSubmit={() => {}}
        onHistoryOpenChange={onHistoryOpenChange}
        onSessionSelect={onSessionSelect}
      />,
    );

    expect(container.textContent).toContain('Transcript fixture');
    expect(childProps.messageList?.['isResponding']).toBe(true);
    expect(childProps.messageList?.['messages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'message-session-a' }),
      ]),
    );

    click(container, 'Previous session');
    expect(onSessionSelect).toHaveBeenCalledWith('session-b');
    expect(onHistoryOpenChange).toHaveBeenCalledWith(false);
  });

  it('maps composer and approval actions to the host without owning runtime state', async () => {
    const onSubmit = vi.fn(() => true);
    const onCancel = vi.fn();
    const onSelectModel = vi.fn();
    const onSelectMode = vi.fn();
    const onPermissionResponse = vi.fn();
    const onQuestionResponse = vi.fn(async () => true);
    const { container } = render(
      <EmbeddedWebShell
        blocks={[block('active')]}
        sessionId="active"
        pendingPermission={permission('permission-1')}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSelectModel={onSelectModel}
        onSelectMode={onSelectMode}
        onPermissionResponse={onPermissionResponse}
        onQuestionResponse={onQuestionResponse}
      />,
    );

    click(container, 'Permission fixture');
    expect(onPermissionResponse).toHaveBeenCalledWith(
      'permission-1',
      'proceed_once',
    );

    expect(childProps.chatEditor).toBeDefined();

    const { rerender } = render(
      <EmbeddedWebShell
        blocks={[block('active')]}
        sessionId="active"
        pendingQuestion={permission('question-1', 'ask_user_question')}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSelectModel={onSelectModel}
        onSelectMode={onSelectMode}
        onPermissionResponse={onPermissionResponse}
        onQuestionResponse={onQuestionResponse}
      />,
    );
    void rerender;
    const questionContainer = mounted.at(-1)?.container;
    expect(questionContainer).toBeDefined();
    click(questionContainer!, 'Question fixture');
    await act(async () => Promise.resolve());
    expect(onQuestionResponse).toHaveBeenCalledWith(
      'question-1',
      'proceed_once',
      { '0': 'Keep current' },
    );

    const callbacks = childProps.chatEditor as {
      onSubmit: (...args: unknown[]) => void;
      onCancel: () => void;
      onSelectModel: (id: string) => void;
      onSelectMode: (id: string) => void;
    };
    callbacks.onSubmit(
      'ship it',
      [{ data: 'a', media_type: 'image/png' }],
      [{ name: 'notes.txt', media_type: 'text/plain', text: 'hi' }],
      undefined,
      { inputAnnotations: [{ type: 'text', text: 'annotation' }] },
    );
    callbacks.onCancel();
    callbacks.onSelectModel('qwen-next');
    callbacks.onSelectMode('yolo');

    expect(onSubmit).toHaveBeenCalledWith({
      text: 'ship it',
      images: [{ data: 'a', media_type: 'image/png' }],
      files: [{ name: 'notes.txt', media_type: 'text/plain', text: 'hi' }],
      inputAnnotations: [{ type: 'text', text: 'annotation' }],
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelectModel).toHaveBeenCalledWith('qwen-next');
    expect(onSelectMode).toHaveBeenCalledWith('yolo');
  });

  it('keeps authentication and loading states host-controlled', () => {
    const onAuthenticate = vi.fn();
    const view = render(
      <EmbeddedWebShell
        blocks={[]}
        authenticated={false}
        loading
        loadingLabel="Connecting to ACP..."
        onSubmit={() => {}}
        onAuthenticate={onAuthenticate}
      />,
    );

    expect(view.container.textContent).toContain('Sign in to start');
    expect(view.container.textContent).toContain('Connecting to ACP...');
    click(view.container, 'Sign in');
    expect(onAuthenticate).toHaveBeenCalledOnce();

    view.rerender(
      <EmbeddedWebShell
        blocks={[]}
        authenticated
        loading={false}
        onSubmit={() => {}}
      />,
    );
    expect(
      view.container.querySelector('[data-testid="embedded-chat-empty"]'),
    ).not.toBeNull();
    expect(view.container.textContent).not.toContain('Connecting to ACP...');
  });
});
