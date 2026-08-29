/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { channelState, useChannelsMock, workspaceState } = vi.hoisted(() => ({
  channelState: {
    current: {
      catalog: [] as Array<{
        type: string;
        displayName: string;
        manageable: boolean;
        fields: Array<{
          key: string;
          label: string;
          kind: 'string' | 'secret';
          required?: boolean;
        }>;
      }>,
      channels: {} as Record<
        string,
        {
          name: string;
          config: { type: string };
          secrets: Record<
            string,
            { present: boolean; source?: 'literal' | 'environment' }
          >;
          startsWithServe: boolean;
          runtime: {
            state: 'stopped' | 'starting' | 'connected' | 'partial' | 'error';
            lastError?: string;
          };
        }
      >,
      snapshot: {
        revision: '1',
        instances: {},
      } as
        | {
            revision: string;
            instances: Record<string, unknown>;
          }
        | undefined,
      loading: false,
      error: undefined as Error | undefined,
      reload: vi.fn(),
      createOrUpdate: vi.fn(),
      remove: vi.fn(),
      setStartup: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      pairing: {
        list: vi.fn(),
        approve: vi.fn(),
        approvals: vi.fn(),
        revoke: vi.fn(),
      },
    },
  },
  useChannelsMock: vi.fn(),
  workspaceState: {
    current: {
      workspaceCwd: '/workspace/demo',
      token: 'secret',
      capabilities: {
        features: ['channel_management'],
        workspaces: [] as Array<{
          id: string;
          cwd: string;
          displayName?: string;
          primary: boolean;
          trusted: boolean;
          kind?: 'live';
        }>,
      },
    },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useChannels: (options: unknown) => {
    useChannelsMock(options);
    return channelState.current;
  },
  useWorkspace: () => workspaceState.current,
}));

const { ChannelsManagerPage } = await import('./ChannelsManagerPage');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement;
let root: Root;

function channel(
  name: string,
  type: string,
  state: 'stopped' | 'starting' | 'connected' | 'partial' | 'error',
) {
  return {
    name,
    config: { type },
    secrets: {},
    startsWithServe: false,
    runtime: { state },
  };
}

async function renderPage() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ChannelsManagerPage onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function inputByLabel(label: string): HTMLInputElement | null {
  const match = Array.from(document.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(label),
  );
  return match?.htmlFor
    ? document.querySelector<HTMLInputElement>(`#${match.htmlFor}`)
    : null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  channelState.current.catalog = [
    {
      type: 'dingtalk',
      displayName: 'DingTalk',
      manageable: true,
      fields: [
        {
          key: 'clientId',
          label: 'Client ID',
          kind: 'string',
          required: true,
        },
        {
          key: 'clientSecret',
          label: 'Client Secret',
          kind: 'secret',
          required: true,
        },
      ],
    },
    {
      type: 'wecom',
      displayName: 'WeCom',
      manageable: true,
      fields: [],
    },
    {
      type: 'feishu',
      displayName: 'Feishu',
      manageable: true,
      fields: [],
    },
    {
      type: 'telegram',
      displayName: 'Telegram',
      manageable: true,
      fields: [],
    },
  ];
  channelState.current.channels = {
    ding: channel('DingTalk Bot', 'dingtalk', 'stopped'),
    hidden: channel('Telegram Bot', 'telegram', 'connected'),
  };
  channelState.current.snapshot = {
    revision: '1',
    instances: channelState.current.channels,
  };
  channelState.current.loading = false;
  channelState.current.error = undefined;
  useChannelsMock.mockReset();
  channelState.current.reload.mockReset().mockResolvedValue(undefined);
  channelState.current.createOrUpdate.mockReset().mockResolvedValue(undefined);
  channelState.current.remove.mockReset().mockResolvedValue(undefined);
  channelState.current.setStartup.mockReset().mockResolvedValue(undefined);
  channelState.current.start.mockReset().mockResolvedValue(undefined);
  channelState.current.stop.mockReset().mockResolvedValue(undefined);
  channelState.current.restart.mockReset().mockResolvedValue(undefined);
  channelState.current.pairing.list
    .mockReset()
    .mockResolvedValue({ requests: [] });
  channelState.current.pairing.approve.mockReset();
  channelState.current.pairing.approvals
    .mockReset()
    .mockResolvedValue({ senderIds: [] });
  channelState.current.pairing.revoke.mockReset();
  workspaceState.current = {
    workspaceCwd: '/workspace/demo',
    token: 'secret',
    capabilities: { features: ['channel_management'], workspaces: [] },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelsManagerPage', () => {
  it('shows only the three enabled platforms and configured instances', async () => {
    await renderPage();

    expect(container.textContent).toContain('DingTalk Bot');
    expect(container.textContent).toContain(
      'Offline and not receiving messages.',
    );
    expect(container.textContent).not.toContain('Telegram Bot');
    expect(
      container.querySelectorAll('[data-testid^="channel-platform-"]'),
    ).toHaveLength(3);
    expect(container.textContent).toContain('DingTalk');
    expect(container.textContent).toContain('WeCom');
    expect(container.textContent).toContain('Feishu');
    expect(container.textContent).not.toContain('Telegram');
  });

  it('starts a stopped Channel from its card', async () => {
    await renderPage();

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Start',
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });

    expect(channelState.current.start).toHaveBeenCalledWith('DingTalk Bot');
  });

  it('updates whether a Channel starts with serve', async () => {
    await renderPage();

    const toggle =
      container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.click();
    });

    expect(channelState.current.setStartup).toHaveBeenCalledWith(
      'DingTalk Bot',
      {
        expectedRevision: '1',
        enabled: true,
      },
    );
  });

  it('opens the typed editor from an available platform', async () => {
    await renderPage();

    const platform = container.querySelector<HTMLButtonElement>(
      '[data-testid="channel-platform-dingtalk"]',
    );
    expect(platform?.tagName).toBe('BUTTON');
    await act(async () => {
      platform?.click();
    });

    expect(document.body.textContent).toContain('Configure DingTalk');
    expect(document.body.textContent).toContain('Client ID (AppKey)');
    expect(document.body.textContent).toContain('Client Secret (AppSecret)');
  });

  it('manages the primary workspace by default and switches to a registered workspace', async () => {
    workspaceState.current = {
      ...workspaceState.current,
      workspaceCwd: '/workspace/secondary',
      capabilities: {
        features: ['channel_management'],
        workspaces: [
          {
            id: 'primary',
            cwd: '/workspace/main',
            displayName: 'Main repo',
            primary: true,
            trusted: true,
          },
          {
            id: 'secondary',
            cwd: '/workspace/secondary',
            displayName: 'Secondary repo',
            primary: false,
            trusted: true,
          },
        ],
      },
    };
    await renderPage();

    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/main',
    });

    const trigger = document.querySelector<HTMLElement>(
      '[aria-label="Workspace"]',
    );
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const secondary = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Secondary repo');
    await act(async () => {
      secondary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/secondary',
    });
  });

  it('keeps a newer workspace selection when a dismissed save finishes', async () => {
    let finishSave!: () => void;
    channelState.current.createOrUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    workspaceState.current = {
      ...workspaceState.current,
      capabilities: {
        features: ['channel_management'],
        workspaces: [
          {
            id: 'primary',
            cwd: '/workspace/main',
            displayName: 'Main repo',
            primary: true,
            trusted: true,
          },
          {
            id: 'secondary',
            cwd: '/workspace/secondary',
            displayName: 'Secondary repo',
            primary: false,
            trusted: true,
          },
          {
            id: 'third',
            cwd: '/workspace/third',
            displayName: 'Third repo',
            primary: false,
            trusted: true,
          },
        ],
      },
    };
    await renderPage();

    const platform = container.querySelector<HTMLButtonElement>(
      '[data-testid="channel-platform-dingtalk"]',
    );
    await act(async () => platform?.click());
    const dialog = document.querySelector('[role="dialog"]');
    const workspaceLabel = Array.from(
      dialog?.querySelectorAll<HTMLLabelElement>('label') ?? [],
    ).find((label) => label.textContent?.includes('Workspace'));
    const workspaceTrigger = workspaceLabel?.htmlFor
      ? document.getElementById(workspaceLabel.htmlFor)
      : undefined;
    await act(async () => {
      workspaceTrigger?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const secondary = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Secondary repo');
    await act(async () => secondary?.click());

    await act(async () => {
      setInputValue(inputByLabel('Instance name')!, 'release-bot');
      setInputValue(inputByLabel('Client ID')!, 'ding-client-id');
      setInputValue(inputByLabel('Client Secret')!, 'ding-client-secret');
    });
    const save = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    await act(async () => save?.click());
    expect(channelState.current.createOrUpdate).toHaveBeenCalledTimes(1);

    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel',
    );
    await act(async () => cancel?.click());
    const toolbarWorkspace = document.querySelector<HTMLElement>(
      '[aria-label="Workspace"]',
    );
    await act(async () => {
      toolbarWorkspace?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const third = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Third repo');
    await act(async () => third?.click());
    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/third',
    });

    await act(async () => finishSave());
    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/third',
    });
  });

  it('opens an existing Channel for editing', async () => {
    channelState.current.channels.ding = {
      ...channelState.current.channels.ding,
      config: {
        type: 'dingtalk',
        clientId: 'stored-id',
        senderPolicy: 'pairing',
      },
      secrets: {
        clientSecret: { present: true, source: 'literal' },
      },
    };
    channelState.current.pairing.list.mockResolvedValue({
      requests: [
        {
          senderId: 'user-42',
          senderName: 'Ada',
          code: 'ABCD1234',
          createdAt: Date.now(),
        },
      ],
    });
    await renderPage();

    const edit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Edit DingTalk Bot',
    );
    await act(async () => {
      edit?.click();
    });

    expect(document.body.textContent).toContain('Edit DingTalk');
    const name = Array.from(document.querySelectorAll('input')).find(
      (input) => input.value === 'DingTalk Bot',
    );
    expect(name?.disabled).toBe(true);
    expect(channelState.current.pairing.list).toHaveBeenCalledWith(
      'DingTalk Bot',
    );
    expect(document.body.textContent).toContain('ABCD1234');
  });

  it('deletes a Channel with the current revision', async () => {
    await renderPage();

    const more = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        button.getAttribute('aria-label') === 'More actions for DingTalk Bot',
    );
    await act(async () => {
      more?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const remove = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.getAttribute('aria-label') === 'Delete DingTalk Bot');
    await act(async () => {
      remove?.click();
    });
    expect(document.body.textContent).toContain('Delete DingTalk Bot?');

    const dialog = document.querySelector('[role="alertdialog"]');
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    await act(async () => {
      confirm?.click();
    });

    expect(channelState.current.remove).toHaveBeenCalledWith('DingTalk Bot', {
      expectedRevision: '1',
    });
  });

  it('clears a stale lifecycle error after deleting the channel', async () => {
    channelState.current.start.mockRejectedValueOnce(
      new Error('stale start failure'),
    );
    await renderPage();

    const start = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start',
    );
    await act(async () => start?.click());
    expect(container.textContent).toContain('stale start failure');

    const more = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        button.getAttribute('aria-label') === 'More actions for DingTalk Bot',
    );
    await act(async () => {
      more?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const remove = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.getAttribute('aria-label') === 'Delete DingTalk Bot');
    await act(async () => remove?.click());
    const confirm = Array.from(
      document
        .querySelector('[role="alertdialog"]')
        ?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent?.trim() === 'Delete');
    await act(async () => confirm?.click());

    expect(container.textContent).not.toContain('stale start failure');
  });

  it('allows an independent lifecycle action after switching workspaces', async () => {
    let finishPrimaryStart!: () => void;
    let finishSecondaryStart!: () => void;
    channelState.current.start
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPrimaryStart = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSecondaryStart = resolve;
          }),
      );
    workspaceState.current = {
      ...workspaceState.current,
      capabilities: {
        features: ['channel_management'],
        workspaces: [
          {
            id: 'primary',
            cwd: '/workspace/main',
            displayName: 'Main repo',
            primary: true,
            trusted: true,
          },
          {
            id: 'secondary',
            cwd: '/workspace/secondary',
            displayName: 'Secondary repo',
            primary: false,
            trusted: true,
          },
        ],
      },
    };
    await renderPage();

    const start = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start',
    );
    await act(async () => start?.click());
    const workspaceTrigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Workspace"]',
    );
    expect(workspaceTrigger?.disabled).toBe(false);
    await act(async () => {
      workspaceTrigger?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const secondary = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Secondary repo');
    await act(async () => {
      secondary?.click();
    });

    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/secondary',
    });
    const secondaryStart = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.trim() === 'Start');
    expect(secondaryStart?.disabled).toBe(false);
    await act(async () => secondaryStart?.click());
    expect(channelState.current.start).toHaveBeenCalledTimes(2);
    expect(secondaryStart?.disabled).toBe(true);

    await act(async () => {
      workspaceTrigger?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const primary = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.includes('Main repo'));
    expect(primary).toBeDefined();
    await act(async () => primary?.click());
    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: true,
      enabled: true,
      workspaceCwd: '/workspace/main',
    });
    const primaryStart = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Start',
    );
    expect(primaryStart?.disabled).toBe(true);
    expect(primaryStart?.querySelector('[data-slot="spinner"]')).not.toBeNull();

    await act(async () => {
      workspaceTrigger?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const secondaryAgain = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent?.trim() === 'Secondary repo');
    await act(async () => secondaryAgain?.click());

    await act(async () => finishPrimaryStart());
    expect(secondaryStart?.disabled).toBe(true);

    await act(async () => finishSecondaryStart());
    expect(secondaryStart?.disabled).toBe(false);
  });

  it('keeps restart in the overflow menu for a running Channel', async () => {
    channelState.current.channels.ding = channel(
      'DingTalk Bot',
      'dingtalk',
      'connected',
    );
    channelState.current.snapshot = {
      revision: '1',
      instances: channelState.current.channels,
    };
    await renderPage();

    const more = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        button.getAttribute('aria-label') === 'More actions for DingTalk Bot',
    );
    await act(async () => {
      more?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    const restart = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === 'Restart');
    await act(async () => {
      restart?.click();
    });

    expect(channelState.current.restart).toHaveBeenCalledWith('DingTalk Bot');
  });

  it('closes an editor when the selected workspace changes', async () => {
    await renderPage();
    const platform = container.querySelector<HTMLButtonElement>(
      '[data-testid="channel-platform-dingtalk"]',
    );
    await act(async () => {
      platform?.click();
    });
    expect(document.body.textContent).toContain('Configure DingTalk');

    workspaceState.current = {
      ...workspaceState.current,
      workspaceCwd: '/workspace/other',
    };
    channelState.current.snapshot = {
      revision: 'other-1',
      instances: {},
    };
    channelState.current.channels = {};
    await renderPage();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('disables lifecycle controls without a bearer token', async () => {
    workspaceState.current = {
      ...workspaceState.current,
      token: '',
    };
    await renderPage();

    expect(container.textContent).toContain('Channel management is read-only');
    const start = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === 'Start',
    );
    expect(start?.disabled).toBe(true);
  });

  it('does not load Channel routes when the capability is unavailable', async () => {
    workspaceState.current = {
      ...workspaceState.current,
      capabilities: { features: [], workspaces: [] },
    };
    await renderPage();

    expect(container.textContent).toContain(
      'Channel management is not supported',
    );
    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: false,
      enabled: false,
      workspaceCwd: '/workspace/demo',
    });
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Workspace"]')
        ?.disabled,
    ).toBe(true);
  });
});
