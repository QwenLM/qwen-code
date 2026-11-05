/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SettingScope } from '../config/settings.js';
import type { ServeOptions } from './types.js';
import type { WorkspaceSkillsStatusProviderOptions } from './workspace-skills-status.js';
import {
  getServeAppLifecycle,
  ServeAppLifecycleController,
} from './serve-app-lifecycle.js';

const mockCreateDaemonWorkspaceService = vi.hoisted(() =>
  vi.fn((_deps: unknown) => ({})),
);

vi.mock('./workspace-service/index.js', () => ({
  createDaemonWorkspaceService: mockCreateDaemonWorkspaceService,
  // The Skills status provider reuses the runtime interval for its revalidation
  // fallback; the barrel is mocked here, so the constant has to be present.
  WORKSPACE_SKILLS_REVALIDATE_INTERVAL_MS: 1_000,
}));

const mockCreateSkillsProvider = vi.hoisted(() =>
  vi.fn((_options: WorkspaceSkillsStatusProviderOptions) =>
    Object.assign(vi.fn(), { dispose: vi.fn(async () => {}) }),
  ),
);
vi.mock('./workspace-skills-status.js', () => ({
  createWorkspaceSkillsStatusProvider: mockCreateSkillsProvider,
}));

const { createServeApp } = await import('./server.js');

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
};

function makeBridge() {
  return {
    isChannelLive: vi.fn(() => false),
    queryWorkspaceStatus: vi.fn(),
    invokeWorkspaceCommand: vi.fn(),
    refreshExtensionsForAllSessions: vi.fn(async () => ({
      refreshed: 0,
      failed: 0,
    })),
    publishWorkspaceEvent: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

describe('createServeApp workspace service wiring', () => {
  it.each(['before', 'after'] as const)(
    'preserves an injected lifecycle drain registered %s app creation',
    async (order) => {
      mockCreateSkillsProvider.mockClear();
      const lifecycle = new ServeAppLifecycleController();
      const drain = vi.fn(async () => {});
      if (order === 'before') lifecycle.setAppDrain(drain);
      const app = createServeApp(baseOpts, undefined, {
        boundWorkspace: '/workspace',
        bridge: makeBridge(),
        serveAppLifecycle: lifecycle,
      } as never);
      if (order === 'after') lifecycle.setAppDrain(drain);
      await getServeAppLifecycle(app).close();
      expect(drain).toHaveBeenCalledOnce();
      for (const [
        index,
        [options],
      ] of mockCreateSkillsProvider.mock.calls.entries()) {
        if (options.autoDiscover)
          expect(
            mockCreateSkillsProvider.mock.results[index]!.value.dispose,
          ).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    'disposes both automatic catalogs with an externally supplied lifecycle: %s',
    async (supplied) => {
      mockCreateSkillsProvider.mockClear();
      const app = createServeApp(baseOpts, undefined, {
        boundWorkspace: '/workspace',
        bridge: makeBridge(),
        ...(supplied
          ? { serveAppLifecycle: new ServeAppLifecycleController() }
          : {}),
      } as never);
      const automatic = mockCreateSkillsProvider.mock.calls.flatMap(
        ([options], index) =>
          options.autoDiscover
            ? [mockCreateSkillsProvider.mock.results[index]!.value]
            : [],
      );
      expect(automatic).toHaveLength(2);
      await getServeAppLifecycle(app).close();
      for (const provider of automatic)
        expect(provider.dispose).toHaveBeenCalledOnce();
    },
  );

  it('forwards batch settings persistence to the workspace service', () => {
    mockCreateDaemonWorkspaceService.mockClear();
    const persistSetting = vi.fn(
      async (
        _workspace: string,
        _scope: SettingScope,
        _key: string,
        _value: unknown,
      ) => {},
    );
    const persistSettings = vi.fn(
      async (
        _workspace: string,
        _writes: Array<{ scope: SettingScope; key: string; value: unknown }>,
      ) => {},
    );

    createServeApp(baseOpts, undefined, {
      boundWorkspace: '/workspace',
      bridge: makeBridge(),
      persistSetting,
      persistSettings,
    } as never);

    expect(mockCreateDaemonWorkspaceService).toHaveBeenCalledTimes(1);
    expect(mockCreateDaemonWorkspaceService.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        persistSetting,
        persistSettings,
      }),
    );
  });
});
