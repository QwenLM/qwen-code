/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfiguredStartupContext } from './startupContext.js';
import type { RuntimeRouteRunnerOptions } from './route/runtimeRouteTypes.js';
import type { SessionUiBinding } from '../ui/session/prepareSessionUi.js';
const mocks = vi.hoisted(() => ({
  start: vi.fn(async (..._args: unknown[]) => {}),
  yoga: vi.fn(async () => {}),
}));
vi.mock('../interactiveCli.js', () => ({ startInteractiveUI: mocks.start }));
vi.mock('../ink/layout/yoga.js', () => ({ ensureYogaLoaded: mocks.yoga }));
import { runInteractiveRoute } from './route/interactiveRouteRunner.js';

function TestAppContainer() {
  return null;
}

function start(framework: unknown, binding?: SessionUiBinding) {
  return runInteractiveRoute(
    {
      config: {
        enableBuiltinPluginsForTui: vi.fn(),
        reloadPlugins: vi.fn(async () => {}),
      },
      settings: { settings: { merged: {} }, argv: {} },
      framework: {
        mode: 'tui',
        getAppContainer: () => TestAppContainer,
        whenConfigReady: async () => {},
        ...(framework as object),
      },
    } as unknown as ConfiguredStartupContext,
    {
      startupWarnings: [],
      themeError: null,
      startupCoordinator: {} as RuntimeRouteRunnerOptions['startupCoordinator'],
      sessionUi: binding,
      session: binding?.session,
    } as RuntimeRouteRunnerOptions,
  );
}
describe('interactive session handoff', () => {
  beforeEach(() => vi.clearAllMocks());
  it('passes the prepared binding without waiting for session plugins or creating another session', async () => {
    const framework = {
      awaitInitTUI: vi.fn(async () => {}),
      awaitInitAppPlugins: vi.fn(async () => {
        throw new Error('not needed');
      }),
      prepareSession: vi.fn(),
    };
    const binding = {} as SessionUiBinding;
    await start(framework, binding);
    expect(framework.awaitInitAppPlugins).not.toHaveBeenCalled();
    expect(framework.prepareSession).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0][6]).toBeNull();
    expect(mocks.start.mock.calls[0][13]).toBe(binding);
  });
  it('keeps ordinary local UI on the existing path without a session', async () => {
    const framework = { awaitInitTUI: vi.fn(async () => {}) };
    await start(framework);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0][13]).toBeUndefined();
  });
  it('passes native handle borrowing through the existing application view', async () => {
    const cleanup = vi.fn();
    const framework = {
      mode: 'tui',
      displayName: 'Test CLI',
      bindLocalSession: vi.fn(() => cleanup),
      getAppContainer: vi.fn(() => TestAppContainer),
    };
    await start(framework);
    const application = mocks.start.mock.calls[0][12] as {
      bindLocalSession(handle: unknown): () => void;
    };
    const session = {};
    expect(application.bindLocalSession(session)).toBe(cleanup);
    expect(framework.bindLocalSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(mocks.start.mock.calls[0][0]).toBe(TestAppContainer);
    expect(framework.getAppContainer).toHaveBeenCalledOnce();
  });

  it('initializes Yoga before mounting the UI', async () => {
    await start({});
    expect(mocks.yoga).toHaveBeenCalledOnce();
    expect(mocks.yoga.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0],
    );
  });

  it('rejects a non-TUI framework instead of selecting a default container', async () => {
    await expect(start({ mode: 'headless' })).rejects.toThrow(
      'Interactive route requires a TUI framework',
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('propagates Yoga failures without mounting the UI', async () => {
    mocks.yoga.mockRejectedValueOnce(new Error('Yoga failed'));
    await expect(start({})).rejects.toThrow('Yoga failed');
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
