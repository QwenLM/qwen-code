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
  getRewindSnapshots: vi.fn<
    (sessionId: string) => Promise<{
      snapshots: Array<{ turnIndex: number; promptId: string }>;
    }>
  >(async () => ({ snapshots: [] })),
  rewindSession: vi.fn(async () => ({})),
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
    getRewindSnapshots = sdkMocks.getRewindSnapshots;
    rewindSession = sdkMocks.rewindSession;
  },
}));

vi.mock('@qwen-code/web-shell', async () => {
  const { useEffect, useMemo, useRef, useState } = await import('react');
  return {
    WebShellWithProviders: (props: CapturedProps) => {
      mocks.embeddedProps.current = props;
      // Mirror App.tsx's error-notification effect: while a connection error
      // persists, each distinct error value is reported once. Hosts may pass
      // an onError whose identity changes on every render, which re-runs the
      // effect without re-delivering the already-reported error.
      const onError = props.onError as ((error: Error) => void) | undefined;
      const lastReportedError = useRef<string | undefined>(undefined);
      const [churn, setChurn] = useState(0);
      // A fresh wrapper identity whenever the host's onError identity
      // changes mirrors a host passing an inline onError; the churn state
      // below additionally forces the effect to re-run after a delivery,
      // like the host re-render that delivering the error triggers.
      const unstableOnError = useMemo(
        () => (onError ? (error: Error) => onError(error) : undefined),
        [onError],
      );
      useEffect(() => {
        const message = mocks.connectionError.current;
        if (!message) {
          lastReportedError.current = undefined;
          return;
        }
        if (lastReportedError.current === message) return;
        // App.tsx returns before stamping when no handler is attached, so a
        // handler that appears later still receives the persistent error.
        if (!unstableOnError) return;
        lastReportedError.current = message;
        mocks.errorNotifications.current += 1;
        if (mocks.errorNotifications.current > 3) {
          // Value-dedup makes a notify loop impossible; fail fast if this
          // mirror ever regresses instead of hanging.
          throw new Error('onError notified in a loop');
        }
        unstableOnError(new Error(message));
        // Delivering an error re-renders the host; force one extra effect
        // run under a fresh callback identity to mirror that churn.
        if (churn < 1) setChurn((count) => count + 1);
      }, [unstableOnError, churn]);
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
  document.body.dataset.qwenDaemonToken = 'test-token';
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

  it('relativizes the active file across a symlinked workspace', async () => {
    await renderApp();

    // The daemon matches workspaces by canonical path while every
    // `activeEditorChanged` sender posts VS Code's raw `uri.fsPath`, so the
    // bootstrap carries both spellings of a symlinked folder.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'webShellBootstrap',
            data: {
              baseUrl: 'http://localhost:4141',
              clientId: 'client-1',
              workspaceCwd: '/private/workspace',
              editorWorkspaceCwd: '/workspace',
              hostKind: 'view',
            },
          },
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'activeEditorChanged',
            data: {
              fileName: 'editor.ts',
              filePath: '/workspace/nested/editor.ts',
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

    // A bare `@editor.ts` is what the prefix strip degrades to when the two
    // sides sit in different path spaces; the agent then resolves it against
    // the workspace root and finds nothing, or the wrong sibling.
    await expect(
      prepareSubmit({ prompt: 'Explain this', inputAnnotations: [] }),
    ).resolves.toEqual({
      prompt: '@nested/editor.ts Explain this',
      inputAnnotations: [
        expect.objectContaining({
          type: 'reference',
          reference: expect.objectContaining({
            value: '/workspace/nested/editor.ts',
            serialized: '@nested/editor.ts',
          }),
        }),
      ],
    });

    // The file picker produces a true workspace-relative annotation value, so
    // the dedup has to see the same string or it attaches the file twice.
    const pickerAnnotation = {
      type: 'reference',
      start: 0,
      end: '@nested/editor.ts'.length,
      text: '@nested/editor.ts',
      reference: {
        id: 'picker:nested/editor.ts',
        kind: 'file',
        label: 'editor.ts',
        value: 'nested/editor.ts',
        serialized: '@nested/editor.ts',
      },
    };
    await expect(
      prepareSubmit({
        prompt: 'Explain this',
        inputAnnotations: [pickerAnnotation],
      }),
    ).resolves.toEqual({
      prompt: 'Explain this',
      inputAnnotations: [pickerAnnotation],
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

  it('keeps an explicit active-file exclusion across editor changes', async () => {
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

      // Switching to a different file must preserve the explicit exclusion.
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
      ).resolves.toBeUndefined();
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

  it('opens permission diffs only from authoritative tool-call content', async () => {
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
          preview: { kind: 'key_value', rows: [] },
          toolCall: {
            content: [
              {
                type: 'diff',
                path: '/workspace/new.ts',
                oldText: 'header\nconst value = 1;\nfooter',
                newText: 'header\nconst value = 2;\nfooter',
              },
            ],
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
        oldText: 'header\nconst value = 1;\nfooter',
        newText: 'header\nconst value = 2;\nfooter',
        source: 'web-shell',
        requestId: 'req-write',
      },
    });
    expect(postMessagesOfType('webShellPermissionState').at(-1)).toEqual({
      type: 'webShellPermissionState',
      data: { pending: true, requestId: 'req-write' },
    });
  });

  it('keeps host permission ownership in sync while pending stays true', async () => {
    const props = await renderApp();
    const onTranscriptChange = callback<(blocks: unknown[]) => void>(
      props,
      'onTranscriptChange',
    );
    const permissionBlock = (id: string, path: string) => ({
      id,
      kind: 'permission',
      requestId: id,
      title: path,
      options: [],
      preview: { kind: 'key_value', rows: [] },
      toolCall: {
        content: [{ type: 'diff', path, oldText: 'old', newText: 'new' }],
      },
    });

    await act(async () => {
      onTranscriptChange([
        permissionBlock('req-a', '/workspace/a.ts'),
        permissionBlock('req-b', '/workspace/b.ts'),
      ]);
      await Promise.resolve();
    });

    expect(postMessagesOfType('webShellPermissionState').at(-1)).toEqual({
      type: 'webShellPermissionState',
      data: { pending: true, requestId: 'req-a' },
    });

    await act(async () => {
      onTranscriptChange([
        { ...permissionBlock('req-a', '/workspace/a.ts'), resolved: true },
        permissionBlock('req-b', '/workspace/b.ts'),
      ]);
      await Promise.resolve();
    });

    // Pending stays true, but ownership moves to the remaining request so a
    // stale accept cannot vote on the wrong approval.
    expect(postMessagesOfType('webShellPermissionState').at(-1)).toEqual({
      type: 'webShellPermissionState',
      data: { pending: true, requestId: 'req-b' },
    });
  });

  it('posts pending: false when pending permission diffs are torn down', async () => {
    const props = await renderApp();
    const onTranscriptChange = callback<(blocks: unknown[]) => void>(
      props,
      'onTranscriptChange',
    );

    await act(async () => {
      onTranscriptChange([
        {
          id: 'perm-a',
          kind: 'permission',
          requestId: 'req-a',
          title: 'update a.ts',
          options: [],
          preview: { kind: 'key_value', rows: [] },
          toolCall: {
            content: [
              {
                type: 'diff',
                path: '/workspace/a.ts',
                oldText: 'old',
                newText: 'new',
              },
            ],
          },
        },
      ]);
      await Promise.resolve();
    });

    expect(postMessagesOfType('webShellPermissionState').at(-1)).toEqual({
      type: 'webShellPermissionState',
      data: { pending: true, requestId: 'req-a' },
    });

    // Closing the host tab/view unmounts the app. The teardown must tell
    // the extension the pending set is gone; otherwise the vote gate stays
    // open for an approval the user can no longer see.
    const { container, root } = mounted.splice(mounted.length - 1, 1)[0];
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();

    expect(postMessagesOfType('webShellPermissionState').at(-1)).toEqual({
      type: 'webShellPermissionState',
      data: { pending: false },
    });
    expect(postMessagesOfType('closeDiff')).toEqual([
      {
        type: 'closeDiff',
        data: { path: '/workspace/a.ts', requestId: 'req-a' },
      },
    ]);
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

    // The mirrored effect re-runs under a fresh onError identity on every
    // re-render (like a host passing an inline onError); the value-dedup
    // must still deliver the persistent error exactly once. The mock trips
    // after three notifications instead of hanging if that ever regresses.
    await renderApp();
    const { container } = mounted[mounted.length - 1];

    expect(mocks.errorNotifications.current).toBe(1);
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain('daemon connection lost');
  });

  it('does not report or stamp an error while no onError handler is attached', async () => {
    mocks.connectionError.current = 'daemon connection lost';
    const { WebShellWithProviders } = await import('@qwen-code/web-shell');
    const WebShell =
      WebShellWithProviders as unknown as ComponentType<CapturedProps>;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ container, root });

    await act(async () => {
      root.render(<WebShell />);
      await Promise.resolve();
    });
    // App.tsx returns before stamping when no handler exists; the mirror must
    // leave the error unreported and unstamped here.
    expect(mocks.errorNotifications.current).toBe(0);

    // Because nothing was stamped, a handler attached later still receives
    // the persistent error exactly once.
    await act(async () => {
      root.render(<WebShell onError={() => {}} />);
      await Promise.resolve();
    });
    expect(mocks.errorNotifications.current).toBe(1);
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

      expect(
        container.querySelector(
          '[role="status"][aria-label="Loading conversation…"]',
        ),
      ).not.toBeNull();

      // A retriable connection failure that never settles must not leave the
      // header loading state active forever.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(
        container.querySelector(
          '[role="status"][aria-label="Loading conversation…"]',
        ),
      ).toBeNull();
      expect(container.textContent).toContain(
        'The conversation switch timed out. Try again.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges allowlisted pre-cutover sessions into the history list', async () => {
    // v0.21-era conversations were recorded without source attribution, so
    // the vscode-scoped catalog query cannot return them. The host ships the
    // legacy ids it still has in globalState; the panel then claims exactly
    // those sessions back from the daemon's default catalog — without
    // surfacing unattributed CLI sessions or browser-stamped ones.
    sdkMocks.listWorkspaceSessionsPage.mockImplementation(
      (options?: { sourceType?: string }) => {
        if (options?.sourceType === 'vscode') {
          return Promise.resolve({
            sessions: [
              {
                sessionId: 'vscode-1',
                workspaceCwd: '/workspace',
                displayName: 'Current chat',
                sourceType: 'vscode',
                updatedAt: '2026-09-09T12:00:00.000Z',
              },
            ],
            nextCursor: undefined,
          });
        }
        if (options?.sourceType === 'default') {
          return Promise.resolve({
            sessions: [
              {
                sessionId: 'legacy-1',
                workspaceCwd: '/workspace',
                displayName: 'Pre-upgrade chat',
                updatedAt: '2026-08-01T12:00:00.000Z',
              },
              {
                sessionId: 'cli-1',
                workspaceCwd: '/workspace',
                displayName: 'Terminal chat',
                updatedAt: '2026-08-02T12:00:00.000Z',
              },
              {
                sessionId: 'web-1',
                workspaceCwd: '/workspace',
                displayName: 'Browser chat',
                sourceType: 'default',
                updatedAt: '2026-08-03T12:00:00.000Z',
              },
            ],
            nextCursor: undefined,
          });
        }
        return Promise.resolve({ sessions: [], nextCursor: undefined });
      },
    );

    await renderApp();
    const { container } = mounted[mounted.length - 1];

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'webShellBootstrap',
            data: {
              baseUrl: 'http://localhost:4141',
              clientId: 'client-1',
              workspaceCwd: '/workspace',
              sessionId: 'session-1',
              hostKind: 'panel',
              legacyConversationIds: ['legacy-1', 'never-recorded'],
            },
          },
        }),
      );
      // The remount effect refetches the vscode page, then pages the default
      // catalog for allowlisted ids — both are sequential awaits.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });

    const historyButton = container.querySelector(
      'button[aria-haspopup="dialog"]',
    ) as HTMLButtonElement;
    expect(historyButton).not.toBeNull();
    await act(async () => {
      historyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // Opening the dropdown triggers the first-page load, which now includes
    // the legacy-catalog scan; wait for its rows instead of fixed flushes.
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-session-id="legacy-1"]'),
      ).not.toBeNull();
    });

    expect(
      document.querySelector('[data-session-id="vscode-1"]'),
    ).not.toBeNull();
    // Neither the unattributed CLI session nor the browser-stamped one is
    // allowlisted, so the panel must not claim them.
    expect(document.querySelector('[data-session-id="cli-1"]')).toBeNull();
    expect(document.querySelector('[data-session-id="web-1"]')).toBeNull();

    const defaultCatalogCalls = sdkMocks.listWorkspaceSessionsPage.mock.calls
      .map(([options]) => options)
      .filter(
        (options) =>
          (options as { sourceType?: string })?.sourceType === 'default',
      );
    expect(defaultCatalogCalls.length).toBeGreaterThan(0);
    expect(defaultCatalogCalls[0]).toMatchObject({
      archiveState: 'active',
    });

    // The scan converges after its first successful run: ids that never
    // match (other workspaces, deleted transcripts, since-stamped sessions)
    // must not re-page the default catalog on every dropdown open.
    await act(async () => {
      historyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      historyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      const vscodeCalls = sdkMocks.listWorkspaceSessionsPage.mock.calls.filter(
        ([options]) =>
          (options as { sourceType?: string })?.sourceType === 'vscode',
      );
      expect(vscodeCalls.length).toBeGreaterThanOrEqual(2);
    });
    expect(
      sdkMocks.listWorkspaceSessionsPage.mock.calls.filter(
        ([options]) =>
          (options as { sourceType?: string })?.sourceType === 'default',
      ),
    ).toHaveLength(1);
    expect(
      document.querySelector('[data-session-id="legacy-1"]'),
    ).not.toBeNull();
  });
});

describe('web shell permission decision messages', () => {
  function installShellApi(
    api: Record<string, unknown>,
  ): Record<string, unknown> {
    const props = mocks.embeddedProps.current;
    expect(props).not.toBeNull();
    const shellRef = (props as CapturedProps)['shellRef'] as {
      current: unknown;
    };
    expect(shellRef).toBeTruthy();
    shellRef.current = api;
    return api;
  }

  async function setPendingPermission(
    props: CapturedProps,
    requestId = 'req-1',
  ) {
    const onTranscriptChange = callback<(blocks: unknown[]) => void>(
      props,
      'onTranscriptChange',
    );
    await act(async () => {
      onTranscriptChange([
        {
          id: 'permission-1',
          kind: 'permission',
          requestId,
          title: 'Edit fixture.txt',
          resolved: false,
          options: [],
          preview: { kind: 'key_value', rows: [] },
          toolCall: {
            content: [
              {
                type: 'diff',
                path: '/workspace/fixture.txt',
                oldText: 'before',
                newText: 'after',
              },
            ],
          },
        },
      ]);
      await Promise.resolve();
    });
  }

  async function dispatchDecision(
    decision: string,
    source: Window | null,
    requestId = 'req-1',
  ) {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'webShellPermissionDecision',
            data: { decision, requestId },
          },
          source,
        }),
      );
      await Promise.resolve();
    });
  }

  it('forwards host-relayed decisions to the web shell', async () => {
    const props = await renderApp();
    const respondToPendingPermission = vi.fn().mockResolvedValue(true);
    installShellApi({ respondToPendingPermission });
    await setPendingPermission(props);

    // Extension-host messages arrive via the webview preload frame, i.e.
    // with this frame's parent as their source.
    await dispatchDecision('allow', window.parent);

    expect(respondToPendingPermission).toHaveBeenCalledWith('req-1', 'allow');
  });

  it('ignores decisions posted by a nested iframe window', async () => {
    const props = await renderApp();
    const respondToPendingPermission = vi.fn().mockResolvedValue(true);
    installShellApi({ respondToPendingPermission });
    await setPendingPermission(props);

    // MCP apps and artifact previews run in scriptable sandboxed iframes
    // inside this webview; they can postMessage to this window and must
    // not be able to vote on the pending approval, even when they know the
    // active request id. Their source is their own child window, not the
    // preload parent frame.
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
      const childWindow = iframe.contentWindow;
      expect(childWindow).not.toBeNull();
      await dispatchDecision('allow', childWindow as Window);
      await dispatchDecision('reject', childWindow as Window);
    } finally {
      iframe.remove();
    }

    expect(respondToPendingPermission).not.toHaveBeenCalled();
  });

  it('ignores decisions delivered without a source window', async () => {
    const props = await renderApp();
    const respondToPendingPermission = vi.fn().mockResolvedValue(true);
    installShellApi({ respondToPendingPermission });
    await setPendingPermission(props);

    // Fail closed on synthetic deliveries: real host messages always carry
    // the preload frame as their source.
    await dispatchDecision('allow', null);

    expect(respondToPendingPermission).not.toHaveBeenCalled();
  });

  it('surfaces a notice when the shell resolves the vote to false', async () => {
    const props = await renderApp();
    const respondToPendingPermission = vi.fn().mockResolvedValue(false);
    installShellApi({ respondToPendingPermission });
    await setPendingPermission(props);
    const { container } = mounted[mounted.length - 1];

    await dispatchDecision('allow', window.parent);
    await act(async () => {
      await Promise.resolve();
    });

    expect(respondToPendingPermission).toHaveBeenCalledWith('req-1', 'allow');
    // A resolved `false` must not die silently: it covers both the benign
    // race (the approval was resolved elsewhere one tick earlier) and hung
    // votes (e.g. while catching up after a session switch). Notify the
    // user without the hard-error state reset of `handleShellError`.
    expect(container.textContent).toContain(
      'The approval decision could not be applied.',
    );
  });
});

describe('EmbeddedApp rewind preflight localization', () => {
  it('rethrows a localized error when getRewindSnapshots rejects', async () => {
    await renderApp();
    const props = mocks.embeddedProps.current as CapturedProps;

    const onUserMessageEditRequest = callback<
      (turnIndex: number, content: string) => boolean
    >(props, 'onUserMessageEditRequest');
    await act(async () => {
      onUserMessageEditRequest(0, 'original text');
      await Promise.resolve();
    });

    sdkMocks.getRewindSnapshots.mockRejectedValueOnce(new Error('HTTP 503'));

    const prepareSubmit = callback<
      (submission: {
        prompt: string;
        inputAnnotations: unknown[];
      }) => Promise<{ prompt: string; inputAnnotations: unknown[] } | undefined>
    >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');

    await expect(
      prepareSubmit({ prompt: 'edited text', inputAnnotations: [] }),
    ).rejects.toThrow('Failed to edit the message. Please try again.');
  });

  it('rethrows a localized error when rewindSession rejects', async () => {
    await renderApp();
    const props = mocks.embeddedProps.current as CapturedProps;

    const onUserMessageEditRequest = callback<
      (turnIndex: number, content: string) => boolean
    >(props, 'onUserMessageEditRequest');
    await act(async () => {
      onUserMessageEditRequest(0, 'original text');
      await Promise.resolve();
    });

    sdkMocks.getRewindSnapshots.mockResolvedValueOnce({
      snapshots: [{ turnIndex: 0, promptId: 'p-1' }],
    });
    sdkMocks.rewindSession.mockRejectedValueOnce(new Error('HTTP 503'));

    const prepareSubmit = callback<
      (submission: {
        prompt: string;
        inputAnnotations: unknown[];
      }) => Promise<{ prompt: string; inputAnnotations: unknown[] } | undefined>
    >(mocks.embeddedProps.current as CapturedProps, 'prepareSubmit');

    await expect(
      prepareSubmit({ prompt: 'edited text', inputAnnotations: [] }),
    ).rejects.toThrow('Failed to edit the message. Please try again.');
  });
});
