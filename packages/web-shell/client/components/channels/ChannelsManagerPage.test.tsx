/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonChannelInstanceSnapshot,
} from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { channelState, workspace, actions, authActions } = vi.hoisted(() => {
  const authActions = {
    begin: vi.fn(),
    status: vi.fn(),
    qr: vi.fn(),
    cancel: vi.fn(),
    commit: vi.fn(),
  };
  return {
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
      client: {},
      workspaceCwd: '/workspace/demo',
      token: 'test-token' as string | undefined,
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
      auth: authActions,
    },
    authActions,
  };
});

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
    webhookSecrets: {},
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
  channelState.catalog = [
    {
      type: 'dingtalk',
      displayName: 'DingTalk',
      manageable: true,
      fields: [],
      auth: ['credentials'] as const,
    },
  ];
  channelState.snapshot = { revision: 'revision-1', instances: {} };
  workspace.client = {};
  workspace.workspaceCwd = '/workspace/demo';
  workspace.token = 'test-token';
  workspace.capabilities = {
    features: ['channel_management', 'channel_auth'],
  };
  for (const mock of Object.values(actions)) {
    if (typeof mock !== 'function') continue;
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
  for (const mock of Object.values(authActions)) {
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
  authActions.begin.mockResolvedValue({
    id: 'auth-1',
    state: 'requesting',
    qrRevision: 0,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
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

  it('explains when channel management is unsupported', async () => {
    workspace.capabilities = { features: [] };
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    expect(document.body.textContent?.toLowerCase()).toContain('not supported');
    expect(document.body.textContent?.toLowerCase()).not.toContain(
      'bearer token',
    );
    expect(button('Add channel').disabled).toBe(true);
    expect(button('Start bot').disabled).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('[role="switch"]')?.disabled,
    ).toBe(true);
  });

  it('requires a bearer token even when channel management is supported', async () => {
    workspace.token = undefined;
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

  it.each(['starting', 'partial'] as const)(
    'stops a %s channel',
    async (runtimeState) => {
      channelState.snapshot.instances.bot = instance(runtimeState);
      await renderPage();

      click(button('Stop bot'));
      await flush();
      expect(actions.stop).toHaveBeenCalledWith('bot');
    },
  );

  it('restarts a connected channel', async () => {
    channelState.snapshot.instances.bot = instance('connected');
    await renderPage();

    click(button('Restart bot'));
    await flush();
    expect(actions.restart).toHaveBeenCalledWith('bot');
  });

  it('saves an edit with the authoritative revision and restores focus', async () => {
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const trigger = button('More actions for bot');
    pointerDown(trigger);
    await flush();
    click(elementWithText('[role="menuitem"]', 'Edit bot'));
    await flush();

    expect(
      document.querySelector<HTMLInputElement>('#channel-editor-name')
        ?.disabled,
    ).toBe(true);
    click(button('Save changes'));
    await flush();
    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    );

    expect(actions.createOrUpdate).toHaveBeenCalledWith('bot', {
      expectedRevision: 'revision-1',
      config: { type: 'dingtalk', appKey: 'visible-config' },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the editor open and reloads on a save conflict', async () => {
    actions.createOrUpdate.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'channel_settings_conflict' },
        'Channel settings changed.',
      ),
    );
    actions.reload.mockResolvedValue(channelState);
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    pointerDown(button('More actions for bot'));
    await flush();
    click(elementWithText('[role="menuitem"]', 'Edit bot'));
    await flush();
    click(button('Save changes'));
    await flush();

    expect(actions.reload).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Channel settings changed.');
  });

  it('keeps unmanaged channel configuration read-only', async () => {
    channelState.catalog.push({
      type: 'legacy',
      displayName: 'Legacy',
      manageable: false,
      fields: [],
      auth: [],
    });
    channelState.snapshot.instances.bot = instance('stopped', {
      config: { type: 'legacy', inheritedField: true },
    });
    await renderPage();

    pointerDown(button('More actions for bot'));
    await flush();

    const item = elementWithText(
      '[role="menuitem"]',
      'Configuration is read-only',
    );
    expect(item.getAttribute('data-disabled')).not.toBeNull();
    click(item);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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

  it('reloads a conflicted revision before retrying delete', async () => {
    const pendingReload = deferred<typeof channelState>();
    actions.remove
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          { code: 'channel_settings_conflict' },
          'Channel settings changed.',
        ),
      )
      .mockResolvedValue(undefined);
    actions.reload.mockReturnValue(pendingReload.promise);
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    pointerDown(button('More actions for bot'));
    await flush();
    click(elementWithText('[role="menuitem"]', 'Delete bot'));
    await flush();
    click(button('Delete channel'));
    await flush();

    expect(actions.reload).toHaveBeenCalledOnce();
    expect(actions.remove).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Channel settings changed.');
    expect(document.body.textContent).toContain('Delete channel?');
    expect(button('Delete channel').disabled).toBe(true);

    channelState.snapshot = {
      ...channelState.snapshot,
      revision: 'revision-2',
    };
    pendingReload.resolve(channelState);
    await flush();
    await renderPage();
    click(button('Delete channel'));
    await flush();

    expect(actions.remove).toHaveBeenNthCalledWith(2, 'bot', {
      expectedRevision: 'revision-2',
    });
  });

  it('keeps revisioned actions blocked when conflict reload fails', async () => {
    actions.setStartup.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'channel_settings_conflict' },
        'Channel settings changed.',
      ),
    );
    actions.reload.mockRejectedValue(new Error('reload failed'));
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const startupSwitch = document.querySelector('[role="switch"]');
    if (!startupSwitch) throw new Error('Startup switch not found');
    click(startupSwitch);
    await flush();

    expect(document.body.textContent).toContain('Channel settings changed.');
    expect(document.body.textContent).toContain('reload failed');
    expect(
      document.querySelector<HTMLInputElement>('[role="switch"]')?.disabled,
    ).toBe(true);
  });

  it('blocks every workspace config action after a stale reload failure', async () => {
    actions.setStartup.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'channel_settings_conflict' },
        'Channel settings changed.',
      ),
    );
    actions.reload.mockRejectedValue(new Error('reload failed'));
    channelState.snapshot.instances = {
      bot: instance('stopped'),
      other: instance('stopped', { name: 'other' }),
    };
    await renderPage();

    const botStartup = document.querySelector(
      '[aria-label="Start bot with serve"]',
    );
    if (!botStartup) throw new Error('Bot startup switch not found');
    click(botStartup);
    await flush();

    expect(document.body.textContent).toContain(
      'Channel settings are out of date',
    );
    expect(button('Add channel').disabled).toBe(true);
    expect(button('More actions for other').disabled).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Start other with serve"]',
      )?.disabled,
    ).toBe(true);
    expect(button('Start other').disabled).toBe(false);
  });

  it('clears the workspace revision block after a runtime action reloads', async () => {
    actions.setStartup.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'channel_settings_conflict' },
        'Channel settings changed.',
      ),
    );
    actions.reload.mockRejectedValue(new Error('reload failed'));
    actions.start.mockImplementation(async () => {
      channelState.snapshot = {
        ...channelState.snapshot,
        instances: { ...channelState.snapshot.instances },
      };
    });
    channelState.snapshot.instances = {
      bot: instance('stopped'),
      other: instance('stopped', { name: 'other' }),
    };
    await renderPage();

    const botStartup = document.querySelector(
      '[aria-label="Start bot with serve"]',
    );
    if (!botStartup) throw new Error('Bot startup switch not found');
    click(botStartup);
    await flush();
    expect(button('Add channel').disabled).toBe(true);
    click(button('Start other'));
    await flush();

    expect(actions.start).toHaveBeenCalledWith('other');
    expect(button('Add channel').disabled).toBe(false);
    expect(document.body.textContent).not.toContain(
      'Channel settings are out of date',
    );
  });

  it('clears the workspace revision block after manual reload', async () => {
    actions.setStartup.mockRejectedValue(
      new DaemonHttpError(
        409,
        { code: 'channel_settings_conflict' },
        'Channel settings changed.',
      ),
    );
    actions.reload
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValue(channelState);
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const startupSwitch = document.querySelector('[role="switch"]');
    if (!startupSwitch) throw new Error('Startup switch not found');
    click(startupSwitch);
    await flush();
    expect(button('Add channel').disabled).toBe(true);
    channelState.error = new Error('reload failed');
    await renderPage();
    click(button('Retry loading channels'));
    await flush();

    expect(button('Add channel').disabled).toBe(false);
    expect(document.body.textContent).not.toContain(
      'Channel settings are out of date',
    );
  });

  it('keeps focus on Add after the deleted trigger unmounts', async () => {
    actions.remove.mockImplementation(async () => {
      channelState.snapshot = {
        revision: 'revision-2',
        instances: {},
      };
    });
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();

    const removedTrigger = button('More actions for bot');
    removedTrigger.focus();
    pointerDown(removedTrigger);
    await flush();
    click(elementWithText('[role="menuitem"]', 'Delete bot'));
    await flush();
    button('Delete channel').focus();
    click(button('Delete channel'));
    await flush();
    await act(
      async () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    );

    expect(document.body.textContent).not.toContain('bot');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(removedTrigger.isConnected).toBe(false);
    expect(document.activeElement).toBe(button('Add channel'));
    expect(document.activeElement).not.toBe(removedTrigger);
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

  it('opens QR authentication after a successful save-and-continue handoff', async () => {
    channelState.catalog = [
      {
        type: 'qq',
        displayName: 'QQ',
        manageable: true,
        fields: [],
        auth: ['credentials', 'qr'] as const,
      },
    ];
    await renderPage();

    click(button('Add channel'));
    await flush();
    const nameInput = document.querySelector<HTMLInputElement>(
      '#channel-editor-name',
    );
    if (!nameInput) throw new Error('Channel name input not found');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(nameInput, 'qq-main');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(button('Continue with QR code'));
    click(button('Save and continue'));
    await flush();

    expect(actions.createOrUpdate).toHaveBeenCalledOnce();
    expect(authActions.begin).toHaveBeenCalledWith('qq-main', {
      channelType: 'qq',
    });
    expect(document.body.textContent).toContain('Authenticate qq-main');
  });

  it('offers Authenticate only for configured QR types with auth capability and token', async () => {
    channelState.catalog = [
      {
        type: 'qq',
        displayName: 'QQ',
        manageable: true,
        fields: [],
        auth: ['qr'] as const,
      },
    ];
    channelState.snapshot.instances.bot = instance('stopped', {
      config: { type: 'qq' },
    });
    await renderPage();

    click(button('Authenticate bot'));
    await flush();
    expect(authActions.begin).toHaveBeenCalledWith('bot', {
      channelType: 'qq',
    });
  });

  it('does not bind QR authentication to the channel-management feature gate', async () => {
    workspace.capabilities = { features: ['channel_auth'] };
    channelState.catalog = [
      {
        type: 'qq',
        displayName: 'QQ',
        manageable: true,
        fields: [],
        auth: ['qr'] as const,
      },
    ];
    channelState.snapshot.instances.bot = instance('stopped', {
      config: { type: 'qq' },
    });
    await renderPage();

    expect(button('Authenticate bot').disabled).toBe(false);
  });

  it('closes and cancels the old QR session instead of rebinding it on workspace switch', async () => {
    channelState.catalog = [
      {
        type: 'qq',
        displayName: 'QQ',
        manageable: true,
        fields: [],
        auth: ['qr'] as const,
      },
    ];
    channelState.snapshot.instances.bot = instance('stopped', {
      config: { type: 'qq' },
    });
    await renderPage();
    click(button('Authenticate bot'));
    await flush();

    workspace.client = {};
    workspace.workspaceCwd = '/workspace/other';
    await renderPage();
    await flush();

    expect(authActions.cancel).toHaveBeenCalledWith('bot', 'auth-1');
    expect(authActions.begin).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Authenticate bot');
  });

  it.each([
    { features: ['channel_management'], token: 'test-token' },
    {
      features: ['channel_management', 'channel_auth'],
      token: undefined,
    },
  ])('hides QR actions when auth access is unavailable', async (access) => {
    workspace.capabilities = { features: access.features };
    workspace.token = access.token;
    channelState.catalog = [
      {
        type: 'qq',
        displayName: 'QQ',
        manageable: true,
        fields: [],
        auth: ['qr'] as const,
      },
    ];
    channelState.snapshot.instances.bot = instance('stopped', {
      config: { type: 'qq' },
    });
    await renderPage();

    expect(
      Array.from(document.querySelectorAll('button')).some(
        (element) => element.getAttribute('aria-label') === 'Authenticate bot',
      ),
    ).toBe(false);
  });

  it('does not offer QR authentication for unsupported channel types', async () => {
    channelState.snapshot.instances.bot = instance('stopped');
    await renderPage();
    expect(document.body.textContent).not.toContain('Authenticate');
  });
});
