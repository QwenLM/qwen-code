/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from './settings.js';
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
    system: { settings: system },
    systemDefaults: { settings: systemDefaults },
    user: { settings: user },
    workspace: { settings: workspace },
  };
  const readEffort = (value: Record<string, unknown>) =>
    (value['model'] as { reasoningEffort?: unknown } | undefined)
      ?.reasoningEffort;
  const setValue = vi.fn((scope: SettingScope, key: string, value: unknown) => {
    if (key !== 'model.reasoningEffort') return;
    const target = scope === SettingScope.Workspace ? workspace : user;
    const model = (target['model'] ??= {}) as Record<string, unknown>;
    if (value === undefined) {
      delete model['reasoningEffort'];
    } else {
      model['reasoningEffort'] = value;
    }
  });
  return {
    settings: {
      isTrusted,
      ...files,
      get merged() {
        const effort = [
          readEffort(system),
          ...(isTrusted ? [readEffort(workspace)] : []),
          readEffort(user),
          readEffort(systemDefaults),
        ].find((value) => value !== undefined);
        return effort === undefined
          ? {}
          : { model: { reasoningEffort: effort } };
      },
      setValue,
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
