/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let EmbeddedApp: ComponentType;

interface CapturedProps {
  [key: string]: unknown;
}

interface RenderedApp {
  container: HTMLElement;
  root: Root;
}

const mocks = vi.hoisted(() => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
  },
  embeddedProps: { current: null as CapturedProps | null },
  connectionError: { current: undefined as string | undefined },
  errorNotifications: { current: 0 },
}));

const sdkMocks = vi.hoisted(() => ({
  listWorkspaceSessionsPage: vi.fn(),
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: class {
    workspaceByCwd() {
      return {
        listWorkspaceSessionsPage: sdkMocks.listWorkspaceSessionsPage,
        updateSessionMetadata: vi.fn(async () => ({})),
        deleteSessionsData: vi.fn(async () => ({})),
      };
    }
    getRewindSnapshots = vi.fn(async () => ({ snapshots: [] }));
    rewindSession = vi.fn(async () => ({}));
  },
}));

vi.mock('@qwen-code/web-shell', async () => {
  const { useEffect } = await import('react');
  return {
    WebShellWithProviders: (props: CapturedProps) => {
      mocks.embeddedProps.current = props;
      // Mirror App.tsx's error-notification effect: while a connection error
      // persists it re-runs whenever the onError prop identity changes — an
      // unstable callback turns that into an infinite render loop.
      useEffect(() => {
        const message = mocks.connectionError.current;
        if (!message) return;
        mocks.errorNotifications.current += 1;
        if (mocks.errorNotifications.current > 3) {
          // An unstable onError re-runs this effect on every render; fail
          // fast instead of hanging on the infinite loop.
          throw new Error('onError notified in a loop');
        }
        (props.onError as ((error: Error) => void) | undefined)?.(
          new Error(message),
        );
      }, [props.onError]);
      return null;
    },
  };
});

vi.mock('./hooks/useVSCode.js', () => ({
  useVSCode: () => mocks.vscode,
}));

const mounted: RenderedApp[] = [];

async function renderApp(): Promise<CapturedProps> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<EmbeddedApp />);
    await Promise.resolve();
  });
  mounted.push({ container, root });
  const props = mocks.embeddedProps.current;
  expect(props).not.toBeNull();
  return props as CapturedProps;
}

function callback<T extends (...args: never[]) => unknown>(
  props: CapturedProps,
  name: string,
): T {
  const value = props[name];
  expect(typeof value).toBe('function');
  return value as T;
}

function postMessagesOfType(
  type: string,
): Array<{ type?: string; data?: unknown }> {
  return mocks.vscode.postMessage.mock.calls
    .map(([message]) => message as { type?: string })
    .filter((message) => message.type === type);
}

beforeAll(async () => {
  document.body.dataset.qwenDaemonBaseUrl = 'http://localhost:4141';
  document.body.dataset.qwenWorkspaceCwd = '/workspace';
  document.body.dataset.qwenSessionId = 'session-1';
  document.body.dataset.qwenHostKind = 'panel';
  ({ EmbeddedApp } = await import('./EmbeddedApp.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embeddedProps.current = null;
  mocks.connectionError.current = undefined;
  mocks.errorNotifications.current = 0;
  sdkMocks.listWorkspaceSessionsPage.mockResolvedValue({ sessions: [] });
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('EmbeddedApp host wiring', () => {
  it('attributes its sessions to the VS Code channel', async () => {
    const props = await renderApp();
    // The daemon is shared with the CLI and the browser Web Shell for this
    // workspace; without a distinct source type the panel cannot tell its own
    // conversations apart from theirs.
    expect(props['sessionSourceType']).toBe('vscode');
  });

  it('injects the active editor reference into prepared submissions', async () => {
    await renderApp();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'activeEditorChanged',
            data: {
              fileName: 'editor.ts',
              filePath: '/workspace/editor.ts',
              selection: { startLine: 3, endLine: 5 },
            },
          },
        }),
      );
      await Promise.resolve();
    });

    const prepareSubmit = callback<
      (submission: {
        prompt: string;
        sessionId?: string;
        inputAnnotations: unknown[];
      }) => Promise<{ prompt: string; inputAnnotations: unknown[] } | undefined>
    >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');

    await expect(
      prepareSubmit({ prompt: 'Explain this', inputAnnotations: [] }),
    ).resolves.toEqual({
      prompt: '@editor.ts (selected lines 3-5) Explain this',
      inputAnnotations: [
        expect.objectContaining({
          type: 'reference',
          start: 0,
          end: '@editor.ts'.length,
          reference: expect.objectContaining({
            kind: 'file',
            label: 'editor.ts',
            value: '/workspace/editor.ts',
          }),
        }),
      ],
    });
  });

  it('keeps an authenticated session visible when auth is cancelled', async () => {
    await renderApp();
    const { container } = mounted[mounted.length - 1];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'authState', data: { authenticated: true } },
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'authCancelled' } }),
      );
      await Promise.resolve();
    });

    // The live session must not be swapped for the onboarding screen.
    expect(container.textContent).not.toContain('Get Started');
  });

  it('still shows onboarding when an unauthenticated flow is cancelled', async () => {
    await renderApp();
    const { container } = mounted[mounted.length - 1];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'authState', data: { authenticated: false } },
        }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Get Started');
  });

  it('keeps an explicit active-file exclusion across same-file editor changes', async () => {
    await renderApp();

    const dispatchEditorChanged = (fileName: string, filePath: string) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'activeEditorChanged',
              data: { fileName, filePath },
            },
          }),
        );
        await Promise.resolve();
      });

    await dispatchEditorChanged('editor.ts', '/workspace/editor.ts');

    // The composer chip lives in a render prop consumed by the (mocked)
    // shell, so render it standalone to click it.
    const renderToolbar = callback<
      (args: { disabled: boolean; currentModel?: string }) => ReactNode
    >(
      mocks.embeddedProps.current as CapturedProps,
      'renderComposerToolbarStart',
    );
    const toolbarContainer = document.createElement('div');
    document.body.appendChild(toolbarContainer);
    const toolbarRoot = createRoot(toolbarContainer);

    try {
      await act(async () => {
        toolbarRoot.render(
          renderToolbar({ disabled: false, currentModel: 'm' }),
        );
        await Promise.resolve();
      });
      const chip = toolbarContainer.querySelector('.qwen-vscode-active-file');
      if (!chip) throw new Error('active-file chip did not render');
      await act(async () => {
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      // A selection-only change for the same file must not re-arm inclusion.
      await dispatchEditorChanged('editor.ts', '/workspace/editor.ts');
      const prepareSubmitAfterSameFile = callback<
        (submission: {
          prompt: string;
          inputAnnotations: unknown[];
        }) => Promise<
          { prompt: string; inputAnnotations: unknown[] } | undefined
        >
      >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');
      await expect(
        prepareSubmitAfterSameFile({ prompt: 'hi', inputAnnotations: [] }),
      ).resolves.toBeUndefined();

      // Switching to a different file re-arms inclusion.
      await dispatchEditorChanged('other.ts', '/workspace/other.ts');
      const prepareSubmitAfterSwitch = callback<
        (submission: {
          prompt: string;
          inputAnnotations: unknown[];
        }) => Promise<
          { prompt: string; inputAnnotations: unknown[] } | undefined
        >
      >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');
      await expect(
        prepareSubmitAfterSwitch({ prompt: 'hi', inputAnnotations: [] }),
      ).resolves.toMatchObject({ prompt: '@other.ts hi' });
    } finally {
      act(() => toolbarRoot.unmount());
      toolbarContainer.remove();
    }
  });

  it('treats a workspace-relative mention annotation as already included', async () => {
    await renderApp();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'activeEditorChanged',
            data: { fileName: 'editor.ts', filePath: '/workspace/editor.ts' },
          },
        }),
      );
      await Promise.resolve();
    });

    const prepareSubmit = callback<
      (submission: {
        prompt: string;
        inputAnnotations: unknown[];
      }) => Promise<{ prompt: string; inputAnnotations: unknown[] } | undefined>
    >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');

    const mention = {
      type: 'reference',
      start: 8,
      end: 18,
      text: '@editor.ts',
      reference: {
        id: 'mention-1',
        kind: 'file',
        label: 'editor.ts',
        value: 'editor.ts',
        serialized: '@editor.ts',
      },
    };

    await expect(
      prepareSubmit({
        prompt: 'Explain @editor.ts',
        inputAnnotations: [mention],
      }),
    ).resolves.toEqual({
      prompt: 'Explain @editor.ts',
      inputAnnotations: [expect.objectContaining({ start: 8, end: 18 })],
    });
  });

  it('matches typed active-file references on a whole-reference boundary', async () => {
    await renderApp();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'activeEditorChanged',
            data: { fileName: 'editor.ts', filePath: '/workspace/editor.ts' },
          },
        }),
      );
      await Promise.resolve();
    });

    const prepareSubmit = callback<
      (submission: {
        prompt: string;
        inputAnnotations: unknown[];
      }) => Promise<{ prompt: string; inputAnnotations: unknown[] } | undefined>
    >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');

    // A sibling-file mention must not suppress the active-file injection.
    await expect(
      prepareSubmit({ prompt: '@editor.tsx hi', inputAnnotations: [] }),
    ).resolves.toMatchObject({ prompt: '@editor.ts @editor.tsx hi' });

    // An exact mention is recognized and annotated, not duplicated.
    const prepared = await prepareSubmit({
      prompt: '@editor.ts hi',
      inputAnnotations: [],
    });
    expect(prepared).toMatchObject({ prompt: '@editor.ts hi' });
    expect(prepared?.inputAnnotations).toHaveLength(1);
    expect(prepared?.inputAnnotations[0]).toMatchObject({
      start: 0,
      end: '@editor.ts'.length,
    });
  });

  it('opens permission diffs only from the authoritative file_diff preview', async () => {
    const props = await renderApp();
    const onTranscriptChange = callback<(blocks: unknown[]) => void>(
      props,
      'onTranscriptChange',
    );

    await act(async () => {
      onTranscriptChange([
        {
          id: 'perm-write',
          kind: 'permission',
          requestId: 'req-write',
          title: 'Write new.ts',
          options: [],
          preview: {
            kind: 'file_diff',
            path: '/workspace/new.ts',
            newText: 'hello world',
          },
        },
        {
          id: 'perm-mined',
          kind: 'permission',
          requestId: 'req-mined',
          title: 'update a.txt',
          options: [],
          preview: { kind: 'key_value', rows: [] },
          toolCall: {
            _meta: { toolName: 'edit_file' },
            file_path: 'a.txt',
            original_content: 'X',
            new_content: 'Y',
          },
        },
      ]);
      await Promise.resolve();
    });

    const openDiffs = postMessagesOfType('openDiff');
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toEqual({
      type: 'openDiff',
      data: {
        path: '/workspace/new.ts',
        oldText: '',
        newText: 'hello world',
        source: 'web-shell',
      },
    });
  });

  it('routes auth and session-change host actions to the extension', async () => {
    const props = await renderApp();

    const onSlashCommand = callback<
      (command: { command: string; input: string }) => boolean | void
    >(props, 'onSlashCommand');
    expect(onSlashCommand({ command: 'auth', input: '' })).toBe(true);
    expect(onSlashCommand({ command: 'account', input: '' })).toBe(true);

    callback<(sessionId: string | undefined) => void>(
      props,
      'onSessionIdChange',
    )('session-2');
    callback<(session: { sessionId?: string; sessionName?: string }) => void>(
      props,
      'onSessionInfoChange',
    )({ sessionId: 'session-2', sessionName: 'My Title' });

    expect(postMessagesOfType('auth')).toHaveLength(1);
    expect(postMessagesOfType('getAccountInfo')).toHaveLength(1);
    expect(postMessagesOfType('webShellSessionChanged').at(-1)).toEqual({
      type: 'webShellSessionChanged',
      data: { sessionId: 'session-2', workspaceCwd: '/workspace' },
    });
    expect(postMessagesOfType('updatePanelTitle').at(-1)).toEqual({
      type: 'updatePanelTitle',
      data: { title: 'My Title' },
    });
  });

  it('notifies once when a connection error persists instead of looping', async () => {
    mocks.connectionError.current = 'daemon connection lost';

    // An unstable onError re-runs the mirrored notification effect on every
    // render; the mock trips after three notifications instead of hanging
    // on the infinite loop.
    await renderApp();
    const { container } = mounted[mounted.length - 1];

    expect(mocks.errorNotifications.current).toBe(1);
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain('daemon connection lost');
  });

  it('releases the panel when a session switch times out', async () => {
    sdkMocks.listWorkspaceSessionsPage.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'session-2',
          workspaceCwd: '/workspace',
          displayName: 'Other session',
        },
      ],
      nextCursor: undefined,
    });
    vi.useFakeTimers();
    try {
      await renderApp();
      const { container } = mounted[mounted.length - 1];

      const historyButton = container.querySelector(
        'button[aria-haspopup="dialog"]',
      ) as HTMLButtonElement;
      expect(historyButton).not.toBeNull();
      await act(async () => {
        historyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      const row = document.querySelector(
        '[data-session-id="session-2"]',
      ) as HTMLElement;
      expect(row).not.toBeNull();
      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Loading conversation…');

      // A retriable connection failure that never settles must not lock the
      // panel behind the overlay forever.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(container.textContent).not.toContain('Loading conversation…');
      expect(container.textContent).toContain(
        'The conversation switch timed out. Try again.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('session switch overlay', () => {
  async function selectPastSession(): Promise<{
    container: HTMLElement;
    historyButton: HTMLButtonElement;
  }> {
    sdkMocks.listWorkspaceSessionsPage.mockResolvedValueOnce({
      sessions: [
        {
          sessionId: 'session-2',
          workspaceCwd: '/workspace',
          displayName: 'Old conversation',
          updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
        },
      ],
    });
    await renderApp();
    const { container } = mounted[mounted.length - 1];
    const historyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Past conversations"]',
    );
    expect(historyButton).not.toBeNull();
    await act(async () => {
      historyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const row = container.querySelector<HTMLElement>(
      '[data-session-id="session-2"]',
    );
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    return { container, historyButton: historyButton! };
  }

  it('unlocks the panel when the daemon never confirms a session switch', async () => {
    // https://github.com/QwenLM/qwen-code/issues/10405 — with the daemon
    // unreachable the embedded shell can never confirm the switch, so the
    // "switching session" overlay would lock the panel until a webview
    // reload. The host must lift the lock on its own so the user can retry.
    vi.useFakeTimers();
    try {
      const { container, historyButton } = await selectPastSession();
      expect(container.textContent).toContain('Loading conversation…');

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Loading conversation…');
      expect(historyButton.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still clears the overlay at once when the shell confirms the switch', async () => {
    vi.useFakeTimers();
    try {
      const { container } = await selectPastSession();
      expect(container.textContent).toContain('Loading conversation…');

      await act(async () => {
        callback<(sessionId: string | undefined) => void>(
          mocks.embeddedProps.current as CapturedProps,
          'onSessionIdChange',
        )('session-2');
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Loading conversation…');

      // A confirmed switch must also cancel the failure timer, or it would
      // raise a bogus switch-failed notice after the fact.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain(
        'The conversation switch timed out.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
