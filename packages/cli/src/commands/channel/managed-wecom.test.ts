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
        config: { type: 'wecom', cwd: opts.defaultCwd },
      },
    ],
  ),
}));
vi.mock('./managed-channel-client.js', () => ({
  HttpManagedChannelControlPlane: vi.fn(),
}));

const adapterInstances: Array<{ cwd: string }> = [];
vi.mock('@qwen-code/channel-wecom', () => ({
  ManagedWecomAdapter: vi
    .fn()
    .mockImplementation((options: { cwd: string }) => {
      adapterInstances.push({ cwd: options.cwd });
      return {
        connect: async () => {},
        disconnect: async () => {},
        generation: 1,
      };
    }),
  createManagedWecomDeps: vi.fn(() => ({})),
}));

import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';
import { managedWecomCommand } from './managed-wecom.js';

const handler = managedWecomCommand.handler as unknown as (
  argv: Record<string, unknown>,
) => Promise<void>;

function argv(cwd: string): Record<string, unknown> {
  return {
    _: ['managed-wecom'],
    name: 'bot',
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

describe('managed-wecom command workspace resolution', () => {
  it('threads --cwd through channel config resolution, matching the Legacy daemon', async () => {
    // Keep the resolved config cwd distinct from the raw --cwd: the adapter's
    // state directory follows the resolved one, so a swap of the two is
    // observable.
    vi.mocked(parseConfiguredChannels).mockResolvedValueOnce([
      {
        name: 'bot',
        config: { type: 'wecom', cwd: '/configured/workspace' },
      },
    ] as never);
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadChannelsConfig).toHaveBeenCalledWith('/daemon/workspace');
    expect(parseConfiguredChannels).toHaveBeenCalledWith({}, ['bot'], {
      defaultCwd: '/daemon/workspace',
    });
    expect(adapterInstances).toEqual([{ cwd: '/configured/workspace' }]);
  });

  it('refuses a channel that is not WeCom', async () => {
    vi.mocked(parseConfiguredChannels).mockResolvedValueOnce([
      { name: 'bot', config: { type: 'dingtalk', cwd: '/workspace' } },
    ] as never);
    await expect(handler(argv('/workspace'))).rejects.toThrow(
      /not a WeCom channel/,
    );
    expect(adapterInstances).toEqual([]);
  });
});
