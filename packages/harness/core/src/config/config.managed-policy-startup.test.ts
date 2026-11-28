/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
import { DEFAULT_CONFIG_PARAMETERS } from '../test-utils/config.js';
import {
  PermissionManager,
  createPermissionModes,
} from '../permissions/manager/permission-manager.js';

const configs: Config[] = [];
const managers: PermissionManager[] = [];

function setup(mode: 'auto' | 'yolo', whenReady?: () => Promise<void>) {
  let disabled = false;
  const policy = {
    getRules: () => ({ allow: {}, deny: {}, ask: {} }),
    getModeRestriction: () =>
      disabled ? { message: 'Host policy disabled this mode' } : undefined,
    ...(whenReady ? { whenReady: vi.fn(whenReady) } : {}),
    dispose: () => {},
  };
  class Manager extends PermissionManager {
    override initialize() {
      super.initialize();
      this.managedPolicy = policy;
      this.modes = createPermissionModes(policy);
    }
  }
  const manager = new Manager();
  manager.initialize();
  managers.push(manager);
  const config = new Config({
    ...DEFAULT_CONFIG_PARAMETERS,
    permissionMode: mode,
    permissionManager: manager,
  });
  configs.push(config);
  vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
  vi.spyOn(config, 'getModel').mockReturnValue('');
  const storage = vi
    .spyOn(config.storage, 'initialize')
    .mockRejectedValue(new Error('storage reached'));
  return {
    config,
    policy,
    storage,
    disable: () => {
      disabled = true;
    },
  };
}

afterEach(async () => {
  for (const config of configs.splice(0)) await config.dispose();
  for (const manager of managers.splice(0)) manager.dispose();
  vi.restoreAllMocks();
});

describe.each(['auto', 'yolo'] as const)('managed %s startup', (mode) => {
  it.each(['interactive', 'headless'] as const)(
    'waits for the initial snapshot without rejecting %s mode selection',
    async (entry) => {
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const state = setup(mode, () => ready);
      const initialization =
        entry === 'interactive'
          ? state.config.initializeForInteractiveStartup()
          : state.config.initialize();
      void initialization.catch(() => {});
      try {
        await Promise.resolve();
        expect(state.policy.whenReady).toHaveBeenCalledOnce();
        expect(state.storage).not.toHaveBeenCalled();
        state.disable();
        finish();
        await expect(initialization).rejects.toThrow('storage reached');
        expect(state.storage).toHaveBeenCalledOnce();
        expect(state.config.getPermissionMode()).toBe(mode);
        expect(state.config.getPermissionModeRestriction(mode)).toBe(
          'Host policy disabled this mode',
        );
      } finally {
        finish();
      }
    },
  );

  it('allows selecting a mode when the managed restriction is already known', () => {
    const state = setup(mode);
    state.disable();
    expect(() => state.config.initPermission()).not.toThrow();
    expect(state.config.getPermissionMode()).toBe(mode);
    expect(state.config.getPermissionModeRestriction(mode)).toBe(
      'Host policy disabled this mode',
    );
  });

  it('does not invent a restriction when the first read has no policy', async () => {
    const state = setup(mode, async () => {});
    await expect(state.config.initialize()).rejects.toThrow('storage reached');
    expect(state.storage).toHaveBeenCalledOnce();
  });

  it('preserves startup for a static policy without a readiness method', async () => {
    const state = setup(mode);
    await expect(state.config.initialize()).rejects.toThrow('storage reached');
    expect(state.storage).toHaveBeenCalledOnce();
  });
});
