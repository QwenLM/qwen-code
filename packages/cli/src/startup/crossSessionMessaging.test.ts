/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreEvent, coreEvents } from '@qwen-code/core';
import { startCrossSessionMessaging } from './crossSessionMessaging.js';
import type { LoadedSettings } from '../config/settings.js';

const mocks = vi.hoisted(() => ({
  isCrossSessionMessagingEnabled: vi.fn(),
  startUdsMessaging: vi.fn(),
  writeSessionRegistryEntry: vi.fn(),
  refreshSessionRegistryEntry: vi.fn(),
  getSessionRegistryRefreshFailures: vi.fn(() => 0),
  removeSessionRegistryEntry: vi.fn(),
  probeSocket: vi.fn(),
  getDefaultUdsSocketPath: vi.fn(() => '/tmp/socks/1.sock'),
  setCrossSessionInboundResolver: vi.fn(),
  setPermissionModeGetter: vi.fn(),
  setReviewSurfaceAvailable: vi.fn(),
  settleHeldMessagesOnShutdown: vi.fn(),
  reevaluateHeldMessages: vi.fn(),
  currentModeClass: vi.fn(() => 'prompting'),
  runLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...mocks };
});

function makeConfig(isInteractive = true) {
  return {
    isInteractive: () => isInteractive,
    getSessionId: () => 'session-1',
    getPermissionMode: () => 'default',
    topicState: { getTopic: () => 'my-topic' },
  } as never;
}

const settings = { user: { settings: {} } } as unknown as LoadedSettings;

/**
 * Asserts the four process-level gate hooks are back where they started.
 *
 * They are installed before the bind on purpose, so "we never bound" and "we are
 * shutting down" have to leave core in the same state; anything else strands a
 * closure over this session's settings with no receipt sink behind it.
 */
function expectInboundGateUnwired(): void {
  expect(mocks.setCrossSessionInboundResolver).toHaveBeenLastCalledWith(
    undefined,
  );
  expect(mocks.setPermissionModeGetter).toHaveBeenLastCalledWith(undefined);
  expect(mocks.setReviewSurfaceAvailable).toHaveBeenLastCalledWith(true);
}

describe('startCrossSessionMessaging', () => {
  beforeEach(() => {
    // `runLogger` is a bag of spies rather than a spy, so reset by shape.
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
    }
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(true);
    mocks.currentModeClass.mockReturnValue('prompting');
    mocks.runLogger.debug.mockReset();
    mocks.runLogger.warn.mockReset();
    mocks.runLogger.error.mockReset();
    mocks.getDefaultUdsSocketPath.mockReturnValue('/tmp/socks/1.sock');
    mocks.probeSocket.mockResolvedValue(false);
    mocks.writeSessionRegistryEntry.mockResolvedValue(true);
    mocks.getSessionRegistryRefreshFailures.mockReturnValue(0);
    mocks.settleHeldMessagesOnShutdown.mockResolvedValue(0);
    mocks.startUdsMessaging.mockResolvedValue({
      socketPath: '/tmp/socks/1.sock',
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    // `coreEvents` is a process singleton, and a test that never calls its stop
    // function leaves its listener attached. Without this the counts asserted
    // below accumulate across the file.
    coreEvents.removeAllListeners(CoreEvent.SessionTitleChanged);
    coreEvents.removeAllListeners(CoreEvent.PermissionModeChanged);
    coreEvents.removeAllListeners(CoreEvent.SettingsChanged);
    vi.restoreAllMocks();
  });

  it('does nothing when the gate is off', async () => {
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(false);
    const stop = await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
    });
    expect(stop).toBeUndefined();
    expect(mocks.startUdsMessaging).not.toHaveBeenCalled();
    expect(mocks.writeSessionRegistryEntry).not.toHaveBeenCalled();
  });

  it('skips a non-interactive session with no explicit path', async () => {
    const stop = await startCrossSessionMessaging({
      config: makeConfig(false),
      settings,
    });
    expect(stop).toBeUndefined();
    expect(mocks.startUdsMessaging).not.toHaveBeenCalled();
  });

  it('binds for a non-interactive session given an explicit path', async () => {
    mocks.startUdsMessaging.mockResolvedValue({
      socketPath: '/tmp/explicit.sock',
      close: vi.fn().mockResolvedValue(undefined),
    });
    const stop = await startCrossSessionMessaging({
      config: makeConfig(false),
      settings,
      explicitSocketPath: '/tmp/explicit.sock',
    });
    expect(stop).toBeDefined();
    expect(mocks.startUdsMessaging).toHaveBeenCalledWith(
      '/tmp/explicit.sock',
      expect.objectContaining({ isExplicit: true }),
    );
  });

  it('refuses an explicit path that is already live', async () => {
    mocks.probeSocket.mockResolvedValue(true);
    const stop = await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
      explicitSocketPath: '/tmp/taken.sock',
    });
    expect(stop).toBeUndefined();
    expect(mocks.startUdsMessaging).not.toHaveBeenCalled();
  });

  // The gate is installed before the bind, so a path that returns without a stop
  // function has to take it back down itself: nothing else ever will.
  it('[RA17] unwires the gate when an explicit path is already live', async () => {
    mocks.probeSocket.mockResolvedValue(true);
    await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
      explicitSocketPath: '/tmp/taken.sock',
    });
    expectInboundGateUnwired();
  });

  it('publishes a registry entry naming the bound socket', async () => {
    await startCrossSessionMessaging({ config: makeConfig(), settings });
    expect(mocks.writeSessionRegistryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: process.pid,
        sessionId: 'session-1',
        name: 'my-topic',
        kind: 'interactive',
        messagingSocketPath: '/tmp/socks/1.sock',
      }),
    );
  });

  it('wires the gate before binding', async () => {
    await startCrossSessionMessaging({ config: makeConfig(), settings });
    expect(mocks.setCrossSessionInboundResolver).toHaveBeenCalled();
    expect(mocks.setPermissionModeGetter).toHaveBeenCalled();
  });

  it('survives a bind failure without throwing', async () => {
    mocks.startUdsMessaging.mockResolvedValue(undefined);
    const stop = await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
    });
    expect(stop).toBeUndefined();
    expect(mocks.writeSessionRegistryEntry).not.toHaveBeenCalled();
  });

  it('[RA17] unwires the gate when the bind fails', async () => {
    mocks.startUdsMessaging.mockResolvedValue(undefined);
    await startCrossSessionMessaging({ config: makeConfig(), settings });
    expectInboundGateUnwired();
  });

  it('survives a bind that throws', async () => {
    mocks.startUdsMessaging.mockRejectedValue(new Error('boom'));
    await expect(
      startCrossSessionMessaging({ config: makeConfig(), settings }),
    ).resolves.toBeUndefined();
  });

  it('[RA17] unwires the gate when the bind throws', async () => {
    mocks.startUdsMessaging.mockRejectedValue(new Error('boom'));
    await startCrossSessionMessaging({ config: makeConfig(), settings });
    expectInboundGateUnwired();
  });

  it('declares a review surface for an interactive session', async () => {
    await startCrossSessionMessaging({ config: makeConfig(true), settings });
    expect(mocks.setReviewSurfaceAvailable).toHaveBeenCalledWith(true);
  });

  it('declares no review surface for a non-interactive session', async () => {
    await startCrossSessionMessaging({
      config: makeConfig(false),
      settings,
      explicitSocketPath: '/tmp/explicit.sock',
    });
    expect(mocks.setReviewSurfaceAvailable).toHaveBeenCalledWith(false);
  });

  it('settles held messages before closing the socket', async () => {
    const order: string[] = [];
    mocks.settleHeldMessagesOnShutdown.mockImplementation(async () => {
      order.push('settle');
      return 1;
    });
    const close = vi.fn().mockImplementation(async () => {
      order.push('close');
    });
    mocks.startUdsMessaging.mockResolvedValue({
      socketPath: '/tmp/socks/1.sock',
      close,
    });

    const stop = await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
    });
    await stop?.();

    // Reversed, a peer's reply address would already be unreachable.
    expect(order).toEqual(['settle', 'close']);
  });

  it('removes the socket and registry entry on stop', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startUdsMessaging.mockResolvedValue({
      socketPath: '/tmp/socks/1.sock',
      close,
    });
    const stop = await startCrossSessionMessaging({
      config: makeConfig(),
      settings,
    });
    await stop?.();
    expect(close).toHaveBeenCalled();
    expect(mocks.removeSessionRegistryEntry).toHaveBeenCalled();
    expect(mocks.setCrossSessionInboundResolver).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  describe('session identity', () => {
    it('[AC1] republishes the name when the session title changes', async () => {
      await startCrossSessionMessaging({ config: makeConfig(), settings });

      coreEvents.emitSessionTitleChanged('test-session', 'renamed-session');

      expect(mocks.refreshSessionRegistryEntry).toHaveBeenCalledWith({
        name: 'renamed-session',
      });
    });

    it('[AC2] carries a title set after bind, which is the usual case', async () => {
      // At bind time the topic is normally still unset: `--name`, a resumed
      // title and the model's own `SetTopic` all land later in startup.
      await startCrossSessionMessaging({
        config: makeConfig(),
        settings,
      });

      coreEvents.emitSessionTitleChanged('test-session', 'first');
      coreEvents.emitSessionTitleChanged('test-session', 'second');

      expect(mocks.refreshSessionRegistryEntry).toHaveBeenNthCalledWith(1, {
        name: 'first',
      });
      expect(mocks.refreshSessionRegistryEntry).toHaveBeenNthCalledWith(2, {
        name: 'second',
      });
    });

    it('stops listening for titles once torn down', async () => {
      const stop = await startCrossSessionMessaging({
        config: makeConfig(),
        settings,
      });
      await stop?.();

      coreEvents.emitSessionTitleChanged('test-session', 'too-late');

      expect(mocks.refreshSessionRegistryEntry).not.toHaveBeenCalled();
    });

    it('does not listen for titles when the session never bound', async () => {
      mocks.startUdsMessaging.mockResolvedValue(undefined);
      await startCrossSessionMessaging({ config: makeConfig(), settings });

      coreEvents.emitSessionTitleChanged('test-session', 'nobody-home');

      expect(mocks.refreshSessionRegistryEntry).not.toHaveBeenCalled();
    });
  });

  describe('held-queue triggers', () => {
    it('[AC18] re-judges the queue when settings change', async () => {
      const stop = await startCrossSessionMessaging({
        config: makeConfig(),
        settings,
      });
      coreEvents.emitSettingsChanged();
      expect(mocks.reevaluateHeldMessages).toHaveBeenCalled();
      await stop?.();
    });

    it('stops listening after teardown', async () => {
      const stop = await startCrossSessionMessaging({
        config: makeConfig(),
        settings,
      });
      await stop?.();
      mocks.reevaluateHeldMessages.mockClear();
      coreEvents.emitSettingsChanged();
      expect(mocks.reevaluateHeldMessages).not.toHaveBeenCalled();
    });
  });

  describe('[AC7] headless refusal warning', () => {
    // A non-interactive bypass session with no explicit setting refuses every
    // inbound message. That is the intended fail-closed behaviour, but it is
    // silent enough to look like a transport failure, so it says so once.
    it('warns when this session will refuse everything', async () => {
      mocks.currentModeClass.mockReturnValue('bypass');
      const stop = await startCrossSessionMessaging({
        config: makeConfig(false),
        settings,
        explicitSocketPath: '/tmp/socks/explicit.sock',
      });

      const warnings = mocks.runLogger.warn.mock.calls.filter((call) => {
        const [message] = call as unknown as [unknown];
        return (
          typeof message === 'string' &&
          message.includes('security.crossSessionInbound')
        );
      });
      expect(warnings).toHaveLength(1);
      await stop?.();
    });

    it('stays quiet when an explicit policy is configured', async () => {
      mocks.currentModeClass.mockReturnValue('bypass');
      const configured = {
        user: { settings: { security: { crossSessionInbound: 'accept' } } },
      } as unknown as LoadedSettings;

      const stop = await startCrossSessionMessaging({
        config: makeConfig(false),
        settings: configured,
        explicitSocketPath: '/tmp/socks/explicit.sock',
      });
      expect(mocks.runLogger.warn).not.toHaveBeenCalled();
      await stop?.();
    });

    it('stays quiet in an interactive session, which can show a prompt', async () => {
      mocks.currentModeClass.mockReturnValue('bypass');
      const stop = await startCrossSessionMessaging({
        config: makeConfig(true),
        settings,
      });
      expect(mocks.runLogger.warn).not.toHaveBeenCalled();
      await stop?.();
    });

    it('stays quiet for a prompting session, which accepts anyway', async () => {
      const stop = await startCrossSessionMessaging({
        config: makeConfig(false),
        settings,
        explicitSocketPath: '/tmp/socks/explicit.sock',
      });
      expect(mocks.runLogger.warn).not.toHaveBeenCalled();
      await stop?.();
    });
  });
});
