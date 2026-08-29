/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { LoadedSettings, SettingScope } from './settings.js';
import { clearIncompatibleReasoningEffortForModel } from './reasoning-effort-persistence.js';

function makeSettings({
  isTrusted = true,
  system = {},
  systemDefaults = {},
  user = {},
  workspace = {},
}: {
  isTrusted?: boolean;
  system?: Record<string, unknown>;
  systemDefaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
} = {}): { settings: LoadedSettings; setValue: ReturnType<typeof vi.fn> } {
  const files = {
    system: { settings: system, originalSettings: structuredClone(system) },
    systemDefaults: {
      settings: systemDefaults,
      originalSettings: structuredClone(systemDefaults),
    },
    user: { settings: user, originalSettings: structuredClone(user) },
    workspace: {
      settings: workspace,
      originalSettings: structuredClone(workspace),
    },
  };
  const setValue = vi.fn((scope: SettingScope, key: string, value: unknown) => {
    if (key !== 'model.reasoningEffort') return;
    const target = scope === SettingScope.Workspace ? workspace : user;
    const model = (target['model'] ??= {}) as Record<string, unknown>;
    model['reasoningEffort'] = value;
  });
  return {
    settings: {
      isTrusted,
      ...files,
      get merged() {
        let ownsEffort = false;
        let effort: unknown;
        for (const source of [
          systemDefaults,
          user,
          ...(isTrusted ? [workspace] : []),
          system,
        ]) {
          const model = source['model'] as Record<string, unknown> | undefined;
          if (
            model &&
            Object.prototype.hasOwnProperty.call(model, 'reasoningEffort')
          ) {
            ownsEffort = true;
            effort = model['reasoningEffort'];
          }
        }
        return ownsEffort ? { model: { reasoningEffort: effort } } : {};
      },
      setValue,
      recomputeMerged: vi.fn(),
    } as unknown as LoadedSettings,
    setValue,
  };
}

function makeConfig(
  reasoningPreference?: false | string,
  modelRouteIdentity = 'current-model@route',
): {
  config: Config;
  disableReasoning: ReturnType<typeof vi.fn>;
  setReasoningEffort: ReturnType<typeof vi.fn>;
} {
  const disableReasoning = vi.fn();
  const setReasoningEffort = vi.fn();
  return {
    config: {
      disableReasoning,
      getReasoningPreference: vi.fn().mockReturnValue(reasoningPreference),
      getModelRouteIdentity: vi.fn().mockReturnValue(modelRouteIdentity),
      setReasoningEffort,
    } as unknown as Config,
    disableReasoning,
    setReasoningEffort,
  };
}

describe('clearIncompatibleReasoningEffortForModel', () => {
  it('clears persisted effort from every active writable scope', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
      workspace: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'qwen3.7-max'),
    ).toBe(true);
    expect(setValue).toHaveBeenNthCalledWith(
      1,
      SettingScope.Workspace,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setValue).toHaveBeenNthCalledWith(
      2,
      SettingScope.User,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('does not clear effort for tiered Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(
        config,
        settings,
        'qwen3.8-max-latest',
      ),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('clears opaque effort for non-Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig(
      'ultra',
      'glm-5.2@target-route',
    );

    expect(
      clearIncompatibleReasoningEffortForModel(
        config,
        settings,
        'glm-5.2',
        true,
        'previous-model@route',
      ),
    ).toBe(true);
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('preserves built-in effort for non-Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig('high');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'glm-5.2'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('preserves a persisted disabled preference for toggle-only Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'none' } },
    });
    const { config, setReasoningEffort } = makeConfig(false);

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'coder-model'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('preserves a portable persisted tier while clearing an opaque live override', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig('Vendor.Ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'glm-5.2'),
    ).toBe(true);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).toHaveBeenCalledWith('high');
  });

  it('reveals a lower-scope tier after clearing a higher-scope opaque effort', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-reasoning-cleanup-'),
    );
    const userPath = path.join(tempDir, 'user.json');
    const workspacePath = path.join(tempDir, 'workspace.json');
    const user = { model: { reasoningEffort: 'high' } };
    const workspace = { model: { reasoningEffort: 'Vendor.Ultra' } };
    await fs.writeFile(userPath, JSON.stringify(user));
    await fs.writeFile(workspacePath, JSON.stringify(workspace));
    const settings = new LoadedSettings(
      {
        path: path.join(tempDir, 'system.json'),
        settings: {},
        originalSettings: {},
      },
      {
        path: path.join(tempDir, 'system-defaults.json'),
        settings: {},
        originalSettings: {},
      },
      {
        path: userPath,
        settings: structuredClone(user),
        originalSettings: structuredClone(user),
      },
      {
        path: workspacePath,
        settings: structuredClone(workspace),
        originalSettings: structuredClone(workspace),
      },
      true,
      new Set(),
    );
    const { config, setReasoningEffort } = makeConfig(
      'Vendor.Ultra',
      'glm-5.2@target-route',
    );

    try {
      expect(
        clearIncompatibleReasoningEffortForModel(
          config,
          settings,
          'glm-5.2',
          true,
          'previous-model@route',
        ),
      ).toBe(true);
      expect(settings.merged.model?.reasoningEffort).toBe('high');
      expect(
        Object.prototype.hasOwnProperty.call(
          settings.workspace.settings.model ?? {},
          'reasoningEffort',
        ),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(
          settings.workspace.originalSettings.model ?? {},
          'reasoningEffort',
        ),
      ).toBe(false);
      expect(setReasoningEffort).toHaveBeenCalledWith('high');
      expect(JSON.parse(await fs.readFile(workspacePath, 'utf8'))).toEqual({
        model: {},
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reveals a lower-scope disabled preference after clearing a higher-scope tier', () => {
    const { settings } = makeSettings({
      user: { model: { reasoningEffort: 'none' } },
      workspace: { model: { reasoningEffort: 'high' } },
    });
    const { config, disableReasoning } = makeConfig(
      'high',
      'qwen3.7-max@target-route',
    );

    expect(
      clearIncompatibleReasoningEffortForModel(
        config,
        settings,
        'qwen3.7-max',
        true,
        'qwen3.8-max@previous-route',
      ),
    ).toBe(true);
    expect(disableReasoning).toHaveBeenCalledOnce();
  });

  it('still clears the live preference when a persisted cleanup write fails', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    setValue.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'qwen3.7-max'),
    ).toBe(true);
    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('preserves an opaque preference when the resolved model route did not change', () => {
    const routeIdentity = 'glm-5.2@same-route';
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'Vendor.Ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig(
      'Vendor.Ultra',
      routeIdentity,
    );

    expect(
      clearIncompatibleReasoningEffortForModel(
        config,
        settings,
        'glm-5.2',
        true,
        routeIdentity,
      ),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it.each(['high', 'Vendor.Ultra'])(
    'clears live %s effort from a session-only toggle-only switch',
    (reasoningPreference) => {
      const { settings, setValue } = makeSettings({
        user: { model: { reasoningEffort: reasoningPreference } },
      });
      const { config, setReasoningEffort } = makeConfig(reasoningPreference);

      expect(
        clearIncompatibleReasoningEffortForModel(
          config,
          settings,
          'qwen3.7-max',
          false,
        ),
      ).toBe(true);
      expect(setValue).not.toHaveBeenCalled();
      expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
    },
  );

  it.each(['system', 'systemDefaults'] as const)(
    'clears a live incompatible effort owned by the read-only %s scope',
    (scope) => {
      const { settings, setValue } = makeSettings({
        [scope]: { model: { reasoningEffort: 'Vendor.Ultra' } },
      });
      const { config, setReasoningEffort } = makeConfig('Vendor.Ultra');

      expect(
        clearIncompatibleReasoningEffortForModel(
          config,
          settings,
          'qwen3.7-max',
        ),
      ).toBe(true);
      expect(setValue).not.toHaveBeenCalled();
      expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
    },
  );

  it('ignores workspace persistence when the workspace is untrusted', () => {
    const { settings, setValue } = makeSettings({
      isTrusted: false,
      workspace: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'coder-model'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });
});
