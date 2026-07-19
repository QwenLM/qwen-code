/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelInstanceSnapshot } from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { channelState, workspace, actions } = vi.hoisted(() => ({
  channelState: {
    loading: false,
    error: undefined as Error | undefined,
    catalog: [
      {
        type: 'dingtalk',
        displayName: 'DingTalk',
        manageable: true,
        fields: [],
        auth: ['credentials'] as const,
      },
    ],
    snapshot: {
      revision: 'revision-1',
      instances: {} as Record<string, DaemonChannelInstanceSnapshot>,
    },
  },
  workspace: {
    workspaceCwd: '/workspace/demo',
    capabilities: { features: ['channel_management'] },
  },
  actions: {
    reload: vi.fn(),
    createOrUpdate: vi.fn(),
    remove: vi.fn(),
    setStartup: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useChannels: () => ({ ...channelState, ...actions }),
  useWorkspace: () => workspace,
}));

const { ChannelsManagerPage } = await import('./ChannelsManagerPage');

let container: HTMLDivElement;
let root: Root;

function instance(
  state: DaemonChannelInstanceSnapshot['runtime']['state'],
  overrides: Partial<DaemonChannelInstanceSnapshot> = {},
): DaemonChannelInstanceSnapshot {
  return {
    name: 'bot',
    config: { type: 'dingtalk', appKey: 'visible-config' },
    secrets: { appSecret: { present: true, source: 'literal' } },
    startsWithServe: false,
    runtime: { state },
    ...overrides,
  };
}

async function renderPage() {
  await act(async () => {
    root.render(<ChannelsManagerPage onClose={vi.fn()} />);
  });
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (element) =>
      element.getAttribute('aria-label') === name ||
      element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

function elementWithText(selector: string, text: string): Element {
  const match = Array.from(document.querySelectorAll(selector)).find(
    (element) => element.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Element not found: ${text}`);
  return match;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function pointerDown(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  channelState.loading = false;
  channelState.error = undefined;
  channelState.snapshot = { revision: 'revision-1', instances: {} };
  workspace.workspaceCwd = '/workspace/demo';
  workspace.capabilities = { features: ['channel_management'] };
  for (const mock of Object.values(actions)) {
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelsManagerPage', () => {
  it('renders status and retries an error instance', async () => {
    channelState.snapshot.instances.bot = instance('error', {
      runtime: { state: 'error', lastError: 'invalid token' },
    });
    await renderPage();

    expect(document.body.textContent).toContain('invalid token');
    click(button('Retry bot'));
    await flush();

    expect(actions.restart).toHaveBeenCalledWith('bot');
  });

  it('stays read-only when channel_management is unavailable', async () => {
    workspace.capabilities = { features: [] };
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    expect(document.body.textContent?.toLowerCase()).toContain('bearer token');
    expect(button('Add channel').disabled).toBe(true);
    expect(button('Start bot').disabled).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('[role="switch"]')?.disabled,
    ).toBe(true);
  });

  it('starts a stopped channel', async () => {
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    click(button('Start bot'));
    await flush();
    expect(actions.start).toHaveBeenCalledWith('bot');
  });

  it('updates the startup preference with the current revision', async () => {
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const startupSwitch = document.querySelector('[role="switch"]');
    if (!startupSwitch) throw new Error('Startup switch not found');
    click(startupSwitch);
    await flush();
    expect(actions.setStartup).toHaveBeenCalledWith('bot', {
      expectedRevision: 'revision-1',
      enabled: true,
    });
  });

  it('stops a connected channel', async () => {
    channelState.snapshot.instances.bot = instance('connected');
    await renderPage();

    click(button('Stop bot'));
    await flush();
    expect(actions.stop).toHaveBeenCalledWith('bot');
  });

  it('restarts a connected channel', async () => {
    channelState.snapshot.instances.bot = instance('connected');
    await renderPage();

    click(button('Restart bot'));
    await flush();
    expect(actions.restart).toHaveBeenCalledWith('bot');
  });

  it('confirms before deleting a channel', async () => {
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    pointerDown(button('More actions for bot'));
    await flush();
    click(elementWithText('[role="menuitem"]', 'Delete bot'));
    await flush();
    expect(actions.remove).not.toHaveBeenCalled();

    click(button('Delete channel'));
    await flush();
    expect(actions.remove).toHaveBeenCalledWith('bot', {
      expectedRevision: 'revision-1',
    });
  });

  it('renders the loading state', async () => {
    channelState.loading = true;
    await renderPage();
    expect(document.body.textContent).toContain('Loading channels');
  });

  it('renders the empty state', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('No channels configured');
  });

  it('retries after a channel load error', async () => {
    channelState.error = new Error('daemon unavailable');
    await renderPage();
    expect(document.body.textContent).toContain('daemon unavailable');
    click(button('Retry loading channels'));
    expect(actions.reload).toHaveBeenCalledOnce();
  });

  it('prevents double submission while an instance action is busy', async () => {
    const pending = deferred<void>();
    actions.start.mockReturnValue(pending.promise);
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const start = button('Start bot');
    click(start);
    click(start);
    expect(actions.start).toHaveBeenCalledOnce();
    expect(start.disabled).toBe(true);

    pending.resolve();
    await flush();
    expect(button('Start bot').disabled).toBe(false);
  });

  it('recovers focus and controls after an action failure', async () => {
    actions.restart.mockRejectedValue(new Error('worker did not stop'));
    channelState.snapshot.instances.bot = instance('connected');
    await renderPage();

    const restart = button('Restart bot');
    restart.focus();
    click(restart);
    await flush();

    expect(document.body.textContent).toContain('worker did not stop');
    expect(button('Restart bot').disabled).toBe(false);
    expect(document.activeElement).toBe(button('Restart bot'));
  });

  it('keeps delete confirmation open when deletion fails', async () => {
    actions.remove.mockRejectedValue(new Error('revision conflict'));
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    pointerDown(button('More actions for bot'));
    await flush();
    click(elementWithText('[role="menuitem"]', 'Delete bot'));
    await flush();
    click(button('Delete channel'));
    await flush();

    expect(document.body.textContent).toContain('revision conflict');
    expect(document.body.textContent).toContain('Delete channel?');
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain('revision conflict');
    expect(button('Delete channel').disabled).toBe(false);
  });

  it('keeps channel secrets out of rendered output', async () => {
    channelState.snapshot.instances.bot = instance('connected', {
      config: { type: 'dingtalk', appSecret: 'must-not-render' },
    });
    await renderPage();

    expect(document.body.textContent).not.toContain('must-not-render');
  });

  it('wires the initial focus ref to the page heading', async () => {
    const headingRef = createRef<HTMLHeadingElement>();
    await act(async () => {
      root.render(
        <ChannelsManagerPage onClose={vi.fn()} initialFocusRef={headingRef} />,
      );
    });

    expect(headingRef.current?.textContent).toBe('Channels');
  });
});
