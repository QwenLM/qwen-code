/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import type { ComponentType } from 'react';
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
}));

vi.mock('@qwen-code/web-shell', () => ({
  WebShellWithProviders: (props: CapturedProps) => {
    mocks.embeddedProps.current = props;
    return null;
  },
}));

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
});
