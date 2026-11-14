/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime.js', () => ({
  loadChannelsConfig: vi.fn(() => ({})),
  parseConfiguredChannels: vi.fn(
    async (
      _config: Record<string, unknown>,
      names: string[],
      opts: { defaultCwd?: string },
    ) => [
      {
        name: names[0],
        config: { type: 'dingtalk', cwd: opts.defaultCwd },
      },
    ],
  ),
}));
vi.mock('./managed-channel-client.js', () => ({
  HttpManagedChannelControlPlane: vi.fn(),
}));
vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    merged: { proxy: 'http://proxy.internal:8080' },
  })),
}));
vi.mock('./proxy.js', () => ({
  resolveProxyUrl: vi.fn(() => 'http://proxy.internal:8080'),
}));

const adapterInstances: Array<{ cwd: string }> = [];
vi.mock('@qwen-code/channel-dingtalk', () => ({
  ManagedDingtalkAdapter: vi
    .fn()
    .mockImplementation((options: { cwd: string }) => {
      adapterInstances.push({ cwd: options.cwd });
      return {
        connect: async () => {},
        disconnect: async () => {},
        generation: 1,
      };
    }),
  createManagedDingtalkDeps: vi.fn(() => ({})),
}));

import { createManagedDingtalkDeps } from '@qwen-code/channel-dingtalk';
import { loadSettings } from '../../config/settings.js';
import { resolveProxyUrl } from './proxy.js';
import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';
import { managedDingtalkCommand } from './managed-dingtalk.js';

const handler = managedDingtalkCommand.handler as unknown as (
  argv: Record<string, unknown>,
) => Promise<void>;

function argv(cwd: string): Record<string, unknown> {
  return {
    _: ['managed-dingtalk'],
    name: 'ding',
    'control-plane': 'http://127.0.0.1:4181',
    tenant: 'tenant-1',
    actor: 'owner',
    workspace: 'ws-1',
    'cwd-relative': '.',
    cwd,
  };
}

beforeEach(() => {
  adapterInstances.length = 0;
  vi.clearAllMocks();
});

describe('managed-dingtalk command workspace resolution', () => {
  it('threads --cwd through channel config resolution, matching the Legacy daemon', async () => {
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadChannelsConfig).toHaveBeenCalledWith('/daemon/workspace');
    expect(parseConfiguredChannels).toHaveBeenCalledWith({}, ['ding'], {
      defaultCwd: '/daemon/workspace',
    });
    expect(adapterInstances).toEqual([{ cwd: '/daemon/workspace' }]);
  });

  it('refuses a channel that is not DingTalk', async () => {
    vi.mocked(parseConfiguredChannels).mockResolvedValueOnce([
      { name: 'ding', config: { type: 'email', cwd: '/workspace' } },
    ] as never);
    await expect(handler(argv('/workspace'))).rejects.toThrow(
      /not a DingTalk channel/,
    );
    expect(adapterInstances).toEqual([]);
  });

  it('resolves the egress proxy and hands it to the deps (R6-1)', async () => {
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadSettings).toHaveBeenCalledWith('/daemon/workspace');
    expect(resolveProxyUrl).toHaveBeenCalledWith(
      undefined,
      'http://proxy.internal:8080',
    );
    expect(createManagedDingtalkDeps).toHaveBeenCalledWith(
      'http://proxy.internal:8080',
    );
  });
});
