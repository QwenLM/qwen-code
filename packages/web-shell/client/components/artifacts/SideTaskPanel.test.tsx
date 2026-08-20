// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const {
  connection,
  providerProps,
  latestChatPaneProps,
  renameSession,
  sendPrompt,
  transcript,
  catalogController,
} = vi.hoisted(() => ({
  connection: {
    status: 'idle',
    sessionId: undefined as string | undefined,
    workspaceCwd: undefined as string | undefined,
    displayName: undefined as string | undefined,
    loadingTranscript: false,
    catchingUp: false,
  },
  providerProps: {
    current: undefined as Record<string, unknown> | undefined,
  },
  latestChatPaneProps: {
    current: undefined as Record<string, unknown> | undefined,
  },
  renameSession: vi.fn().mockResolvedValue(undefined),
  sendPrompt: vi.fn(
    async (
      _prompt: string,
      options?: {
        onAdmitted?: () => void;
      },
    ) => {
      options?.onAdmitted?.();
    },
  ),
  transcript: {
    blocks: [] as Array<{
      kind: string;
      text?: string;
      images?: Array<{ data: string; mimeType: string }>;
    }>,
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: undefined as string | undefined,
  },
  catalogController: {
    invalidateWorkspace: vi.fn(),
    sessionCreated: vi.fn(),
    promptAdmitted: vi.fn(),
    renamed: vi.fn(),
    turnCompleted: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonSessionProvider: (props: {
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    providerProps.current = props;
    return props.children;
  },
  useConnection: () => connection,
  useActions: () => ({ renameSession, sendPrompt }),
  useWorkspace: () => ({ client: {}, workspaceCwd: '/work/project' }),
  useTranscriptBlocks: () => transcript.blocks,
  useTranscriptHistory: () => transcript,
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => catalogController,
}));

vi.mock('../ChatPane', () => ({
  ChatPane: (props: Record<string, unknown>) => {
    latestChatPaneProps.current = props;
    return <div data-testid="side-task-chat" />;
  },
}));

const { SideTaskPanel } = await import('./SideTaskPanel');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderSideTask(
  props: Partial<ComponentProps<typeof SideTaskPanel>> = {},
) {
  root!.render(
    <I18nProvider language="en">
      <SideTaskPanel
        tabId="side-task:side-session-1"
        sessionId="side-session-1"
        parentSessionId="parent-session"
        workspaceCwd="/work/project"
        title="Side task"
        createSession={vi.fn()}
        onCreated={vi.fn()}
        onTitleChange={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  connection.status = 'idle';
  connection.sessionId = undefined;
  connection.workspaceCwd = undefined;
  connection.displayName = undefined;
  connection.loadingTranscript = false;
  connection.catchingUp = false;
  providerProps.current = undefined;
  latestChatPaneProps.current = undefined;
  transcript.blocks = [];
  transcript.hasMore = false;
  transcript.loading = false;
  transcript.capacityReached = false;
  transcript.paginationError = undefined;
  renameSession.mockClear();
  renameSession.mockResolvedValue(undefined);
  sendPrompt.mockClear();
  catalogController.invalidateWorkspace.mockClear();
  catalogController.promptAdmitted.mockClear();
  catalogController.renamed.mockClear();
});

it('creates a side task and reports the new session id', async () => {
  const onCreated = vi.fn();
  const onTitleChange = vi.fn();
  const createSession = vi.fn().mockResolvedValue({
    sessionId: 'side-session-1',
    displayName: 'Side task',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:draft:1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Side task"
          createSession={createSession}
          onCreated={onCreated}
          onTitleChange={onTitleChange}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(createSession).toHaveBeenCalledWith(
    'side-task:draft:1',
    'parent-session',
    'Side task',
  );
  expect(onCreated).toHaveBeenCalledWith('side-task:draft:1', 'side-session-1');
  expect(onTitleChange).toHaveBeenCalledWith('side-task:draft:1', 'Side task');
});

it('does not retry creation after a prop change until the user requests it', async () => {
  const createSession = vi
    .fn()
    .mockRejectedValueOnce(new Error('create failed'))
    .mockResolvedValue({
      sessionId: 'side-session-1',
      displayName: 'Renamed task',
    });
  const onCreated = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const renderDraft = (title: string) => (
    <I18nProvider language="en">
      <SideTaskPanel
        tabId="side-task:draft:1"
        parentSessionId="parent-session"
        workspaceCwd="/work/project"
        title={title}
        createSession={createSession}
        onCreated={onCreated}
        onTitleChange={vi.fn()}
      />
    </I18nProvider>
  );

  await act(async () => {
    root!.render(renderDraft('Side task'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(createSession).toHaveBeenCalledOnce();

  await act(async () => {
    root!.render(renderDraft('Renamed task'));
    await Promise.resolve();
  });
  expect(createSession).toHaveBeenCalledOnce();

  await act(async () => {
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retryButton).not.toBeUndefined();
    retryButton?.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(createSession).toHaveBeenCalledTimes(2);
  expect(createSession).toHaveBeenLastCalledWith(
    'side-task:draft:1',
    'parent-session',
    'Renamed task',
  );
  expect(onCreated).toHaveBeenCalledWith('side-task:draft:1', 'side-session-1');
});

it('renders a restored side task as a full chat pane', () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Investigate flaky tests';
  connection.status = 'connected';
  transcript.blocks = [{ kind: 'user' }];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  const onRightPanelOpen = vi.fn();
  const onArtifactsChange = vi.fn();
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:side-session-1"
          sessionId="side-session-1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Side task"
          createSession={vi.fn()}
          onCreated={vi.fn()}
          onTitleChange={onTitleChange}
          onRightPanelOpen={onRightPanelOpen}
          onArtifactsChange={onArtifactsChange}
        />
      </I18nProvider>,
    );
  });

  expect(
    container.querySelector('[data-testid="side-task-chat"]'),
  ).not.toBeNull();
  expect(latestChatPaneProps.current).toMatchObject({
    title: 'Investigate flaky tests',
    workspaceCwd: '/work/project',
    embedded: true,
    onRightPanelOpen,
    onPaneArtifactsChange: onArtifactsChange,
  });
  expect(
    latestChatPaneProps.current?.['onFirstPromptAdmitted'],
  ).toBeUndefined();
  expect(providerProps.current).toMatchObject({
    sessionId: 'side-session-1',
    workspaceCwd: '/work/project',
    autoConnect: true,
  });
});

it('threads sessionWorkflowEnabled to its chat pane', () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Investigate flaky tests';
  connection.status = 'connected';
  transcript.blocks = [{ kind: 'user' }];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    renderSideTask({ sessionWorkflowEnabled: true });
  });

  expect(latestChatPaneProps.current?.sessionWorkflowEnabled).toBe(true);
});

it('names a restored empty side task from its first prompt', async () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Side task';
  connection.status = 'connected';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  act(() => {
    renderSideTask({ onTitleChange });
  });

  await act(async () => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )('Investigate restored task');
    await Promise.resolve();
  });

  expect(renameSession).toHaveBeenCalledWith('Investigate restored task');
  expect(catalogController.renamed).toHaveBeenCalledWith(
    '/work/project',
    'side-session-1',
    'Investigate restored task',
  );
  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:side-session-1',
    'Investigate restored task',
    true,
  );
});

it('keeps first-text naming available after an image-only user prompt', () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Side task';
  connection.status = 'connected';
  transcript.blocks = [
    {
      kind: 'user',
      images: [{ data: 'Ym1w', mimeType: 'image/bmp' }],
    },
  ];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    renderSideTask();
  });

  expect(latestChatPaneProps.current?.['onFirstPromptAdmitted']).toEqual(
    expect.any(Function),
  );
});

it('truncates the first-prompt title by code point, not code unit', async () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Side task';
  connection.status = 'connected';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  act(() => {
    renderSideTask({ onTitleChange });
  });

  const longPrompt = `${'a'.repeat(199)}\u{1F600} trailing`;
  await act(async () => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )(longPrompt);
    await Promise.resolve();
  });

  const expected = `${'a'.repeat(199)}\u{1F600}`;
  expect(renameSession).toHaveBeenCalledWith(expected);
  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:side-session-1',
    expected,
    true,
  );
});

it('sends the /btw question as the first side-task prompt', async () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Side task';
  connection.status = 'connected';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  await act(async () => {
    renderSideTask({
      initialPrompt: 'Explain the current implementation',
      onTitleChange,
    });
    await Promise.resolve();
  });

  expect(sendPrompt).toHaveBeenCalledWith(
    'Explain the current implementation',
    expect.objectContaining({ onAdmitted: expect.any(Function) }),
  );
  expect(renameSession).toHaveBeenCalledWith(
    'Explain the current implementation',
  );
  expect(catalogController.promptAdmitted).toHaveBeenCalledWith(
    '/work/project',
    'side-session-1',
  );
  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:side-session-1',
    'Explain the current implementation',
    true,
  );
});

it('does not patch a different workspace after side-task admission', async () => {
  connection.sessionId = 'side-session-1';
  connection.workspaceCwd = '/work/other';
  connection.displayName = 'Side task';
  connection.status = 'connected';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    renderSideTask({ initialPrompt: 'Explain the current implementation' });
    await Promise.resolve();
  });

  expect(catalogController.promptAdmitted).not.toHaveBeenCalled();
  expect(catalogController.renamed).not.toHaveBeenCalled();
});

it('does not rename a restored side task when older history exists', () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Existing task';
  connection.status = 'connected';
  transcript.hasMore = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    renderSideTask({ title: 'Existing task' });
  });

  expect(
    latestChatPaneProps.current?.['onFirstPromptAdmitted'],
  ).toBeUndefined();
});

it.each([
  ['loading', { loading: true }],
  ['capacity reached', { capacityReached: true }],
  ['pagination failed', { paginationError: 'history unavailable' }],
])('does not rename when transcript history is incomplete: %s', (_, state) => {
  connection.sessionId = 'side-session-1';
  connection.status = 'connected';
  Object.assign(transcript, state);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    renderSideTask();
  });

  expect(
    latestChatPaneProps.current?.['onFirstPromptAdmitted'],
  ).toBeUndefined();
});

it('names a newly created side task from its first prompt', async () => {
  connection.sessionId = 'side-session-1';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:draft:1"
          sessionId="side-session-1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Side task"
          shouldNameFromFirstPrompt
          createSession={vi.fn()}
          onCreated={vi.fn()}
          onTitleChange={onTitleChange}
        />
      </I18nProvider>,
    );
  });

  await act(async () => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )('Investigate cache invalidation');
    await Promise.resolve();
  });

  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:draft:1',
    'Investigate cache invalidation',
    true,
  );
  expect(renameSession).toHaveBeenCalledWith('Investigate cache invalidation');

  act(() => {
    root!.render(null);
  });
  transcript.blocks = [{ kind: 'user' }];
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:draft:1"
          sessionId="side-session-1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Investigate cache invalidation"
          shouldNameFromFirstPrompt={false}
          createSession={vi.fn()}
          onCreated={vi.fn()}
          onTitleChange={onTitleChange}
        />
      </I18nProvider>,
    );
  });

  expect(
    latestChatPaneProps.current?.['onFirstPromptAdmitted'],
  ).toBeUndefined();
});

it('retries the first-prompt title before marking it complete', async () => {
  connection.sessionId = 'side-session-1';
  connection.status = 'connected';
  renameSession
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  const onError = vi.fn();
  act(() => {
    renderSideTask({
      tabId: 'side-task:draft:1',
      shouldNameFromFirstPrompt: true,
      onTitleChange,
      onError,
    });
  });

  await act(async () => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )('Retry this title');
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renameSession).toHaveBeenCalledTimes(2);
  expect(renameSession).toHaveBeenNthCalledWith(1, 'Retry this title');
  expect(renameSession).toHaveBeenNthCalledWith(2, 'Retry this title');
  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:draft:1',
    'Retry this title',
    true,
  );
  expect(onError).not.toHaveBeenCalled();
});

it('bounds first-prompt title retries and reports the final failure', async () => {
  connection.sessionId = 'side-session-1';
  connection.status = 'connected';
  const failure = new Error('persistent failure');
  renameSession.mockRejectedValue(failure);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  const onError = vi.fn();
  act(() => {
    renderSideTask({
      tabId: 'side-task:draft:1',
      shouldNameFromFirstPrompt: true,
      onTitleChange,
      onError,
    });
  });

  await act(async () => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )('Keep this title');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(renameSession).toHaveBeenCalledTimes(3);
  expect(onTitleChange).not.toHaveBeenCalledWith(
    'side-task:draft:1',
    'Keep this title',
    true,
  );
  expect(onError).toHaveBeenCalledWith(failure, 'Failed to name side task');
});
