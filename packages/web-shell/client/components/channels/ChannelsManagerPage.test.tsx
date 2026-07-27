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
        fields: never[];
      }>,
      channels: {} as Record<
        string,
        {
          name: string;
          config: { type: string };
          secrets: Record<string, never>;
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
      setStartup: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
    },
  },
  useChannelsMock: vi.fn(),
  workspaceState: {
    current: {
      workspaceCwd: '/workspace/demo',
      token: 'secret',
      capabilities: { features: ['channel_management'] },
    },
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  channelState.current.catalog = [
    {
      type: 'dingtalk',
      displayName: 'DingTalk',
      manageable: true,
      fields: [],
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
  channelState.current.setStartup.mockReset().mockResolvedValue(undefined);
  channelState.current.start.mockReset().mockResolvedValue(undefined);
  channelState.current.stop.mockReset().mockResolvedValue(undefined);
  channelState.current.restart.mockReset().mockResolvedValue(undefined);
  workspaceState.current = {
    workspaceCwd: '/workspace/demo',
    token: 'secret',
    capabilities: { features: ['channel_management'] },
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
      capabilities: { features: [] },
    };
    await renderPage();

    expect(container.textContent).toContain(
      'Channel management is not supported',
    );
    expect(useChannelsMock).toHaveBeenLastCalledWith({
      autoLoad: false,
      enabled: false,
    });
  });
});
