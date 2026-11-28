/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
import { DEFAULT_CONFIG_PARAMETERS, createEmptyLoadedSettings } from '../test-utils/config.js';
import { PermissionManager, createPermissionModes } from '../permissions/manager/permission-manager.js';
import type { PermissionMode } from '../permissions/manager/decision/index.js';
import { AUTO_MODE_UNSUPPORTED_MESSAGE, BYPASS_PERMISSIONS_DISABLED_MESSAGE } from '../permissions/permission-modes/index.js';

const configs: Config[] = [];
const managers: PermissionManager[] = [];
function setup(disabledModes: PermissionMode[] = [], disableYolo = false) {
  class ManagedManager extends PermissionManager {
    override initialize() {
      super.initialize();
      this.managedPolicy = {
        getRules: () => ({ allow: {}, deny: {}, ask: {} }),
        getModeRestriction: (mode) =>
          disabledModes.includes(mode)
            ? { message: 'Host policy restriction' }
            : undefined,
        dispose: () => {},
      };
      this.modes = createPermissionModes(this.managedPolicy);
    }
  }
  const manager = new ManagedManager();
  manager.initialize();
  managers.push(manager);
  const loadedSettings = createEmptyLoadedSettings();
  loadedSettings.merged.security = { ...loadedSettings.merged.security, disableYoloMode: disableYolo };
  const config = new Config({
    ...DEFAULT_CONFIG_PARAMETERS,
    targetDir: '.',
    cwd: '.',
    permissionManager: manager,
    loadedSettings,
  });
  configs.push(config);
  vi.spyOn(config, 'isTrustedFolder').mockReturnValue(true);
  vi.spyOn(config, 'getModel').mockReturnValue('');
  config.initPermission();
  return config;
}
afterEach(async () => {
  for (const config of configs.splice(0)) await config.dispose();
  for (const manager of managers.splice(0)) manager.dispose();
  vi.restoreAllMocks();
});

describe('permission model readiness', () => {
  it('defers Auto model validation before initialization selects the main model', () => {
    const config = setup();
    expect(config.isInitialized()).toBe(false);
    expect(config.getPermissionModeRestriction('auto')).toBeUndefined();
  });

  it('still refuses Auto without a model after initialization', () => {
    const config = setup();
    vi.spyOn(config, 'isInitialized').mockReturnValue(true);
    expect(config.getPermissionModeRestriction('auto')).toBe(AUTO_MODE_UNSUPPORTED_MESSAGE);
  });

  it('accepts Auto once the main model is available', () => {
    const config = setup();
    vi.spyOn(config, 'isInitialized').mockReturnValue(true);
    vi.mocked(config.getModel).mockReturnValue('main-model');
    expect(config.getPermissionModeRestriction('auto')).toBeUndefined();
  });

  it('checks configured Auto requirements if a main model is already selected', () => {
    const config = setup();
    vi.mocked(config.getModel).mockReturnValue('main-model');
    vi.spyOn(config.permission!, 'getAutoJudgmentSettings').mockReturnValue({ classifier: 'jev' });
    vi.spyOn(config.permission!, 'isAutoModeJevEnabled').mockReturnValue(true);
    expect(config.getPermissionModeRestriction('auto')).toBe(AUTO_MODE_UNSUPPORTED_MESSAGE);
  });

  it.each(['auto', 'yolo'] as const)('keeps managed %s restrictions before model readiness', mode => {
    expect(setup([mode]).getPermissionModeRestriction(mode)).toBe('Host policy restriction');
  });

  it.each(['auto', 'yolo'] as const)('permits selecting managed restricted %s without permitting execution', (mode) => {
    const config = setup([mode]);
    vi.mocked(config.getModel).mockReturnValue('main-model');
    expect(() => config.setPermissionMode(mode)).not.toThrow();
    expect(config.getPermissionMode()).toBe(mode);
    expect(config.getPermissionModeRestriction(mode)).toBe('Host policy restriction');
  });

  it('still rejects selecting locally disabled YOLO', () => {
    const config = setup([], true);
    expect(() => config.setPermissionMode('yolo')).toThrow(BYPASS_PERMISSIONS_DISABLED_MESSAGE);
  });

  it('still rejects selecting a privileged mode in an untrusted folder', () => {
    const config = setup();
    vi.mocked(config.getModel).mockReturnValue('main-model');
    vi.mocked(config.isTrustedFolder).mockReturnValue(false);
    expect(() => config.setPermissionMode('auto')).toThrow('untrusted folder');
  });

  it('still rejects selecting Auto without its required model', () => {
    const config = setup();
    vi.spyOn(config, 'isInitialized').mockReturnValue(true);
    expect(() => config.setPermissionMode('auto')).toThrow(AUTO_MODE_UNSUPPORTED_MESSAGE);
  });

  it('keeps the local YOLO restriction before model readiness', () => {
    expect(setup([], true).getPermissionModeRestriction('yolo')).toBe(BYPASS_PERMISSIONS_DISABLED_MESSAGE);
  });

  it('keeps the directory trust restriction before model readiness', () => {
    const config = setup();
    vi.mocked(config.isTrustedFolder).mockReturnValue(false);
    expect(config.getPermissionModeRestriction('auto')).toContain('untrusted folder');
  });
});
