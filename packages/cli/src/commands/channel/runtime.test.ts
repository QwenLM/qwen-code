import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../../config/settings.js';
import * as stdioHelpers from '../../utils/stdioHelpers.js';
import {
  channelLoopPath,
  daemonChannelLoopPath,
  daemonChannelStateDir,
  daemonObservedContactsPath,
  daemonSessionRoutesPath,
  loadChannelsConfig,
  parseConfiguredChannels,
  registerBackgroundResponseRelay,
  registerPermissionRelay,
  registerSessionCleanup,
  resetReservedNameWarningsForTesting,
  sessionsPath,
} from './runtime.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  APPROVAL_MODES: (
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>()
  ).APPROVAL_MODES,
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
    path.join(
      '/tmp/qwen',
      'channels',
      'daemon',
      'workspace-hash',
      'routes.json',
    ),
  );
  expect(daemonSessionRoutesPath('/other')).toBe(
    path.join('/tmp/qwen', 'channels', 'daemon', 'other-hash', 'routes.json'),
  );
  expect(daemonSessionRoutesPath('/workspace')).not.toBe(sessionsPath());
});

it('isolates observed contact stores beside daemon routes', () => {
  expect(daemonObservedContactsPath('/workspace')).toBe(
    path.join(
      '/tmp/qwen',
      'channels',
      'daemon',
      'workspace-hash',
      'observed-contacts.json',
    ),
  );
  expect(daemonObservedContactsPath('/other')).toBe(
    path.join(
      '/tmp/qwen',
      'channels',
      'daemon',
      'other-hash',
      'observed-contacts.json',
    ),
  );
  expect(daemonObservedContactsPath('/workspace')).not.toBe(sessionsPath());
});

it('isolates daemon loop stores by workspace hash', () => {
  expect(daemonChannelLoopPath('/workspace')).toBe(
    path.join('/tmp/qwen', 'channels', 'daemon', 'workspace-hash', 'cron.json'),
  );
  expect(daemonChannelLoopPath('/other')).toBe(
    path.join('/tmp/qwen', 'channels', 'daemon', 'other-hash', 'cron.json'),
  );
  expect(daemonChannelLoopPath('/workspace')).not.toBe(channelLoopPath());
  expect(daemonChannelLoopPath('/workspace')).not.toBe(sessionsPath());
});

it('isolates daemon channel state by workspace and safe instance key', () => {
  const stateDir = daemonChannelStateDir('/workspace', 'team/../bot');

  expect(stateDir.replaceAll(path.sep, '/')).toMatch(
    /^\/tmp\/qwen\/channels\/daemon\/workspace-hash\/instances\/team_\.\._bot-[0-9a-f]{16}$/,
  );
  expect(stateDir.replaceAll(path.sep, '/')).not.toContain('/../');
  expect(daemonChannelStateDir('/workspace', 'team/../bot')).toBe(stateDir);
  expect(daemonChannelStateDir('/workspace', 'team:../bot')).not.toBe(stateDir);
  expect(daemonChannelStateDir('/other', 'team/../bot')).not.toBe(stateDir);
});

describe('loadChannelsConfig (#8975)', () => {
  function settingsWith(
    channels: Record<string, unknown> | undefined,
  ): LoadedSettings {
    return { merged: { channels } } as unknown as LoadedSettings;
  }

  // The reserved-name warning rides the real best-effort sink, which
  // installs a process-wide no-op stderr 'error' guard when nothing else
  // listens (R12-8) and never removes it. Drop exactly the listeners the
  // test attached so the process-wide stderr state leaks into no later
  // test file running in the same worker (the R12-17 discipline).
  let stderrErrorListenersBefore: Set<(...args: unknown[]) => void>;

  beforeEach(() => {
    // The reserved-name warning dedup is process-scoped (R11-15).
    resetReservedNameWarningsForTesting();
    stderrErrorListenersBefore = new Set(
      process.stderr.listeners('error') as Array<(...args: unknown[]) => void>,
    );
  });

  afterEach(() => {
    for (const listener of process.stderr.listeners('error')) {
      if (
        !stderrErrorListenersBefore.has(
          listener as (...args: unknown[]) => void,
        )
      ) {
        process.stderr.removeListener(
          'error',
          listener as (...args: unknown[]) => void,
        );
      }
    }
  });

  it('returns the configured channels on a hardened null-prototype copy (R11-31)', () => {
    // No identity fast path: the returned map is always a null-prototype
    // rebuild, so indexing it with an unconfigured user-controlled name
    // (`channelsConfig['constructor']` in startSingle's not-found guard)
    // resolves undefined instead of an inherited Object.prototype member.
    const channels = {
      telegram: { type: 'telegram' },
      feishu: { type: 'feishu' },
    };
    const loaded = loadChannelsConfig('/workspace', settingsWith(channels));
    expect(loaded).toEqual(channels);
    expect(loaded).not.toBe(channels);
    expect(Object.getPrototypeOf(loaded)).toBeNull();
    expect(loaded['constructor']).toBeUndefined();
    expect(loaded['toString']).toBeUndefined();
    expect(loadChannelsConfig('/workspace', settingsWith(undefined))).toEqual(
      {},
    );
  });

  it('warns once per process per (workspace, name) pair for a reserved name (R11-15, R12-33)', () => {
    // The deferred webhook auth path calls loadChannelsConfig per request;
    // an unresolved hand-edited entry must not add an identical stderr
    // line per webhook POST.
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      const entry = { all: { type: 'telegram' } };
      // The SAME entry twice warns once.
      loadChannelsConfig('/workspace', settingsWith(entry));
      loadChannelsConfig('/workspace', settingsWith(entry));
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // A different workspace warns independently.
      loadChannelsConfig('/other', settingsWith(entry));
      expect(writeSpy).toHaveBeenCalledTimes(2);

      // Two DIFFERENTLY-SPELLED reserved variants are two distinct
      // (workspace, name) pairs, so each warns once (R12-33):
      // isAllChannelSelectionName matches on the TRIMMED name, so ` all`
      // is a reserved variant too — a workspace-keyed dedup set silenced
      // every later variant after the first, and a user who edits
      // settings to a differently-spelled reserved key got a silently
      // never-connecting channel with nothing in the logs explaining why.
      // 'all' already warned for /workspace above, so only ' all' is new.
      loadChannelsConfig(
        '/workspace',
        settingsWith({
          all: { type: 'telegram' },
          ' all': { type: 'telegram' },
        }),
      );
      expect(writeSpy).toHaveBeenCalledTimes(3);
      // Repeating the SAME pair stays silent.
      loadChannelsConfig(
        '/workspace',
        settingsWith({
          all: { type: 'telegram' },
          ' all': { type: 'telegram' },
        }),
      );
      expect(writeSpy).toHaveBeenCalledTimes(3);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('routes the reserved-name warning through the guarded stderr sink (R12-8)', () => {
    // The warning fires on EVERY launch of a worker whose settings keep
    // the reserved entry, and the daemon supervisor spawns a fresh
    // process per launch: on the loud `writeStderrLine`, a failing
    // stderr target (full disk, dead redirect) raises an ASYNCHRONOUS
    // stderr 'error' event that kills the process past any try/catch —
    // a tolerated config becomes a crash loop bounded only by the
    // restart budget. Pin the sink choice: the guarded best-effort
    // wrapper, never the loud sink.
    const bestEffortSpy = vi
      .spyOn(stdioHelpers, 'writeStderrLineBestEffort')
      .mockImplementation(() => {});
    const loudSpy = vi
      .spyOn(stdioHelpers, 'writeStderrLine')
      .mockImplementation(() => {});

    try {
      loadChannelsConfig(
        '/workspace',
        settingsWith({ all: { type: 'telegram' } }),
      );

      expect(bestEffortSpy).toHaveBeenCalledTimes(1);
      expect(bestEffortSpy).toHaveBeenCalledWith(
        expect.stringContaining('the name is reserved'),
      );
      expect(loudSpy).not.toHaveBeenCalled();
    } finally {
      bestEffortSpy.mockRestore();
      loudSpy.mockRestore();
    }
  });

  it('warns and skips a channel literally named "all" (R10-36)', () => {
    // `all` is the whole-selection placeholder: a real channel with that
    // name would be connected by a mode-`all` worker, yet the stop
    // capture's placeholder filter would drop it from the persisted
    // stopped set and the channel resurrects on the next `--channel all`.
    // The collision is refused where settings are read.
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      const loaded = loadChannelsConfig(
        '/workspace',
        settingsWith({
          all: { type: 'telegram' },
          telegram: { type: 'telegram' },
        }),
      );

      expect(Object.keys(loaded)).toEqual(['telegram']);
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining('the name is reserved'),
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('keeps a channel literally named "__proto__" in the reserved-name filter (R11-1)', () => {
    // The filter rebuilds the map when a reserved name is present; on a
    // plain object, assigning a channel named `__proto__` routes through
    // the Object.prototype setter — the entry silently drops and the
    // map's prototype becomes the channel config. Channel names are
    // user-controlled settings keys, so the rebuild must be a
    // null-prototype map (the same hazard the state store's
    // filterChannelStates avoids) (#8975).
    //
    // REACHABILITY (R14-27): loadChannelsConfig consumes the ALREADY-
    // MERGED settings. customDeepMerge's prototype-pollution guard drops
    // a `__proto__` key in the SINGLE-scope case (the common one), so
    // such a channel never reaches this filter from settings.json — the
    // drop is pinned at the merge layer (deepMerge.test). This test
    // injects merged.channels directly, covering the scopes where the
    // key DOES survive the merge (a later scope defining `channels`
    // takes the spread branch) and any future caller handing in a
    // merged-equivalent map with the key as an own entry — JSON.parse
    // yields `__proto__` as an own key, exercising exactly that shape.
    const channels = JSON.parse(
      '{"all":{"type":"telegram"},"__proto__":{"type":"feishu"},"telegram":{"type":"telegram"}}',
    ) as Record<string, unknown>;
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write);

    try {
      const loaded = loadChannelsConfig('/workspace', settingsWith(channels));

      expect(Object.keys(loaded).sort()).toEqual(['__proto__', 'telegram']);
      expect(Object.getPrototypeOf(loaded)).toBeNull();
      expect(loaded['__proto__']).toEqual({ type: 'feishu' });
    } finally {
      writeSpy.mockRestore();
    }
  });
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
          cwd: path.resolve('/workspace'),
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
