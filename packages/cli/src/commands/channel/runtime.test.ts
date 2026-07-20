import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  daemonObservedContactsPath,
  daemonSessionRoutesPath,
  parseConfiguredChannels,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  sessionsPath,
} from './runtime.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: { getGlobalQwenDir: () => '/tmp/qwen' },
  hashDaemonWorkspace: (workspace: string) =>
    workspace === '/workspace' ? 'workspace-hash' : 'other-hash',
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: () => ({ merged: {} }),
}));

vi.mock('../extensions/utils.js', () => ({
  getExtensionManager: async () => ({
    getLoadedExtensions: () => [],
  }),
}));

vi.mock('./channel-registry.js', () => ({
  getPlugin: async (type: string) =>
    type === 'telegram'
      ? { channelType: 'telegram', requiredConfigFields: ['token'] }
      : undefined,
  supportedTypes: async () => ['telegram'],
}));

it('isolates daemon route stores by workspace hash', () => {
  expect(daemonSessionRoutesPath('/workspace')).toBe(
    '/tmp/qwen/channels/daemon/workspace-hash/routes.json',
  );
  expect(daemonSessionRoutesPath('/other')).toBe(
    '/tmp/qwen/channels/daemon/other-hash/routes.json',
  );
  expect(daemonSessionRoutesPath('/workspace')).not.toBe(sessionsPath());
});

it('isolates observed contact stores beside daemon routes', () => {
  expect(daemonObservedContactsPath('/workspace')).toBe(
    '/tmp/qwen/channels/daemon/workspace-hash/observed-contacts.json',
  );
  expect(daemonObservedContactsPath('/other')).toBe(
    '/tmp/qwen/channels/daemon/other-hash/observed-contacts.json',
  );
  expect(daemonObservedContactsPath('/workspace')).not.toBe(sessionsPath());
});

describe('parseConfiguredChannels', () => {
  beforeEach(() => {
    delete process.env['TOKEN_LITERAL_VALUE'];
  });

  afterEach(() => {
    delete process.env['TEST_CHANNEL_TOKEN'];
    delete process.env['TOKEN_LITERAL_VALUE'];
  });

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

  it('rejects unresolved credential env vars', async () => {
    await expect(
      parseConfiguredChannels(
        {
          telegram: {
            type: 'telegram',
            token: '$TOKEN_LITERAL_VALUE',
          },
        },
        ['telegram'],
        { defaultCwd: '/workspace' },
      ),
    ).rejects.toThrow(
      'Error in channel "telegram": Environment variable TOKEN_LITERAL_VALUE is not set (referenced as $TOKEN_LITERAL_VALUE). Set the variable or remove the $ prefix to use a literal value.',
    );
  });

  it('resolves channel credentials from environment loaded after settings', async () => {
    process.env['TEST_CHANNEL_TOKEN'] = 'token-from-env';

    const parsed = await parseConfiguredChannels(
      {
        telegram: {
          type: 'telegram',
          token: '$TEST_CHANNEL_TOKEN',
        },
      },
      ['telegram'],
      { defaultCwd: '/workspace' },
    );

    expect(parsed[0]?.config.token).toBe('token-from-env');
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
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = createBridge();
    const router = { getTarget: vi.fn() };

    try {
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
      expect(stderr.mock.calls.join('')).toContain(
        'No route for session missing-session; cancelling permission req-1',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('does not crash cancelling permission requests without a responder', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = createBridge();
    delete (bridge as { respondToPermission?: unknown }).respondToPermission;
    const router = { getTarget: vi.fn() };

    try {
      registerPermissionRelay(bridge, router as never, new Map());

      expect(() =>
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
        }),
      ).not.toThrow();
      expect(stderr.mock.calls.join('')).toContain(
        'No route for session missing-session; cancelling permission req-1',
      );
    } finally {
      stderr.mockRestore();
    }
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

  it('logs before cancelling permission requests with no channel', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = createBridge();
    const router = {
      getTarget: vi.fn(() => ({ channelName: 'telegram', chatId: 'chat1' })),
    };

    try {
      registerPermissionRelay(bridge, router as never, new Map());
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
      expect(stderr.mock.calls.join('')).toContain(
        'No channel "telegram" for session session-1; cancelling permission req-1',
      );
    } finally {
      stderr.mockRestore();
    }
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

describe('registerBackgroundResponseRelay', () => {
  it('routes the final background response without joining the active prompt', async () => {
    const bridge = new EventEmitter();
    const router = {
      getTarget: vi.fn(() => ({
        channelName: 'telegram',
        chatId: 'chat1',
      })),
    };
    const channel = {
      dispatchBackgroundResponse: vi.fn().mockResolvedValue(undefined),
    };

    registerBackgroundResponseRelay(
      bridge as never,
      router as never,
      new Map([['telegram', channel as never]]),
    );
    bridge.emit('backgroundResponse', 'session-1', 'Background final answer.');

    await vi.waitFor(() => {
      expect(channel.dispatchBackgroundResponse).toHaveBeenCalledWith(
        'session-1',
        'Background final answer.',
      );
    });
  });

  it('logs when no route exists for the background response', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new EventEmitter();
    const router = { getTarget: vi.fn() };

    try {
      registerBackgroundResponseRelay(
        bridge as never,
        router as never,
        new Map(),
      );
      bridge.emit(
        'backgroundResponse',
        'session-1',
        'Background final answer.',
      );

      await vi.waitFor(() => {
        expect(stderr.mock.calls.join('')).toContain(
          'No route for background response from session session-1',
        );
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it('logs when the channel is not found for the background response', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new EventEmitter();
    const router = {
      getTarget: vi.fn(() => ({
        channelName: 'telegram',
        chatId: 'chat1',
      })),
    };

    try {
      registerBackgroundResponseRelay(
        bridge as never,
        router as never,
        new Map(),
      );
      bridge.emit(
        'backgroundResponse',
        'session-1',
        'Background final answer.',
      );

      await vi.waitFor(() => {
        expect(stderr.mock.calls.join('')).toContain(
          'No channel "telegram" for background response from session session-1',
        );
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it('logs when dispatchBackgroundResponse rejects', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const bridge = new EventEmitter();
    const router = {
      getTarget: vi.fn(() => ({
        channelName: 'telegram',
        chatId: 'chat1',
      })),
    };
    const channel = {
      dispatchBackgroundResponse: vi
        .fn()
        .mockRejectedValue(new Error('network down')),
    };

    try {
      registerBackgroundResponseRelay(
        bridge as never,
        router as never,
        new Map([['telegram', channel as never]]),
      );
      bridge.emit(
        'backgroundResponse',
        'session-1',
        'Background final answer.',
      );

      await vi.waitFor(() => {
        expect(stderr.mock.calls.join('')).toContain(
          'Background response relay failed for session session-1',
        );
      });
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('registerSessionCleanup', () => {
  it('updates routing state when no channel matches the dead session', () => {
    const bridge = new EventEmitter();
    const router = {
      getTarget: vi.fn(),
      handleSessionDied: vi.fn(),
    };

    registerSessionCleanup(bridge as never, router as never, new Map());
    bridge.emit('sessionDied', { sessionId: 'session-1' });

    expect(router.handleSessionDied).toHaveBeenCalledTimes(1);
    expect(router.handleSessionDied).toHaveBeenCalledWith('session-1');
  });
});
