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
        config: { type: 'github', cwd: opts.defaultCwd },
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
vi.mock('@qwen-code/channel-github', () => ({
  ManagedGithubAdapter: vi
    .fn()
    .mockImplementation((options: { cwd: string }) => {
      adapterInstances.push({ cwd: options.cwd });
      return {
        connect: async () => {},
        disconnect: async () => {},
        generation: 1,
      };
    }),
  createManagedGithubDeps: vi.fn(() => ({})),
}));

import { createManagedGithubDeps } from '@qwen-code/channel-github';
import { loadSettings } from '../../config/settings.js';
import { resolveProxyUrl } from './proxy.js';
import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';
import { managedGithubCommand } from './managed-github.js';

const handler = managedGithubCommand.handler as unknown as (
  argv: Record<string, unknown>,
) => Promise<void>;

function argv(cwd: string): Record<string, unknown> {
  return {
    _: ['managed-github'],
    name: 'gh',
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

describe('managed-github command workspace resolution', () => {
  it('threads --cwd through channel config resolution, matching the Legacy daemon', async () => {
    // Keep the resolved config cwd distinct from the raw --cwd: the adapter's
    // state directory follows the resolved one, while the proxy reads the raw
    // argument, so a swap of the two is observable.
    vi.mocked(parseConfiguredChannels).mockResolvedValueOnce([
      {
        name: 'gh',
        config: { type: 'github', cwd: '/configured/workspace' },
      },
    ] as never);
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadChannelsConfig).toHaveBeenCalledWith('/daemon/workspace');
    expect(parseConfiguredChannels).toHaveBeenCalledWith({}, ['gh'], {
      defaultCwd: '/daemon/workspace',
    });
    expect(adapterInstances).toEqual([{ cwd: '/configured/workspace' }]);
    expect(loadSettings).toHaveBeenCalledWith('/daemon/workspace');
  });

  it('refuses a channel that is not GitHub', async () => {
    vi.mocked(parseConfiguredChannels).mockResolvedValueOnce([
      { name: 'gh', config: { type: 'email', cwd: '/workspace' } },
    ] as never);
    await expect(handler(argv('/workspace'))).rejects.toThrow(
      /not a GitHub channel/,
    );
    expect(adapterInstances).toEqual([]);
  });

  it('resolves the egress proxy and hands it to the deps', async () => {
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadSettings).toHaveBeenCalledWith('/daemon/workspace');
    expect(resolveProxyUrl).toHaveBeenCalledWith(
      undefined,
      'http://proxy.internal:8080',
    );
    expect(createManagedGithubDeps).toHaveBeenCalledWith(
      'http://proxy.internal:8080',
    );
  });
});
