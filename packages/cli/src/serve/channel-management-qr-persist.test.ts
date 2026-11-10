/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelQrLoginHandlers } from '@qwen-code/channel-base';

const { mockGetPlugin } = vi.hoisted(() => ({ mockGetPlugin: vi.fn() }));

vi.mock('../commands/channel/channel-registry.js', () => ({
  getPlugin: mockGetPlugin,
}));

import { createChannelManagementService } from './channel-management-service.js';

const WORKSPACE = '/tmp/qq-persist-workspace';

let captured: ChannelQrLoginHandlers | undefined;

/** A channel that already holds a credential — the state every bind leaves. */
function setup(opts?: { foreignCwd?: boolean; committed?: boolean }) {
  let persisted = {
    revision: 'rev-1',
    channels: {
      bot: {
        type: 'qq',
        appID: 'app-old',
        // The stored snapshot resolves secret references to literals, so this
        // is what persist sees even when the operator used an env reference.
        appSecret: 'secret-old',
        ...(opts?.foreignCwd ? { cwd: '/tmp/other-project' } : {}),
      },
    } as Record<string, Record<string, unknown>>,
    startupNames: (opts?.committed ? ['bot'] : []) as string[],
  };
  const upsert = vi.fn(async (name: string, request: never) => {
    const body = request as unknown as {
      config: Record<string, unknown>;
      secrets?: Record<string, { operation: string; value?: string }>;
    };
    const next = { ...body.config };
    for (const [key, update] of Object.entries(body.secrets ?? {})) {
      if (update.operation === 'replace') next[key] = update.value;
      if (update.operation === 'clear') delete next[key];
    }
    persisted = {
      revision: 'rev-2',
      channels: { ...persisted.channels, [name]: next },
      startupNames: persisted.startupNames,
    };
    return persisted;
  });
  const reloadWorkspace = vi.fn(async () => ({
    enabled: true,
    state: 'running' as const,
    channels: ['bot'],
  }));
  const service = createChannelManagementService({
    workspaceCwd: WORKSPACE,
    store: {
      snapshot: () => persisted,
      upsert,
      remove: vi.fn(),
      setStartupNames: vi.fn(),
    } as never,
    manager: {
      committedChannelNames: vi.fn(() => (opts?.committed ? ['bot'] : [])),
      state: vi.fn(() => ({
        enabled: Boolean(opts?.committed),
        selection: opts?.committed
          ? { mode: 'names' as const, names: ['bot'] }
          : null,
        transition: 'idle' as const,
        workers: opts?.committed
          ? [
              {
                enabled: true,
                state: 'running' as const,
                channels: ['bot'],
                workspaceCwd: WORKSPACE,
              },
            ]
          : [],
      })),
      listChannelRuntimes: vi.fn(async () => []),
      setChannelEnabled: vi.fn(async () => {}),
      reload: vi.fn(async () => ({
        enabled: true,
        state: 'running' as const,
        channels: [],
      })),
      reloadWorkspace,
    } as never,
    loadChannelsConfig: vi.fn(() => ({})),
  });
  const repointToForeignWorkspace = () => {
    persisted = {
      ...persisted,
      channels: {
        ...persisted.channels,
        bot: { ...persisted.channels['bot']!, cwd: '/tmp/other-project' },
      },
    };
  };
  return {
    service,
    upsert,
    reloadWorkspace,
    repointToForeignWorkspace,
    stored: () => persisted.channels['bot']!,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  captured = undefined;
  mockGetPlugin.mockReset();
  mockGetPlugin.mockResolvedValue({
    channelType: 'qq',
    management: {
      fields: [
        { key: 'appID', label: 'App ID', kind: 'string' },
        { key: 'appSecret', label: 'App Secret', kind: 'secret' },
      ],
      qrLogin: {
        start: (handlers: ChannelQrLoginHandlers) => {
          captured = handlers;
          return () => {};
        },
      },
    },
  });
});

describe('QR login credential persistence', () => {
  it('never resubmits a secret-kind key inside config', async () => {
    const h = setup();
    const { view } = await h.service.startQrLogin('bot');
    captured!.onSuccess({ appID: 'app-new', appSecret: 'secret-new' });
    await flush();

    expect(h.upsert).toHaveBeenCalledOnce();
    const body = h.upsert.mock.calls[0]![1] as unknown as {
      config: Record<string, unknown>;
      secrets: Record<string, { operation: string; value?: string }>;
    };
    // The store rejects any secret-kind config key, so leaking it here is what
    // made a second bind impossible.
    expect(body.config).not.toHaveProperty('appSecret');
    expect(body.config['appID']).toBe('app-new');
    expect(body.secrets['appSecret']).toEqual({
      operation: 'replace',
      value: 'secret-new',
    });
    expect(h.service.qrLoginState(view.loginId)?.status).toBe('succeeded');
  });

  it('re-binds a channel that already holds a credential', async () => {
    const h = setup();
    const first = await h.service.startQrLogin('bot');
    captured!.onSuccess({ appID: 'app-1', appSecret: 'secret-1' });
    await flush();
    expect(h.service.qrLoginState(first.view.loginId)?.status).toBe(
      'succeeded',
    );
    expect(h.stored()['appSecret']).toBe('secret-1');

    const second = await h.service.startQrLogin('bot');
    captured!.onSuccess({ appID: 'app-2', appSecret: 'secret-2' });
    await flush();
    const state = h.service.qrLoginState(second.view.loginId)!;
    expect(state.status).toBe('succeeded');
    expect(state.error).toBeUndefined();
    expect(h.stored()['appSecret']).toBe('secret-2');
    expect(h.stored()['appID']).toBe('app-2');
  });

  it('refuses to start a login for a channel owned by another workspace', async () => {
    const h = setup({ foreignCwd: true });
    await expect(h.service.startQrLogin('bot')).rejects.toMatchObject({
      code: 'channel_workspace_mismatch',
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('refuses to persist when ownership changed after the login started', async () => {
    const h = setup();
    const { view } = await h.service.startQrLogin('bot');
    // A concurrent save repoints the entry at another workspace while the
    // operator is still scanning. The write must not follow it there.
    // Repoint during the descriptor import, i.e. after persist's outer read
    // and before it enters the mutation lane. Only the in-lane re-check can
    // catch this window.
    mockGetPlugin.mockImplementation(async () => {
      h.repointToForeignWorkspace();
      return {
        channelType: 'qq',
        management: {
          fields: [
            { key: 'appID', label: 'App ID', kind: 'string' },
            { key: 'appSecret', label: 'App Secret', kind: 'secret' },
          ],
        },
      };
    });
    captured!.onSuccess({ appID: 'attacker', appSecret: 'attacker-secret' });
    await flush();
    await flush();
    const state = h.service.qrLoginState(view.loginId)!;
    expect(state.status).toBe('failed');
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.stored()['appSecret']).toBe('secret-old');
  });

  it('reloads the running worker after a successful bind', async () => {
    const h = setup({ committed: true });
    const { view } = await h.service.startQrLogin('bot');
    captured!.onSuccess({ appID: 'app-new', appSecret: 'secret-new' });
    await flush();
    await flush();
    expect(h.service.qrLoginState(view.loginId)?.status).toBe('succeeded');
    // Without this the worker keeps authenticating as the previous bot.
    expect(h.reloadWorkspace).toHaveBeenCalledWith(WORKSPACE, 'bot');
  });

  it('does not reload when the channel is not committed to this workspace', async () => {
    const h = setup();
    await h.service.startQrLogin('bot');
    captured!.onSuccess({ appID: 'a', appSecret: 's' });
    await flush();
    await flush();
    expect(h.reloadWorkspace).not.toHaveBeenCalled();
  });

  it('refuses to bind a channel that was never saved', async () => {
    const h = setup();
    await expect(h.service.startQrLogin('absent')).rejects.toMatchObject({
      code: 'channel_qr_login_channel_missing',
    });
  });

  it('refuses a channel type without the capability', async () => {
    const h = setup();
    mockGetPlugin.mockResolvedValue({
      channelType: 'qq',
      management: { fields: [] },
    });
    await expect(h.service.startQrLogin('bot')).rejects.toMatchObject({
      code: 'channel_qr_login_unsupported',
    });
  });
});
