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
        config: { type: 'email', cwd: opts.defaultCwd },
      },
    ],
  ),
}));
vi.mock('./managed-channel-client.js', () => ({
  HttpManagedChannelControlPlane: vi.fn(),
}));

const adapterInstances: Array<{ cwd: string }> = [];
vi.mock('@qwen-code/channel-email', () => ({
  ManagedEmailAdapter: vi
    .fn()
    .mockImplementation((options: { cwd: string }) => {
      adapterInstances.push({ cwd: options.cwd });
      return {
        connect: async () => {},
        disconnect: async () => {},
        generation: 1,
      };
    }),
  createManagedEmailDeps: vi.fn(() => ({})),
}));

import { loadChannelsConfig, parseConfiguredChannels } from './runtime.js';
import { managedEmailCommand } from './managed-email.js';

const handler = managedEmailCommand.handler as unknown as (
  argv: Record<string, unknown>,
) => Promise<void>;

function argv(cwd: string): Record<string, unknown> {
  return {
    _: ['managed-email'],
    name: 'mail',
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

describe('managed-email command workspace resolution', () => {
  it('threads --cwd through channel config resolution, matching the Legacy daemon', async () => {
    const running = handler(argv('/daemon/workspace'));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGINT');
    await running;
    expect(loadChannelsConfig).toHaveBeenCalledWith('/daemon/workspace');
    expect(parseConfiguredChannels).toHaveBeenCalledWith({}, ['mail'], {
      defaultCwd: '/daemon/workspace',
    });
    expect(adapterInstances).toEqual([{ cwd: '/daemon/workspace' }]);
  });

  it('resolves a different state directory per --cwd, pinning the diverge', async () => {
    for (const cwd of ['/workspace-a', '/workspace-b']) {
      const running = handler(argv(cwd));
      await new Promise((resolve) => setImmediate(resolve));
      process.emit('SIGINT');
      await running;
    }
    expect(adapterInstances).toEqual([
      { cwd: '/workspace-a' },
      { cwd: '/workspace-b' },
    ]);
  });
});
