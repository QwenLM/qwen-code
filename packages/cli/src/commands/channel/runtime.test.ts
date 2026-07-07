import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { parseConfiguredChannels, registerPermissionRelay } from './runtime.js';

vi.mock('./channel-registry.js', () => ({
  getPlugin: async (type: string) =>
    type === 'telegram'
      ? { channelType: 'telegram', requiredConfigFields: ['token'] }
      : undefined,
  supportedTypes: async () => ['telegram'],
}));

describe('parseConfiguredChannels', () => {
  it('throws a clear error when a selected channel is missing config', async () => {
    await expect(
      parseConfiguredChannels({}, ['telegram'], { defaultCwd: '/workspace' }),
    ).rejects.toThrow(
      'Error in channel "telegram": channel is not configured. Add a "telegram" entry under "channels" in settings.json.',
    );
  });

  it('parses configured channels', async () => {
    const parsed = await parseConfiguredChannels(
      {
        telegram: {
          type: 'telegram',
          token: 'secret',
        },
      },
      ['telegram'],
      { defaultCwd: '/workspace' },
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'telegram',
        config: expect.objectContaining({
          type: 'telegram',
          token: 'secret',
          cwd: '/workspace',
        }),
      }),
    ]);
  });
});

describe('registerPermissionRelay', () => {
  function createBridge() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      availableCommands: [],
      newSession: vi.fn(),
      loadSession: vi.fn(),
      prompt: vi.fn(),
      cancelSession: vi.fn(),
      respondToPermission: vi.fn().mockResolvedValue(true),
    });
  }

  it('cancels permission requests when no route exists', async () => {
    const bridge = createBridge();
    const router = { getTarget: vi.fn() };

    registerPermissionRelay(bridge, router as never, new Map());
    bridge.emit('permissionRequest', {
      requestId: 'req-1',
      sessionId: 'missing-session',
      request: {
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'shell',
          title: 'Run command',
        },
        options: [],
      },
    });

    await vi.waitFor(() =>
      expect(bridge.respondToPermission).toHaveBeenCalledWith('req-1', {
        outcome: { outcome: 'cancelled' },
      }),
    );
  });

  it('cancels permission requests when channel dispatch fails', async () => {
    const bridge = createBridge();
    const router = {
      getTarget: vi.fn(() => ({ channelName: 'telegram', chatId: 'chat1' })),
    };
    const channel = {
      dispatchPermissionRequest: vi
        .fn()
        .mockRejectedValue(new Error('send failed')),
      dispatchPermissionResolved: vi.fn(),
    };

    registerPermissionRelay(
      bridge,
      router as never,
      new Map([['telegram', channel as never]]),
    );
    bridge.emit('permissionRequest', {
      requestId: 'req-1',
      sessionId: 'session-1',
      request: {
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'shell',
          title: 'Run command',
        },
        options: [],
      },
    });

    await vi.waitFor(() =>
      expect(bridge.respondToPermission).toHaveBeenCalledWith('req-1', {
        outcome: { outcome: 'cancelled' },
      }),
    );
  });

  it('broadcasts resolved permission requests to channels', () => {
    const bridge = createBridge();
    const channel = {
      dispatchPermissionResolved: vi.fn(),
    };

    registerPermissionRelay(
      bridge,
      { getTarget: vi.fn() } as never,
      new Map([['telegram', channel as never]]),
    );
    bridge.emit('permissionResolved', {
      requestId: 'req-1',
      outcome: { outcome: 'cancelled' },
    });

    expect(channel.dispatchPermissionResolved).toHaveBeenCalledWith({
      requestId: 'req-1',
      outcome: { outcome: 'cancelled' },
    });
  });
});
